import {
    createGlossaryId,
    glossaryEntriesToText,
    languageLabel,
    loadSettings,
    normalizeSitePattern,
    parseGlossaryEditorText,
    saveAutoTranslateEnabled,
    saveBuiltinGlossaryEnabled,
    saveDisplayMode,
    saveGlossaryCollections,
    saveImageOcrProfileId,
    saveImageTranslationEnabled,
    saveLanguageRules,
    saveModelUpdatePolicy,
    saveSelectionQuickTranslateButton,
    saveSiteRules,
    saveTargetLanguage,
    type DisplayMode,
    type GlossaryCollection,
    type ModelUpdatePolicy,
} from "./shared/settings";
import { sendRuntimeMessage } from "./shared/runtime-message";
import { initializeTranslationEngines } from "./options-engines";
import { initializeVideoSubtitleSettings } from "./options-video-subtitles";
import { initializeBilingualStyleSettings } from "./options-bilingual-style";

interface LanguageOption {
    code: string;
    label: string;
}

interface LanguagePackDirection {
    key: string;
    sourceLanguage: string;
    targetLanguage: string;
    bytes: number;
    version: string;
    installed: boolean;
    updateAvailable: boolean;
    latestVersion: string;
}

interface LanguagePackInfo {
    language: string;
    label: string;
    totalBytes: number;
    installedBytes: number;
    installed: boolean;
    partial: boolean;
    updateAvailable: boolean;
    directions: LanguagePackDirection[];
}

interface LanguageCatalog {
    sourceLanguages: LanguageOption[];
    targetLanguages: LanguageOption[];
    packs: LanguagePackInfo[];
    updateCheckedAt: number;
    updateCount: number;
}

interface ImageOcrProfileStatus {
    id: string;
    label: string;
    languagesLabel: string;
    installed: boolean;
    detectionInstalled?: boolean;
    recognitionBytes: number;
    totalBytes: number;
}

interface ImageOcrStatus {
    installed: boolean;
    totalBytes: number;
    runtimeSupported: boolean;
    activeProfileId?: string;
    detectionInstalled?: boolean;
    detectionBytes?: number;
    docLayoutInstalled?: boolean;
    docLayoutBytes?: number;
    profiles?: ImageOcrProfileStatus[];
}

interface OptionsRuntimeResponse {
    ok?: boolean;
    error?: string;
    catalog?: LanguageCatalog;
    pack?: LanguagePackInfo;
    status?: ImageOcrStatus;
}

type RuleGroupKey = "always-site" | "never-site" | "always-language" | "never-language";
const INLINE_RULE_CHIP_LIMIT = 12;

const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="display-mode"]'));
const status = document.querySelector<HTMLElement>("#save-status");
const autoToggle = document.querySelector<HTMLInputElement>("#auto-translate-enabled");
const selectionQuickButtonToggle = document.querySelector<HTMLInputElement>("#selection-quick-translate-button");
const targetSelect = document.querySelector<HTMLSelectElement>("#target-language");
const neverSiteInput = document.querySelector<HTMLInputElement>("#never-site-input");
const neverSiteAdd = document.querySelector<HTMLButtonElement>("#never-site-add");
const neverSiteList = document.querySelector<HTMLElement>("#never-site-list");
const neverSiteCount = document.querySelector<HTMLElement>("#never-site-count");
const alwaysSiteInput = document.querySelector<HTMLInputElement>("#always-site-input");
const alwaysSiteAdd = document.querySelector<HTMLButtonElement>("#always-site-add");
const alwaysSiteList = document.querySelector<HTMLElement>("#always-site-list");
const alwaysSiteCount = document.querySelector<HTMLElement>("#always-site-count");
const neverLanguageSelect = document.querySelector<HTMLSelectElement>("#never-language-select");
const neverLanguageAdd = document.querySelector<HTMLButtonElement>("#never-language-add");
const neverLanguageList = document.querySelector<HTMLElement>("#never-language-list");
const neverLanguageCount = document.querySelector<HTMLElement>("#never-language-count");
const alwaysLanguageSelect = document.querySelector<HTMLSelectElement>("#always-language-select");
const alwaysLanguageAdd = document.querySelector<HTMLButtonElement>("#always-language-add");
const alwaysLanguageList = document.querySelector<HTMLElement>("#always-language-list");
const alwaysLanguageCount = document.querySelector<HTMLElement>("#always-language-count");
const manageRuleButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-manage-rules]"));
const rulesManagerDialog = document.querySelector<HTMLDialogElement>("#rules-manager-dialog");
const rulesManagerTitle = document.querySelector<HTMLElement>("#rules-manager-title");
const rulesManagerCount = document.querySelector<HTMLElement>("#rules-manager-count");
const rulesManagerSearch = document.querySelector<HTMLInputElement>("#rules-manager-search");
const rulesManagerList = document.querySelector<HTMLElement>("#rules-manager-list");
const rulesManagerEmpty = document.querySelector<HTMLElement>("#rules-manager-empty");
const closeRulesManagerButton = document.querySelector<HTMLButtonElement>("#close-rules-manager");
const doneRulesManagerButton = document.querySelector<HTMLButtonElement>("#done-rules-manager");
const clearAllRulesButton = document.querySelector<HTMLButtonElement>("#clear-all-rules");
const packSelect = document.querySelector<HTMLSelectElement>("#language-pack-select");
const downloadPackButton = document.querySelector<HTMLButtonElement>("#download-language-pack");
const packList = document.querySelector<HTMLElement>("#language-pack-list");
const updatePolicy = document.querySelector<HTMLSelectElement>("#model-update-policy");
const checkUpdates = document.querySelector<HTMLButtonElement>("#check-model-updates");
const updateStatus = document.querySelector<HTMLElement>("#model-update-status");
const imageToggle = document.querySelector<HTMLInputElement>("#image-translation-enabled");
const imageOcrProfileSelect = document.querySelector<HTMLSelectElement>("#image-ocr-profile-select");
const imageOcrProfileList = document.querySelector<HTMLElement>("#image-ocr-profile-list");
const builtinGlossaryToggle = document.querySelector<HTMLInputElement>("#builtin-glossary-enabled");
const glossaryCollectionList = document.querySelector<HTMLElement>("#glossary-collection-list");
const createGlossaryButton = document.querySelector<HTMLButtonElement>("#create-glossary");
const glossaryEditor = document.querySelector<HTMLElement>("#glossary-editor");
const glossaryEditorTitle = document.querySelector<HTMLElement>("#glossary-editor-title");
const glossaryNameInput = document.querySelector<HTMLInputElement>("#glossary-name");
const glossaryEntriesTextarea = document.querySelector<HTMLTextAreaElement>("#glossary-entries");
const saveGlossaryButton = document.querySelector<HTMLButtonElement>("#save-glossary");
const cancelGlossaryButton = document.querySelector<HTMLButtonElement>("#cancel-glossary");
const closeGlossaryEditorButton = document.querySelector<HTMLButtonElement>("#close-glossary-editor");
const deleteGlossaryButton = document.querySelector<HTMLButtonElement>("#delete-glossary");
const imageStatus = document.querySelector<HTMLElement>("#image-ocr-status");
const imageOcrAction = document.querySelector<HTMLButtonElement>("#image-ocr-action");
const translationCacheStatus = document.querySelector<HTMLElement>("#translation-cache-status");
const clearCacheButton = document.querySelector<HTMLButtonElement>("#clear-translation-cache");
const navItems = Array.from(document.querySelectorAll<HTMLElement>("[data-settings-page]"));
const pages = Array.from(document.querySelectorAll<HTMLElement>(".settings-page"));

