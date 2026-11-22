import {
  isSiteListed,
  languageLabel,
  loadSettings,
  normalizeDetectedLanguage,
  saveAutoTranslateEnabled,
  saveDisplayMode,
  saveSiteRules,
  saveTargetLanguage,
  type DisplayMode,
} from "./shared/settings";
import { sendRuntimeMessage } from "./shared/runtime-message";
import { sendMainFrameMessage } from "./shared/main-frame-message";
import { requestExternalTranslationConsent } from "./shared/data-consent";
import {
  BUILTIN_GOOGLE_ENGINE_ID,
  BUILTIN_MICROSOFT_ENGINE_ID,
  LOCAL_TRANSLATION_ENGINE_ID,
  isBuiltinFreeEngineId,
} from "./shared/translation-engine-settings";
import {
  applyTerminologyCorrectionsHtml,
  escapeHtml,
  parseTerminology,
  protectTerminologyHtml,
  restoreTerminologyHtml,
  terminologyForText,
} from "./core/rich-segment";
import { RuntimeMessageProvider } from "./providers/runtime-message-provider";

const statusEl = document.querySelector<HTMLElement>("#status");
const detectedEl = document.querySelector<HTMLElement>("#detected-language");
const translate = document.querySelector<HTMLButtonElement>("#translate");
const restore = document.querySelector<HTMLButtonElement>("#restore");
const settingsButton = document.querySelector<HTMLButtonElement>("#settings");
const sourceSelect = document.querySelector<HTMLSelectElement>("#source-language");
const targetSelect = document.querySelector<HTMLSelectElement>("#target-language");
const engineSelect = document.querySelector<HTMLSelectElement>("#active-engine");
const siteAuto = document.querySelector<HTMLInputElement>("#site-auto");
const siteAutoHint = document.querySelector<HTMLElement>("#site-auto-hint");
const modeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-display-mode]"));
const textSourceSelect = document.querySelector<HTMLSelectElement>("#text-source-language");
const textTargetSelect = document.querySelector<HTMLSelectElement>("#text-target-language");
const textSwapButton = document.querySelector<HTMLButtonElement>("#text-swap-language");
const textInput = document.querySelector<HTMLTextAreaElement>("#text-translate-input");
const textMeta = document.querySelector<HTMLElement>("#text-translate-meta");
const textClearButton = document.querySelector<HTMLButtonElement>("#text-translate-clear");
const textSubmitButton = document.querySelector<HTMLButtonElement>("#text-translate-submit");
const textResultWrap = document.querySelector<HTMLElement>("#text-translate-result-wrap");
const textResultEl = document.querySelector<HTMLElement>("#text-translate-result");
const textResultLangEl = document.querySelector<HTMLElement>("#text-translate-result-lang");
const textCopyButton = document.querySelector<HTMLButtonElement>("#text-translate-copy");
let currentHostname = "";
let neverTranslateSites: string[] = [];
let alwaysTranslateSites: string[] = [];
let neverTranslateLanguages: string[] = [];
let alwaysTranslateLanguages: string[] = [];
let globalAutoEnabled = false;
let detectedCode: string | null = null;
let storedTargetLanguage = "zh-Hans";
let lastTextDetectedLanguage: string | null = null;
let textTranslateSeq = 0;
let copyResetTimer: ReturnType<typeof setTimeout> | null = null;
let pageTranslated = false;
let engineSwitchedSinceTranslate = false;
let lastTextTranslationKey = "";

interface LanguageOption { code: string; label: string }
interface CatalogResponse {
  ok?: boolean;
  catalog?: { sourceLanguages: LanguageOption[]; targetLanguages: LanguageOption[] };
}
interface EngineItemView {
  id: string;
  name: string;
  enabled: boolean;
  hasApiKey: boolean;
}
interface EngineStateResponse {
  ok?: boolean;
  state?: {
    activeEngineId: string;
    engines?: EngineItemView[];
  };
  error?: string;
}
interface LanguageResponse {
  ok?: boolean;
  pageTranslated?: boolean;
  language?: { effectiveLanguage?: string | null; detectedLanguage?: string | null; percentage?: number; isReliable?: boolean };
}

let activeEngineId = LOCAL_TRANSLATION_ENGINE_ID;
let configuredEngines: EngineItemView[] = [];

