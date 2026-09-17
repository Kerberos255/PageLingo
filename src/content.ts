import { PageTranslator } from "./core/page-translator";
import { RuntimeMessageProvider } from "./providers/runtime-message-provider";
import { sendRuntimeMessage } from "./shared/runtime-message";
import {
  isSiteListed,
  languageLabel,
  loadSettings,
  normalizeDetectedLanguage,
  normalizeDisplayMode,
  type ManualSourceLanguage,
} from "./shared/settings";
import type { OcrRegion } from "./image-translation/ocr-layout";

let translator: PageTranslator | null = null;
const imageOverlays = new Map<HTMLImageElement, HTMLElement>();
let activeImageOverlay: HTMLElement | null = null;

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
  srcUrl?: string;
  status?: string;
}

interface ImageBytesResponse {
  ok?: boolean;
  bytes?: ArrayBuffer;
  contentType?: string;
  error?: string;
}

interface ImageOcrResponse {
  ok?: boolean;
  regions?: OcrRegion[];
  error?: string;
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
  const response = await sendRuntimeMessage<{ ok?: boolean; supported?: boolean }>({ type: "can-translate", sourceLanguage, targetLanguage });
  return response?.ok === true && response.supported === true;
}

async function translationRouteReady(sourceLanguage: string, targetLanguage: string): Promise<boolean> {
  const response = await sendRuntimeMessage<{ ok?: boolean; ready?: boolean }>({
    type: "is-translation-ready",
    sourceLanguage,
    targetLanguage,
  });
  return response?.ok === true && response.ready === true;
}

async function detectRootLanguage(root: HTMLElement): Promise<string | null> {
  const declared = normalizeDetectedLanguage(root.lang || root.closest<HTMLElement>("[lang]")?.lang);
  if (declared) return declared;
  const sample = (root.innerText || root.textContent || "").replace(/\s+/g, " ").trim().slice(0, 1200);
  if (sample.length < 24) return null;
  try {
    const result = await browser.i18n.detectLanguage(sample);
    const top = result.languages?.[0];
    if (!top || (top.percentage ?? 0) < 55) return null;
    return normalizeDetectedLanguage(top.language);
  } catch {
    return null;
  }
}

async function translatePage(
  sourceLanguage: ManualSourceLanguage,
  targetLanguage: string,
): Promise<number> {
  const settings = await loadSettings();
  const resolvedSource = await resolveSourceLanguage(sourceLanguage);
  const normalizedTarget = normalizeDetectedLanguage(targetLanguage) ?? targetLanguage;
  if (resolvedSource === normalizedTarget) throw new Error("当前页面已经是目标语言");
  if (!await canTranslate(resolvedSource, normalizedTarget)) {
    throw new Error(`当前本地模型不支持 ${languageLabel(resolvedSource)} → ${languageLabel(normalizedTarget)}`);
  }

  ensureStyle();
  translator?.restore();
  const shouldTranslateRoot = settings.neverTranslateLanguages.length === 0
    ? undefined
    : async (root: HTMLElement): Promise<boolean> => {
        const rootLanguage = await detectRootLanguage(root);
        if (!rootLanguage) return true;
        if (rootLanguage === normalizedTarget) return false;
        return !settings.neverTranslateLanguages.includes(rootLanguage);
      };
  translator = new PageTranslator(document, new RuntimeMessageProvider(), {
    sourceLanguage: resolvedSource,
    targetLanguage: normalizedTarget,
    concurrency: 4,
    displayMode: settings.displayMode,
    ...(shouldTranslateRoot ? { shouldTranslateRoot } : {}),
  });
  const count = await translator.translateAll();
  translator.observe();
  return count;
}

function normalizeAbsoluteUrl(value: string): string {
  try {
    return new URL(value, document.baseURI).href;
  } catch {
    return value;
  }
}

function findImage(srcUrl: string): HTMLImageElement | null {
  const target = normalizeAbsoluteUrl(srcUrl);
  for (const image of Array.from(document.images)) {
    if (normalizeAbsoluteUrl(image.currentSrc || image.src) === target || normalizeAbsoluteUrl(image.src) === target) return image;
  }
  return null;
}

