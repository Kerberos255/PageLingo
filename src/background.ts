import { BergamotClient } from "./providers/bergamot/bergamot-client";
import {
  listModelPairs,
  listPackLanguages,
  listSourceLanguages,
  listTargetLanguages,
  planTranslationRouteWithResolver,
  type BergamotModelPair,
} from "./providers/bergamot/model-manifest";
import {
  deleteModelPair,
  downloadModelPair,
  isModelPairCached,
  pruneModelPair,
} from "./providers/bergamot/model-cache";
import {
  effectivePair,
  effectivePairByKey,
  fetchLatestPairs,
  isModelUpdate,
  loadModelOverrides,
  loadModelUpdateState,
  saveModelOverrides,
  saveModelUpdateState,
  type ModelCatalogOverrides,
  type ModelUpdateState,
} from "./providers/bergamot/model-updates";
import { handleImageRuntimeMessage, initializeImageTranslation } from "./image-translation/background-service";
import { languageLabel, loadSettings, normalizeDetectedLanguage } from "./shared/settings";
import { hasExternalTranslationConsent } from "./shared/data-consent";
import { isLoopbackTranslationEndpoint } from "./shared/network-endpoint";
import {
  externalEngineIsLlm,
  externalEngineSupportsBatch,
  listExternalTranslationModels,
  resetThinkingModeCache,
  translateBatchWithExternalEngine,
  translateWithExternalEngine,
  type ExternalTranslationRequest,
  type ExternalTranslationTerminologyEntry,
} from "./providers/external-translation";
import { ExternalTranslationCache, externalTranslationCacheKey } from "./providers/external-translation-cache";
import {
  LOCAL_TRANSLATION_ENGINE_ID,
  PAGELINGO_MT_ENGINE_ID,
  deleteTranslationEngine,
  loadTranslationEngineState,
  normalizeTranslationEngineConfig,
  saveTranslationEngine,
  setActiveTranslationEngine,
  setTranslationEngineEnabled,
  type TranslationEngineConfig,
} from "./shared/translation-engine-settings";
import { PageLingoMtClient } from "./providers/pagelingo-mt/client";
import { mtRouteSupported } from "./providers/pagelingo-mt/protocol";
import { keepEventPageAlive } from "./shared/event-page-keepalive";

class ConcurrencyGate {
  readonly #limit: number;
  #active = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.#limit = Math.max(1, limit);
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#limit) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    this.#active += 1;
    try {
      return await task();
    } finally {
      this.#active -= 1;
      const next = this.#waiters.shift();
      if (next) next();
    }
  }
}

const bergamot = new BergamotClient();
const pagelingoMt = new PageLingoMtClient();
const externalCache = new ExternalTranslationCache();
const externalGate = new ConcurrencyGate(6);
const MODEL_UPDATE_ALARM = "pagelingo-model-updates";
const MODEL_UPDATE_INTERVAL_MINUTES = 24 * 60;
let overridesPromise = loadModelOverrides();
let updateStatePromise = loadModelUpdateState();
let updateRun: Promise<ModelUpdateState> | null = null;
let translationEngineStatePromise = loadTranslationEngineState();

interface RuntimeMessage {
  type?: string;
  request?: {
    html?: unknown;
    sourceLanguage?: unknown;
    targetLanguage?: unknown;
    terminology?: unknown;
  };
  requests?: Array<{
    html?: unknown;
    sourceLanguage?: unknown;
    targetLanguage?: unknown;
    terminology?: unknown;
  }>;
  sourceLanguage?: unknown;
  targetLanguage?: unknown;
  language?: unknown;
  config?: unknown;
  id?: unknown;
  enabled?: unknown;
}

function asLanguage(value: unknown): string | null {
  return normalizeDetectedLanguage(value);
}

function parseTerminologyPayload(raw: unknown): ExternalTranslationTerminologyEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is ExternalTranslationTerminologyEntry =>
      Boolean(
        entry &&
        typeof entry === "object" &&
        typeof (entry as { source?: unknown }).source === "string" &&
        typeof (entry as { target?: unknown }).target === "string" &&
        ((entry as { mode?: unknown }).mode === "protect" || (entry as { mode?: unknown }).mode === "replace")
      )
    )
    .map((entry) => ({ source: entry.source, target: entry.target, mode: entry.mode }));
}