async function activeTab(): Promise<browser.tabs.Tab> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("找不到当前标签页");
  return tab;
}

function engineLabel(id: string): string {
  if (id === LOCAL_TRANSLATION_ENGINE_ID) return "Firefox 本地翻译";
  if (id === BUILTIN_MICROSOFT_ENGINE_ID) return "微软翻译";
  if (id === BUILTIN_GOOGLE_ENGINE_ID) return "Google 翻译";
  return configuredEngines.find((item) => item.id === id)?.name ?? "外部引擎";
}

function renderEngineSelect(): void {
  if (!engineSelect) return;
  engineSelect.replaceChildren();
  const builtins: Array<{ id: string; label: string }> = [
    { id: LOCAL_TRANSLATION_ENGINE_ID, label: "Firefox 本地翻译" },
    { id: BUILTIN_MICROSOFT_ENGINE_ID, label: "微软翻译" },
    { id: BUILTIN_GOOGLE_ENGINE_ID, label: "Google 翻译" },
  ];
  for (const item of builtins) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.label;
    engineSelect.append(option);
  }
  for (const engine of configuredEngines.filter((item) => item.enabled)) {
    const option = document.createElement("option");
    option.value = engine.id;
    option.textContent = engine.name;
    engineSelect.append(option);
  }
  engineSelect.value = activeEngineId;
  if (engineSelect.value !== activeEngineId) {
    activeEngineId = LOCAL_TRANSLATION_ENGINE_ID;
    engineSelect.value = LOCAL_TRANSLATION_ENGINE_ID;
  }
}

function applyEngineState(state: EngineStateResponse["state"]): void {
  if (!state) return;
  activeEngineId = typeof state.activeEngineId === "string" ? state.activeEngineId : LOCAL_TRANSLATION_ENGINE_ID;
  configuredEngines = Array.isArray(state.engines) ? state.engines : [];
  renderEngineSelect();
}

async function refreshEngines(): Promise<void> {
  if (!engineSelect) return;
  try {
    const response = await sendRuntimeMessage<EngineStateResponse>({ type: "get-translation-engines" });
    if (response?.ok && response.state) applyEngineState(response.state);
  } catch {
    renderEngineSelect();
  }
}

function syncTranslateButton(): void {
  if (!translate) return;
  const forceMode = pageTranslated && !engineSwitchedSinceTranslate;
  translate.textContent = forceMode ? "重新翻译" : "翻译本页";
  translate.title = forceMode ? "跳过缓存，重新翻译当前页面" : "";
}

