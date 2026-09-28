export type DisplayMode = "translation" | "bilingual";
export type ModelUpdatePolicy = "auto" | "notify" | "manual";
export type ManualSourceLanguage = "auto" | string;
export interface GlossaryEntry { source:string; target:string; mode:"protect"|"replace"; caseSensitive?:boolean }
export interface GlossaryCollection { id:string; name:string; enabled:boolean; entries:GlossaryEntry[] }
export interface PageLingoSettings { displayMode:DisplayMode; autoTranslateEnabled:boolean; targetLanguage:string; neverTranslateSites:string[]; alwaysTranslateSites:string[]; neverTranslateLanguages:string[]; alwaysTranslateLanguages:string[]; modelUpdatePolicy:ModelUpdatePolicy; imageTranslationEnabled:boolean; terminologyText:string; builtinGlossaryEnabled:boolean; glossaryCollections:GlossaryCollection[] }

export const DEFAULT_SETTINGS: PageLingoSettings = {
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

const LABEL_OVERRIDES: Record<string, string> = {
    en: "English",
    "zh-Hans": "简体中文",
    "zh-Hant": "繁體中文",
    nb: "挪威语（书面语）",
};

export function languageLabel(code: string): string {
    if (LABEL_OVERRIDES[code])
        return LABEL_OVERRIDES[code];
    try {
        return new Intl.DisplayNames(["zh-CN"], { type: "language" }).of(code) ?? code;
    }
    catch {
        return code;
    }
}

export function normalizeDisplayMode(value: unknown): DisplayMode {
    return value === "bilingual" ? "bilingual" : "translation";
}

export function normalizeModelUpdatePolicy(value: unknown): ModelUpdatePolicy {
    return value === "notify" || value === "manual" ? value : "auto";
}

export function normalizeDetectedLanguage(value: unknown): string | null {
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

export function normalizeSourceLanguage(value: unknown): string {
    return normalizeDetectedLanguage(value) ?? "en";
}

export function normalizeTargetLanguage(value: unknown): string {
    return normalizeDetectedLanguage(value) ?? "zh-Hans";
}

export function normalizeSitePattern(value: string): string | null {
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

export function normalizeExcludedSites(value: unknown): string[] {
    if (!Array.isArray(value))
        return [];
    const normalized = value
        .filter((item): item is string => typeof item === "string")
        .map(normalizeSitePattern)
        .filter((item): item is string => item !== null);
    return Array.from(new Set(normalized)).sort();
}

export function normalizeLanguageList(value: unknown): string[] {
    if (!Array.isArray(value))
        return [];
    const normalized = value
        .map(normalizeDetectedLanguage)
        .filter((item): item is string => item !== null);
    return Array.from(new Set(normalized)).sort();
}

export function createGlossaryId(): string {
    try {
        if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") return `glossary-${globalThis.crypto.randomUUID()}`;
    } catch {}
    return `glossary-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeGlossaryEntry(value: unknown): GlossaryEntry | null {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const source = typeof record.source === "string" ? record.source.trim() : "";
    if (!source) return null;
    const requestedMode = record.mode === "protect" ? "protect" : "replace";
    const requestedTarget = typeof record.target === "string" ? record.target.trim() : "";
    // "Slack = Slack" is semantically a hard-preserve rule. Normalize source==target
    // to protect mode so the term is shielded before translation instead of repaired after.
    const mode: GlossaryEntry["mode"] = requestedMode === "protect" || (requestedTarget && requestedTarget === source) ? "protect" : "replace";
    const target = mode === "protect" ? source : requestedTarget;
    const caseSensitive = typeof record.caseSensitive === "boolean" ? record.caseSensitive : mode === "protect";
    if (mode === "replace" && !target) return null;
    return { source, target, mode, caseSensitive };
}

export function parseGlossaryEditorText(text: string): GlossaryEntry[] {
    const entries: GlossaryEntry[] = [];
    for (const rawLine of String(text || "").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const match = line.match(/^(.+?)\s*(?:=>|=|\t)\s*(.+)$/);
        if (match) {
            const source = (match[1] ?? "").trim();
            const target = (match[2] ?? "").trim();
            if (source && target) entries.push({ source, target, mode: "replace", caseSensitive: false });
        } else {
            entries.push({ source: line, target: line, mode: "protect", caseSensitive: true });
        }
    }
    const map = new Map<string, GlossaryEntry>();
    for (const entry of entries) map.set(entry.source.toLocaleLowerCase(), entry);
    return Array.from(map.values());
}

function parseLegacyGlossaryText(text: unknown): GlossaryEntry[] {
    return parseGlossaryEditorText(String(text || "").split(/\r?\n/).filter((line) => /(?:=>|=|\t)/.test(line)).join("\n"));
}

export function normalizeGlossaryCollections(value: unknown, legacyText: unknown = ""): GlossaryCollection[] {
    const source: unknown[] = Array.isArray(value) ? value : [];
    const normalized: GlossaryCollection[] = [];
    for (const item of source) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        const id = typeof record.id === "string" && record.id.trim() ? record.id.trim().slice(0, 96) : createGlossaryId();
        const name = typeof record.name === "string" && record.name.trim() ? record.name.trim().slice(0, 80) : "我的术语";
        const entries = Array.isArray(record.entries)
            ? record.entries.map(normalizeGlossaryEntry).filter((entry): entry is GlossaryEntry => entry !== null)
            : [];
        normalized.push({ id, name, enabled: record.enabled !== false, entries });
    }
    if (!normalized.length) {
        const legacyEntries = parseLegacyGlossaryText(legacyText);
        if (legacyEntries.length) normalized.push({ id: "legacy-custom", name: "我的术语", enabled: true, entries: legacyEntries });
    }
    return normalized;
}

export function glossaryEntriesToText(entries: readonly GlossaryEntry[] | null | undefined): string {
    return (entries ?? []).map((entry) => entry.mode === "protect" ? entry.source : `${entry.source} = ${entry.target}`).join("\n");
}

export function isSiteListed(hostname: string, sites: readonly string[]): boolean {
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

export async function saveDisplayMode(displayMode: DisplayMode): Promise<void> {
    await browser.storage.local.set({ displayMode });
}

export async function saveAutoTranslateEnabled(autoTranslateEnabled: boolean): Promise<void> {
    await browser.storage.local.set({ autoTranslateEnabled });
}

export async function saveTargetLanguage(targetLanguage: string): Promise<void> {
    await browser.storage.local.set({ targetLanguage: normalizeTargetLanguage(targetLanguage) });
}

export async function saveSiteRules(neverTranslateSites: readonly string[], alwaysTranslateSites: readonly string[]): Promise<void> {
    await browser.storage.local.set({
        neverTranslateSites: normalizeExcludedSites(neverTranslateSites),
        alwaysTranslateSites: normalizeExcludedSites(alwaysTranslateSites),
    });
}

export async function saveLanguageRules(neverTranslateLanguages: readonly string[], alwaysTranslateLanguages: readonly string[]): Promise<void> {
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

export async function saveBuiltinGlossaryEnabled(builtinGlossaryEnabled: boolean): Promise<void> {
    await browser.storage.local.set({ builtinGlossaryEnabled: builtinGlossaryEnabled !== false });
}

export async function saveGlossaryCollections(glossaryCollections: readonly GlossaryCollection[]): Promise<void> {
    await browser.storage.local.set({ glossaryCollections: normalizeGlossaryCollections(glossaryCollections) });
}