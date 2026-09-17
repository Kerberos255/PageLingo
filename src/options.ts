import {
  languageLabel,
  loadSettings,
  normalizeSitePattern,
  saveAutoTranslateEnabled,
  saveDisplayMode,
  saveImageTranslationEnabled,
  saveLanguageRules,
  saveModelUpdatePolicy,
  saveSiteRules,
  saveTargetLanguage,
  type DisplayMode,
  type ModelUpdatePolicy,
} from "./shared/settings";
import { sendRuntimeMessage } from "./shared/runtime-message";
import { initializeTranslationEngines } from "./options-engines";

interface LanguageOption { code: string; label: string }
interface DirectionInfo {
  key: string;
  sourceLanguage: string;
  targetLanguage: string;
  bytes: number;
  version: string;
  installed: boolean;
  updateAvailable: boolean;
  latestVersion: string;
}
interface PackInfo {
  language: string;
  label: string;
  canTranslateFromEnglish: boolean;
  canTranslateToEnglish: boolean;
  totalBytes: number;
  installedBytes: number;
  installed: boolean;
  partial: boolean;
  updateAvailable: boolean;
  directions: DirectionInfo[];
}
interface Catalog {
  sourceLanguages: LanguageOption[];
  targetLanguages: LanguageOption[];
  packs: PackInfo[];
  updateCheckedAt: number;
  updateCount: number;
}
interface ImageOcrStatus {
  installed: boolean;
  runtimeSupported: boolean;
  totalBytes: number;
}
interface ImageOcrResponse {
  ok?: boolean;
  status?: ImageOcrStatus;
  error?: string;
}

const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="display-mode"]'));
const status = document.querySelector<HTMLElement>("#save-status");
const autoToggle = document.querySelector<HTMLInputElement>("#auto-translate-enabled");
const targetSelect = document.querySelector<HTMLSelectElement>("#target-language");
const neverSiteInput = document.querySelector<HTMLInputElement>("#never-site-input");
const neverSiteAdd = document.querySelector<HTMLButtonElement>("#never-site-add");
const neverSiteList = document.querySelector<HTMLElement>("#never-site-list");
const alwaysSiteInput = document.querySelector<HTMLInputElement>("#always-site-input");
const alwaysSiteAdd = document.querySelector<HTMLButtonElement>("#always-site-add");
const alwaysSiteList = document.querySelector<HTMLElement>("#always-site-list");
const neverLanguageSelect = document.querySelector<HTMLSelectElement>("#never-language-select");
const neverLanguageAdd = document.querySelector<HTMLButtonElement>("#never-language-add");
const neverLanguageList = document.querySelector<HTMLElement>("#never-language-list");
const alwaysLanguageSelect = document.querySelector<HTMLSelectElement>("#always-language-select");
const alwaysLanguageAdd = document.querySelector<HTMLButtonElement>("#always-language-add");
const alwaysLanguageList = document.querySelector<HTMLElement>("#always-language-list");
const packSelect = document.querySelector<HTMLSelectElement>("#language-pack-select");
const downloadPackButton = document.querySelector<HTMLButtonElement>("#download-language-pack");
const packList = document.querySelector<HTMLElement>("#language-pack-list");
const updatePolicy = document.querySelector<HTMLSelectElement>("#model-update-policy");
const checkUpdates = document.querySelector<HTMLButtonElement>("#check-model-updates");
const updateStatus = document.querySelector<HTMLElement>("#model-update-status");
const imageToggle = document.querySelector<HTMLInputElement>("#image-translation-enabled");
const imageStatus = document.querySelector<HTMLElement>("#image-ocr-status");
const deleteOcrModels = document.querySelector<HTMLButtonElement>("#delete-image-ocr-models");
const navItems = Array.from(document.querySelectorAll<HTMLAnchorElement>("[data-settings-page]"));
const pages = Array.from(document.querySelectorAll<HTMLElement>(".settings-page"));
let neverTranslateSites: string[] = [];
let alwaysTranslateSites: string[] = [];
let neverTranslateLanguages: string[] = [];
let alwaysTranslateLanguages: string[] = [];
let sourceLanguages: LanguageOption[] = [];
let packs: PackInfo[] = [];

function setChecked(mode: DisplayMode): void {
  for (const radio of radios) radio.checked = radio.value === mode;
}