async function switchEngine(nextId: string): Promise<void> {
  if (!engineSelect) return;
  const previousId = activeEngineId;
  try {
    if (nextId !== LOCAL_TRANSLATION_ENGINE_ID) {
      const builtinFree = isBuiltinFreeEngineId(nextId);
      const engine = builtinFree ? null : configuredEngines.find((item) => item.id === nextId);
      if (!builtinFree && !engine) throw new Error("找不到所选翻译引擎");
      const granted = await requestExternalTranslationConsent(Boolean(engine?.hasApiKey));
      if (!granted) {
        engineSelect.value = previousId;
        throw new Error("未授权向外部翻译服务发送网页内容");
      }
    }
    const response = await sendRuntimeMessage<EngineStateResponse>({ type: "set-active-translation-engine", id: nextId });
    if (!response?.ok || !response.state) {
      engineSelect.value = previousId;
      throw new Error(response?.error ?? "切换翻译引擎失败");
    }
    applyEngineState(response.state);
    engineSwitchedSinceTranslate = true;
    await refreshLanguage();

    let translatedNow = pageTranslated;
    try {
      const tab = await activeTab();
      const menuState = await sendMainFrameMessage<{ ok?: boolean; pageTranslated?: boolean }>(tab.id!, { type: "get-context-menu-state" });
      translatedNow = menuState?.pageTranslated === true;
      pageTranslated = translatedNow;
    } catch {
      // Non-web tabs do not have a content script.
    }
    syncTranslateButton();
    if (statusEl && !statusEl.textContent?.startsWith("暂不支持") && statusEl.textContent !== "当前页面已经是目标语言") {
      const label = engineLabel(activeEngineId);
      statusEl.textContent = translatedNow
        ? `已切换到 ${label}，可点击「翻译本页」重新翻译`
        : `已切换到 ${label}`;
    }
  } catch (error) {
    engineSelect.value = previousId;
    if (statusEl) statusEl.textContent = error instanceof Error ? error.message : String(error);
  }
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
  for (const button of modeButtons) {
    const active = button.dataset.displayMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

async function routeSupported(source: string, target: string): Promise<boolean> {
  if (source === target) return false;
  const response = await sendRuntimeMessage<{ ok?: boolean; supported?: boolean }>({ type: "can-translate", sourceLanguage: source, targetLanguage: target });
  return response?.ok === true && response.supported === true;
}

async function refreshLanguage(): Promise<void> {
  currentHostname = "";
  try {
    const tab = await activeTab();
    const url = tab.url ? new URL(tab.url) : null;
    currentHostname = url && (url.protocol === "http:" || url.protocol === "https:") ? url.hostname : "";
    const response = await sendMainFrameMessage<LanguageResponse>(tab.id!, { type: "get-page-language" });
    pageTranslated = response?.pageTranslated === true;
    syncTranslateButton();
    const info = response?.language;
    detectedCode = info?.effectiveLanguage ?? info?.detectedLanguage ?? null;
    const confidence = info?.percentage ? ` · ${info.percentage}%` : "";
    if (detectedEl) detectedEl.textContent = `检测到 ${detectedCode ? languageLabel(detectedCode) : "未知语言"}${confidence}`;

    const source = sourceSelect?.value === "auto" ? detectedCode : sourceSelect?.value;
    const target = targetSelect?.value;
    if (source && target && !await routeSupported(source, target)) {
      if (statusEl) statusEl.textContent = source === target ? "当前页面已经是目标语言" : `暂不支持 ${languageLabel(source)} → ${languageLabel(target)}`;
    } else if (statusEl && (statusEl.textContent?.startsWith("暂不支持") || statusEl.textContent === "当前页面已经是目标语言")) {
      statusEl.textContent = "";
    }
    refreshSiteAuto();
  } catch {
    detectedCode = null;
    pageTranslated = false;
    syncTranslateButton();
    if (detectedEl) detectedEl.textContent = "暂时无法检测当前页面";
    refreshSiteAuto();
  }
}

async function send(type: "translate-page" | "restore-page"): Promise<void> {
  const bypassCache = type === "translate-page" && pageTranslated && !engineSwitchedSinceTranslate;
  if (statusEl) {
    statusEl.textContent = type === "translate-page"
      ? (bypassCache ? "正在跳过缓存重新翻译…" : "正在翻译…")
      : "恢复中…";
  }
  try {
    const tab = await activeTab();
    const response = await sendMainFrameMessage<{ok?: boolean; count?: number; failedCount?: number; error?: string}>(tab.id!, {
      type,
      sourceLanguage: sourceSelect?.value ?? "auto",
      targetLanguage: targetSelect?.value ?? "zh-Hans",
      ...(bypassCache ? { bypassCache: true } : {}),
    });
    if (!response?.ok) throw new Error(response?.error ?? "操作失败");
    if (type === "translate-page") {
      pageTranslated = true;
      engineSwitchedSinceTranslate = false;
    } else {
      pageTranslated = false;
      engineSwitchedSinceTranslate = false;
    }
    syncTranslateButton();
    if (statusEl) statusEl.textContent = type === "translate-page"
      ? `${bypassCache ? "已重新翻译" : "已翻译"} ${response.count ?? 0} 个段落${response.failedCount ? `；${response.failedCount} 个未完成，已保留原文` : ""}`
      : "已恢复原文";
  } catch (error) {
    if (statusEl) statusEl.textContent = error instanceof Error ? error.message : String(error);
  }
}

function refreshSiteAuto(): void {
  if (!siteAuto || !siteAutoHint) return;
  siteAuto.disabled = !currentHostname;
  const neverSite = currentHostname !== "" && isSiteListed(currentHostname, neverTranslateSites);
  const alwaysSite = currentHostname !== "" && isSiteListed(currentHostname, alwaysTranslateSites);
  const neverLanguage = Boolean(detectedCode && neverTranslateLanguages.includes(detectedCode));
  const alwaysLanguage = Boolean(detectedCode && alwaysTranslateLanguages.includes(detectedCode));
  siteAuto.checked = Boolean(currentHostname) && !neverSite && (alwaysSite || alwaysLanguage || (globalAutoEnabled && !neverLanguage));
  siteAutoHint.textContent = currentHostname;
}

function selectHasValue(select: HTMLSelectElement | null, value: string): boolean {
  return Boolean(select && Array.from(select.options).some((option) => option.value === value));
}

function guessLanguageByScript(text: string): string | null {
  if (/[\u3040-\u30ff]/u.test(text)) return "ja";
  if (/[\uac00-\ud7af]/u.test(text)) return "ko";
  if (/\p{Script=Han}/u.test(text)) return "zh-Hans";
  if (/\p{Script=Cyrillic}/u.test(text)) return "ru";
  if (/\p{Script=Arabic}/u.test(text)) return "ar";
  if (/[A-Za-z]/.test(text)) return "en";
  return null;
}

async function detectInputLanguage(text: string): Promise<string | null> {
  const sample = text.trim().slice(0, 4096);
  if (!sample) return null;
  try {
    const detection = await browser.i18n?.detectLanguage?.(sample);
    const primary = detection?.languages?.[0];
    if (primary?.language && primary.language !== "und") {
      const normalized = normalizeDetectedLanguage(primary.language);
      if (normalized) return normalized;
    }
  } catch {
    // Fall back to script heuristics when browser.i18n.detectLanguage is unavailable.
  }
  return guessLanguageByScript(sample);
}

function setTextMeta(message: string, isError = false): void {
  if (!textMeta) return;
  textMeta.textContent = message;
  textMeta.classList.toggle("error", isError);
}

function updateTextClearVisibility(): void {
  if (!textClearButton || !textInput) return;
  textClearButton.hidden = textInput.value.length === 0;
}

async function translateInputText(): Promise<void> {
  if (!textInput || !textSubmitButton || !textResultWrap || !textResultEl) return;
  const raw = textInput.value;
  if (!raw.trim()) {
    textResultWrap.hidden = true;
    textResultEl.textContent = "";
    lastTextTranslationKey = "";
    setTextMeta("");
    return;
  }

  const seq = ++textTranslateSeq;
  textSubmitButton.disabled = true;
  textSubmitButton.textContent = "翻译中…";
  setTextMeta("");

  try {
    const selectedSource = textSourceSelect?.value || "auto";
    let targetLanguage = textTargetSelect?.value || storedTargetLanguage || "zh-Hans";
    const sourceLanguage = selectedSource === "auto" ? await detectInputLanguage(raw) : selectedSource;
    if (seq !== textTranslateSeq) return;
    if (!sourceLanguage) throw new Error("无法识别语言，请手动选择原文语言");
    lastTextDetectedLanguage = sourceLanguage;

    if (sourceLanguage === targetLanguage) {
      if (selectedSource === "auto") {
        const pivot = (targetLanguage === "zh-Hans" || targetLanguage === "zh-Hant")
          ? "en"
          : (storedTargetLanguage && storedTargetLanguage !== sourceLanguage ? storedTargetLanguage : "zh-Hans");
        if (pivot !== sourceLanguage && await routeSupported(sourceLanguage, pivot)) {
          targetLanguage = pivot;
        } else {
          throw new Error("输入文本已经是目标语言");
        }
      } else {
        throw new Error("原文和译文语言相同");
      }
    }

    if (activeEngineId === LOCAL_TRANSLATION_ENGINE_ID && !await routeSupported(sourceLanguage, targetLanguage)) {
      throw new Error(`暂不支持 ${languageLabel(sourceLanguage)} → ${languageLabel(targetLanguage)}`);
    }

    const requestKey = `${activeEngineId}\u0000${sourceLanguage}\u0000${targetLanguage}\u0000${raw}`;
    const bypassCache = !textResultWrap.hidden && lastTextTranslationKey === requestKey;

    const settings = await loadSettings();
    if (seq !== textTranslateSeq) return;
    const terminology = parseTerminology(
      settings.glossaryCollections,
      sourceLanguage,
      targetLanguage,
      settings.builtinGlossaryEnabled,
    );
    const provider = new RuntimeMessageProvider();
    const lines = raw.replace(/\r\n?/g, "\n").split("\n");
    const translatedLines = await Promise.all(lines.map(async (line) => {
      if (!line.trim()) return "";
      const protectedLine = protectTerminologyHtml(document, escapeHtml(line), terminology);
      let html = await provider.translateHtml({
        html: protectedLine.html,
        sourceLanguage,
        targetLanguage,
        terminology: terminologyForText(terminology, line),
        ...(bypassCache ? { bypassCache: true } : {}),
      });
      html = restoreTerminologyHtml(document, html, protectedLine.replacements);
      html = applyTerminologyCorrectionsHtml(document, html, line, terminology);
      return new DOMParser().parseFromString(html, "text/html").body.textContent ?? line;
    }));
    if (seq !== textTranslateSeq) return;

    lastTextTranslationKey = requestKey;
    textResultEl.textContent = translatedLines.join("\n");
    textResultWrap.hidden = false;
    if (textResultLangEl) {
      textResultLangEl.textContent = `${languageLabel(sourceLanguage)} → ${languageLabel(targetLanguage)}`;
    }
    if (textCopyButton) textCopyButton.textContent = "复制";
    setTextMeta(bypassCache ? "已跳过缓存重新翻译" : "");
  } catch (error) {
    if (seq !== textTranslateSeq) return;
    setTextMeta(error instanceof Error ? error.message : String(error), true);
  } finally {
    if (seq === textTranslateSeq) {
      textSubmitButton.disabled = false;
      textSubmitButton.textContent = "翻译 ↵";
    }
  }
}

function swapTextLanguages(): void {
  if (!textSourceSelect || !textTargetSelect) return;
  const currentSource = textSourceSelect.value;
  const currentTarget = textTargetSelect.value;
  if (currentSource === "auto") {
    const fallbackTarget = lastTextDetectedLanguage && lastTextDetectedLanguage !== currentTarget
      ? lastTextDetectedLanguage
      : (currentTarget === "zh-Hans" || currentTarget === "zh-Hant" ? "en" : "zh-Hans");
    if (selectHasValue(textSourceSelect, currentTarget) && selectHasValue(textTargetSelect, fallbackTarget)) {
      textSourceSelect.value = currentTarget;
      textTargetSelect.value = fallbackTarget;
    } else if (selectHasValue(textTargetSelect, fallbackTarget)) {
      textTargetSelect.value = fallbackTarget;
    }
  } else if (selectHasValue(textSourceSelect, currentTarget) && selectHasValue(textTargetSelect, currentSource)) {
    textSourceSelect.value = currentTarget;
    textTargetSelect.value = currentSource;
  } else if (selectHasValue(textTargetSelect, currentSource)) {
    textSourceSelect.value = "auto";
    textTargetSelect.value = currentSource;
  }
  if (textInput?.value.trim() && textResultWrap && !textResultWrap.hidden) {
    void translateInputText();
  }
}

translate?.addEventListener("click", () => void send("translate-page"));
restore?.addEventListener("click", () => void send("restore-page"));
settingsButton?.addEventListener("click", () => void browser.runtime.openOptionsPage());
sourceSelect?.addEventListener("change", () => void refreshLanguage());
targetSelect?.addEventListener("change", () => {
  storedTargetLanguage = targetSelect.value;
  void saveTargetLanguage(targetSelect.value).then(() => refreshLanguage());
});
engineSelect?.addEventListener("change", () => void switchEngine(engineSelect.value));
textSubmitButton?.addEventListener("click", () => void translateInputText());
textSwapButton?.addEventListener("click", () => swapTextLanguages());
textSourceSelect?.addEventListener("change", () => {
  if (textInput?.value.trim() && textResultWrap && !textResultWrap.hidden) void translateInputText();
});
textTargetSelect?.addEventListener("change", () => {
  if (textInput?.value.trim() && textResultWrap && !textResultWrap.hidden) void translateInputText();
});
textInput?.addEventListener("input", () => {
  updateTextClearVisibility();
  if (!textInput.value.trim()) {
    setTextMeta("");
    if (textResultWrap) textResultWrap.hidden = true;
  }
});
textInput?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing) return;
  if (event.shiftKey) return;
  if (!event.altKey) {
    event.preventDefault();
    void translateInputText();
  }
});
textClearButton?.addEventListener("click", () => {
  textTranslateSeq += 1;
  lastTextTranslationKey = "";
  if (textInput) textInput.value = "";
  if (textResultEl) textResultEl.textContent = "";
  if (textResultWrap) textResultWrap.hidden = true;
  if (textSubmitButton) {
    textSubmitButton.disabled = false;
    textSubmitButton.textContent = "翻译 ↵";
  }
  setTextMeta("");
  updateTextClearVisibility();
  textInput?.focus();
});
textCopyButton?.addEventListener("click", () => {
  const value = textResultEl?.textContent ?? "";
  if (!value || !navigator.clipboard?.writeText) return;
  void navigator.clipboard.writeText(value).then(() => {
    if (!textCopyButton) return;
    textCopyButton.textContent = "已复制";
    if (copyResetTimer) clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      textCopyButton.textContent = "复制";
    }, 1500);
  }).catch(() => {
    setTextMeta("复制失败，请手动选中复制", true);
  });
});

