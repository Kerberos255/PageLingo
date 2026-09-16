import {
  isSiteExcluded,
  LANGUAGE_LABELS,
  loadSettings,
  saveDisplayMode,
  saveExcludedSites,
  type DisplayMode,
  type ManualSourceLanguage,
  type SupportedTargetLanguage,
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

interface LanguageResponse {
  ok?: boolean;
  language?: {
    effectiveLanguage?: string | null;
    detectedLanguage?: string | null;
    percentage?: number;
    isReliable?: boolean;
  };
}

async function activeTab(): Promise<browser.tabs.Tab> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("找不到当前标签页");
  return tab;
}

function languageLabel(code: string | null | undefined): string {
  if (!code) return "未知语言";
  if (LANGUAGE_LABELS[code]) return LANGUAGE_LABELS[code];
  try {
    return new Intl.DisplayNames(["zh-CN"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function setMode(mode: DisplayMode): void {
  for (const button of modeButtons) {
    button.classList.toggle("active", button.dataset.displayMode === mode);
  }
}

async function refreshLanguage(): Promise<void> {
  try {
    const tab = await activeTab();
    const response = await browser.tabs.sendMessage(tab.id!, { type: "get-page-language" }) as LanguageResponse;
    const info = response?.language;
    const code = info?.effectiveLanguage ?? info?.detectedLanguage ?? null;
    const confidence = info?.percentage ? ` · ${info.percentage}%` : "";
    if (detectedEl) detectedEl.textContent = `检测到 ${languageLabel(code)}${confidence}`;
    if (sourceSelect?.value === "auto" && code && code !== "en") {
      if (statusEl) statusEl.textContent = `当前本地模型暂未支持 ${languageLabel(code)}`;
    }
  } catch {
    if (detectedEl) detectedEl.textContent = "暂时无法检测当前页面";
  }
}

async function send(type: "translate-page" | "restore-page"): Promise<void> {
  if (statusEl) statusEl.textContent = type === "translate-page" ? "翻译中…" : "恢复中…";
  try {
    const tab = await activeTab();
    const response = await browser.tabs.sendMessage(tab.id!, {
      type,
      sourceLanguage: (sourceSelect?.value ?? "auto") as ManualSourceLanguage,
      targetLanguage: (targetSelect?.value ?? "zh-Hans") as SupportedTargetLanguage,
    }) as { ok?: boolean; count?: number; error?: string };
    if (!response?.ok) throw new Error(response?.error ?? "操作失败");
    if (statusEl) {
      statusEl.textContent = type === "translate-page"
        ? `已翻译 ${response.count ?? 0} 个段落`
        : "已恢复原文";
    }
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
  const stored = await loadSettings();
  setMode(stored.displayMode);
  globalAutoEnabled = stored.autoTranslateEnabled;
  excludedSites = [...stored.excludedSites];
  if (targetSelect) targetSelect.value = stored.targetLanguage;
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