function showSaved(message = "已保存", timeout = 1600): void {
  if (!status) return;
  status.textContent = message;
  window.setTimeout(() => {
    if (status.textContent === message) status.textContent = "设置会自动保存并立即生效";
  }, timeout);
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function formatCheckedAt(value: number): string {
  if (!value) return "尚未检查更新";
  return `上次检查：${new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(value))}`;
}

function applyCatalog(catalog: Catalog): void {
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

function fillSelect(select: HTMLSelectElement | null, languages: LanguageOption[]): void {
  if (!select) return;
  select.replaceChildren();
  for (const language of languages) {
    const option = document.createElement("option");
    option.value = language.code;
    option.textContent = language.label;
    select.append(option);
  }
}

function renderRuleList(
  container: HTMLElement | null,
  values: readonly string[],
  emptyText: string,
  labelFor: (value: string) => string,
  removeValue: (value: string) => void,
): void {
  if (!container) return;
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

function renderRuleLists(): void {
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

function packRouteLabel(pack: PackInfo): string {
  if (pack.canTranslateFromEnglish && pack.canTranslateToEnglish) return `English ↔ ${pack.label}`;
  if (pack.canTranslateFromEnglish) return `English → ${pack.label}`;
  return `${pack.label} → English`;
}

function renderPackPicker(): void {
  if (!packSelect || !downloadPackButton) return;
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
  if (!packList) return;
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
    const row = document.createElement("div"); row.className = "pack-item";
    const copy = document.createElement("div"); copy.className = "pack-copy";
    const title = document.createElement("strong"); title.textContent = pack.label;
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
      update.type = "button"; update.className = "pack-action"; update.textContent = "更新";
      update.addEventListener("click", () => void updatePack(pack, update));
      const remove = document.createElement("button");
      remove.type = "button"; remove.className = "pack-action danger"; remove.textContent = "删除";
      remove.addEventListener("click", () => void changePack(pack, remove));
      actions.append(update, remove);
    } else {
      const action = document.createElement("button");
      action.type = "button";
      action.className = pack.installed ? "pack-action danger" : "pack-action";
      action.textContent = pack.installed ? "删除" : pack.partial ? "补全" : "下载";
      action.addEventListener("click", () => void changePack(pack, action));
      actions.append(action);
    }
    row.append(copy, state, actions); packList.append(row);
  }
}

async function changePack(pack: PackInfo, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  const deleting = pack.installed;
  button.textContent = deleting ? "删除中…" : "下载中…";
  showSaved(deleting ? `正在删除 ${pack.label}` : `正在下载 ${pack.label} · ${formatBytes(pack.totalBytes)}`, 30_000);
  try {
    const response = await sendRuntimeMessage<{ ok?: boolean; pack?: PackInfo; error?: string }>({ type: deleting ? "delete-language-pack" : "download-language-pack", language: pack.language });
    if (!response?.ok || !response.pack) throw new Error(response?.error ?? "语言包操作失败");
    packs = packs.map((item) => item.language === pack.language ? response.pack! : item);
    renderPacks();
    renderPackPicker();
    showSaved(deleting ? `已删除 ${pack.label}` : `已下载 ${pack.label}`);
  } catch (error) {
    button.disabled = false;
    button.textContent = deleting ? "删除" : "下载";
    showSaved(error instanceof Error ? error.message : String(error), 5000);
  }
}

async function updatePack(pack: PackInfo, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  button.textContent = "更新中…";
  showSaved(`正在安全更新 ${pack.label}`, 60_000);
  try {
    const response = await sendRuntimeMessage<{ ok?: boolean; catalog?: Catalog; error?: string }>({ type: "update-language-pack", language: pack.language });
    if (!response?.ok || !response.catalog) throw new Error(response?.error ?? "模型更新失败");
    applyCatalog(response.catalog);
    showSaved(`${pack.label} 已更新`);
  } catch (error) {
    button.disabled = false;
    button.textContent = "更新";
    showSaved(error instanceof Error ? error.message : String(error), 5000);
  }
}

async function refreshImageOcrStatus(): Promise<void> {
  if (!imageStatus || !deleteOcrModels) return;
  try {
    const response = await sendRuntimeMessage<ImageOcrResponse>({ type: "get-image-ocr-status" });
    if (!response?.ok || !response.status) throw new Error(response?.error ?? "无法读取 OCR 状态");
    const current = response.status;
    imageStatus.textContent = !current.runtimeSupported
      ? "当前 Firefox 环境不支持本地 WASM OCR"
      : current.installed
        ? `PP-OCRv5 Mobile · 已缓存 ${formatBytes(current.totalBytes)}`
        : `PP-OCRv5 Mobile · 首次使用下载约 ${formatBytes(current.totalBytes)}`;
    deleteOcrModels.disabled = !current.installed;
  } catch (error) {
    imageStatus.textContent = error instanceof Error ? error.message : String(error);
    deleteOcrModels.disabled = true;
  }
}

async function initialize(): Promise<void> {
  const [settings, response] = await Promise.all([
    loadSettings(),
    sendRuntimeMessage<{ ok?: boolean; catalog?: Catalog; error?: string }>({ type: "get-language-catalog" }),
  ]);
  if (!response?.ok || !response.catalog) throw new Error(response?.error ?? "无法读取语言目录");
  const catalog = response.catalog;
  applyCatalog(catalog);
  fillSelect(targetSelect, catalog.targetLanguages);
  setChecked(settings.displayMode);
  if (autoToggle) autoToggle.checked = settings.autoTranslateEnabled;
  if (targetSelect) targetSelect.value = catalog.targetLanguages.some((item) => item.code === settings.targetLanguage)
    ? settings.targetLanguage
    : "en";
  if (updatePolicy) updatePolicy.value = settings.modelUpdatePolicy;
  if (imageToggle) imageToggle.checked = settings.imageTranslationEnabled;
  neverTranslateSites = [...settings.neverTranslateSites];
  alwaysTranslateSites = [...settings.alwaysTranslateSites];
  neverTranslateLanguages = [...settings.neverTranslateLanguages];
  alwaysTranslateLanguages = [...settings.alwaysTranslateLanguages];
  renderRuleLists();
  selectSettingsPage(location.hash.slice(1) || "translation");
  await refreshImageOcrStatus();
}

function selectSettingsPage(pageId: string): void {
  const next = pages.some((page) => page.id === pageId) ? pageId : "translation";
  for (const page of pages) page.classList.toggle("active", page.id === next);
  for (const item of navItems) item.classList.toggle("active", item.dataset.settingsPage === next);
}

function addSiteRule(kind: "never" | "always"): void {
  const input = kind === "never" ? neverSiteInput : alwaysSiteInput;
  if (!input) return;
  const site = normalizeSitePattern(input.value);
  if (!site) {
    showSaved("网址格式不正确");
    input.focus();
    return;
  }
  if (kind === "never") {
    neverTranslateSites = Array.from(new Set([...neverTranslateSites, site])).sort();
    alwaysTranslateSites = alwaysTranslateSites.filter((item) => item !== site);
  } else {
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
  if (!language) return;
  if (kind === "never") {
    neverTranslateLanguages = Array.from(new Set([...neverTranslateLanguages, language])).sort();
    alwaysTranslateLanguages = alwaysTranslateLanguages.filter((item) => item !== language);
  } else {
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
    if (radio.checked) void saveDisplayMode(radio.value as DisplayMode).then(() => showSaved());
  });
}

for (const item of navItems) {
  item.addEventListener("click", () => selectSettingsPage(item.dataset.settingsPage ?? "translation"));
}
window.addEventListener("hashchange", () => selectSettingsPage(location.hash.slice(1) || "translation"));

autoToggle?.addEventListener("change", () => void saveAutoTranslateEnabled(autoToggle.checked).then(() => showSaved()));
targetSelect?.addEventListener("change", () => void saveTargetLanguage(targetSelect.value).then(() => showSaved()));
imageToggle?.addEventListener("change", () => {
  void saveImageTranslationEnabled(imageToggle.checked).then(() => showSaved(imageToggle.checked ? "图片翻译已开启" : "图片翻译已关闭"));
});

neverSiteAdd?.addEventListener("click", () => addSiteRule("never"));
alwaysSiteAdd?.addEventListener("click", () => addSiteRule("always"));
neverSiteInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); addSiteRule("never"); }
});
alwaysSiteInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); addSiteRule("always"); }
});
neverLanguageAdd?.addEventListener("click", () => addLanguageRule("never"));
alwaysLanguageAdd?.addEventListener("click", () => addLanguageRule("always"));

