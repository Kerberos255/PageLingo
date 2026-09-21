// @ts-nocheck
import { languageLabel, loadSettings, normalizeSitePattern, saveAutoTranslateEnabled, saveDisplayMode, saveImageTranslationEnabled, saveLanguageRules, saveModelUpdatePolicy, saveSiteRules, saveTargetLanguage, saveBuiltinGlossaryEnabled, saveGlossaryCollections, glossaryEntriesToText, parseGlossaryEditorText } from "./shared/settings";
import { sendRuntimeMessage } from "./shared/runtime-message";
import { initializeTranslationEngines } from "./options-engines";
var radios = Array.from(document.querySelectorAll('input[name="display-mode"]'));
var status = document.querySelector("#save-status");
var autoToggle = document.querySelector("#auto-translate-enabled");
var targetSelect = document.querySelector("#target-language");
var neverSiteInput = document.querySelector("#never-site-input");
var neverSiteAdd = document.querySelector("#never-site-add");
var neverSiteList = document.querySelector("#never-site-list");
var alwaysSiteInput = document.querySelector("#always-site-input");
var alwaysSiteAdd = document.querySelector("#always-site-add");
var alwaysSiteList = document.querySelector("#always-site-list");
var neverLanguageSelect = document.querySelector("#never-language-select");
var neverLanguageAdd = document.querySelector("#never-language-add");
var neverLanguageList = document.querySelector("#never-language-list");
var alwaysLanguageSelect = document.querySelector("#always-language-select");
var alwaysLanguageAdd = document.querySelector("#always-language-add");
var alwaysLanguageList = document.querySelector("#always-language-list");
var packSelect = document.querySelector("#language-pack-select");
var downloadPackButton = document.querySelector("#download-language-pack");
var packList = document.querySelector("#language-pack-list");
var updatePolicy = document.querySelector("#model-update-policy");
var checkUpdates = document.querySelector("#check-model-updates");
var updateStatus = document.querySelector("#model-update-status");
var imageToggle = document.querySelector("#image-translation-enabled");
var builtinGlossaryToggle = document.querySelector("#builtin-glossary-enabled");
var glossaryCollectionList = document.querySelector("#glossary-collection-list");
var createGlossaryButton = document.querySelector("#create-glossary");
var glossaryEditor = document.querySelector("#glossary-editor");
var glossaryEditorTitle = document.querySelector("#glossary-editor-title");
var glossaryNameInput = document.querySelector("#glossary-name");
var glossaryEntriesTextarea = document.querySelector("#glossary-entries");
var saveGlossaryButton = document.querySelector("#save-glossary");
var cancelGlossaryButton = document.querySelector("#cancel-glossary");
var closeGlossaryEditorButton = document.querySelector("#close-glossary-editor");
var deleteGlossaryButton = document.querySelector("#delete-glossary");
var imageStatus = document.querySelector("#image-ocr-status");
var deleteOcrModels = document.querySelector("#delete-image-ocr-models");
var navItems = Array.from(document.querySelectorAll("[data-settings-page]"));
var pages = Array.from(document.querySelectorAll(".settings-page"));
var neverTranslateSites = [];
var alwaysTranslateSites = [];
var neverTranslateLanguages = [];
var alwaysTranslateLanguages = [];
var sourceLanguages = [];
var packs = [];
var glossaryCollections = [];
var editingGlossaryId = null;
function setChecked(mode) {
    for (const radio of radios)
        radio.checked = radio.value === mode;
}
function showSaved(message = "已保存", timeout = 1600) {
    if (!status)
        return;
    status.textContent = message;
    window.setTimeout(() => {
        if (status.textContent === message)
            status.textContent = "设置会自动保存并立即生效";
    }, timeout);
}
function formatBytes(bytes) {
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}
function formatCheckedAt(value) {
    if (!value)
        return "尚未检查更新";
    return `上次检查：${new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(value))}`;
}
function applyCatalog(catalog) {
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
function fillSelect(select, languages) {
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
function renderRuleList(container, values, emptyText, labelFor, removeValue) {
    if (!container)
        return;
    container.replaceChildren();
    if (values.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.textContent = emptyText;
        container.append(empty);
        return;
    }
    for (const value of values) {
        const row = document.createElement("div");
        row.className = "exception-item";
        const label = document.createElement("span");
        label.textContent = labelFor(value);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "移除";
        remove.addEventListener("click", () => removeValue(value));
        row.append(label, remove);
        container.append(row);
    }
}
function renderRuleLists() {
    renderRuleList(neverSiteList, neverTranslateSites, "暂无网址", (value) => value, (value) => {
        neverTranslateSites = neverTranslateSites.filter((item) => item !== value);
        void saveSiteRules(neverTranslateSites, alwaysTranslateSites).then(() => { renderRuleLists(); showSaved(); });
    });
    renderRuleList(alwaysSiteList, alwaysTranslateSites, "暂无网址", (value) => value, (value) => {
        alwaysTranslateSites = alwaysTranslateSites.filter((item) => item !== value);
        void saveSiteRules(neverTranslateSites, alwaysTranslateSites).then(() => { renderRuleLists(); showSaved(); });
    });
    renderRuleList(neverLanguageList, neverTranslateLanguages, "暂无语言", languageLabel, (value) => {
        neverTranslateLanguages = neverTranslateLanguages.filter((item) => item !== value);
        void saveLanguageRules(neverTranslateLanguages, alwaysTranslateLanguages).then(() => { renderRuleLists(); showSaved(); });
    });
    renderRuleList(alwaysLanguageList, alwaysTranslateLanguages, "暂无语言", languageLabel, (value) => {
        alwaysTranslateLanguages = alwaysTranslateLanguages.filter((item) => item !== value);
        void saveLanguageRules(neverTranslateLanguages, alwaysTranslateLanguages).then(() => { renderRuleLists(); showSaved(); });
    });
}
function packRouteLabel(pack) {
    if (pack.canTranslateFromEnglish && pack.canTranslateToEnglish)
        return `English ↔ ${pack.label}`;
    if (pack.canTranslateFromEnglish)
        return `English → ${pack.label}`;
    return `${pack.label} → English`;
}
function renderPackPicker() {
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
function renderPacks() {
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
        const versions = Array.from(new Set(pack.directions.map((direction) => direction.version))).map((version) => `v${version}`).join(" / ");
        const detail = document.createElement("small");
        detail.textContent = `${packRouteLabel(pack)} · ${formatBytes(pack.totalBytes)}${versions ? ` · ${versions}` : ""}`;
        copy.append(title, detail);
        const state = document.createElement("span");
        state.className = `pack-state ${pack.updateAvailable && pack.installed ? "update" : pack.installed ? "installed" : pack.partial ? "partial" : ""}`;
        state.textContent = pack.updateAvailable && pack.installed ? "有更新" : pack.installed ? "已下载" : pack.partial ? "部分已下载" : "未下载";
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
            action.textContent = pack.installed ? "删除" : pack.partial ? "补全" : "下载";
            action.addEventListener("click", () => void changePack(pack, action));
            actions.append(action);
        }
        row.append(copy, state, actions);
        packList.append(row);
    }
}
async function changePack(pack, button) {
    button.disabled = true;
    const deleting = pack.installed;
    button.textContent = deleting ? "删除中…" : "下载中…";
    showSaved(deleting ? `正在删除 ${pack.label}` : `正在下载 ${pack.label} · ${formatBytes(pack.totalBytes)}`, 30_000);
    try {
        const response = await sendRuntimeMessage({ type: deleting ? "delete-language-pack" : "download-language-pack", language: pack.language });
        if (!response?.ok || !response.pack)
            throw new Error(response?.error ?? "语言包操作失败");
        packs = packs.map((item) => item.language === pack.language ? response.pack : item);
        renderPacks();
        renderPackPicker();
        showSaved(deleting ? `已删除 ${pack.label}` : `已下载 ${pack.label}`);
    }
    catch (error) {
        button.disabled = false;
        button.textContent = deleting ? "删除" : "下载";
        showSaved(error instanceof Error ? error.message : String(error), 5000);
    }
}
async function updatePack(pack, button) {
    button.disabled = true;
    button.textContent = "更新中…";
    showSaved(`正在安全更新 ${pack.label}`, 60_000);
    try {
        const response = await sendRuntimeMessage({ type: "update-language-pack", language: pack.language });
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
function glossarySummary(collection) {
    const protect = collection.entries.filter((entry) => entry.mode === "protect").length;
    const replace = collection.entries.length - protect;
    const parts = [];
    if (protect) parts.push(`${protect} 个保留原文`);
    if (replace) parts.push(`${replace} 个指定译法`);
    return parts.length ? parts.join(" · ") : "暂无术语";
}
async function persistGlossaryCollections(message = "术语库已保存") {
    await saveGlossaryCollections(glossaryCollections);
    renderGlossaryCollections();
    showSaved(message);
}
function renderGlossaryCollections() {
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
function openGlossaryEditor(id = null) {
    editingGlossaryId = id;
    const collection = id ? glossaryCollections.find((item) => item.id === id) : null;
    if (glossaryEditorTitle) glossaryEditorTitle.textContent = collection ? "编辑术语库" : "新建术语库";
    if (glossaryNameInput) glossaryNameInput.value = collection?.name ?? "";
    if (glossaryEntriesTextarea) glossaryEntriesTextarea.value = collection ? glossaryEntriesToText(collection.entries) : "";
    if (deleteGlossaryButton) deleteGlossaryButton.hidden = !collection;
    if (glossaryEditor) glossaryEditor.hidden = false;
    glossaryNameInput?.focus();
    glossaryEditor?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function closeGlossaryEditor() {
    editingGlossaryId = null;
    if (glossaryEditor) glossaryEditor.hidden = true;
}
async function saveGlossaryEditor() {
    const name = glossaryNameInput?.value.trim() ?? "";
    if (!name) { showSaved("请填写术语库名称", 3000); glossaryNameInput?.focus(); return; }
    const entries = parseGlossaryEditorText(glossaryEntriesTextarea?.value ?? "");
    if (editingGlossaryId) {
        const index = glossaryCollections.findIndex((item) => item.id === editingGlossaryId);
        if (index >= 0) glossaryCollections[index] = { ...glossaryCollections[index], name, entries };
    } else {
        glossaryCollections.push({ id: createGlossaryId(), name, enabled: true, entries });
    }
    await persistGlossaryCollections("术语库已保存");
    closeGlossaryEditor();
}
async function deleteEditingGlossary() {
    if (!editingGlossaryId) return;
    glossaryCollections = glossaryCollections.filter((item) => item.id !== editingGlossaryId);
    await persistGlossaryCollections("术语库已删除");
    closeGlossaryEditor();
}
async function refreshImageOcrStatus() {
    if (!imageStatus || !deleteOcrModels)
        return;
    try {
        const response = await sendRuntimeMessage({ type: "get-image-ocr-status" });
        if (!response?.ok || !response.status)
            throw new Error(response?.error ?? "无法读取 OCR 状态");
        const current = response.status;
        imageStatus.textContent = !current.runtimeSupported
            ? "当前 Firefox 环境不支持本地 WASM OCR"
            : current.installed
                ? `PP-OCRv5 Mobile · 已缓存 ${formatBytes(current.totalBytes)}`
                : `PP-OCRv5 Mobile · 首次使用下载约 ${formatBytes(current.totalBytes)}`;
        deleteOcrModels.disabled = !current.installed;
    }
    catch (error) {
        imageStatus.textContent = error instanceof Error ? error.message : String(error);
        deleteOcrModels.disabled = true;
    }
}
async function initialize() {
    const [settings, response] = await Promise.all([
        loadSettings(),
        sendRuntimeMessage({ type: "get-language-catalog" }),
    ]);
    if (!response?.ok || !response.catalog)
        throw new Error(response?.error ?? "无法读取语言目录");
    const catalog = response.catalog;
    applyCatalog(catalog);
    fillSelect(targetSelect, catalog.targetLanguages);
    setChecked(settings.displayMode);
    if (autoToggle)
        autoToggle.checked = settings.autoTranslateEnabled;
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
    await refreshImageOcrStatus();
}
function selectSettingsPage(pageId) {
    const next = pages.some((page) => page.id === pageId) ? pageId : "translation";
    for (const page of pages)
        page.classList.toggle("active", page.id === next);
    for (const item of navItems)
        item.classList.toggle("active", item.dataset.settingsPage === next);
}
function addSiteRule(kind) {
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
function addLanguageRule(kind) {
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
        if (radio.checked)
            void saveDisplayMode(radio.value).then(() => showSaved());
    });
}
for (const item of navItems) {
    item.addEventListener("click", () => selectSettingsPage(item.dataset.settingsPage ?? "translation"));
}
window.addEventListener("hashchange", () => selectSettingsPage(location.hash.slice(1) || "translation"));
autoToggle?.addEventListener("change", () => void saveAutoTranslateEnabled(autoToggle.checked).then(() => showSaved()));
targetSelect?.addEventListener("change", () => void saveTargetLanguage(targetSelect.value).then(() => showSaved()));
builtinGlossaryToggle?.addEventListener("change", () => {
    void saveBuiltinGlossaryEnabled(builtinGlossaryToggle.checked).then(() => showSaved(builtinGlossaryToggle.checked ? "默认术语库已启用" : "默认术语库已停用"));
});
createGlossaryButton?.addEventListener("click", () => openGlossaryEditor(null));
saveGlossaryButton?.addEventListener("click", () => void saveGlossaryEditor());
cancelGlossaryButton?.addEventListener("click", closeGlossaryEditor);
closeGlossaryEditorButton?.addEventListener("click", closeGlossaryEditor);
deleteGlossaryButton?.addEventListener("click", () => void deleteEditingGlossary());
imageToggle?.addEventListener("change", () => {
    void saveImageTranslationEnabled(imageToggle.checked).then(() => showSaved(imageToggle.checked ? "图片翻译已开启" : "图片翻译已关闭"));
});
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
downloadPackButton?.addEventListener("click", () => {
    const pack = packs.find((item) => item.language === packSelect?.value);
    if (pack)
        void changePack(pack, downloadPackButton);
});
deleteOcrModels?.addEventListener("click", () => {
    void (async () => {
        deleteOcrModels.disabled = true;
        showSaved("正在删除 OCR 模型…", 30_000);
        try {
            const response = await sendRuntimeMessage({ type: "delete-image-ocr-models" });
            if (!response?.ok)
                throw new Error(response?.error ?? "删除 OCR 模型失败");
            await refreshImageOcrStatus();
            showSaved("OCR 模型已删除");
        }
        catch (error) {
            showSaved(error instanceof Error ? error.message : String(error), 5000);
            await refreshImageOcrStatus();
        }
    })();
});
updatePolicy?.addEventListener("change", () => {
    void saveModelUpdatePolicy(updatePolicy.value).then(() => showSaved("模型更新策略已保存"));
});
checkUpdates?.addEventListener("click", () => {
    void (async () => {
        checkUpdates.disabled = true;
        checkUpdates.textContent = "检查中…";
        showSaved("正在检查 Firefox 模型更新…", 60_000);
        try {
            const response = await sendRuntimeMessage({ type: "check-model-updates" });
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
void initialize().catch((error) => showSaved(error instanceof Error ? error.message : String(error), 5000));
void initializeTranslationEngines().catch((error) => showSaved(error instanceof Error ? error.message : String(error), 5000));