let neverTranslateSites: string[] = [];
let alwaysTranslateSites: string[] = [];
let neverTranslateLanguages: string[] = [];
let alwaysTranslateLanguages: string[] = [];
let activeRuleManagerGroup: RuleGroupKey | null = null;
let sourceLanguages: LanguageOption[] = [];
let packs: LanguagePackInfo[] = [];
let currentImageOcrStatus: ImageOcrStatus | undefined;
let glossaryCollections: GlossaryCollection[] = [];
let editingGlossaryId: string | null = null;

function setChecked(mode: DisplayMode): void {
    for (const radio of radios)
        radio.checked = radio.value === mode;
}

function showSaved(message = "已保存", timeout = 1600): void {
    if (!status)
        return;
    status.textContent = message;
    window.setTimeout(() => {
        if (status.textContent === message)
            status.textContent = "";
    }, timeout);
}

function formatBytes(bytes: number): string {
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function formatCheckedAt(value: number): string {
    if (!value)
        return "尚未检查更新";
    return `上次检查：${new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(value))}`;
}

function applyCatalog(catalog: LanguageCatalog): void {
    packs = [...catalog.packs].sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
    sourceLanguages = [...catalog.sourceLanguages];
    fillSelect(neverLanguageSelect, sourceLanguages);
    fillSelect(alwaysLanguageSelect, sourceLanguages);
    if (updateStatus) {
        updateStatus.textContent = catalog.updateCount > 0
            ? `${formatCheckedAt(catalog.updateCheckedAt)} · ${catalog.updateCount} 个方向有更新`
            : `${formatCheckedAt(catalog.updateCheckedAt)} · 已是最新`;
    }
    renderPacks();
    renderPackPicker();
}

function fillSelect(select: HTMLSelectElement | null, languages: readonly LanguageOption[]): void {
    if (!select)
        return;
    select.replaceChildren();
    for (const language of languages) {
        const option = document.createElement("option");
        option.value = language.code;
        option.textContent = language.label;
        select.append(option);
    }
}

interface RuleGroupDescriptor {
    key: RuleGroupKey;
    title: string;
    emptyText: string;
    searchPlaceholder: string;
    container: HTMLElement | null;
    countEl: HTMLElement | null;
    values: () => readonly string[];
    labelFor: (value: string) => string;
    removeValue: (value: string) => void;
    clearAll: () => void;
}

function getRuleGroupDescriptor(key: RuleGroupKey): RuleGroupDescriptor {
    if (key === "always-site") {
        return {
            key,
            title: "网站规则 · 总是翻译",
            emptyText: "暂无网址",
            searchPlaceholder: "搜索域名...",
            container: alwaysSiteList,
            countEl: alwaysSiteCount,
            values: () => alwaysTranslateSites,
            labelFor: (value) => value,
            removeValue: (value) => {
                alwaysTranslateSites = alwaysTranslateSites.filter((item) => item !== value);
                void saveSiteRules(neverTranslateSites, alwaysTranslateSites).then(() => { renderRuleLists(); showSaved(); });
            },
            clearAll: () => {
                alwaysTranslateSites = [];
                void saveSiteRules(neverTranslateSites, alwaysTranslateSites).then(() => { renderRuleLists(); showSaved("已清空该组规则"); });
            },
        };
    }
    if (key === "never-site") {
        return {
            key,
            title: "网站规则 · 不自动翻译",
            emptyText: "暂无网址",
            searchPlaceholder: "搜索域名...",
            container: neverSiteList,
            countEl: neverSiteCount,
            values: () => neverTranslateSites,
            labelFor: (value) => value,
            removeValue: (value) => {
                neverTranslateSites = neverTranslateSites.filter((item) => item !== value);
                void saveSiteRules(neverTranslateSites, alwaysTranslateSites).then(() => { renderRuleLists(); showSaved(); });
            },
            clearAll: () => {
                neverTranslateSites = [];
                void saveSiteRules(neverTranslateSites, alwaysTranslateSites).then(() => { renderRuleLists(); showSaved("已清空该组规则"); });
            },
        };
    }
    if (key === "always-language") {
        return {
            key,
            title: "语言规则 · 总是翻译",
            emptyText: "暂无语言",
            searchPlaceholder: "搜索语言名称或代码...",
            container: alwaysLanguageList,
            countEl: alwaysLanguageCount,
            values: () => alwaysTranslateLanguages,
            labelFor: languageLabel,
            removeValue: (value) => {
                alwaysTranslateLanguages = alwaysTranslateLanguages.filter((item) => item !== value);
                void saveLanguageRules(neverTranslateLanguages, alwaysTranslateLanguages).then(() => { renderRuleLists(); showSaved(); });
            },
            clearAll: () => {
                alwaysTranslateLanguages = [];
                void saveLanguageRules(neverTranslateLanguages, alwaysTranslateLanguages).then(() => { renderRuleLists(); showSaved("已清空该组规则"); });
            },
        };
    }
    return {
        key: "never-language",
        title: "语言规则 · 跳过翻译",
        emptyText: "暂无语言",
        searchPlaceholder: "搜索语言名称或代码...",
        container: neverLanguageList,
        countEl: neverLanguageCount,
        values: () => neverTranslateLanguages,
        labelFor: languageLabel,
        removeValue: (value) => {
            neverTranslateLanguages = neverTranslateLanguages.filter((item) => item !== value);
            void saveLanguageRules(neverTranslateLanguages, alwaysTranslateLanguages).then(() => { renderRuleLists(); showSaved(); });
        },
        clearAll: () => {
            neverTranslateLanguages = [];
            void saveLanguageRules(neverTranslateLanguages, alwaysTranslateLanguages).then(() => { renderRuleLists(); showSaved("已清空该组规则"); });
        },
    };
}

function renderRuleGroupChips(descriptor: RuleGroupDescriptor): void {
    const values = descriptor.values();
    if (descriptor.countEl) descriptor.countEl.textContent = String(values.length);
    const manageBtn = manageRuleButtons.find((button) => button.dataset.manageRules === descriptor.key);
    if (manageBtn) manageBtn.hidden = values.length === 0;
    if (!descriptor.container) return;
    descriptor.container.replaceChildren();
    if (values.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.textContent = descriptor.emptyText;
        descriptor.container.append(empty);
        return;
    }
    const visibleValues = values.slice(0, INLINE_RULE_CHIP_LIMIT);
    for (const value of visibleValues) {
        const text = descriptor.labelFor(value);
        const chip = document.createElement("span");
        chip.className = "rule-chip";
        const label = document.createElement("span");
        label.className = "rule-chip-label";
        label.textContent = text;
        label.title = text;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "rule-chip-remove";
        remove.textContent = "×";
        remove.setAttribute("aria-label", `移除 ${text}`);
        remove.addEventListener("click", () => descriptor.removeValue(value));
        chip.append(label, remove);
        descriptor.container.append(chip);
    }
    const hiddenCount = values.length - visibleValues.length;
    if (hiddenCount > 0) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "rule-chip-more";
        more.textContent = `+${hiddenCount} 项 · 查看全部`;
        more.addEventListener("click", () => openRulesManager(descriptor.key));
        descriptor.container.append(more);
    }
}