async function translateExternalSingleCached(
  external: TranslationEngineConfig,
  request: ExternalTranslationRequest,
): Promise<string> {
  const cacheable = externalCache.isCacheable(request.html);
  const key = cacheable
    ? externalTranslationCacheKey(external, request.sourceLanguage, request.targetLanguage, request.html, request.terminology)
    : "";
  if (cacheable) {
    const cached = await externalCache.get(key);
    if (cached !== undefined) return cached;
    const inFlight = externalCache.getInFlight(key);
    if (inFlight) return inFlight;
  }
  const run = externalGate.run(async () => {
    const html = await translateWithExternalEngine(external, request);
    if (cacheable) externalCache.set(key, html);
    return html;
  });
  return cacheable ? externalCache.trackInFlight(key, run) : run;
}

async function translateExternalBatchCached(
  external: TranslationEngineConfig,
  requests: readonly ExternalTranslationRequest[],
): Promise<string[]> {
  if (requests.length === 0) return [];
  if (requests.length === 1) return [await translateExternalSingleCached(external, requests[0]!)];

  const results = new Array<string>(requests.length);
  const keys = requests.map((request) =>
    externalCache.isCacheable(request.html)
      ? externalTranslationCacheKey(external, request.sourceLanguage, request.targetLanguage, request.html, request.terminology)
      : "",
  );
  const uniqueLookupKeys = Array.from(new Set(keys.filter(Boolean)));
  const cachedMap = uniqueLookupKeys.length > 0 ? await externalCache.getMany(uniqueLookupKeys) : new Map<string, string>();

  const joinedPromises: Array<{ index: number; promise: Promise<string> }> = [];
  const pendingByKey = new Map<string, {
    request: ExternalTranslationRequest;
    indexes: number[];
    cacheable: boolean;
    key: string;
    resolve: (html: string) => void;
    reject: (error: Error) => void;
  }>();
  const uncacheableItems: Array<{ request: ExternalTranslationRequest; index: number }> = [];

  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index]!;
    const key = keys[index]!;
    if (key) {
      const cached = cachedMap.get(key);
      if (cached !== undefined) {
        results[index] = cached;
        continue;
      }
      const inFlight = externalCache.getInFlight(key);
      if (inFlight) {
        joinedPromises.push({ index, promise: inFlight });
        continue;
      }
      const existing = pendingByKey.get(key);
      if (existing) {
        existing.indexes.push(index);
        continue;
      }
      let resolveDeferred!: (html: string) => void;
      let rejectDeferred!: (error: Error) => void;
      const deferred = new Promise<string>((resolve, reject) => {
        resolveDeferred = resolve;
        rejectDeferred = reject;
      });
      // Prevent unhandled rejection when no external caller joins this in-flight promise.
      void deferred.catch(() => {});
      externalCache.trackInFlight(key, deferred);
      pendingByKey.set(key, {
        request,
        indexes: [index],
        cacheable: true,
        key,
        resolve: resolveDeferred,
        reject: rejectDeferred,
      });
    } else {
      uncacheableItems.push({ request, index });
    }
  }

  const batchEntries = Array.from(pendingByKey.values());
  const batchRequests: ExternalTranslationRequest[] = [
    ...batchEntries.map((entry) => entry.request),
    ...uncacheableItems.map((entry) => entry.request),
  ];

  if (batchRequests.length > 0) {
    try {
      const translated = await externalGate.run(() =>
        batchRequests.length === 1
          ? translateWithExternalEngine(external, batchRequests[0]!).then((html) => [html])
          : translateBatchWithExternalEngine(external, batchRequests),
      );
      for (let i = 0; i < batchEntries.length; i += 1) {
        const entry = batchEntries[i]!;
        const html = translated[i]!;
        if (entry.cacheable) externalCache.set(entry.key, html);
        entry.resolve(html);
        for (const targetIndex of entry.indexes) results[targetIndex] = html;
      }
      for (let i = 0; i < uncacheableItems.length; i += 1) {
        const entry = uncacheableItems[i]!;
        results[entry.index] = translated[batchEntries.length + i]!;
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      for (const entry of batchEntries) entry.reject(err);
      throw err;
    }
  }

  if (joinedPromises.length > 0) {
    await Promise.all(joinedPromises.map(async ({ index, promise }) => {
      results[index] = await promise;
    }));
  }

  return results;
}