for (const button of modeButtons) {
  button.addEventListener("click", () => {
    const mode = button.dataset.displayMode as DisplayMode;
    void saveDisplayMode(mode).then(() => setMode(mode));
  });
}

siteAuto?.addEventListener("change", () => {
  if (!currentHostname) return;
  const normalized = currentHostname.replace(/^www\./, "").toLowerCase();
  if (siteAuto.checked) {
    globalAutoEnabled = true;
    neverTranslateSites = neverTranslateSites.filter((site) => site !== normalized);
    alwaysTranslateSites = Array.from(new Set([...alwaysTranslateSites, normalized])).sort();
    void Promise.all([
      saveAutoTranslateEnabled(true),
      saveSiteRules(neverTranslateSites, alwaysTranslateSites),
    ]).then(refreshSiteAuto);
  } else {
    alwaysTranslateSites = alwaysTranslateSites.filter((site) => site !== normalized);
    neverTranslateSites = Array.from(new Set([...neverTranslateSites, normalized])).sort();
    void saveSiteRules(neverTranslateSites, alwaysTranslateSites).then(refreshSiteAuto);
  }
});

void (async () => {
  const [stored, catalogResponse] = await Promise.all([
    loadSettings(),
    sendRuntimeMessage<CatalogResponse>({ type: "get-language-catalog" }),
    refreshEngines(),
  ]);
  const catalog = catalogResponse?.catalog;
  const sourceLanguages = catalog?.sourceLanguages ?? [{ code: "en", label: "English" }];
  const targetLanguages = catalog?.targetLanguages ?? [{ code: "zh-Hans", label: "简体中文" }];
  fillSelect(sourceSelect, sourceLanguages, true);
  fillSelect(targetSelect, targetLanguages);
  fillSelect(textSourceSelect, sourceLanguages, true);
  fillSelect(textTargetSelect, targetLanguages);
  storedTargetLanguage = stored.targetLanguage;
  const resolvedTarget = selectHasValue(targetSelect, stored.targetLanguage) ? stored.targetLanguage : "en";
  if (sourceSelect) sourceSelect.value = "auto";
  if (targetSelect) targetSelect.value = resolvedTarget;
  if (textSourceSelect) textSourceSelect.value = "auto";
  if (textTargetSelect) {
    textTargetSelect.value = selectHasValue(textTargetSelect, stored.targetLanguage) ? stored.targetLanguage : resolvedTarget;
  }

  setMode(stored.displayMode);
  globalAutoEnabled = stored.autoTranslateEnabled;
  neverTranslateSites = [...stored.neverTranslateSites];
  alwaysTranslateSites = [...stored.alwaysTranslateSites];
  neverTranslateLanguages = [...stored.neverTranslateLanguages];
  alwaysTranslateLanguages = [...stored.alwaysTranslateLanguages];
  await refreshLanguage();
})();

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.displayMode) setMode(changes.displayMode.newValue === "translation" ? "translation" : "bilingual");
  if (changes.activeTranslationEngineId || changes.translationEngines) {
    void refreshEngines().then(() => refreshLanguage());
  }
});