function renderRulesManagerDialog(): void {
    if (!activeRuleManagerGroup || !rulesManagerList) return;
    const descriptor = getRuleGroupDescriptor(activeRuleManagerGroup);
    const allValues = descriptor.values();
    const query = (rulesManagerSearch?.value ?? "").trim().toLowerCase();
    const filtered = query
        ? allValues.filter((value) => {
            const label = descriptor.labelFor(value).toLowerCase();
            return label.includes(query) || value.toLowerCase().includes(query);
        })
        : allValues;

    if (rulesManagerTitle) rulesManagerTitle.textContent = descriptor.title;
    if (rulesManagerSearch) rulesManagerSearch.placeholder = descriptor.searchPlaceholder;
    if (rulesManagerCount) {
        rulesManagerCount.textContent = query
            ? `显示 ${filtered.length} / ${allValues.length} 项`
            : `共 ${allValues.length} 项`;
    }
    if (clearAllRulesButton) clearAllRulesButton.disabled = allValues.length === 0;

    rulesManagerList.replaceChildren();
    if (rulesManagerEmpty) {
        rulesManagerEmpty.hidden = filtered.length > 0;
        rulesManagerEmpty.textContent = allValues.length === 0 ? descriptor.emptyText : "没有匹配的规则";
    }
    for (const value of filtered) {
        const row = document.createElement("div");
        row.className = "rules-manager-row";
        const label = document.createElement("span");
        label.textContent = descriptor.labelFor(value);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "移除";
        remove.addEventListener("click", () => descriptor.removeValue(value));
        row.append(label, remove);
        rulesManagerList.append(row);
    }
}