async function currentOverrides(): Promise<ModelCatalogOverrides> {
  return overridesPromise;
}

async function currentUpdateState(): Promise<ModelUpdateState> {
  return updateStatePromise;
}

function routeFor(sourceLanguage: string, targetLanguage: string, overrides: ModelCatalogOverrides) {
  return planTranslationRouteWithResolver(
    sourceLanguage,
    targetLanguage,
    (source, target) => effectivePair(source, target, overrides),
  );
}

function modelPairsForLanguage(language: string, overrides: ModelCatalogOverrides): BergamotModelPair[] {
  return [effectivePair("en", language, overrides), effectivePair(language, "en", overrides)]
    .filter((pair): pair is BergamotModelPair => Boolean(pair));
}

async function isTranslationRouteCached(sourceLanguage: string, targetLanguage: string): Promise<boolean> {
  const overrides = await currentOverrides();
  const route = routeFor(sourceLanguage, targetLanguage, overrides);
  if (!route) return false;
  const cached = await Promise.all(route.models.map((pair) => isModelPairCached(pair)));
  return cached.every(Boolean);
}

async function currentTranslationEngineState() {
  return translationEngineStatePromise;
}

async function refreshTranslationEngineState() {
  const state = await loadTranslationEngineState();
  translationEngineStatePromise = Promise.resolve(state);
  return state;
}

async function activeExternalEngine() {
  const state = await currentTranslationEngineState();
  if (state.activeEngineId === LOCAL_TRANSLATION_ENGINE_ID || state.activeEngineId === PAGELINGO_MT_ENGINE_ID) return null;
  return state.engines.find((engine) => engine.id === state.activeEngineId && engine.enabled) ?? null;
}

async function translationEngineStateForUi() {
  const state = await currentTranslationEngineState();
  const activeExternal = state.activeEngineId === LOCAL_TRANSLATION_ENGINE_ID || state.activeEngineId === PAGELINGO_MT_ENGINE_ID
    ? null
    : state.engines.find((engine) => engine.id === state.activeEngineId && engine.enabled) ?? null;
  const mt = await pagelingoMt.status();
  const externalIsLlm = Boolean(activeExternal && externalEngineIsLlm(activeExternal.type));
  const externalSupportsBatch = Boolean(activeExternal && externalEngineSupportsBatch(activeExternal.type));
  const executionProfile = activeExternal
    ? {
        isExternal: true,
        isLlm: externalIsLlm,
        supportsBatch: externalSupportsBatch,
        supportsPromptTerminology: externalIsLlm,
        recommendedConcurrency: externalSupportsBatch ? 24 : 8,
        batchMaxItems: externalIsLlm ? 10 : 24,
        batchMaxChars: externalIsLlm ? 1500 : 4000,
        batchConcurrency: 5,
      }
    : state.activeEngineId === PAGELINGO_MT_ENGINE_ID
      ? {
          isExternal: false,
          isLlm: false,
          supportsBatch: false,
          supportsPromptTerminology: false,
          recommendedConcurrency: 2,
          batchMaxItems: 1,
          batchMaxChars: 4000,
          batchConcurrency: 1,
        }
      : {
          isExternal: false,
          isLlm: false,
          supportsBatch: true,
          supportsPromptTerminology: false,
          recommendedConcurrency: 4,
          batchMaxItems: 32,
          batchMaxChars: 16000,
          batchConcurrency: 1,
        };
  return {
    activeEngineId: state.activeEngineId,
    structuralSplittingSafe: state.activeEngineId === LOCAL_TRANSLATION_ENGINE_ID
      || state.activeEngineId === PAGELINGO_MT_ENGINE_ID
      || Boolean(activeExternal && isLoopbackTranslationEndpoint(activeExternal.baseUrl)),
    executionProfile,
    mt,
    engines: state.engines.map((engine) => ({
      id: engine.id,
      name: engine.name,
      type: engine.type,
      enabled: engine.enabled,
      model: engine.model,
      hasApiKey: Boolean(engine.apiKey),
      disableThinking: engine.disableThinking !== false,
    })),
  };
}