function positionImageOverlay(image: HTMLImageElement, overlay: HTMLElement): void {
  const rect = image.getBoundingClientRect();
  overlay.style.left = `${rect.left + window.scrollX}px`;
  overlay.style.top = `${rect.top + window.scrollY}px`;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
}

function createImageOverlay(image: HTMLImageElement): HTMLElement {
  imageOverlays.get(image)?.remove();
  const overlay = document.createElement("div");
  overlay.dataset.pagelingoImageOverlay = "true";
  Object.assign(overlay.style, {
    position: "absolute",
    zIndex: "2147483646",
    pointerEvents: "none",
    overflow: "hidden",
    boxSizing: "border-box",
  });
  positionImageOverlay(image, overlay);
  (document.body ?? document.documentElement).append(overlay);
  imageOverlays.set(image, overlay);
  return overlay;
}

function showImageStatus(overlay: HTMLElement, status: string): void {
  let statusEl = overlay.querySelector<HTMLElement>("[data-pagelingo-image-status]");
  if (!statusEl) {
    statusEl = document.createElement("div");
    statusEl.dataset.pagelingoImageStatus = "true";
    Object.assign(statusEl.style, {
      position: "absolute",
      left: "50%",
      top: "12px",
      transform: "translateX(-50%)",
      maxWidth: "calc(100% - 24px)",
      padding: "7px 10px",
      borderRadius: "8px",
      background: "rgba(16, 18, 22, .88)",
      color: "white",
      font: "600 12px/1.35 system-ui, sans-serif",
      textAlign: "center",
      boxShadow: "0 4px 16px rgba(0,0,0,.28)",
      whiteSpace: "normal",
    });
    overlay.append(statusEl);
  }
  statusEl.textContent = `PageLingo · ${status}`;
}

function renderTranslatedRegions(
  image: HTMLImageElement,
  overlay: HTMLElement,
  regions: readonly OcrRegion[],
  ocrWidth: number,
  ocrHeight: number,
): void {
  overlay.replaceChildren();
  positionImageOverlay(image, overlay);
  if (regions.length === 0) {
    showImageStatus(overlay, "未识别到可翻译文字");
    return;
  }
  for (const region of regions) {
    const item = document.createElement("div");
    item.dataset.pagelingoImageItem = "true";
    item.textContent = region.text;
    const left = Math.max(0, Math.min(100, (region.box.x / ocrWidth) * 100));
    const top = Math.max(0, Math.min(100, (region.box.y / ocrHeight) * 100));
    const width = Math.max(1, Math.min(100 - left, (region.box.width / ocrWidth) * 100));
    const height = Math.max(1, Math.min(100 - top, (region.box.height / ocrHeight) * 100));
    Object.assign(item.style, {
      position: "absolute",
      left: `${left}%`,
      top: `${top}%`,
      width: `${width}%`,
      minHeight: `${height}%`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      boxSizing: "border-box",
      padding: "2px 4px",
      borderRadius: "4px",
      background: "rgba(15, 17, 20, .82)",
      color: "white",
      fontFamily: "system-ui, sans-serif",
      fontSize: `${Math.max(10, Math.min(24, (height / 100) * image.getBoundingClientRect().height * 0.72))}px`,
      lineHeight: "1.15",
      textAlign: "center",
      overflow: "hidden",
      overflowWrap: "anywhere",
      textShadow: "0 1px 2px rgba(0,0,0,.45)",
    });
    overlay.append(item);
  }
}

async function imagePixels(srcUrl: string): Promise<{ width: number; height: number; pixels: ArrayBuffer }> {
  const response = await sendRuntimeMessage<ImageBytesResponse>({ type: "fetch-image-bytes", url: srcUrl });
  if (!response?.ok || !(response.bytes instanceof ArrayBuffer)) throw new Error(response?.error ?? "无法读取图片");
  const blob = new Blob([response.bytes], { type: response.contentType || "application/octet-stream" });
  const bitmap = await createImageBitmap(blob);
  try {
    const maxSide = 2200;
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("无法创建图片画布");
    context.drawImage(bitmap, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height).data;
    const pixels = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return { width, height, pixels };
  } finally {
    bitmap.close();
  }
}

function translatedTextFromHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  return (parsed.body.textContent ?? html).replace(/\s+/g, " ").trim();
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function translateOcrRegions(regions: readonly OcrRegion[]): Promise<OcrRegion[]> {
  if (regions.length === 0) return [];
  const settings = await loadSettings();
  const sample = regions.map((region) => region.text).join("\n").slice(0, 4096);
  const detection = await browser.i18n.detectLanguage(sample);
  const sourceLanguage = normalizeDetectedLanguage(detection.languages?.[0]?.language);
  const targetLanguage = normalizeDetectedLanguage(settings.targetLanguage) ?? settings.targetLanguage;
  if (!sourceLanguage) throw new Error("无法识别图片文字语言");
  if (sourceLanguage === targetLanguage) return regions.map((region) => ({ ...region }));
  if (!await canTranslate(sourceLanguage, targetLanguage)) {
    throw new Error(`当前本地模型不支持 ${languageLabel(sourceLanguage)} → ${languageLabel(targetLanguage)}`);
  }
  const provider = new RuntimeMessageProvider();
  return Promise.all(regions.map(async (region) => {
    const html = await provider.translateHtml({
      html: escapeHtml(region.text),
      sourceLanguage,
      targetLanguage,
    });
    return { ...region, text: translatedTextFromHtml(html) || region.text };
  }));
}

async function translateImage(srcUrl: string): Promise<void> {
  const image = findImage(srcUrl);
  if (!image) throw new Error("找不到当前图片，请重新右键后再试");
  const overlay = createImageOverlay(image);
  activeImageOverlay = overlay;
  showImageStatus(overlay, "正在识别图片…");
  try {
    const input = await imagePixels(srcUrl);
    const response = await sendRuntimeMessage<ImageOcrResponse>({
      type: "recognize-image",
      width: input.width,
      height: input.height,
      pixels: input.pixels,
    });
    if (!response?.ok || !Array.isArray(response.regions)) throw new Error(response?.error ?? "图片文字识别失败");
    showImageStatus(overlay, "文字识别完成 · 正在翻译");
    const translated = await translateOcrRegions(response.regions);
    renderTranslatedRegions(image, overlay, translated, input.width, input.height);
  } catch (error) {
    showImageStatus(overlay, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    if (activeImageOverlay === overlay) activeImageOverlay = null;
  }
}

function refreshImageOverlayPositions(): void {
  for (const [image, overlay] of imageOverlays) {
    if (!image.isConnected) {
      overlay.remove();
      imageOverlays.delete(image);
      continue;
    }
    positionImageOverlay(image, overlay);
  }
}

window.addEventListener("resize", refreshImageOverlayPositions, { passive: true });
window.addEventListener("scroll", refreshImageOverlayPositions, { passive: true });

browser.runtime.onMessage.addListener(async (message: ContentMessage) => {
  if (message.type === "image-translation-progress") {
    if (activeImageOverlay && typeof message.status === "string") showImageStatus(activeImageOverlay, message.status);
    return { ok: true };
  }

  if (message.type === "translate-image") {
    try {
      if (typeof message.srcUrl !== "string") throw new Error("图片地址无效");
      await translateImage(message.srcUrl);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

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
  if (isSiteListed(location.hostname, settings.neverTranslateSites)) return;

  const info = await detectPageLanguage();
  const sourceLanguage = info.effectiveLanguage;
  const targetLanguage = normalizeDetectedLanguage(settings.targetLanguage) ?? settings.targetLanguage;
  if (!sourceLanguage || sourceLanguage === targetLanguage) return;

  const alwaysSite = isSiteListed(location.hostname, settings.alwaysTranslateSites);
  if (!alwaysSite && settings.neverTranslateLanguages.includes(sourceLanguage)) return;
  const explicitAlways = alwaysSite || settings.alwaysTranslateLanguages.includes(sourceLanguage);
  if (!explicitAlways) {
    if (!settings.autoTranslateEnabled) return;
    if (!await translationRouteReady(sourceLanguage, targetLanguage)) return;
  }

  try {
    await translatePage(sourceLanguage, targetLanguage);
  } catch (error) {
    console.warn("[PageLingo] Automatic translation failed", error);
  }
}

void maybeAutoTranslate();