function openRulesManager(key: RuleGroupKey): void {
    activeRuleManagerGroup = key;
    if (rulesManagerSearch) rulesManagerSearch.value = "";
    renderRulesManagerDialog();
    if (rulesManagerDialog && !rulesManagerDialog.open) {
        rulesManagerDialog.showModal();
    }
    rulesManagerSearch?.focus();
}

function closeRulesManager(): void {
    activeRuleManagerGroup = null;
    if (rulesManagerDialog?.open) rulesManagerDialog.close();
}

function renderRuleLists(): void {
    const keys: RuleGroupKey[] = ["always-site", "never-site", "always-language", "never-language"];
    for (const key of keys) {
        renderRuleGroupChips(getRuleGroupDescriptor(key));
    }
    if (activeRuleManagerGroup && rulesManagerDialog?.open) {
        renderRulesManagerDialog();
    }
}

function packRouteLabel(label: string, directions: readonly LanguagePackDirection[]): string {
    if (directions.length > 1) return `English ↔ ${label}`;
    return directions[0]?.sourceLanguage === "en" ? `English → ${label}` : `${label} → English`;
}

function renderPackPicker(): void {
    if (!packSelect || !downloadPackButton)
        return;
    downloadPackButton.textContent = "下载";
    const available = packs.filter((pack) => !pack.installed && !pack.partial);
    packSelect.replaceChildren();
    for (const pack of available) {
        const option = document.createElement("option");
        option.value = pack.language;
        option.textContent = `${pack.label} · ${formatBytes(pack.totalBytes)}`;
        packSelect.append(option);
    }
    if (available.length === 0) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "所有可用语言包均已下载";
        packSelect.append(option);
    }
    downloadPackButton.disabled = available.length === 0;
}

function renderPacks(): void {
    if (!packList)
        return;
    packList.replaceChildren();
    const installedPacks = packs.filter((pack) => pack.installed || pack.partial);
    if (installedPacks.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.textContent = "暂无已下载语言包";
        packList.append(empty);
        return;
    }
    for (const pack of installedPacks) {
        const row = document.createElement("div");
        row.className = "pack-item";
        const copy = document.createElement("div");
        copy.className = "pack-copy";
        const title = document.createElement("strong");
        title.textContent = pack.label;
        const installed = pack.directions.filter(direction => direction.installed);
        const versions = Array.from(new Set(installed.map(direction => direction.version))).map(version => `v${version}`).join(" / ");
        const detail = document.createElement("small");
        detail.textContent = `${packRouteLabel(pack.label, installed)} · ${formatBytes(pack.installedBytes)}${versions ? ` · ${versions}` : ""}`;
        copy.append(title, detail);
        const state = document.createElement("span");
        state.className = `pack-state ${pack.updateAvailable && pack.installed ? "update" : pack.installed ? "installed" : pack.partial ? "partial" : ""}`;
        state.textContent = pack.updateAvailable && pack.installed ? "有更新" : pack.installed ? "已下载" : "单向可用";
        const actions = document.createElement("div");
        actions.className = "pack-actions";
        if (pack.installed && pack.updateAvailable) {
            const update = document.createElement("button");
            update.type = "button";
            update.className = "pack-action";
            update.textContent = "更新";
            update.addEventListener("click", () => void updatePack(pack, update));
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "pack-action danger";
            remove.textContent = "删除";
            remove.addEventListener("click", () => void changePack(pack, remove));
            actions.append(update, remove);
        }
        else {
            const action = document.createElement("button");
            action.type = "button";
            action.className = pack.installed ? "pack-action danger" : "pack-action";
            action.textContent = pack.installed ? "删除" : "下载反向";
            if (pack.partial) {
                const route = packRouteLabel(pack.label, pack.directions.filter(direction => !direction.installed));
                action.title = `下载 ${route} · ${formatBytes(pack.totalBytes - pack.installedBytes)}`;
            }
            action.addEventListener("click", () => void changePack(pack, action));
            actions.append(action);
        }
        row.append(copy, state, actions);
        packList.append(row);
    }
}

async function changePack(pack: LanguagePackInfo, button: HTMLButtonElement): Promise<void> {
    const actionLabel = button.textContent;
    button.disabled = true;
    const deleting = pack.installed;
    button.textContent = deleting ? "删除中…" : "下载中…";
    showSaved(deleting ? `正在删除 ${pack.label}` : `正在下载 ${pack.label} · ${formatBytes(pack.totalBytes - pack.installedBytes)}`, 30_000);
    try {
        const response = await sendRuntimeMessage<OptionsRuntimeResponse>({ type: deleting ? "delete-language-pack" : "download-language-pack", language: pack.language });
        if (!response?.ok || !response.pack)
            throw new Error(response?.error ?? "语言包操作失败");
        packs = packs.map((item) => item.language === pack.language ? response.pack as LanguagePackInfo : item);
        renderPacks();
        renderPackPicker();
        showSaved(deleting ? `已删除 ${pack.label}` : `已下载 ${pack.label}`);
    }
    catch (error) {
        button.disabled = false;
        button.textContent = actionLabel;
        showSaved(error instanceof Error ? error.message : String(error), 5000);
    }
}

