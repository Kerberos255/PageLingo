import { PageTranslator } from "./core/page-translator";
import { RuntimeMessageProvider } from "./providers/runtime-message-provider";
import {
  isSiteExcluded,
  languageLabel,
  loadSettings,
  normalizeDetectedLanguage,
  normalizeDisplayMode,
  type ManualSourceLanguage,
} from "./shared/settings";

let translator: PageTranslator | null = null;

interface PageLanguageInfo {
  declaredLanguage: string | null;
  detectedLanguage: string | null;
  effectiveLanguage: string | null;
  percentage: number;
  isReliable: boolean;
  sampleLength: number;
}

interface ContentMessage {
  type?: string;
  sourceLanguage?: ManualSourceLanguage;
  targetLanguage?: string;
}

function ensureStyle(): void {
  if (document.getElementById("flt-style")) return;
  const style = document.createElement("style");
  style.id = "flt-style";
  style.dataset.fltGenerated = "style";
  style.textContent = `
    .flt-translation { display: block !important; margin-block-start: 0.28em !important; font: inherit !important; line-height: inherit !important; letter-spacing: inherit !important; text-transform: none !important; }
    .flt-source-hidden { display: none !important; }
    .flt-source-content-hidden { font-size: 0 !important; line-height: 0 !important; }
    .flt-source-content-hidden > :not(.flt-translation) { display: none !important; }
    .flt-source-content-hidden > .flt-translation { margin-block-start: 0 !important; font-size: var(--pagelingo-source-font-size) !important; line-height: var(--pagelingo-source-line-height) !important; }
    .flt-source-content-hidden::marker { font-size: var(--pagelingo-source-font-size) !important; }
  `;
  document.documentElement.append(style);
}

function pageTextSample(): string {
  const root = document.querySelector<HTMLElement>("article, main, [role='main']") ?? document.body;
  if (!root) return "";
  return (root.innerText || root.textContent || "").replace(/\s+/g, " ").trim().slice(0, 4096);
}

async function detectPageLanguage(): Promise<PageLanguageInfo> {
  const declaredLanguage = normalizeDetectedLanguage(document.documentElement.lang);
  const sample = pageTextSample();
  if (!sample) return { declaredLanguage, detectedLanguage: null, effectiveLanguage: declaredLanguage, percentage: 0, isReliable: false, sampleLength: 0 };

  try {
    const result = await browser.i18n.detectLanguage(sample);
    const top = result.languages?.[0];
    const detectedLanguage = normalizeDetectedLanguage(top?.language);
    const percentage = Math.round(top?.percentage ?? 0);
    const isReliable = Boolean(result.isReliable && sample.length >= 150 && percentage >= 60);
    return {
      declaredLanguage,
      detectedLanguage,
      effectiveLanguage: isReliable ? detectedLanguage : (declaredLanguage ?? detectedLanguage),
      percentage,
      isReliable,
      sampleLength: sample.length,
    };
  } catch {
    return { declaredLanguage, detectedLanguage: null, effectiveLanguage: declaredLanguage, percentage: 0, isReliable: false, sampleLength: sample.length };
  }
}

async function resolveSourceLanguage(sourceLanguage: ManualSourceLanguage): Promise<string> {
  if (sourceLanguage !== "auto") return normalizeDetectedLanguage(sourceLanguage) ?? sourceLanguage;
  const info = await detectPageLanguage();
  if (info.effectiveLanguage) return info.effectiveLanguage;
  throw new Error("无法可靠识别当前页面语言，请手动选择原文语言");
}

async function canTranslate(sourceLanguage: string, targetLanguage: string): Promise<boolean> {
  const response = await browser.runtime.sendMessage({ type: "can-translate", sourceLanguage, targetLanguage }) as { ok?: boolean; supported?: boolean };
  return response?.ok === true && response.supported === true;
}

async function translatePage(sourceLanguage: ManualSourceLanguage, targetLanguage: string): Promise<number> {
  const settings = await loadSettings();
  const resolvedSource = await resolveSourceLanguage(sourceLanguage);
  const normalizedTarget = normalizeDetectedLanguage(targetLanguage) ?? targetLanguage;
  if (resolvedSource === normalizedTarget) throw new Error("当前页面已经是目标语言");
  if (!await canTranslate(resolvedSource, normalizedTarget)) {
    throw new Error(`当前本地模型不支持 ${languageLabel(resolvedSource)} → ${languageLabel(normalizedTarget)}`);
  }

  ensureStyle();
  translator?.restore();
  translator = new PageTranslator(document, new RuntimeMessageProvider(), {
    sourceLanguage: resolvedSource,
    targetLanguage: normalizedTarget,
    concurrency: 4,
    displayMode: settings.displayMode,
  });
  const count = await translator.translateAll();
  translator.observe();
  return count;
}

browser.runtime.onMessage.addListener(async (message: ContentMessage) => {
  if (message.type === "ping") return { ok: true };
  if (message.type === "get-page-language") return { ok: true, language: await detectPageLanguage() };

  if (message.type === "translate-page") {
    try {
      const settings = await loadSettings();
      const count = await translatePage(message.sourceLanguage ?? "auto", message.targetLanguage ?? settings.targetLanguage);
      return { ok: true, count };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (message.type === "restore-page") {
    translator?.restore();
    translator = null;
    document.getElementById("flt-style")?.remove();
    return { ok: true };
  }
  return undefined;
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.displayMode || !translator) return;
  translator.setDisplayMode(normalizeDisplayMode(changes.displayMode.newValue));
});

async function maybeAutoTranslate(): Promise<void> {
  if (window.top !== window) return;
  const settings = await loadSettings();
  if (!settings.autoTranslateEnabled || isSiteExcluded(location.hostname, settings.excludedSites)) return;
  const info = await detectPageLanguage();
  if (info.effectiveLanguage !== settings.autoSourceLanguage || info.effectiveLanguage === settings.targetLanguage) return;
  try {
    await translatePage(settings.autoSourceLanguage, settings.targetLanguage);
  } catch (error) {
    console.warn("[PageLingo] Automatic translation failed", error);
  }
}

void maybeAutoTranslate();