downloadPackButton?.addEventListener("click", () => {
  const pack = packs.find((item) => item.language === packSelect?.value);
  if (pack) void changePack(pack, downloadPackButton);
});

deleteOcrModels?.addEventListener("click", () => {
  void (async () => {
    deleteOcrModels.disabled = true;
    showSaved("正在删除 OCR 模型…", 30_000);
    try {
      const response = await sendRuntimeMessage<ImageOcrResponse>({ type: "delete-image-ocr-models" });
      if (!response?.ok) throw new Error(response?.error ?? "删除 OCR 模型失败");
      await refreshImageOcrStatus();
      showSaved("OCR 模型已删除");
    } catch (error) {
      showSaved(error instanceof Error ? error.message : String(error), 5000);
      await refreshImageOcrStatus();
    }
  })();
});

updatePolicy?.addEventListener("change", () => {
  void saveModelUpdatePolicy(updatePolicy.value as ModelUpdatePolicy).then(() => showSaved("模型更新策略已保存"));
});

checkUpdates?.addEventListener("click", () => {
  void (async () => {
    checkUpdates.disabled = true;
    checkUpdates.textContent = "检查中…";
    showSaved("正在检查 Firefox 模型更新…", 60_000);
    try {
      const response = await sendRuntimeMessage<{ ok?: boolean; catalog?: Catalog; error?: string }>({ type: "check-model-updates" });
      if (!response?.ok || !response.catalog) throw new Error(response?.error ?? "检查更新失败");
      applyCatalog(response.catalog);
      renderRuleLists();
      showSaved(response.catalog.updateCount > 0 ? `发现 ${response.catalog.updateCount} 个模型方向有更新` : "所有已安装模型均为最新");
    } catch (error) {
      showSaved(error instanceof Error ? error.message : String(error), 5000);
    } finally {
      checkUpdates.disabled = false;
      checkUpdates.textContent = "检查更新";
    }
  })();
});

void initialize().catch((error) => showSaved(error instanceof Error ? error.message : String(error), 5000));
void initializeTranslationEngines().catch((error) => showSaved(error instanceof Error ? error.message : String(error), 5000));