async function updatePack(pack: LanguagePackInfo, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    button.textContent = "更新中…";
    showSaved(`正在安全更新 ${pack.label}`, 60_000);
    try {
        const response = await sendRuntimeMessage<OptionsRuntimeResponse>({ type: "update-language-pack", language: pack.language });
        if (!response?.ok || !response.catalog)
            throw new Error(response?.error ?? "模型更新失败");
        applyCatalog(response.catalog);
        showSaved(`${pack.label} 已更新`);
    }
    catch (error) {
        button.disabled = false;
        button.textContent = "更新";
        showSaved(error instanceof Error ? error.message : String(error), 5000);
    }
}

function glossarySummary(collection: GlossaryCollection): string {
    const protect = collection.entries.filter((entry) => entry.mode === "protect").length;
    const replace = collection.entries.length - protect;
    const parts: string[] = [];
    if (protect) parts.push(`${protect} 个保留原文`);
    if (replace) parts.push(`${replace} 个指定译法`);
    return parts.length ? parts.join(" · ") : "暂无术语";
}

async function persistGlossaryCollections(message = "术语库已保存"): Promise<void> {
    await saveGlossaryCollections(glossaryCollections);
    renderGlossaryCollections();
    showSaved(message);
}

function renderGlossaryCollections(): void {
    if (!glossaryCollectionList) return;
    glossaryCollectionList.replaceChildren();
    if (!glossaryCollections.length) {
        const empty = document.createElement("div");
        empty.className = "glossary-card";
        empty.innerHTML = '<div class="glossary-card-top"><div><strong>还没有自定义术语库</strong><span class="glossary-handle">新建一个集合来覆盖默认术语</span></div></div><p>适合项目名、团队内部术语或你偏好的固定译法。</p>';
        glossaryCollectionList.append(empty);
        return;
    }
    for (const collection of glossaryCollections) {
        const card = document.createElement("article");
        card.className = "glossary-card";
        const top = document.createElement("div"); top.className = "glossary-card-top";
        const copy = document.createElement("div");
        const title = document.createElement("strong"); title.textContent = collection.name;
        const handle = document.createElement("span"); handle.className = "glossary-handle"; handle.textContent = `@custom · ${collection.entries.length} 条`;
        copy.append(title, handle);
        const toggleLabel = document.createElement("label"); toggleLabel.className = "switch";
        const toggle = document.createElement("input"); toggle.type = "checkbox"; toggle.checked = collection.enabled !== false;
        toggle.setAttribute("aria-label", `启用术语库 ${collection.name}`);
        const knob = document.createElement("i"); toggleLabel.append(toggle, knob);
        toggle.addEventListener("change", () => { collection.enabled = toggle.checked; void persistGlossaryCollections(toggle.checked ? "术语库已启用" : "术语库已停用"); });
        top.append(copy, toggleLabel);
        const description = document.createElement("p"); description.textContent = glossarySummary(collection);
        const actions = document.createElement("div"); actions.className = "glossary-card-actions";
        const tags = document.createElement("div"); tags.className = "glossary-tags";
        const tag = document.createElement("span"); tag.textContent = "自定义"; tags.append(tag);
        const edit = document.createElement("button"); edit.type = "button"; edit.textContent = "编辑"; edit.addEventListener("click", () => openGlossaryEditor(collection.id));
        actions.append(tags, edit);
        card.append(top, description, actions);
        glossaryCollectionList.append(card);
    }
}

