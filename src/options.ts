import {
  loadSettings,
  normalizeSitePattern,
  saveAutoTranslateEnabled,
  saveDisplayMode,
  saveExcludedSites,
  saveLanguageRule,
  saveModelUpdatePolicy,
  type DisplayMode,
  type ModelUpdatePolicy,
} from "./shared/settings";

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

const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="display-mode"]'));
const status = document.querySelector<HTMLElement>("#save-status");
const autoToggle = document.querySelector<HTMLInputElement>("#auto-translate-enabled");
const sourceSelect = document.querySelector<HTMLSelectElement>("#auto-source-language");
const targetSelect = document.querySelector<HTMLSelectElement>("#target-language");
const exceptionInput = document.querySelector<HTMLInputElement>("#exception-site");
const exceptionAdd = document.querySelector<HTMLButtonElement>("#exception-add");
const exceptionList = document.querySelector<HTMLElement>("#exception-list");
const packList = document.querySelector<HTMLElement>("#language-pack-list");
const updatePolicy = document.querySelector<HTMLSelectElement>("#model-update-policy");
const checkUpdates = document.querySelector<HTMLButtonElement>("#check-model-updates");
const updateStatus = document.querySelector<HTMLElement>("#model-update-status");
let excludedSites: string[] = [];
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
  packs = catalog.packs.sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
  if (updateStatus) {
    updateStatus.textContent = catalog.updateCount > 0
      ? `${formatCheckedAt(catalog.updateCheckedAt)} · ${catalog.updateCount} 个方向有更新`
      : `${formatCheckedAt(catalog.updateCheckedAt)} · 已是最新`;
  }
  renderPacks();
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

function renderExceptions(): void {
  if (!exceptionList) return;
  exceptionList.replaceChildren();
  if (excludedSites.length === 0) {
    const empty = document.createElement("div"); empty.className = "empty-state"; empty.textContent = "暂无例外网站"; exceptionList.append(empty); return;
  }
  for (const site of excludedSites) {
    const row = document.createElement("div"); row.className = "exception-item";
    const label = document.createElement("span"); label.textContent = site;
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "移除";
    remove.addEventListener("click", () => {
      excludedSites = excludedSites.filter((item) => item !== site);
      void saveExcludedSites(excludedSites).then(() => { renderExceptions(); showSaved("已移除例外网站"); });
    });
    row.append(label, remove); exceptionList.append(row);
  }
}

function packRouteLabel(pack: PackInfo): string {
  if (pack.canTranslateFromEnglish && pack.canTranslateToEnglish) return `English ↔ ${pack.label}`;
  if (pack.canTranslateFromEnglish) return `English → ${pack.label}`;
  return `${pack.label} → English`;
}

function renderPacks(): void {
  if (!packList) return;
  packList.replaceChildren();
  for (const pack of packs) {
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
    const response = await browser.runtime.sendMessage({ type: deleting ? "delete-language-pack" : "download-language-pack", language: pack.language }) as { ok?: boolean; pack?: PackInfo; error?: string };
    if (!response?.ok || !response.pack) throw new Error(response?.error ?? "语言包操作失败");
    packs = packs.map((item) => item.language === pack.language ? response.pack! : item);
    renderPacks();
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
    const response = await browser.runtime.sendMessage({ type: "update-language-pack", language: pack.language }) as { ok?: boolean; catalog?: Catalog; error?: string };
    if (!response?.ok || !response.catalog) throw new Error(response?.error ?? "模型更新失败");
    applyCatalog(response.catalog);
    showSaved(`${pack.label} 已更新`);
  } catch (error) {
    button.disabled = false;
    button.textContent = "更新";
    showSaved(error instanceof Error ? error.message : String(error), 5000);
  }
}

async function initialize(): Promise<void> {
  const [settings, response] = await Promise.all([
    loadSettings(),
    browser.runtime.sendMessage({ type: "get-language-catalog" }) as Promise<{ ok?: boolean; catalog?: Catalog; error?: string }>,
  ]);
  if (!response?.ok || !response.catalog) throw new Error(response?.error ?? "无法读取语言目录");
  const catalog = response.catalog;
  applyCatalog(catalog);
  fillSelect(sourceSelect, catalog.sourceLanguages);
  fillSelect(targetSelect, catalog.targetLanguages);
  setChecked(settings.displayMode);
  if (autoToggle) autoToggle.checked = settings.autoTranslateEnabled;
  if (sourceSelect) sourceSelect.value = catalog.sourceLanguages.some((item) => item.code === settings.autoSourceLanguage) ? settings.autoSourceLanguage : "en";
  if (targetSelect) targetSelect.value = catalog.targetLanguages.some((item) => item.code === settings.targetLanguage) ? settings.targetLanguage : "en";
  if (updatePolicy) updatePolicy.value = settings.modelUpdatePolicy;
  excludedSites = [...settings.excludedSites];
  renderExceptions();
}

for (const radio of radios) {
  radio.addEventListener("change", () => { if (radio.checked) void saveDisplayMode(radio.value as DisplayMode).then(() => showSaved()); });
}
autoToggle?.addEventListener("change", () => void saveAutoTranslateEnabled(autoToggle.checked).then(() => showSaved()));

updatePolicy?.addEventListener("change", () => {
  void saveModelUpdatePolicy(updatePolicy.value as ModelUpdatePolicy).then(() => showSaved("模型更新策略已保存"));
});

checkUpdates?.addEventListener("click", () => {
  void (async () => {
    checkUpdates.disabled = true;
    checkUpdates.textContent = "检查中…";
    showSaved("正在检查 Mozilla 模型更新…", 60_000);
    try {
      const response = await browser.runtime.sendMessage({ type: "check-model-updates" }) as { ok?: boolean; catalog?: Catalog; error?: string };
      if (!response?.ok || !response.catalog) throw new Error(response?.error ?? "检查更新失败");
      applyCatalog(response.catalog);
      showSaved(response.catalog.updateCount > 0 ? `发现 ${response.catalog.updateCount} 个模型方向有更新` : "所有已安装模型均为最新");
    } catch (error) {
      showSaved(error instanceof Error ? error.message : String(error), 5000);
    } finally {
      checkUpdates.disabled = false;
      checkUpdates.textContent = "检查更新";
    }
  })();
});

function saveRule(): void {
  if (!sourceSelect || !targetSelect) return;
  void saveLanguageRule(sourceSelect.value, targetSelect.value).then(() => showSaved());
}
sourceSelect?.addEventListener("change", saveRule);
targetSelect?.addEventListener("change", saveRule);

function addException(): void {
  if (!exceptionInput) return;
  const site = normalizeSitePattern(exceptionInput.value);
  if (!site) { showSaved("网址格式不正确"); exceptionInput.focus(); return; }
  if (!excludedSites.includes(site)) excludedSites.push(site);
  excludedSites.sort(); exceptionInput.value = "";
  void saveExcludedSites(excludedSites).then(() => { renderExceptions(); showSaved("已添加例外网站"); });
}
exceptionAdd?.addEventListener("click", addException);
exceptionInput?.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); addException(); } });

void initialize().catch((error) => showSaved(error instanceof Error ? error.message : String(error), 5000));
