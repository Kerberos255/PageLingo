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
import { languageLabel, loadSettings, normalizeDetectedLanguage } from "./shared/settings";

const bergamot = new BergamotClient();
const MODEL_UPDATE_ALARM = "pagelingo-model-updates";
const MODEL_UPDATE_INTERVAL_MINUTES = 24 * 60;
let overridesPromise = loadModelOverrides();
let updateStatePromise = loadModelUpdateState();
let updateRun: Promise<ModelUpdateState> | null = null;

interface RuntimeMessage {
  type?: string;
  request?: {
    html?: unknown;
    sourceLanguage?: unknown;
    targetLanguage?: unknown;
  };
  sourceLanguage?: unknown;
  targetLanguage?: unknown;
  language?: unknown;
}

function asLanguage(value: unknown): string | null {
  return normalizeDetectedLanguage(value);
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

void syncModelUpdateAlarm();
void currentUpdateState().then((state) => setUpdateState(state));

browser.runtime.onMessage.addListener(async (message: RuntimeMessage) => {
  if (message.type === "ping-backend") return { ok: true };

  try {
    if (message.type === "translate-html") {
      const request = message.request;
      if (!request || typeof request.html !== "string") throw new Error("Invalid translation request");
      const sourceLanguage = asLanguage(request.sourceLanguage);
      const targetLanguage = asLanguage(request.targetLanguage);
      if (!sourceLanguage || !targetLanguage) throw new Error("Invalid translation languages");
      const overrides = await currentOverrides();
      const route = routeFor(sourceLanguage, targetLanguage, overrides);
      if (!route) throw new Error(`当前本地模型不支持 ${languageLabel(sourceLanguage)} → ${languageLabel(targetLanguage)}`);
      const html = await bergamot.translateHtml(request.html, route);
      return { ok: true, html };
    }

    if (message.type === "can-translate") {
      const sourceLanguage = asLanguage(message.sourceLanguage);
      const targetLanguage = asLanguage(message.targetLanguage);
      const overrides = await currentOverrides();
      return {
        ok: true,
        supported: Boolean(sourceLanguage && targetLanguage && routeFor(sourceLanguage, targetLanguage, overrides)),
      };
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