function openGlossaryEditor(id: string | null = null): void {
    editingGlossaryId = id;
    const collection = id ? glossaryCollections.find((item) => item.id === id) ?? null : null;
    if (glossaryEditorTitle) glossaryEditorTitle.textContent = collection ? "编辑术语库" : "新建术语库";
    if (glossaryNameInput) glossaryNameInput.value = collection?.name ?? "";
    if (glossaryEntriesTextarea) glossaryEntriesTextarea.value = collection ? glossaryEntriesToText(collection.entries) : "";
    if (deleteGlossaryButton) deleteGlossaryButton.hidden = !collection;
    if (glossaryEditor) glossaryEditor.hidden = false;
    glossaryNameInput?.focus();
    glossaryEditor?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function closeGlossaryEditor(): void {
    editingGlossaryId = null;
    if (glossaryEditor) glossaryEditor.hidden = true;
}

async function saveGlossaryEditor(): Promise<void> {
    const name = glossaryNameInput?.value.trim() ?? "";
    if (!name) { showSaved("请填写术语库名称", 3000); glossaryNameInput?.focus(); return; }
    const entries = parseGlossaryEditorText(glossaryEntriesTextarea?.value ?? "");
    if (editingGlossaryId) {
        const index = glossaryCollections.findIndex((item) => item.id === editingGlossaryId);
        const current = index >= 0 ? glossaryCollections[index] : undefined;
        if (current) glossaryCollections[index] = { ...current, name, entries };
    } else {
        glossaryCollections.push({ id: createGlossaryId(), name, enabled: true, entries });
    }
    await persistGlossaryCollections("术语库已保存");
    closeGlossaryEditor();
}

async function deleteEditingGlossary(): Promise<void> {
    if (!editingGlossaryId) return;
    glossaryCollections = glossaryCollections.filter((item) => item.id !== editingGlossaryId);
    await persistGlossaryCollections("术语库已删除");
    closeGlossaryEditor();
}

async function refreshImageOcrStatus(): Promise<void> {
    if (!imageStatus || !imageOcrAction) return;
    try {
        const response = await sendRuntimeMessage<OptionsRuntimeResponse>({ type: "get-image-ocr-status" });
        if (!response?.ok || !response.status)
            throw new Error(response?.error ?? "无法读取 OCR 状态");
        renderImageOcrStatus(response.status);
    }
    catch (error) {
        imageStatus.textContent = error instanceof Error ? error.message : String(error);
        imageOcrAction.disabled = true;
    }
}

function renderImageOcrStatus(current: ImageOcrStatus): void {
    if (!imageStatus || !imageOcrAction) return;
    currentImageOcrStatus = current;
    const profiles = current.profiles ?? [];
    const activeId = current.activeProfileId ?? "pp-ocrv6-small";
    const activeProfile = profiles.find((item) => item.id === activeId);

    if (imageOcrProfileSelect && profiles.length > 0) {
        imageOcrProfileSelect.replaceChildren();
        for (const item of profiles) {
            const opt = document.createElement("option");
            opt.value = item.id;
            opt.textContent = `${item.label}${item.installed ? "（已下载）" : ""}`;
            imageOcrProfileSelect.append(opt);
        }
        imageOcrProfileSelect.value = activeId;
    }

    const activeLabel = activeProfile?.label ?? "PP-OCRv6 Small";
    const detNote = current.detectionInstalled ? " · 检测模型已缓存" : "";
    const layoutNote = current.docLayoutInstalled ? " · PDF 版面模型已缓存" : "";
    imageStatus.textContent = !current.runtimeSupported
        ? "当前 Firefox 环境不支持本地文字识别"
        : `${activeLabel} · ${current.installed ? "已下载" : "可下载"} ${formatBytes(current.totalBytes)}${detNote}${layoutNote}`;
    imageOcrAction.textContent = current.installed ? "删除当前包" : "下载当前包";
    imageOcrAction.disabled = !current.installed && !current.runtimeSupported;

    if (imageOcrProfileList) {
        imageOcrProfileList.replaceChildren();
        for (const profile of profiles) {
            const row = document.createElement("div");
            row.className = "pack-item";

            const copy = document.createElement("div");
            copy.className = "pack-copy";
            const title = document.createElement("strong");
            title.textContent = profile.id === activeId ? `${profile.label}（当前使用）` : profile.label;
            const detail = document.createElement("small");
            const sizeText = profile.detectionInstalled
                ? `识别包 ${formatBytes(profile.recognitionBytes)}`
                : `含检测模型 ${formatBytes(profile.totalBytes)}`;
            detail.textContent = `${profile.languagesLabel} · ${sizeText}`;
            copy.append(title, detail);

            const stateBadge = document.createElement("span");
            stateBadge.className = `pack-state ${profile.installed ? "installed" : ""}`;
            stateBadge.textContent = profile.installed ? "已下载" : "未下载";

            const actions = document.createElement("div");
            actions.className = "pack-actions";
            if (profile.id !== activeId) {
                const useBtn = document.createElement("button");
                useBtn.type = "button";
                useBtn.className = "pack-action";
                useBtn.textContent = "设为当前";
                useBtn.addEventListener("click", () => {
                    void saveImageOcrProfileId(profile.id).then(async () => {
                        await refreshImageOcrStatus();
                        showSaved(`已切换图片识别包为 ${profile.label}`);
                    });
                });
                actions.append(useBtn);
            }
            const toggleBtn = document.createElement("button");
            toggleBtn.type = "button";
            toggleBtn.className = profile.installed ? "pack-action danger" : "pack-action";
            toggleBtn.textContent = profile.installed ? "删除" : "下载";
            toggleBtn.disabled = !profile.installed && !current.runtimeSupported;
            toggleBtn.addEventListener("click", () => {
                void changeImageOcrModels(profile.id, profile.installed, toggleBtn);
            });
            actions.append(toggleBtn);

            row.append(copy, stateBadge, actions);
            imageOcrProfileList.append(row);
        }
    }
}

async function changeImageOcrModels(
    profileId?: string,
    forceDeleting?: boolean,
    triggerButton?: HTMLButtonElement,
): Promise<void> {
    if (!imageStatus || !imageOcrAction || !currentImageOcrStatus) return;
    const targetProfileId = profileId ?? currentImageOcrStatus.activeProfileId ?? "pp-ocrv6-small";
    const deleting = typeof forceDeleting === "boolean" ? forceDeleting : currentImageOcrStatus.installed;
    const type = deleting ? "delete-image-ocr-models" : "download-image-ocr-models";
    const btn = triggerButton ?? imageOcrAction;
    btn.disabled = true;
    btn.textContent = deleting ? "删除中…" : "下载中…";
    if (!triggerButton) {
        imageStatus.textContent = deleting ? "正在删除模型…" : "正在下载文字识别模型…";
    }
    try {
        const response = await sendRuntimeMessage<OptionsRuntimeResponse>({ type, profileId: targetProfileId });
        if (!response?.ok || !response.status)
            throw new Error(response?.error ?? (deleting ? "删除模型失败" : "下载模型失败"));
        renderImageOcrStatus(response.status);
        showSaved(deleting ? "文字识别包已删除" : "文字识别包已下载并校验完成");
    }
    catch (error) {
        await refreshImageOcrStatus();
        showSaved(error instanceof Error ? error.message : String(error), 5000);
    }
}

async function refreshTranslationCacheStatus(): Promise<void> {
    if (!translationCacheStatus || !clearCacheButton) return;
    try {
        const response = await sendRuntimeMessage<{ ok?: boolean; totalCount?: number; externalCount?: number; localCount?: number; error?: string }>({
            type: "get-translation-cache-stats",
        });
        if (!response?.ok) throw new Error(response?.error ?? "无法读取缓存状态");
        const total = response.totalCount ?? 0;
        translationCacheStatus.textContent = total > 0
            ? `已缓存 ${total} 条译文，重复内容可直接复用以减少调用`
            : "当前暂无缓存译文";
        clearCacheButton.disabled = total === 0;
    } catch {
        translationCacheStatus.textContent = "外置引擎译文自动缓存 14 天，重复内容可免重复调用";
        clearCacheButton.disabled = false;
    }
}

async function clearTranslationCache(): Promise<void> {
    if (!clearCacheButton) return;
    clearCacheButton.disabled = true;
    clearCacheButton.textContent = "清空中…";
    try {
        const response = await sendRuntimeMessage<{ ok?: boolean; error?: string }>({ type: "clear-translation-cache" });
        if (!response?.ok) throw new Error(response?.error ?? "清空缓存失败");
        await refreshTranslationCacheStatus();
        showSaved("翻译缓存已清空");
    } catch (error) {
        clearCacheButton.disabled = false;
        showSaved(error instanceof Error ? error.message : String(error), 5000);
    } finally {
        clearCacheButton.textContent = "清空缓存";
    }
}

async function initialize(): Promise<void> {
    const [settings, response] = await Promise.all([
        loadSettings(),
        sendRuntimeMessage<OptionsRuntimeResponse>({ type: "get-language-catalog" }),
    ]);
    if (!response?.ok || !response.catalog)
        throw new Error(response?.error ?? "无法读取语言目录");
    const catalog = response.catalog;
    applyCatalog(catalog);
    fillSelect(targetSelect, catalog.targetLanguages);
    setChecked(settings.displayMode);
    if (autoToggle)
        autoToggle.checked = settings.autoTranslateEnabled;
    if (selectionQuickButtonToggle)
        selectionQuickButtonToggle.checked = settings.selectionQuickTranslateButton;
    if (targetSelect)
        targetSelect.value = catalog.targetLanguages.some((item) => item.code === settings.targetLanguage)
            ? settings.targetLanguage
            : "en";
    if (updatePolicy)
        updatePolicy.value = settings.modelUpdatePolicy;
    if (imageToggle)
        imageToggle.checked = settings.imageTranslationEnabled;
    if (builtinGlossaryToggle) builtinGlossaryToggle.checked = settings.builtinGlossaryEnabled !== false;
    glossaryCollections = settings.glossaryCollections.map((collection) => ({ ...collection, entries: collection.entries.map((entry) => ({ ...entry })) }));
    renderGlossaryCollections();
    neverTranslateSites = [...settings.neverTranslateSites];
    alwaysTranslateSites = [...settings.alwaysTranslateSites];
    neverTranslateLanguages = [...settings.neverTranslateLanguages];
    alwaysTranslateLanguages = [...settings.alwaysTranslateLanguages];
    renderRuleLists();
    selectSettingsPage(location.hash.slice(1) || "translation");
    await Promise.all([refreshImageOcrStatus(), refreshTranslationCacheStatus()]);
}

function selectSettingsPage(pageId: string): void {
    const next = pages.some((page) => page.id === pageId) ? pageId : "translation";
    for (const page of pages)
        page.classList.toggle("active", page.id === next);
    for (const item of navItems) {
        const active = item.dataset.settingsPage === next;
        item.classList.toggle("active", active);
        if (active) item.setAttribute("aria-current", "page");
        else item.removeAttribute("aria-current");
    }
}

function addSiteRule(kind: "never" | "always"): void {
    const input = kind === "never" ? neverSiteInput : alwaysSiteInput;
    if (!input)
        return;
    const site = normalizeSitePattern(input.value);
    if (!site) {
        showSaved("网址格式不正确");
        input.focus();
        return;
    }
    if (kind === "never") {
        neverTranslateSites = Array.from(new Set([...neverTranslateSites, site])).sort();
        alwaysTranslateSites = alwaysTranslateSites.filter((item) => item !== site);
    }
    else {
        alwaysTranslateSites = Array.from(new Set([...alwaysTranslateSites, site])).sort();
        neverTranslateSites = neverTranslateSites.filter((item) => item !== site);
    }
    input.value = "";
    void saveSiteRules(neverTranslateSites, alwaysTranslateSites).then(() => {
        renderRuleLists();
        showSaved();
    });
}

function addLanguageRule(kind: "never" | "always"): void {
    const select = kind === "never" ? neverLanguageSelect : alwaysLanguageSelect;
    const language = select?.value;
    if (!language)
        return;
    if (kind === "never") {
        neverTranslateLanguages = Array.from(new Set([...neverTranslateLanguages, language])).sort();
        alwaysTranslateLanguages = alwaysTranslateLanguages.filter((item) => item !== language);
    }
    else {
        alwaysTranslateLanguages = Array.from(new Set([...alwaysTranslateLanguages, language])).sort();
        neverTranslateLanguages = neverTranslateLanguages.filter((item) => item !== language);
    }
    void saveLanguageRules(neverTranslateLanguages, alwaysTranslateLanguages).then(() => {
        renderRuleLists();
        showSaved();
    });
}

for (const radio of radios) {
    radio.addEventListener("change", () => {
        if (radio.checked) {
            const mode: DisplayMode = radio.value === "bilingual" ? "bilingual" : "translation";
            void saveDisplayMode(mode).then(() => showSaved());
        }
    });
}

for (const item of navItems) {
    item.addEventListener("click", () => selectSettingsPage(item.dataset.settingsPage ?? "translation"));
}

window.addEventListener("hashchange", () => selectSettingsPage(location.hash.slice(1) || "translation"));

if (autoToggle) {
    autoToggle.addEventListener("change", () => void saveAutoTranslateEnabled(autoToggle.checked).then(() => showSaved()));
}
if (targetSelect) {
    targetSelect.addEventListener("change", () => void saveTargetLanguage(targetSelect.value).then(() => showSaved()));
}
if (builtinGlossaryToggle) {
    builtinGlossaryToggle.addEventListener("change", () => {
        void saveBuiltinGlossaryEnabled(builtinGlossaryToggle.checked).then(() => showSaved(builtinGlossaryToggle.checked ? "默认术语库已启用" : "默认术语库已停用"));
    });
}
createGlossaryButton?.addEventListener("click", () => openGlossaryEditor(null));
saveGlossaryButton?.addEventListener("click", () => void saveGlossaryEditor());
cancelGlossaryButton?.addEventListener("click", closeGlossaryEditor);
closeGlossaryEditorButton?.addEventListener("click", closeGlossaryEditor);
deleteGlossaryButton?.addEventListener("click", () => void deleteEditingGlossary());
if (imageToggle) {
    imageToggle.addEventListener("change", () => {
        void saveImageTranslationEnabled(imageToggle.checked).then(() => showSaved(imageToggle.checked ? "图片翻译已开启" : "图片翻译已关闭"));
    });
}
neverSiteAdd?.addEventListener("click", () => addSiteRule("never"));
alwaysSiteAdd?.addEventListener("click", () => addSiteRule("always"));
neverSiteInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        event.preventDefault();
        addSiteRule("never");
    }
});
alwaysSiteInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        event.preventDefault();
        addSiteRule("always");
    }
});
neverLanguageAdd?.addEventListener("click", () => addLanguageRule("never"));
alwaysLanguageAdd?.addEventListener("click", () => addLanguageRule("always"));
if (downloadPackButton) {
    downloadPackButton.addEventListener("click", () => {
        const pack = packs.find((item) => item.language === packSelect?.value);
        if (pack)
            void changePack(pack, downloadPackButton);
    });
}

