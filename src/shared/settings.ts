export type DisplayMode = "translation" | "bilingual";
export type ModelUpdatePolicy = "auto" | "notify" | "manual";
export type ManualSourceLanguage = "auto" | string;
export type SupportedSourceLanguage = string;
export type SupportedTargetLanguage = string;

export interface PageLingoSettings {
  displayMode: DisplayMode;
  autoTranslateEnabled: boolean;
  targetLanguage: string;
  neverTranslateSites: string[];
  alwaysTranslateSites: string[];
  neverTranslateLanguages: string[];
  alwaysTranslateLanguages: string[];
  modelUpdatePolicy: ModelUpdatePolicy;
  imageTranslationEnabled: boolean;
}

export const DEFAULT_SETTINGS: PageLingoSettings = {
  displayMode: "bilingual",
  autoTranslateEnabled: false,
  targetLanguage: "zh-Hans",
  neverTranslateSites: [],
  alwaysTranslateSites: [],
  neverTranslateLanguages: [],
  alwaysTranslateLanguages: [],
  modelUpdatePolicy: "auto",
  imageTranslationEnabled: false,
};

const LABEL_OVERRIDES: Record<string, string> = {
  en: "English",
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
  nb: "挪威语（书面语）",
};

export function languageLabel(code: string): string {
  if (LABEL_OVERRIDES[code]) return LABEL_OVERRIDES[code];
  try {
    return new Intl.DisplayNames(["zh-CN"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function normalizeDisplayMode(value: unknown): DisplayMode {
  return value === "translation" ? "translation" : "bilingual";
}

export function normalizeModelUpdatePolicy(value: unknown): ModelUpdatePolicy {
  return value === "notify" || value === "manual" ? value : "auto";
}

export function normalizeDetectedLanguage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase().replaceAll("_", "-");
  if (lower === "zh" || ["zh-cn", "zh-sg", "zh-hans"].includes(lower)) return "zh-Hans";
  if (["zh-tw", "zh-hk", "zh-mo", "zh-hant"].includes(lower)) return "zh-Hant";
  if (lower === "no" || lower.startsWith("no-")) return "nb";
  if (lower === "iw" || lower.startsWith("iw-")) return "he";
  return lower.split("-")[0] || null;
}

export function normalizeSourceLanguage(value: unknown): string {
  return normalizeDetectedLanguage(value) ?? "en";
}

export function normalizeTargetLanguage(value: unknown): string {
  return normalizeDetectedLanguage(value) ?? "zh-Hans";
}

export function normalizeSitePattern(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    const host = url.hostname.replace(/^www\./, "").replace(/\.$/, "");
    if (!host || !/^[a-z0-9.-]+$/.test(host)) return null;
    return host;
  } catch {
    return null;
  }
}

export function normalizeExcludedSites(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map(normalizeSitePattern)
    .filter((item): item is string => Boolean(item));
  return Array.from(new Set(normalized)).sort();
}

export function normalizeLanguageList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .map(normalizeDetectedLanguage)
    .filter((item): item is string => Boolean(item));
  return Array.from(new Set(normalized)).sort();
}

export function isSiteListed(hostname: string, sites: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return sites.some((site) => host === site || host.endsWith(`.${site}`));
}

export async function loadSettings(): Promise<PageLingoSettings> {
  const stored = await browser.storage.local.get();
  const legacyExcludedSites = normalizeExcludedSites(stored.excludedSites);
  return {
    displayMode: normalizeDisplayMode(stored.displayMode),
    autoTranslateEnabled: stored.autoTranslateEnabled === true,
    targetLanguage: normalizeTargetLanguage(stored.targetLanguage ?? DEFAULT_SETTINGS.targetLanguage),
    neverTranslateSites: Array.isArray(stored.neverTranslateSites)
      ? normalizeExcludedSites(stored.neverTranslateSites)
      : legacyExcludedSites,
    alwaysTranslateSites: normalizeExcludedSites(stored.alwaysTranslateSites),
    neverTranslateLanguages: normalizeLanguageList(stored.neverTranslateLanguages),
    alwaysTranslateLanguages: normalizeLanguageList(stored.alwaysTranslateLanguages),
    modelUpdatePolicy: normalizeModelUpdatePolicy(stored.modelUpdatePolicy),
    imageTranslationEnabled: stored.imageTranslationEnabled === true,
  };
}

export async function saveDisplayMode(displayMode: DisplayMode): Promise<void> {
  await browser.storage.local.set({ displayMode });
}

export async function saveAutoTranslateEnabled(autoTranslateEnabled: boolean): Promise<void> {
  await browser.storage.local.set({ autoTranslateEnabled });
}

export async function saveTargetLanguage(targetLanguage: string): Promise<void> {
  await browser.storage.local.set({ targetLanguage: normalizeTargetLanguage(targetLanguage) });
}

export async function saveSiteRules(
  neverTranslateSites: readonly string[],
  alwaysTranslateSites: readonly string[],
): Promise<void> {
  await browser.storage.local.set({
    neverTranslateSites: normalizeExcludedSites(neverTranslateSites),
    alwaysTranslateSites: normalizeExcludedSites(alwaysTranslateSites),
  });
}

export async function saveLanguageRules(
  neverTranslateLanguages: readonly string[],
  alwaysTranslateLanguages: readonly string[],
): Promise<void> {
  await browser.storage.local.set({
    neverTranslateLanguages: normalizeLanguageList(neverTranslateLanguages),
    alwaysTranslateLanguages: normalizeLanguageList(alwaysTranslateLanguages),
  });
}

export async function saveModelUpdatePolicy(modelUpdatePolicy: ModelUpdatePolicy): Promise<void> {
  await browser.storage.local.set({ modelUpdatePolicy: normalizeModelUpdatePolicy(modelUpdatePolicy) });
}

export async function saveImageTranslationEnabled(imageTranslationEnabled: boolean): Promise<void> {
  await browser.storage.local.set({ imageTranslationEnabled });
}
