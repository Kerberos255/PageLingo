export type DisplayMode = "translation" | "bilingual";
export type ModelUpdatePolicy = "auto" | "notify" | "manual";
export type ManualSourceLanguage = "auto" | string;
export type SupportedSourceLanguage = string;
export type SupportedTargetLanguage = string;

export interface PageLingoSettings {
  displayMode: DisplayMode;
  autoTranslateEnabled: boolean;
  autoSourceLanguage: string;
  targetLanguage: string;
  excludedSites: string[];
  modelUpdatePolicy: ModelUpdatePolicy;
}

export const DEFAULT_SETTINGS: PageLingoSettings = {
  displayMode: "bilingual",
  autoTranslateEnabled: false,
  autoSourceLanguage: "en",
  targetLanguage: "zh-Hans",
  excludedSites: [],
  modelUpdatePolicy: "auto",
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

export function isSiteExcluded(hostname: string, excludedSites: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return excludedSites.some((site) => host === site || host.endsWith(`.${site}`));
}

export async function loadSettings(): Promise<PageLingoSettings> {
  const stored = await browser.storage.local.get(DEFAULT_SETTINGS);
  return {
    displayMode: normalizeDisplayMode(stored.displayMode),
    autoTranslateEnabled: stored.autoTranslateEnabled === true,
    autoSourceLanguage: normalizeSourceLanguage(stored.autoSourceLanguage),
    targetLanguage: normalizeTargetLanguage(stored.targetLanguage),
    excludedSites: normalizeExcludedSites(stored.excludedSites),
    modelUpdatePolicy: normalizeModelUpdatePolicy(stored.modelUpdatePolicy),
  };
}

export async function saveDisplayMode(displayMode: DisplayMode): Promise<void> {
  await browser.storage.local.set({ displayMode });
}

export async function saveAutoTranslateEnabled(autoTranslateEnabled: boolean): Promise<void> {
  await browser.storage.local.set({ autoTranslateEnabled });
}

export async function saveLanguageRule(autoSourceLanguage: string, targetLanguage: string): Promise<void> {
  await browser.storage.local.set({
    autoSourceLanguage: normalizeSourceLanguage(autoSourceLanguage),
    targetLanguage: normalizeTargetLanguage(targetLanguage),
  });
}

export async function saveTargetLanguage(targetLanguage: string): Promise<void> {
  await browser.storage.local.set({ targetLanguage: normalizeTargetLanguage(targetLanguage) });
}

export async function saveModelUpdatePolicy(modelUpdatePolicy: ModelUpdatePolicy): Promise<void> {
  await browser.storage.local.set({ modelUpdatePolicy: normalizeModelUpdatePolicy(modelUpdatePolicy) });
}

export async function saveExcludedSites(excludedSites: readonly string[]): Promise<void> {
  await browser.storage.local.set({ excludedSites: normalizeExcludedSites(excludedSites) });
}