async function setOverrides(overrides: ModelCatalogOverrides): Promise<void> {
  await saveModelOverrides(overrides);
  overridesPromise = Promise.resolve(overrides);
}

async function setUpdateState(state: ModelUpdateState): Promise<void> {
  await saveModelUpdateState(state);
  updateStatePromise = Promise.resolve(state);
  const count = Object.keys(state.available).length;
  await browser.action.setBadgeText({ text: count > 0 ? String(count) : "" });
}

async function packInfo(language: string) {
  const [overrides, updateState] = await Promise.all([currentOverrides(), currentUpdateState()]);
  const pairs = modelPairsForLanguage(language, overrides);
  const states = await Promise.all(pairs.map(async (pair) => {
    const candidate = updateState.available[pair.key];
    return {
      key: pair.key,
      sourceLanguage: pair.sourceLanguage,
      targetLanguage: pair.targetLanguage,
      bytes: pair.installedBytes,
      version: pair.version,
      installed: await isModelPairCached(pair),
      updateAvailable: Boolean(candidate && isModelUpdate(pair, candidate)),
      latestVersion: candidate?.version ?? pair.version,
    };
  }));
  return {
    language,
    label: languageLabel(language),
    canTranslateFromEnglish: Boolean(effectivePair("en", language, overrides)),
    canTranslateToEnglish: Boolean(effectivePair(language, "en", overrides)),
    totalBytes: pairs.reduce((sum, pair) => sum + pair.installedBytes, 0),
    installedBytes: states.filter((state) => state.installed).reduce((sum, state) => sum + state.bytes, 0),
    installed: states.length > 0 && states.every((state) => state.installed),
    partial: states.some((state) => state.installed) && !states.every((state) => state.installed),
    updateAvailable: states.some((state) => state.installed && state.updateAvailable),
    directions: states,
  };
}

async function languageCatalog() {
  const [packs, updateState] = await Promise.all([
    Promise.all(listPackLanguages().map((language) => packInfo(language))),
    currentUpdateState(),
  ]);
  return {
    sourceLanguages: listSourceLanguages().map((code) => ({ code, label: languageLabel(code) })),
    targetLanguages: listTargetLanguages().map((code) => ({ code, label: languageLabel(code) })),
    packs,
    updateCheckedAt: updateState.checkedAt,
    updateCount: Object.keys(updateState.available).length,
  };
}

function choosePreferredTarget(candidates: readonly string[]): string {
  const supported = new Set(listTargetLanguages());
  for (const candidate of candidates) {
    const normalized = normalizeDetectedLanguage(candidate);
    if (normalized && supported.has(normalized)) return normalized;
  }
  return supported.has("zh-Hans") ? "zh-Hans" : "en";
}

async function installLatestPair(current: BergamotModelPair): Promise<BergamotModelPair> {
  let selected = current;
  try {
    const latest = (await fetchLatestPairs([current.key])).get(current.key);
    if (latest && isModelUpdate(current, latest)) selected = latest;
  } catch (error) {
    console.warn("[PageLingo] Could not refresh model metadata; using pinned model", current.key, error);
  }

  await downloadModelPair(selected);
  if (selected !== current) {
    const overrides = await currentOverrides();
    const next = { ...overrides, [selected.key]: selected };
    await setOverrides(next);
    bergamot.reset();
    await pruneModelPair(current, selected);
  }
  return selected;
}

async function initializeFirstInstall(): Promise<void> {
  const uiLanguage = browser.i18n.getUILanguage();
  let accepted: string[] = [];
  try {
    accepted = await browser.i18n.getAcceptLanguages();
  } catch {
    accepted = [];
  }
  const targetLanguage = choosePreferredTarget([...accepted, uiLanguage]);
  await browser.storage.local.set({ targetLanguage });

  if (targetLanguage === "en") return;
  const overrides = await currentOverrides();
  const defaultPair = effectivePair("en", targetLanguage, overrides);
  if (!defaultPair) return;
  try {
    await installLatestPair(defaultPair);
  } catch (error) {
    console.warn("[PageLingo] Initial language pack download failed", error);
  }
}

