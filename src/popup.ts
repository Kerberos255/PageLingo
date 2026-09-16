import {
  isSiteExcluded,
  languageLabel,
  loadSettings,
  saveDisplayMode,
  saveExcludedSites,
  saveTargetLanguage,
  type DisplayMode,
} from "./shared/settings";

const statusEl = document.querySelector<HTMLElement>("#status");
const detectedEl = document.querySelector<HTMLElement>("#detected-language");
const translate = document.querySelector<HTMLButtonElement>("#translate");
const restore = document.querySelector<HTMLButtonElement>("#restore");
const settingsButton = document.querySelector<HTMLButtonElement>("#settings");
const sourceSelect = document.querySelector<HTMLSelectElement>("#source-language");
const targetSelect = document.querySelector<HTMLSelectElement>("#target-language");
const siteAuto = document.querySelector<HTMLInputElement>("#site-auto");
const siteAutoHint = document.querySelector<HTMLElement>("#site-auto-hint");
const modeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-display-mode]"));
let currentHostname = "";
let excludedSites: string[] = [];
let globalAutoEnabled = false;
let detectedCode: string | null = null;

interface LanguageOption { code: string; label: string }
interface CatalogResponse {
  ok?: boolean;
  catalog?: { sourceLanguages: LanguageOption[]; targetLanguages: LanguageOption[] };
}
interface LanguageResponse {
  ok?: boolean;
  language?: { effectiveLanguage?: string | null; detectedLanguage?: string | null; percentage?: number; isReliable?: boolean };
}

async function activeTab(): Promise<browser.tabs.Tab> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("找不到当前标签页");
  return tab;
}

function fillSelect(select: HTMLSelectElement | null, languages: LanguageOption[], includeAuto = false): void {
  if (!select) return;
  select.replaceChildren();
  if (includeAuto) {
    const option = document.createElement("option");
    option.value = "auto";
    option.textContent = "自动检测";
    select.append(option);
  }
  for (const language of languages) {
    const option = document.createElement("option");
    option.value = language.code;
    option.textContent = language.label;
    select.append(option);
  }
}

function setMode(mode: DisplayMode): void {
  for (const button of modeButtons) button.classList.toggle("active", button.dataset.displayMode === mode);
}

async function routeSupported(source: string, target: string): Promise<boolean> {
  if (source === target) return false;
  const response = await browser.runtime.sendMessage({ type: "can-translate", sourceLanguage: source, targetLanguage: target }) as { ok?: boolean; supported?: boolean };
  return response?.ok === true && response.supported === true;
}

async function refreshLanguage(): Promise<void> {
  try {
    const tab = await activeTab();
    const response = await browser.tabs.sendMessage(tab.id!, { type: "get-page-language" }) as LanguageResponse;
    const info = response?.language;
    detectedCode = info?.effectiveLanguage ?? info?.detectedLanguage ?? null;
    const confidence = info?.percentage ? ` · ${info.percentage}%` : "";
    if (detectedEl) detectedEl.textContent = `检测到 ${detectedCode ? languageLabel(detectedCode) : "未知语言"}${confidence}`;

    const source = sourceSelect?.value === "auto" ? detectedCode : sourceSelect?.value;
    const target = targetSelect?.value;
    if (source && target && !await routeSupported(source, target)) {
      if (statusEl) statusEl.textContent = source === target ? "当前页面已经是目标语言" : `暂不支持 ${languageLabel(source)} → ${languageLabel(target)}`;
    } else if (statusEl && statusEl.textContent?.startsWith("暂不支持")) {
      statusEl.textContent = "就绪";
    }
  } catch {
    detectedCode = null;
    if (detectedEl) detectedEl.textContent = "暂时无法检测当前页面";
  }
}

async function send(type: "translate-page" | "restore-page"): Promise<void> {
  if (statusEl) statusEl.textContent = type === "translate-page" ? "准备本地模型并翻译…" : "恢复中…";
  try {
    const tab = await activeTab();
    const response = await browser.tabs.sendMessage(tab.id!, {
      type,
      sourceLanguage: sourceSelect?.value ?? "auto",
      targetLanguage: targetSelect?.value ?? "zh-Hans",
    }) as { ok?: boolean; count?: number; error?: string };
    if (!response?.ok) throw new Error(response?.error ?? "操作失败");
    if (statusEl) statusEl.textContent = type === "translate-page" ? `已翻译 ${response.count ?? 0} 个段落` : "已恢复原文";
  } catch (error) {
    if (statusEl) statusEl.textContent = error instanceof Error ? error.message : String(error);
  }
}

function refreshSiteAuto(): void {
  if (!siteAuto || !siteAutoHint) return;
  siteAuto.disabled = !globalAutoEnabled || !currentHostname;
  siteAuto.checked = globalAutoEnabled && currentHostname !== "" && !isSiteExcluded(currentHostname, excludedSites);
  siteAutoHint.textContent = globalAutoEnabled ? "此网站" : "请先在设置中开启自动翻译";
}

translate?.addEventListener("click", () => void send("translate-page"));
restore?.addEventListener("click", () => void send("restore-page"));
settingsButton?.addEventListener("click", () => void browser.runtime.openOptionsPage());
sourceSelect?.addEventListener("change", () => void refreshLanguage());
targetSelect?.addEventListener("change", () => {
  void saveTargetLanguage(targetSelect.value).then(() => refreshLanguage());
});

for (const button of modeButtons) {
  button.addEventListener("click", () => {
    const mode = button.dataset.displayMode as DisplayMode;
    void saveDisplayMode(mode).then(() => setMode(mode));
  });
}

siteAuto?.addEventListener("change", () => {
  if (!currentHostname || !globalAutoEnabled) return;
  const normalized = currentHostname.replace(/^www\./, "").toLowerCase();
  excludedSites = siteAuto.checked
    ? excludedSites.filter((site) => site !== normalized)
    : Array.from(new Set([...excludedSites, normalized])).sort();
  void saveExcludedSites(excludedSites).then(refreshSiteAuto);
});

void (async () => {
  const [stored, catalogResponse] = await Promise.all([
    loadSettings(),
    browser.runtime.sendMessage({ type: "get-language-catalog" }) as Promise<CatalogResponse>,
  ]);
  const catalog = catalogResponse?.catalog;
  fillSelect(sourceSelect, catalog?.sourceLanguages ?? [{ code: "en", label: "English" }], true);
  fillSelect(targetSelect, catalog?.targetLanguages ?? [{ code: "zh-Hans", label: "简体中文" }]);
  if (sourceSelect) sourceSelect.value = "auto";
  if (targetSelect) targetSelect.value = Array.from(targetSelect.options).some((option) => option.value === stored.targetLanguage) ? stored.targetLanguage : "en";

  setMode(stored.displayMode);
  globalAutoEnabled = stored.autoTranslateEnabled;
  excludedSites = [...stored.excludedSites];
  try {
    const tab = await activeTab();
    if (tab.url) currentHostname = new URL(tab.url).hostname;
  } catch {
    currentHostname = "";
  }
  refreshSiteAuto();
  await refreshLanguage();
})();

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.displayMode) setMode(changes.displayMode.newValue === "translation" ? "translation" : "bilingual");
});