imageOcrAction?.addEventListener("click", () => void changeImageOcrModels());
imageOcrProfileSelect?.addEventListener("change", () => {
    const nextId = imageOcrProfileSelect.value;
    if (!nextId) return;
    void saveImageOcrProfileId(nextId).then(async () => {
        await refreshImageOcrStatus();
        showSaved("图片识别语种包已切换");
    });
});
selectionQuickButtonToggle?.addEventListener("change", () => {
    void saveSelectionQuickTranslateButton(selectionQuickButtonToggle.checked).then(() => {
        showSaved(selectionQuickButtonToggle.checked ? "已开启划词浮动翻译按钮" : "已关闭划词浮动翻译按钮");
    });
});
clearCacheButton?.addEventListener("click", () => void clearTranslationCache());
if (updatePolicy) {
    updatePolicy.addEventListener("change", () => {
        const value = updatePolicy.value;
        const policy: ModelUpdatePolicy = value === "notify" || value === "manual" ? value : "auto";
        void saveModelUpdatePolicy(policy).then(() => showSaved("模型更新策略已保存"));
    });
}
if (checkUpdates) {
    checkUpdates.addEventListener("click", () => {
        void (async () => {
            checkUpdates.disabled = true;
            checkUpdates.textContent = "检查中…";
            showSaved("正在检查 Firefox 模型更新…", 60_000);
            try {
                const response = await sendRuntimeMessage<OptionsRuntimeResponse>({ type: "check-model-updates" });
                if (!response?.ok || !response.catalog)
                    throw new Error(response?.error ?? "检查更新失败");
                applyCatalog(response.catalog);
                renderRuleLists();
                showSaved(response.catalog.updateCount > 0 ? `发现 ${response.catalog.updateCount} 个模型方向有更新` : "所有已安装模型均为最新");
            }
            catch (error) {
                showSaved(error instanceof Error ? error.message : String(error), 5000);
            }
            finally {
                checkUpdates.disabled = false;
                checkUpdates.textContent = "检查更新";
            }
        })();
    });
}