async function installedPairKeys(overrides: ModelCatalogOverrides): Promise<string[]> {
  const keys: string[] = [];
  for (const basePair of listModelPairs()) {
    const pair = effectivePairByKey(basePair.key, overrides);
    if (pair && await isModelPairCached(pair)) keys.push(pair.key);
  }
  return keys;
}

async function checkModelUpdates(): Promise<ModelUpdateState> {
  if (updateRun) return updateRun;
  updateRun = (async () => {
    const overrides = await currentOverrides();
    const keys = await installedPairKeys(overrides);
    const latest = await fetchLatestPairs(keys);
    const available: ModelCatalogOverrides = {};
    for (const key of keys) {
      const current = effectivePairByKey(key, overrides);
      const candidate = latest.get(key);
      if (current && candidate && isModelUpdate(current, candidate)) available[key] = candidate;
    }
    const state = { checkedAt: Date.now(), available };
    await setUpdateState(state);
    return state;
  })().finally(() => {
    updateRun = null;
  });
  return updateRun;
}

async function applyUpdateCandidates(candidates: ModelCatalogOverrides, onlyKeys?: Set<string>): Promise<ModelUpdateState> {
  let overrides = await currentOverrides();
  const remaining = { ...(await currentUpdateState()).available };
  let changed = false;

  for (const [key, candidate] of Object.entries(candidates)) {
    if (onlyKeys && !onlyKeys.has(key)) continue;
    const current = effectivePairByKey(key, overrides);
    if (!current || !isModelUpdate(current, candidate) || !await isModelPairCached(current)) {
      delete remaining[key];
      continue;
    }
    await downloadModelPair(candidate);
    overrides = { ...overrides, [key]: candidate };
    await setOverrides(overrides);
    await pruneModelPair(current, candidate);
    delete remaining[key];
    changed = true;
  }

  if (changed) bergamot.reset();
  const state = { checkedAt: Date.now(), available: remaining };
  await setUpdateState(state);
  return state;
}

async function updateLanguagePack(language: string): Promise<void> {
  const overrides = await currentOverrides();
  const pairs = modelPairsForLanguage(language, overrides);
  const installed = [] as BergamotModelPair[];
  for (const pair of pairs) if (await isModelPairCached(pair)) installed.push(pair);
  if (installed.length === 0) throw new Error("该语言包尚未下载");

  const latest = await fetchLatestPairs(installed.map((pair) => pair.key));
  const candidates: ModelCatalogOverrides = {};
  for (const pair of installed) {
    const candidate = latest.get(pair.key);
    if (candidate && isModelUpdate(pair, candidate)) candidates[pair.key] = candidate;
  }
  if (Object.keys(candidates).length === 0) {
    const state = await currentUpdateState();
    await setUpdateState({ checkedAt: Date.now(), available: state.available });
    return;
  }
  await applyUpdateCandidates(candidates, new Set(installed.map((pair) => pair.key)));
}

async function runScheduledModelUpdate(): Promise<void> {
  const settings = await loadSettings();
  if (settings.modelUpdatePolicy === "manual") return;
  try {
    const state = await checkModelUpdates();
    if (settings.modelUpdatePolicy === "auto" && Object.keys(state.available).length > 0) {
      await applyUpdateCandidates(state.available);
    }
  } catch (error) {
    console.warn("[PageLingo] Model update check failed", error);
  }
}

async function syncModelUpdateAlarm(): Promise<void> {
  const settings = await loadSettings();
  if (settings.modelUpdatePolicy === "manual") {
    await browser.alarms.clear(MODEL_UPDATE_ALARM);
    return;
  }
  await browser.alarms.create(MODEL_UPDATE_ALARM, {
    delayInMinutes: 15,
    periodInMinutes: MODEL_UPDATE_INTERVAL_MINUTES,
  });
}

