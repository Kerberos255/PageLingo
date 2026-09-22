// @ts-nocheck
export type DisplayMode = "translation" | "bilingual";
export type ModelUpdatePolicy = "auto" | "notify" | "manual";
export type ManualSourceLanguage = "auto" | string;
export interface GlossaryEntry { source:string; target:string; mode:"protect"|"replace"; caseSensitive?:boolean }
export interface GlossaryCollection { id:string; name:string; enabled:boolean; entries:GlossaryEntry[] }
export interface PageLingoSettings { displayMode:DisplayMode; autoTranslateEnabled:boolean; targetLanguage:string; neverTranslateSites:string[]; alwaysTranslateSites:string[]; neverTranslateLanguages:string[]; alwaysTranslateLanguages:string[]; modelUpdatePolicy:ModelUpdatePolicy; imageTranslationEnabled:boolean; terminologyText:string; builtinGlossaryEnabled:boolean; glossaryCollections:GlossaryCollection[] }
export var DEFAULT_SETTINGS: PageLingoSettings = {
    displayMode: "translation",
    autoTranslateEnabled: false,
    targetLanguage: "zh-Hans",
    neverTranslateSites: [],
    alwaysTranslateSites: [],
    neverTranslateLanguages: [],
    alwaysTranslateLanguages: [],
    modelUpdatePolicy: "auto",
    imageTranslationEnabled: false,
    terminologyText: "",
    builtinGlossaryEnabled: true,
    glossaryCollections: [],
};
var LABEL_OVERRIDES = {
    en: "English",
    "zh-Hans": "简体中文",
    "zh-Hant": "繁體中文",
    nb: "挪威语（书面语）",
};
export function languageLabel(code) {
    if (LABEL_OVERRIDES[code])
        return LABEL_OVERRIDES[code];
    try {
        return new Intl.DisplayNames(["zh-CN"], { type: "language" }).of(code) ?? code;
    }
    catch {
        return code;
    }
}
export function normalizeDisplayMode(value): DisplayMode {
    return value === "bilingual" ? "bilingual" : "translation";
}
export function normalizeModelUpdatePolicy(value): ModelUpdatePolicy {
    return value === "notify" || value === "manual" ? value : "auto";
}
export function normalizeDetectedLanguage(value): string | null {
    if (typeof value !== "string")
        return null;
    const raw = value.trim();
    if (!raw)
        return null;
    const lower = raw.toLowerCase().replaceAll("_", "-");
    if (lower === "zh" || ["zh-cn", "zh-sg", "zh-hans"].includes(lower))
        return "zh-Hans";
    if (["zh-tw", "zh-hk", "zh-mo", "zh-hant"].includes(lower))
        return "zh-Hant";
    if (lower === "no" || lower.startsWith("no-"))
        return "nb";
    if (lower === "iw" || lower.startsWith("iw-"))
        return "he";
    return lower.split("-")[0] || null;
}
export function normalizeSourceLanguage(value): string {
    return normalizeDetectedLanguage(value) ?? "en";
}
export function normalizeTargetLanguage(value): string {
    return normalizeDetectedLanguage(value) ?? "zh-Hans";
}
export function normalizeSitePattern(value): string | null {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed)
        return null;
    try {
        const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
        const host = url.hostname.replace(/^www\./, "").replace(/\.$/, "");
        if (!host || !/^[a-z0-9.-]+$/.test(host))
            return null;
        return host;
    }
    catch {
        return null;
    }
}
export function normalizeExcludedSites(value): string[] {
    if (!Array.isArray(value))
        return [];
    const normalized = value
        .filter((item) => typeof item === "string")
        .map(normalizeSitePattern)
        .filter((item) => Boolean(item));
    return Array.from(new Set(normalized)).sort();
}
export function normalizeLanguageList(value): string[] {
    if (!Array.isArray(value))
        return [];
    const normalized = value
        .map(normalizeDetectedLanguage)
        .filter((item) => Boolean(item));
    return Array.from(new Set(normalized)).sort();
}
function createGlossaryId() {
    try {
        if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") return `glossary-${globalThis.crypto.randomUUID()}`;
    } catch {}
    return `glossary-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
export function normalizeGlossaryEntry(value): GlossaryEntry | null {
    if (!value || typeof value !== "object") return null;
    const source = typeof value.source === "string" ? value.source.trim() : "";
    if (!source) return null;
    const requestedMode = value.mode === "protect" ? "protect" : "replace";
    const requestedTarget = typeof value.target === "string" ? value.target.trim() : "";
    // "Slack = Slack" is semantically a hard-preserve rule. Normalize source==target
    // to protect mode so the term is shielded before translation instead of repaired after.
    const mode = requestedMode === "protect" || (requestedTarget && requestedTarget === source) ? "protect" : "replace";
    const target = mode === "protect" ? source : requestedTarget;
    const caseSensitive = typeof value.caseSensitive === "boolean" ? value.caseSensitive : mode === "protect";
    if (mode === "replace" && !target) return null;
    return { source, target, mode, caseSensitive };
}
export function parseGlossaryEditorText(text): GlossaryEntry[] {
    const entries = [];
    for (const rawLine of String(text || "").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const match = line.match(/^(.+?)\s*(?:=>|=|\t)\s*(.+)$/);
        if (match) {
            const source = match[1].trim(), target = match[2].trim();
            if (source && target) entries.push({ source, target, mode: "replace", caseSensitive: false });
        } else {
            entries.push({ source: line, target: line, mode: "protect", caseSensitive: true });
        }
    }
    const map = new Map();
    for (const entry of entries) map.set(entry.source.toLocaleLowerCase(), entry);
    return Array.from(map.values());
}
function parseLegacyGlossaryText(text) {
    return parseGlossaryEditorText(String(text || "").split(/\r?\n/).filter((line) => /(?:=>|=|\t)/.test(line)).join("\n"));
}
export function normalizeGlossaryCollections(value, legacyText = ""): GlossaryCollection[] {
    const source = Array.isArray(value) ? value : [];
    const normalized = [];
    for (const item of source) {
        if (!item || typeof item !== "object") continue;
        const id = typeof item.id === "string" && item.id.trim() ? item.id.trim().slice(0, 96) : createGlossaryId();
        const name = typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 80) : "我的术语";
        const entries = Array.isArray(item.entries) ? item.entries.map(normalizeGlossaryEntry).filter(Boolean) : [];
        normalized.push({ id, name, enabled: item.enabled !== false, entries });
    }
    if (!normalized.length) {
        const legacyEntries = parseLegacyGlossaryText(legacyText);
        if (legacyEntries.length) normalized.push({ id: "legacy-custom", name: "我的术语", enabled: true, entries: legacyEntries });
    }
    return normalized;
}
export function glossaryEntriesToText(entries) {
    return (entries ?? []).map((entry) => entry.mode === "protect" ? entry.source : `${entry.source} = ${entry.target}`).join("\n");
}
export function isSiteListed(hostname, sites) {
    const host = hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    return sites.some((site) => host === site || host.endsWith(`.${site}`));
}
export async function loadSettings(): Promise<PageLingoSettings> {
    const stored = await browser.storage.local.get();
    const legacyExcludedSites = normalizeExcludedSites(stored.excludedSites);
    const glossaryCollections = normalizeGlossaryCollections(stored.glossaryCollections, stored.terminologyText);
    if (!Array.isArray(stored.glossaryCollections) && glossaryCollections.length) {
        await browser.storage.local.set({ glossaryCollections });
    }
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
        terminologyText: typeof stored.terminologyText === "string" ? stored.terminologyText : "",
        builtinGlossaryEnabled: stored.builtinGlossaryEnabled !== false,
        glossaryCollections,
    };
}
export async function saveDisplayMode(displayMode) {
    await browser.storage.local.set({ displayMode });
}
export async function saveAutoTranslateEnabled(autoTranslateEnabled) {
    await browser.storage.local.set({ autoTranslateEnabled });
}
export async function saveTargetLanguage(targetLanguage) {
    await browser.storage.local.set({ targetLanguage: normalizeTargetLanguage(targetLanguage) });
}
export async function saveSiteRules(neverTranslateSites, alwaysTranslateSites) {
    await browser.storage.local.set({
        neverTranslateSites: normalizeExcludedSites(neverTranslateSites),
        alwaysTranslateSites: normalizeExcludedSites(alwaysTranslateSites),
    });
}
export async function saveLanguageRules(neverTranslateLanguages, alwaysTranslateLanguages) {
    await browser.storage.local.set({
        neverTranslateLanguages: normalizeLanguageList(neverTranslateLanguages),
        alwaysTranslateLanguages: normalizeLanguageList(alwaysTranslateLanguages),
    });
}
export async function saveModelUpdatePolicy(modelUpdatePolicy) {
    await browser.storage.local.set({ modelUpdatePolicy: normalizeModelUpdatePolicy(modelUpdatePolicy) });
}
export async function saveImageTranslationEnabled(imageTranslationEnabled) {
    await browser.storage.local.set({ imageTranslationEnabled });
}
export async function saveBuiltinGlossaryEnabled(builtinGlossaryEnabled) {
    await browser.storage.local.set({ builtinGlossaryEnabled: builtinGlossaryEnabled !== false });
}
export async function saveGlossaryCollections(glossaryCollections) {
    await browser.storage.local.set({ glossaryCollections: normalizeGlossaryCollections(glossaryCollections) });
}
