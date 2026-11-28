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
import { parseHtmlBody } from "./shared/html-parser";
import { isLoopbackTranslationEndpoint } from "./shared/network-endpoint";
import {
  externalBatchSize,
  isFatalExternalError,
  listExternalTranslationModels,
  translateExternalBatch,
  translateWithExternalEngine,
  type ExternalTranslationRequest,
} from "./providers/external-translation";
import { ExternalTranslationCache, externalTranslationCacheKey } from "./providers/external-translation-cache";
import {
  LOCAL_TRANSLATION_ENGINE_ID,
  builtinFreeEngineConfig,
  deleteTranslationEngine,
  isLlmEngineType,
  loadTranslationEngineState,
  normalizeTranslationEngineConfig,
  saveTranslationEngine,
  setActiveTranslationEngine,
  setTranslationEngineEnabled,
  type RuntimeExternalEngineConfig,
} from "./shared/translation-engine-settings";
import { keepEventPageAlive } from "./shared/event-page-keepalive";
import { fetchBoundedBytes, resolveSubtitleFetchPolicy } from "./shared/bounded-fetch";

const bergamot = new BergamotClient();
const externalCache = new ExternalTranslationCache();
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
    context?: unknown;
    bypassCache?: unknown;
    engineId?: unknown;
  };
  requests?: Array<{
    html?: unknown;
    sourceLanguage?: unknown;
    targetLanguage?: unknown;
    terminology?: unknown;
    bypassCache?: unknown;
    engineId?: unknown;
  }>;
  sourceLanguage?: unknown;
  targetLanguage?: unknown;
  language?: unknown;
  config?: unknown;
  id?: unknown;
  enabled?: unknown;
  url?: unknown;
  credentials?: unknown;
}

function asLanguage(value: unknown): string | null {
  return normalizeDetectedLanguage(value);
}

interface ParsedTranslationRequest extends ExternalTranslationRequest {
  bypassCache: boolean;
  engineId?: string;
}