async function maybeRunStartupUpdate(): Promise<void> {
  const [settings, state] = await Promise.all([loadSettings(), currentUpdateState()]);
  if (settings.modelUpdatePolicy === "manual") return;
  if (Date.now() - state.checkedAt < 24 * 60 * 60 * 1000) return;
  await runScheduledModelUpdate();
}

browser.runtime.onInstalled.addListener((details) => {
  void syncModelUpdateAlarm();
  if (details.reason === "install") void initializeFirstInstall();
});

browser.runtime.onStartup.addListener(() => {
  void syncModelUpdateAlarm();
  void maybeRunStartupUpdate();
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MODEL_UPDATE_ALARM) void runScheduledModelUpdate();
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.modelUpdatePolicy) return;
  void syncModelUpdateAlarm();
  if (changes.modelUpdatePolicy.newValue !== "manual") void runScheduledModelUpdate();
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.activeTranslationEngineId || changes.translationEngines) {
    translationEngineStatePromise = loadTranslationEngineState();
  }
});

void syncModelUpdateAlarm();
void currentUpdateState().then((state) => setUpdateState(state));
initializeImageTranslation();

browser.runtime.onMessage.addListener(async (message: RuntimeMessage, sender) => {
  const imageResponse = await handleImageRuntimeMessage(message, sender);
  if (imageResponse !== undefined) return imageResponse;

  if (message.type === "ping-backend") return { ok: true };

  if (message.type === "get-translation-performance") {
    return { ok: true, stats: bergamot.performanceStats() };
  }
  if (message.type === "reset-translation-performance") {
    bergamot.resetPerformanceStats();
    return { ok: true };
  }

  try {
    if (message.type === "translate-html") {
      const request = message.request;
      if (!request || typeof request.html !== "string") throw new Error("Invalid translation request");
      const sourceLanguage = asLanguage(request.sourceLanguage);
      const targetLanguage = asLanguage(request.targetLanguage);
      if (!sourceLanguage || !targetLanguage) throw new Error("Invalid translation languages");
      const terminology = parseTerminologyPayload(request.terminology);
      const engineState = await currentTranslationEngineState();
      if (engineState.activeEngineId === PAGELINGO_MT_ENGINE_ID) {
        const mtRequest = { html: request.html, sourceLanguage, targetLanguage, terminology };
        const mtResult = await keepEventPageAlive(pagelingoMt.translateHtmlChecked(mtRequest), "mt-translate");
        if (mtResult.accepted) return { ok: true, html: mtResult.html, engine: PAGELINGO_MT_ENGINE_ID };
        const overrides = await currentOverrides();
        const route = routeFor(sourceLanguage, targetLanguage, overrides);
        if (!route) throw new Error(mtResult.reason ?? "PageLingo MT rejected the translation");
        const html = await bergamot.translateHtml(request.html, route);
        return { ok: true, html, engine: LOCAL_TRANSLATION_ENGINE_ID, fallbackFrom: PAGELINGO_MT_ENGINE_ID, fallbackReason: mtResult.reason };
      }
      const external = await activeExternalEngine();
      if (external) {
        if (!await hasExternalTranslationConsent(Boolean(external.apiKey))) {
          throw new Error("外部翻译引擎的数据权限已被拒绝或撤销，请在设置中重新授权");
        }
        const html = await translateExternalSingleCached(external, { html: request.html, sourceLanguage, targetLanguage, terminology });
        return { ok: true, html };
      }
      const overrides = await currentOverrides();
      const route = routeFor(sourceLanguage, targetLanguage, overrides);
      if (!route) throw new Error(`当前本地模型不支持 ${languageLabel(sourceLanguage)} → ${languageLabel(targetLanguage)}`);
      const html = await bergamot.translateHtml(request.html, route);
      return { ok: true, html };
    }

    if (message.type === "translate-html-batch") {
      const requests = message.requests;
      if (!Array.isArray(requests) || requests.length === 0 || requests.length > 32) {
        throw new Error("Invalid translation batch");
      }
      const normalized = requests.map((request) => {
        if (!request || typeof request.html !== "string") throw new Error("Invalid translation request");
        const sourceLanguage = asLanguage(request.sourceLanguage);
        const targetLanguage = asLanguage(request.targetLanguage);
        if (!sourceLanguage || !targetLanguage) throw new Error("Invalid translation languages");
        const terminology = parseTerminologyPayload(request.terminology);
        return {
          html: request.html,
          sourceLanguage,
          targetLanguage,
          ...(terminology.length > 0 ? { terminology } : {}),
        };
      });
      const first = normalized[0]!;
      if (normalized.some((request) =>
        request.sourceLanguage !== first.sourceLanguage || request.targetLanguage !== first.targetLanguage
      )) {
        throw new Error("Translation batch must use one language route");
      }
      const batchEngineState = await currentTranslationEngineState();
      if (batchEngineState.activeEngineId === PAGELINGO_MT_ENGINE_ID) {
        return { ok: false, batchUnsupported: true, error: "PageLingo MT currently runs serial inference" };
      }
      const external = await activeExternalEngine();
      if (external) {
        if (!externalEngineSupportsBatch(external.type)) {
          return { ok: false, batchUnsupported: true, error: "Current external engine does not support batching" };
        }
        if (!await hasExternalTranslationConsent(Boolean(external.apiKey))) {
          throw new Error("外部翻译引擎的数据权限已被拒绝或撤销，请在设置中重新授权");
        }
        const htmls = await translateExternalBatchCached(external, normalized);
        return { ok: true, htmls };
      }
      const overrides = await currentOverrides();
      const route = routeFor(first.sourceLanguage, first.targetLanguage, overrides);
      if (!route) throw new Error(`当前本地模型不支持 ${languageLabel(first.sourceLanguage)} → ${languageLabel(first.targetLanguage)}`);
      const htmls = await bergamot.translateHtmlBatch(normalized.map((request) => request.html), route);
      return { ok: true, htmls };
    }

    if (message.type === "can-translate") {
      const sourceLanguage = asLanguage(message.sourceLanguage);
      const targetLanguage = asLanguage(message.targetLanguage);
      const engineState = await currentTranslationEngineState();
      if (engineState.activeEngineId === PAGELINGO_MT_ENGINE_ID) {
        const mt = await pagelingoMt.status();
        return {
          ok: true,
          supported: Boolean(
            mt.installed &&
            sourceLanguage &&
            targetLanguage &&
            sourceLanguage !== targetLanguage &&
            mtRouteSupported({ html: "", sourceLanguage, targetLanguage })
          ),
        };
      }
      const external = await activeExternalEngine();
      const externalReady = external
        ? await hasExternalTranslationConsent(Boolean(external.apiKey))
        : false;
      const overrides = external ? null : await currentOverrides();
      return {
        ok: true,
        supported: Boolean(
          sourceLanguage &&
          targetLanguage &&
          sourceLanguage !== targetLanguage &&
          (external ? externalReady : (overrides && routeFor(sourceLanguage, targetLanguage, overrides)))
        ),
      };
    }

    if (message.type === "is-translation-ready") {
      const sourceLanguage = asLanguage(message.sourceLanguage);
      const targetLanguage = asLanguage(message.targetLanguage);
      const engineState = await currentTranslationEngineState();
      if (engineState.activeEngineId === PAGELINGO_MT_ENGINE_ID) {
        const mt = await pagelingoMt.status();
        return {
          ok: true,
          ready: Boolean(
            mt.installed &&
            sourceLanguage &&
            targetLanguage &&
            sourceLanguage !== targetLanguage &&
            mtRouteSupported({ html: "", sourceLanguage, targetLanguage })
          ),
        };
      }
      const external = await activeExternalEngine();
      const externalReady = external
        ? await hasExternalTranslationConsent(Boolean(external.apiKey))
        : false;
      return {
        ok: true,
        ready: Boolean(
          sourceLanguage &&
          targetLanguage &&
          sourceLanguage !== targetLanguage &&
          (external ? externalReady : await isTranslationRouteCached(sourceLanguage, targetLanguage))
        ),
      };
    }

    if (message.type === "get-translation-engines") {
      return { ok: true, state: await translationEngineStateForUi() };
    }

    if (message.type === "save-translation-engine") {
      await saveTranslationEngine(message.config);
      await refreshTranslationEngineState();
      externalCache.clearMemory();
      resetThinkingModeCache();
      return { ok: true, state: await translationEngineStateForUi() };
    }

    if (message.type === "delete-translation-engine") {
      if (typeof message.id !== "string") throw new Error("Invalid engine id");
      await deleteTranslationEngine(message.id);
      await refreshTranslationEngineState();
      externalCache.clearMemory();
      resetThinkingModeCache();
      return { ok: true, state: await translationEngineStateForUi() };
    }

    if (message.type === "set-translation-engine-enabled") {
      if (typeof message.id !== "string" || typeof message.enabled !== "boolean") throw new Error("Invalid engine state");
      await setTranslationEngineEnabled(message.id, message.enabled);
      await refreshTranslationEngineState();
      externalCache.clearMemory();
      return { ok: true, state: await translationEngineStateForUi() };
    }

    if (message.type === "set-active-translation-engine") {
      if (typeof message.id !== "string") throw new Error("Invalid engine id");
      if (message.id === PAGELINGO_MT_ENGINE_ID) {
        const mt = await pagelingoMt.status();
        if (!mt.installed) throw new Error("请先下载 PageLingo MT 模型");
      }
      await setActiveTranslationEngine(message.id);
      await refreshTranslationEngineState();
      return { ok: true, state: await translationEngineStateForUi() };
    }

    if (message.type === "list-translation-models") {
      const config = normalizeTranslationEngineConfig(message.config);
      if (!config) throw new Error("翻译引擎配置无效");
      const models = await listExternalTranslationModels(config);
      return { ok: true, models };
    }

    if (message.type === "test-translation-engine") {
      const config = normalizeTranslationEngineConfig(message.config);
      if (!config) throw new Error("翻译引擎配置无效");
      if (!await hasExternalTranslationConsent(Boolean(config.apiKey))) {
        throw new Error("未授权向外部翻译服务发送数据");
      }
      const html = await translateWithExternalEngine(config, {
        html: "<strong>Hello</strong> world",
        sourceLanguage: "en",
        targetLanguage: "zh-Hans",
      });
      return { ok: true, preview: html };
    }

    if (message.type === "get-pagelingo-mt-status") {
      return { ok: true, mt: await pagelingoMt.status() };
    }

    if (message.type === "download-pagelingo-mt") {
      return { ok: true, mt: await keepEventPageAlive(pagelingoMt.download(), "mt-download") };
    }

    if (message.type === "delete-pagelingo-mt") {
      const state = await currentTranslationEngineState();
      if (state.activeEngineId === PAGELINGO_MT_ENGINE_ID) {
        await setActiveTranslationEngine(LOCAL_TRANSLATION_ENGINE_ID);
        await refreshTranslationEngineState();
      }
      return { ok: true, mt: await pagelingoMt.remove(), state: await translationEngineStateForUi() };
    }

    if (message.type === "get-language-catalog") {
      return { ok: true, catalog: await languageCatalog() };
    }

    if (message.type === "download-language-pack") {
      const language = asLanguage(message.language);
      if (!language || language === "en") throw new Error("Invalid language pack");
      const overrides = await currentOverrides();
      const pairs = modelPairsForLanguage(language, overrides);
      if (pairs.length === 0) throw new Error("No stable Firefox model is available for this language");
      for (const pair of pairs) await installLatestPair(pair);
      return { ok: true, pack: await packInfo(language) };
    }

    if (message.type === "delete-language-pack") {
      const language = asLanguage(message.language);
      if (!language || language === "en") throw new Error("Invalid language pack");
      const overrides = await currentOverrides();
      for (const pair of modelPairsForLanguage(language, overrides)) await deleteModelPair(pair);
      bergamot.reset();
      return { ok: true, pack: await packInfo(language) };
    }

    if (message.type === "check-model-updates") {
      const state = await checkModelUpdates();
      return { ok: true, state, catalog: await languageCatalog() };
    }

    if (message.type === "update-language-pack") {
      const language = asLanguage(message.language);
      if (!language || language === "en") throw new Error("Invalid language pack");
      await updateLanguagePack(language);
      return { ok: true, pack: await packInfo(language), catalog: await languageCatalog() };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  return undefined;
});