for (const button of manageRuleButtons) {
    button.addEventListener("click", () => {
        const key = button.dataset.manageRules;
        if (key === "always-site" || key === "never-site" || key === "always-language" || key === "never-language") {
            openRulesManager(key);
        }
    });
}
rulesManagerSearch?.addEventListener("input", () => renderRulesManagerDialog());
closeRulesManagerButton?.addEventListener("click", closeRulesManager);
doneRulesManagerButton?.addEventListener("click", closeRulesManager);
rulesManagerDialog?.addEventListener("click", (event) => {
    if (event.target === rulesManagerDialog) closeRulesManager();
});
rulesManagerDialog?.addEventListener("close", () => {
    activeRuleManagerGroup = null;
});
clearAllRulesButton?.addEventListener("click", () => {
    if (!activeRuleManagerGroup) return;
    getRuleGroupDescriptor(activeRuleManagerGroup).clearAll();
});

void initialize().catch((error) => showSaved(error instanceof Error ? error.message : String(error), 5000));
void initializeBilingualStyleSettings().catch((error) => showSaved(error instanceof Error ? error.message : String(error), 5000));
void initializeTranslationEngines().catch((error) => showSaved(error instanceof Error ? error.message : String(error), 5000));
void initializeVideoSubtitleSettings().catch((error) => showSaved(error instanceof Error ? error.message : String(error), 5000));
