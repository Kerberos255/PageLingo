export type DisplayMode = "translation" | "bilingual";
export type SupportedSourceLanguage = "en";
export type SupportedTargetLanguage = "zh-Hans";
export type ManualSourceLanguage = "auto" | SupportedSourceLanguage;

export interface PageLingoSettings {
  displayMode: DisplayMode;
  autoTranslateEnabled: boolean;
  autoSourceLanguage: SupportedSourceLanguage;
  targetLanguage: SupportedTargetLanguage;
  excludedSites: string[];
}

export const LANGUAGE_LABELS: Record<string, string> = {
  en: "English",
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
};

export const DEFAULT_SETTINGS: PageLingoSettings = {
  displayMode: "bilingual",
  autoTranslateEnabled: false,
  autoSourceLanguage: "en",
  targetLanguage: "zh-Hans",
  excludedSites: [],
};

export function normalizeDisplayMode(value: unknown): DisplayMode {
  return value === "translation" ? "translation" : "bilingual";
}

export function normalizeSourceLanguage(value: unknown): SupportedSourceLanguage {
  return value === "en" ? "en" : "en";
}

export function normalizeTargetLanguage(value: unknown): SupportedTargetLanguage {
  return value === "zh-Hans" ? "zh-Hans" : "zh-Hans";
}

export function normalizeDetectedLanguage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === "en" || lower.startsWith("en-")) return "en";
  if (["zh-cn", "zh-sg", "zh-hans"].includes(lower)) return "zh-Hans";
  if (["zh-tw", "zh-hk", "zh-mo", "zh-hant"].includes(lower)) return "zh-Hant";
  return lower.split("-")[0] || null;
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
  };
}

export async function saveDisplayMode(displayMode: DisplayMode): Promise<void> {
  await browser.storage.local.set({ displayMode });
}

export async function saveAutoTranslateEnabled(autoTranslateEnabled: boolean): Promise<void> {
  await browser.storage.local.set({ autoTranslateEnabled });
}

export async function saveLanguageRule(
  autoSourceLanguage: SupportedSourceLanguage,
  targetLanguage: SupportedTargetLanguage,
): Promise<void> {
  await browser.storage.local.set({ autoSourceLanguage, targetLanguage });
}

export async function saveExcludedSites(excludedSites: readonly string[]): Promise<void> {
  await browser.storage.local.set({ excludedSites: normalizeExcludedSites(excludedSites) });
}
