export const LOCAL_TRANSLATION_ENGINE_ID = "firefox-local";

export type ExternalTranslationEngineType =
  | "microsoft"
  | "google"
  | "gemini"
  | "openrouter"
  | "openai-compatible"
  | "libretranslate"
  | "custom-rest";

export interface TranslationEngineConfig {
  id: string;
  name: string;
  type: ExternalTranslationEngineType;
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  region: string;
  prompt: string;
  headersJson: string;
  bodyJson: string;
  responsePath: string;
}

export interface TranslationEngineState {
  activeEngineId: string;
  engines: TranslationEngineConfig[];
}

const ENGINE_TYPES = new Set<ExternalTranslationEngineType>([
  "microsoft",
  "google",
  "gemini",
  "openrouter",
  "openai-compatible",
  "libretranslate",
  "custom-rest",
]);

function cleanString(value: unknown, maxLength = 4096): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanId(value: unknown): string {
  const id = cleanString(value, 96).replace(/[^a-zA-Z0-9_-]/g, "");
  return id || `engine-${crypto.randomUUID()}`;
}

function cleanUrl(value: unknown): string {
  const raw = cleanString(value, 2048).replace(/\/+$/, "");
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const loopback = host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1";
    if (url.username || url.password) return "";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return "";
    return url.href.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function normalizeTranslationEngineConfig(value: unknown): TranslationEngineConfig | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<TranslationEngineConfig>;
  if (!ENGINE_TYPES.has(raw.type as ExternalTranslationEngineType)) return null;
  const type = raw.type as ExternalTranslationEngineType;
  const name = cleanString(raw.name, 120);
  if (!name) return null;
  return {
    id: cleanId(raw.id),
    name,
    type,
    enabled: raw.enabled !== false,
    baseUrl: cleanUrl(raw.baseUrl),
    apiKey: cleanString(raw.apiKey, 8192),
    model: cleanString(raw.model, 240),
    region: cleanString(raw.region, 160),
    prompt: cleanString(raw.prompt, 6000),
    headersJson: cleanString(raw.headersJson, 6000),
    bodyJson: cleanString(raw.bodyJson, 12000),
    responsePath: cleanString(raw.responsePath, 500),
  };
}

export async function loadTranslationEngineState(): Promise<TranslationEngineState> {
  const stored = await browser.storage.local.get(["activeTranslationEngineId", "translationEngines"]);
  const engines = Array.isArray(stored.translationEngines)
    ? stored.translationEngines
        .map(normalizeTranslationEngineConfig)
        .filter((engine): engine is TranslationEngineConfig => Boolean(engine))
    : [];
  const requested = cleanString(stored.activeTranslationEngineId, 96) || LOCAL_TRANSLATION_ENGINE_ID;
  const active = requested === LOCAL_TRANSLATION_ENGINE_ID || engines.some((engine) => engine.id === requested && engine.enabled)
    ? requested
    : LOCAL_TRANSLATION_ENGINE_ID;
  return { activeEngineId: active, engines };
}

export async function saveTranslationEngine(config: unknown): Promise<TranslationEngineState> {
  const normalized = normalizeTranslationEngineConfig(config);
  if (!normalized) throw new Error("翻译引擎配置无效");
  const state = await loadTranslationEngineState();
  const engines = state.engines.some((engine) => engine.id === normalized.id)
    ? state.engines.map((engine) => engine.id === normalized.id ? normalized : engine)
    : [...state.engines, normalized];
  await browser.storage.local.set({ translationEngines: engines });
  return { ...state, engines };
}

export async function deleteTranslationEngine(id: string): Promise<TranslationEngineState> {
  const state = await loadTranslationEngineState();
  const engines = state.engines.filter((engine) => engine.id !== id);
  const activeEngineId = state.activeEngineId === id ? LOCAL_TRANSLATION_ENGINE_ID : state.activeEngineId;
  await browser.storage.local.set({ translationEngines: engines, activeTranslationEngineId: activeEngineId });
  return { activeEngineId, engines };
}

export async function setTranslationEngineEnabled(id: string, enabled: boolean): Promise<TranslationEngineState> {
  const state = await loadTranslationEngineState();
  const engines = state.engines.map((engine) => engine.id === id ? { ...engine, enabled } : engine);
  if (!engines.some((engine) => engine.id === id)) throw new Error("找不到翻译引擎");
  const activeEngineId = !enabled && state.activeEngineId === id ? LOCAL_TRANSLATION_ENGINE_ID : state.activeEngineId;
  await browser.storage.local.set({ translationEngines: engines, activeTranslationEngineId: activeEngineId });
  return { activeEngineId, engines };
}

export async function setActiveTranslationEngine(id: string): Promise<TranslationEngineState> {
  const state = await loadTranslationEngineState();
  if (id !== LOCAL_TRANSLATION_ENGINE_ID && !state.engines.some((engine) => engine.id === id && engine.enabled)) {
    throw new Error("该翻译引擎未启用或不存在");
  }
  await browser.storage.local.set({ activeTranslationEngineId: id });
  return { ...state, activeEngineId: id };
}