function parseTranslationRequest(request: RuntimeMessage["request"]): ParsedTranslationRequest {
  if (!request || typeof request.html !== "string") throw new Error("Invalid translation request");
  const sourceLanguage = asLanguage(request.sourceLanguage);
  const targetLanguage = asLanguage(request.targetLanguage);
  if (!sourceLanguage || !targetLanguage) throw new Error("Invalid translation languages");
  const terminology = Array.isArray(request.terminology)
    ? request.terminology
        .filter((entry): entry is { source: string; target: string; mode: "protect" | "replace" } =>
          Boolean(
            entry &&
            typeof entry === "object" &&
            typeof (entry as { source?: unknown }).source === "string" &&
            typeof (entry as { target?: unknown }).target === "string" &&
            ((entry as { mode?: unknown }).mode === "protect" || (entry as { mode?: unknown }).mode === "replace")
          )
        )
        .map((entry) => ({ source: entry.source, target: entry.target, mode: entry.mode }))
    : [];
  const rawEngineId = typeof request.engineId === "string" ? request.engineId.trim() : "";
  return {
    html: request.html,
    sourceLanguage,
    targetLanguage,
    terminology,
    bypassCache: request.bypassCache === true,
    ...(rawEngineId && rawEngineId !== "follow" ? { engineId: rawEngineId } : {}),
  };
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

async function externalEngineForId(engineId?: string): Promise<RuntimeExternalEngineConfig | null> {
  const state = await currentTranslationEngineState();
  const resolvedId = engineId && engineId !== "follow" ? engineId : state.activeEngineId;
  if (resolvedId === LOCAL_TRANSLATION_ENGINE_ID) return null;
  const builtinFree = builtinFreeEngineConfig(resolvedId);
  if (builtinFree) return builtinFree;
  const matched = state.engines.find((engine) => engine.id === resolvedId && engine.enabled);
  if (matched) return matched;
  // If a dedicated override engine was deleted/disabled, fall back cleanly to active engine.
  if (engineId && engineId !== "follow" && state.activeEngineId !== LOCAL_TRANSLATION_ENGINE_ID) {
    return builtinFreeEngineConfig(state.activeEngineId)
      ?? state.engines.find((engine) => engine.id === state.activeEngineId && engine.enabled)
      ?? null;
  }
  return null;
}

async function activeExternalEngine(): Promise<RuntimeExternalEngineConfig | null> {
  return externalEngineForId();
}

async function translateExternalSingleCached(
  external: RuntimeExternalEngineConfig,
  request: ParsedTranslationRequest,
  options: { noCache?: boolean } = {},
): Promise<string> {
  if (options.noCache) {
    return keepEventPageAlive(translateWithExternalEngine(external, request), "external-translate");
  }
  const cacheable = externalCache.isCacheable(request.html);
  const key = cacheable
    ? externalTranslationCacheKey(external, request.sourceLanguage, request.targetLanguage, request.html, request.terminology)
    : "";
  if (key && !request.bypassCache) {
    const cached = await externalCache.get(key);
    if (cached !== undefined) return cached;
    const inFlight = externalCache.getInFlight(key);
    if (inFlight) return inFlight;
  }
  const promise = keepEventPageAlive(translateWithExternalEngine(external, request), "external-translate")
    .then((html) => {
      if (key) externalCache.set(key, html);
      return html;
    });
  return key && !request.bypassCache ? externalCache.trackInFlight(key, promise) : promise;
}

async function translateExternalBatchCached(
  external: RuntimeExternalEngineConfig,
  requests: ParsedTranslationRequest[],
  options: { noCache?: boolean } = {},
): Promise<Array<string | null>> {
  const noCache = options.noCache === true;
  const keys = requests.map((request) =>
    externalCache.isCacheable(request.html)
      ? externalTranslationCacheKey(external, request.sourceLanguage, request.targetLanguage, request.html, request.terminology)
      : "",
  );
  const lookupKeys = noCache
    ? []
    : keys.filter((key, index) => Boolean(key) && !requests[index]?.bypassCache);
  const cacheHits = lookupKeys.length > 0 ? await externalCache.getMany(lookupKeys) : new Map<string, string>();
  const results: Array<string | null> = new Array(requests.length).fill(null);
  const awaitedInFlight: Array<Promise<void>> = [];

  // Deduplicate misses within the same batch so identical nav/UI labels are sent once.
  const missGroups = new Map<string, { request: ExternalTranslationRequest; indices: number[] }>();
  const uncacheableMisses: Array<{ request: ExternalTranslationRequest; index: number }> = [];

  for (let index = 0; index < requests.length; index += 1) {
    const req = requests[index]!;
    const key = keys[index]!;
    if (key) {
      if (!noCache && !req.bypassCache) {
        const hit = cacheHits.get(key);
        if (hit !== undefined) {
          results[index] = hit;
          continue;
        }
        const inFlight = externalCache.getInFlight(key);
        if (inFlight) {
          awaitedInFlight.push(inFlight.then((html) => { results[index] = html; }, () => {}));
          continue;
        }
      }
      const existing = missGroups.get(key);
      if (existing) {
        existing.indices.push(index);
      } else {
        missGroups.set(key, { request: req, indices: [index] });
      }
    } else {
      uncacheableMisses.push({ request: req, index });
    }
  }

  const dedupedKeys = Array.from(missGroups.keys());
  const toTranslate: ExternalTranslationRequest[] = [
    ...dedupedKeys.map((key) => missGroups.get(key)!.request),
    ...uncacheableMisses.map((item) => item.request),
  ];

  if (toTranslate.length > 0) {
    const deferredResolvers = new Map<string, { resolve: (html: string) => void; reject: (error: Error) => void }>();
    if (!noCache) {
      for (const key of dedupedKeys) {
        let resolve!: (html: string) => void;
        let reject!: (error: Error) => void;
        const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
        deferredResolvers.set(key, { resolve, reject });
        externalCache.trackInFlight(key, promise);
        // Avoid unhandled rejection warnings if no external waiter attaches.
        void promise.catch(() => {});
      }
    }

    try {
      const batchResults = toTranslate.length === 1
        ? [await keepEventPageAlive(
            translateWithExternalEngine(external, toTranslate[0]!),
            "external-batch",
          ).catch((error) => {
            if (isFatalExternalError(error)) throw error;
            return null;
          })]
        : await keepEventPageAlive(translateExternalBatch(external, toTranslate), "external-batch");

      for (let i = 0; i < dedupedKeys.length; i += 1) {
        const key = dedupedKeys[i]!;
        const html = batchResults[i] ?? null;
        const group = missGroups.get(key)!;
        const deferred = deferredResolvers.get(key);
        if (typeof html === "string") {
          if (!noCache) externalCache.set(key, html);
          for (const index of group.indices) results[index] = html;
          deferred?.resolve(html);
        } else {
          deferred?.reject(new Error("Batch item failed validation"));
        }
      }

      for (let i = 0; i < uncacheableMisses.length; i += 1) {
        const html = batchResults[dedupedKeys.length + i] ?? null;
        results[uncacheableMisses[i]!.index] = html;
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const deferred of deferredResolvers.values()) deferred.reject(failure);
      if (isFatalExternalError(error) || results.every((item) => item === null)) {
        throw error;
      }
    }
  }

  if (awaitedInFlight.length > 0) await Promise.all(awaitedInFlight);
  return results;
}

async function translationEngineStateForUi() {
  const state = await currentTranslationEngineState();
  const activeExternal = await activeExternalEngine();
  const batchSize = activeExternal ? externalBatchSize(activeExternal) : 24;
  const isLlm = Boolean(activeExternal && isLlmEngineType(activeExternal.type));
  const isLoopback = Boolean(activeExternal && activeExternal.baseUrl && isLoopbackTranslationEndpoint(activeExternal.baseUrl));
  const batchHtmlLimit = !activeExternal
    ? 24_000
    : activeExternal.type === "google-free"
      ? 6_000
      : activeExternal.type === "microsoft-free"
        ? 8_000
        : isLlm
          ? 4_800
          : 12_000;
  return {
    activeEngineId: state.activeEngineId,
    batchSize,
    concurrentSegments: activeExternal
      ? (activeExternal.type === "google-free" ? 24 : batchSize > 1 ? Math.min(batchSize * 3, 32) : 8)
      : batchSize,
    batchHtmlLimit,
    firstVisibleSingles: activeExternal?.type === "opencode-go" && batchSize > 1 ? 2 : 0,
    lazyOffscreen: true,
    structuralSplittingSafe: state.activeEngineId === LOCAL_TRANSLATION_ENGINE_ID || isLoopback,
    // Every backend returns text for an application-owned template. Provider
    // markup never replaces source nodes or supplies event handlers/styles.
    prefersWholeSentenceHtml: true,
    engines: state.engines.map((engine) => ({
      id: engine.id,
      name: engine.name,
      type: engine.type,
      enabled: engine.enabled,
      model: engine.model,
      hasApiKey: Boolean(engine.apiKey),
      disableThinking: engine.disableThinking,
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
  const imageTask = handleImageRuntimeMessage(message, sender);
  const busyImageTask = message.type === "recognize-image"
    || message.type === "recognize-pdf-page"
    || message.type === "download-image-ocr-models";
  const imageResponse = await (busyImageTask ? keepEventPageAlive(imageTask, "image-ocr") : imageTask);
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
    const isIncognito = sender.tab?.incognito === true;

    if (message.type === "translate-html") {
      const request = parseTranslationRequest(message.request);
      const external = await externalEngineForId(request.engineId);
      if (external) {
        if (!await hasExternalTranslationConsent(Boolean(external.apiKey))) {
          throw new Error("外部翻译引擎的数据权限已被拒绝或撤销，请在设置中重新授权");
        }
        const html = await translateExternalSingleCached(external, request, { noCache: isIncognito });
        return { ok: true, html };
      }
      const overrides = await currentOverrides();
      const route = routeFor(request.sourceLanguage, request.targetLanguage, overrides);
      if (!route) throw new Error(`当前本地模型不支持 ${languageLabel(request.sourceLanguage)} → ${languageLabel(request.targetLanguage)}`);
      const html = await bergamot.translateHtml(request.html, route, {
        bypassCache: request.bypassCache,
        noCache: isIncognito,
      });
      return { ok: true, html };
    }

    if (message.type === "translate-html-batch") {
      const requests = message.requests;
      if (!Array.isArray(requests) || requests.length === 0 || requests.length > 32) {
        throw new Error("Invalid translation batch");
      }
      const normalized = requests.map(parseTranslationRequest);
      const first = normalized[0]!;
      if (normalized.some((request) =>
        request.sourceLanguage !== first.sourceLanguage
        || request.targetLanguage !== first.targetLanguage
        || request.engineId !== first.engineId
      )) {
        throw new Error("Translation batch must use one language route and engine");
      }
      const external = await externalEngineForId(first.engineId);
      if (external) {
        const size = externalBatchSize(external);
        if (size < 2) return { ok: false, batchUnsupported: true };
        if (!await hasExternalTranslationConsent(Boolean(external.apiKey))) {
          return { ok: false, retrySingles: false, error: "外部翻译引擎的数据权限已被拒绝或撤销，请在设置中重新授权" };
        }
        try {
          const htmls: Array<string | null> = [];
          for (let offset = 0; offset < normalized.length; offset += size) {
            const slice = normalized.slice(offset, offset + size);
            const translatedSlice = await translateExternalBatchCached(external, slice, { noCache: isIncognito });
            htmls.push(...translatedSlice);
          }
          return { ok: true, htmls };
        } catch (error) {
          return {
            ok: false,
            retrySingles: !isFatalExternalError(error),
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      const overrides = await currentOverrides();
      const route = routeFor(first.sourceLanguage, first.targetLanguage, overrides);
      if (!route) throw new Error(`当前本地模型不支持 ${languageLabel(first.sourceLanguage)} → ${languageLabel(first.targetLanguage)}`);
      const bypassCache = normalized.some((request) => request.bypassCache);
      const htmls = await bergamot.translateHtmlBatch(
        normalized.map((request) => request.html),
        route,
        { bypassCache, noCache: isIncognito },
      );
      return { ok: true, htmls };
    }

    if (message.type === "fetch-subtitle-track") {
      const policy = resolveSubtitleFetchPolicy(message.url, message.credentials, isIncognito);
      const fetched = await fetchBoundedBytes(policy.url, {
        maxBytes: 5 * 1024 * 1024,
        timeoutMs: 15_000,
        credentials: policy.credentials,
        tooLargeMessage: "字幕文件过大",
        timeoutMessage: "获取字幕超时，请重试",
        httpErrorPrefix: "获取字幕失败",
      });
      const text = new TextDecoder("utf-8").decode(fetched.bytes);
      return { ok: true, text, contentType: fetched.contentType };
    }

    if (message.type === "get-translation-cache-stats") {
      const externalCount = await externalCache.count();
      const localCount = bergamot.cacheSize();
      return { ok: true, externalCount, localCount, totalCount: externalCount + localCount };
    }

    if (message.type === "clear-translation-cache") {
      await externalCache.clearAll();
      bergamot.clearCache();
      return { ok: true, externalCount: 0, localCount: 0, totalCount: 0 };
    }

    if (message.type === "can-translate") {
      const sourceLanguage = asLanguage(message.sourceLanguage);
      const targetLanguage = asLanguage(message.targetLanguage);
      const engineId = typeof message.id === "string" ? message.id : undefined;
      const external = await externalEngineForId(engineId);
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
      return { ok: true, state: await translationEngineStateForUi() };
    }

    if (message.type === "delete-translation-engine") {
      if (typeof message.id !== "string") throw new Error("Invalid engine id");
      await deleteTranslationEngine(message.id);
      await refreshTranslationEngineState();
      return { ok: true, state: await translationEngineStateForUi() };
    }

    if (message.type === "set-translation-engine-enabled") {
      if (typeof message.id !== "string" || typeof message.enabled !== "boolean") throw new Error("Invalid engine state");
      await setTranslationEngineEnabled(message.id, message.enabled);
      await refreshTranslationEngineState();
      return { ok: true, state: await translationEngineStateForUi() };
    }

    if (message.type === "set-active-translation-engine") {
      if (typeof message.id !== "string") throw new Error("Invalid engine id");
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
      const html = await keepEventPageAlive(translateWithExternalEngine(config, {
        html: "<strong>Hello</strong> world",
        sourceLanguage: "en",
        targetLanguage: "zh-Hans",
      }), "external-test");
      return { ok: true, preview: parseHtmlBody(html).textContent?.trim() };
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
      await keepEventPageAlive((async () => {
        for (const pair of pairs) if (!await isModelPairCached(pair)) await installLatestPair(pair);
      })(), "download-language-pack");
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
      await keepEventPageAlive(updateLanguagePack(language), "update-language-pack");
      return { ok: true, pack: await packInfo(language), catalog: await languageCatalog() };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  return undefined;
});
