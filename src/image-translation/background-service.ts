import {
  getDocLayoutBundle,
  getImageOcrBundle,
  getImageOcrStatus,
  deleteImageOcrModels,
  type DocLayoutBundle,
  type ImageOcrBundle,
} from "./ocr-cache";
import { mergeOcrRegions, type OcrRegion } from "./ocr-layout";
import { MAX_OCR_IMAGE_SIDE } from "./ocr-models";
import { buildPdfBlocksFromOcr, type LayoutMaskPlan } from "../reader/pdf-ocr-layout";
import { loadSettings } from "../shared/settings";
import { sendFrameMessage } from "../shared/main-frame-message";

const IMAGE_MENU_ID = "pagelingo-translate-image";
const PAGE_MENU_ID = "pagelingo-translate-page";
const SELECTION_MENU_ID = "pagelingo-translate-selection";
const LEGACY_RETRANSLATE_SEGMENT_MENU_ID = "pagelingo-retranslate-segment";
const OPEN_PDF_MENU_ID = "pagelingo-open-pdf-reader";

interface ImageRuntimeMessage {
  type?: string;
  url?: unknown;
  width?: unknown;
  height?: unknown;
  pageWidth?: unknown;
  pageHeight?: unknown;
  pageNumber?: unknown;
  pixels?: unknown;
  requestId?: unknown;
  profileId?: unknown;
}

interface WorkerProgressMessage {
  type: "progress";
  id: number;
  status: string;
  progress?: number;
}

interface WorkerResultMessage {
  type: "result";
  id: number;
  regions: OcrRegion[];
}

interface WorkerDocumentResultMessage {
  type: "document-result";
  id: number;
  plan: LayoutMaskPlan;
  regions: OcrRegion[];
}

interface WorkerErrorMessage {
  type: "error";
  id: number;
  error: string;
}

type WorkerMessage =
  | WorkerProgressMessage
  | WorkerResultMessage
  | WorkerDocumentResultMessage
  | WorkerErrorMessage;

interface PendingOcr {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  progress: (status: string, progress?: number) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface ContextMenuFrameInfo {
  frameId?: number | undefined;
  srcUrl?: string | undefined;
}

class ImageOcrWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private initializedProfileId = "";
  private initializedLayoutPreset = "";
  private readonly pending = new Map<number, PendingOcr>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(browser.runtime.getURL("image-ocr-worker.js"), { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.type === "progress") {
        pending.progress(message.status, message.progress);
        return;
      }
      this.pending.delete(message.id);
      globalThis.clearTimeout(pending.timeoutId);
      if (message.type === "error") {
        this.initializedProfileId = "";
        this.initializedLayoutPreset = "";
        pending.reject(new Error(message.error));
        return;
      }
      if (message.type === "document-result") {
        pending.resolve({ plan: message.plan, regions: message.regions });
        return;
      }
      pending.resolve(message.regions);
    });
    worker.addEventListener("error", (event) => {
      const error = new Error(event.message || "OCR Worker failed");
      for (const pending of this.pending.values()) {
        globalThis.clearTimeout(pending.timeoutId);
        pending.reject(error);
      }
      this.pending.clear();
      this.initializedProfileId = "";
      this.initializedLayoutPreset = "";
      this.worker?.terminate();
      this.worker = null;
    });
    this.worker = worker;
    return worker;
  }

  recognize(
    width: number,
    height: number,
    pixels: ArrayBuffer,
    bundle: ImageOcrBundle,
    progress: (status: string, progress?: number) => void,
  ): Promise<OcrRegion[]> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    const initialize = this.initializedProfileId !== bundle.profile.id;
    return new Promise((resolve, reject) => {
      const timeoutId = globalThis.setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        this.initializedProfileId = "";
        this.initializedLayoutPreset = "";
        pending.reject(new Error("OCR 处理超时，请重新尝试"));
        this.worker?.terminate();
        this.worker = null;
      }, 120_000);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        progress,
        timeoutId,
      });
      const message = {
        type: "recognize",
        id,
        profileId: bundle.profile.id,
        modelPreset: bundle.profile.modelPreset,
        dictionaryFormat: bundle.profile.dictionaryFormat,
        width,
        height,
        pixels,
        detectionModel: initialize ? bundle.detectionModel.slice(0) : undefined,
        recognitionModel: initialize ? bundle.recognitionModel.slice(0) : undefined,
        dictionary: initialize ? bundle.dictionary : undefined,
      };
      const transfer: Transferable[] = [pixels];
      if (message.detectionModel && message.recognitionModel) transfer.push(message.detectionModel, message.recognitionModel);
      worker.postMessage(message, transfer);
      if (initialize) this.initializedProfileId = bundle.profile.id;
    });
  }

  recognizeDocumentPage(
    width: number,
    height: number,
    pixels: ArrayBuffer,
    ocrBundle: ImageOcrBundle,
    layoutBundle: DocLayoutBundle,
    progress: (status: string, progress?: number) => void,
  ): Promise<{ plan: LayoutMaskPlan; regions: OcrRegion[] }> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    const initOcr = this.initializedProfileId !== ocrBundle.profile.id;
    const initLayout = this.initializedLayoutPreset !== layoutBundle.asset.preset;
    return new Promise((resolve, reject) => {
      const timeoutId = globalThis.setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        this.initializedProfileId = "";
        this.initializedLayoutPreset = "";
        pending.reject(new Error("扫描页 OCR 处理超时，请重试"));
        this.worker?.terminate();
        this.worker = null;
      }, 180_000);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        progress,
        timeoutId,
      });
      const message = {
        type: "recognize-document-page",
        id,
        profileId: ocrBundle.profile.id,
        modelPreset: ocrBundle.profile.modelPreset,
        dictionaryFormat: ocrBundle.profile.dictionaryFormat,
        layoutPreset: layoutBundle.asset.preset,
        width,
        height,
        pixels,
        detectionModel: initOcr ? ocrBundle.detectionModel.slice(0) : undefined,
        recognitionModel: initOcr ? ocrBundle.recognitionModel.slice(0) : undefined,
        dictionary: initOcr ? ocrBundle.dictionary : undefined,
        layoutModel: initLayout ? layoutBundle.model.slice(0) : undefined,
      };
      const transfer: Transferable[] = [pixels];
      if (message.detectionModel && message.recognitionModel) {
        transfer.push(message.detectionModel, message.recognitionModel);
      }
      if (message.layoutModel) transfer.push(message.layoutModel);
      worker.postMessage(message, transfer);
      if (initOcr) this.initializedProfileId = ocrBundle.profile.id;
      if (initLayout) this.initializedLayoutPreset = layoutBundle.asset.preset;
    });
  }

  reset(): void {
    this.initializedProfileId = "";
    this.initializedLayoutPreset = "";
    this.worker?.postMessage({ type: "reset" });
  }
}

const ocrWorker = new ImageOcrWorkerClient();

async function sendProgress(
  sender: browser.runtime.MessageSender,
  status: string,
  requestId?: string,
  progress?: number,
  messageType = "image-translation-progress",
): Promise<void> {
  const tabId = sender.tab?.id;
  if (!tabId) return;
  try {
    await browser.tabs.sendMessage(
      tabId,
      { type: messageType, status, requestId, progress },
      { frameId: sender.frameId ?? 0 },
    );
  } catch {
    // The originating page may have navigated while OCR was running.
  }
}

function isAllowedImageUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "data:";
  } catch {
    return false;
  }
}

async function rasterizeSvg(svg: Blob): Promise<Blob> {
  const url = URL.createObjectURL(svg);
  try {
    // Firefox can display SVG in an image element even when createImageBitmap
    // rejects the same SVG bytes. Decode here, outside the site's image CSP.
    const image = new Image();
    image.src = url;
    await image.decode();
    const { naturalWidth, naturalHeight } = image;
    if (!naturalWidth || !naturalHeight) throw new Error("SVG 图片尺寸无效");
    const scale = Math.min(1, MAX_OCR_IMAGE_SIDE / Math.max(naturalWidth, naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建 SVG 图片画布");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => {
      canvas.toBlob((png) => png ? resolve(png) : reject(new Error("无法读取 SVG 图片像素")), "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function handleImageRuntimeMessage(
  rawMessage: unknown,
  sender: browser.runtime.MessageSender,
): Promise<unknown | undefined> {
  const message = rawMessage as ImageRuntimeMessage;
  if (message.type === "get-image-ocr-status") {
    const settings = await loadSettings();
    const profileId = typeof message.profileId === "string" && message.profileId.trim()
      ? message.profileId.trim()
      : settings.imageOcrProfileId;
    return { ok: true, status: await getImageOcrStatus(profileId) };
  }

  if (message.type === "download-image-ocr-models") {
    try {
      const settings = await loadSettings();
      const profileId = typeof message.profileId === "string" && message.profileId.trim()
        ? message.profileId.trim()
        : settings.imageOcrProfileId;
      const status = await getImageOcrStatus(profileId);
      if (!status.runtimeSupported) throw new Error("当前 Firefox 环境不支持本地文字识别");
      await getImageOcrBundle(profileId);
      return { ok: true, status: await getImageOcrStatus(settings.imageOcrProfileId) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (message.type === "delete-image-ocr-models") {
    const settings = await loadSettings();
    const profileId = typeof message.profileId === "string" && message.profileId.trim()
      ? message.profileId.trim()
      : settings.imageOcrProfileId;
    await deleteImageOcrModels(profileId);
    ocrWorker.reset();
    return { ok: true, status: await getImageOcrStatus(settings.imageOcrProfileId) };
  }

  if (message.type === "fetch-document-bytes") {
    if (typeof message.url !== "string" || !/^https?:\/\//i.test(message.url)) {
      return { ok: false, error: "仅支持通过 HTTP/HTTPS 打开在线文档，本地文件请直接拖入阅读器" };
    }
    try {
      const response = await fetch(message.url, { cache: "force-cache", credentials: "omit" });
      if (!response.ok) throw new Error(`文档读取失败：HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 64 * 1024 * 1024) {
        throw new Error("文档体积超过 64 MB 限制");
      }
      return {
        ok: true,
        bytes,
        contentType: response.headers.get("content-type") || "application/octet-stream",
        finalUrl: response.url || message.url,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (message.type === "fetch-image-bytes") {
    if (typeof message.url !== "string" || !isAllowedImageUrl(message.url)) {
      return { ok: false, error: "不支持的图片地址" };
    }
    try {
      const response = await fetch(message.url, { cache: "force-cache", credentials: "omit" });
      if (!response.ok) throw new Error(`图片读取失败：HTTP ${response.status}`);
      const source = await response.blob();
      const image = source.type.split(";", 1)[0] === "image/svg+xml" ? await rasterizeSvg(source) : source;
      return {
        ok: true,
        bytes: await image.arrayBuffer(),
        contentType: image.type || "application/octet-stream",
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (message.type === "recognize-image") {
    const width = typeof message.width === "number" ? Math.round(message.width) : 0;
    const height = typeof message.height === "number" ? Math.round(message.height) : 0;
    const requestId = typeof message.requestId === "string" ? message.requestId : undefined;
    if (width <= 0 || height <= 0 || !(message.pixels instanceof ArrayBuffer)) {
      return { ok: false, error: "无效的图片像素数据" };
    }
    try {
      const settings = await loadSettings();
      const profileId = typeof message.profileId === "string" && message.profileId.trim()
        ? message.profileId.trim()
        : settings.imageOcrProfileId;
      const bundle = await getImageOcrBundle(profileId, (status: string) => {
        void sendProgress(sender, status, requestId, 0.12);
      });
      await sendProgress(sender, "正在检测图片文字", requestId, 0.2);
      // Copy pixels before transferring message.pixels to the worker (transfer detaches the buffer).
      const pixelSnapshot = new Uint8ClampedArray(message.pixels.slice(0));
      const regions = await ocrWorker.recognize(width, height, message.pixels, bundle, (status, progress) => {
        void sendProgress(sender, status, requestId, progress);
      });
      return {
        ok: true,
        regions: mergeOcrRegions(
          regions.filter((region) => region.confidence >= 0.25),
          { pixels: pixelSnapshot, width, height },
        ),
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (message.type === "recognize-pdf-page") {
    const width = typeof message.width === "number" ? Math.round(message.width) : 0;
    const height = typeof message.height === "number" ? Math.round(message.height) : 0;
    const pageWidth = typeof message.pageWidth === "number" && message.pageWidth > 0 ? message.pageWidth : width;
    const pageHeight = typeof message.pageHeight === "number" && message.pageHeight > 0 ? message.pageHeight : height;
    const pageNumber = typeof message.pageNumber === "number" && message.pageNumber >= 1 ? Math.round(message.pageNumber) : 1;
    const requestId = typeof message.requestId === "string" ? message.requestId : undefined;
    if (width <= 0 || height <= 0 || !(message.pixels instanceof ArrayBuffer)) {
      return { ok: false, error: "无效的 PDF 页面像素数据" };
    }
    try {
      const settings = await loadSettings();
      const profileId = typeof message.profileId === "string" && message.profileId.trim()
        ? message.profileId.trim()
        : settings.imageOcrProfileId;
      const [layoutBundle, ocrBundle] = await Promise.all([
        getDocLayoutBundle((status) => {
          void sendProgress(sender, status, requestId, 0.08, "pdf-ocr-progress");
        }),
        getImageOcrBundle(profileId, (status) => {
          void sendProgress(sender, status, requestId, 0.16, "pdf-ocr-progress");
        }),
      ]);
      await sendProgress(sender, "正在分析版面并保护公式/图表…", requestId, 0.24, "pdf-ocr-progress");
      const { plan, regions } = await ocrWorker.recognizeDocumentPage(
        width,
        height,
        message.pixels,
        ocrBundle,
        layoutBundle,
        (status, progress) => {
          void sendProgress(sender, status, requestId, progress, "pdf-ocr-progress");
        },
      );
      const blocks = buildPdfBlocksFromOcr(plan, regions, width, height, pageWidth, pageHeight, pageNumber);
      return {
        ok: true,
        blocks,
        visualCount: plan.visualBlocks.length,
        ocrLineCount: regions.length,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return undefined;
}

async function removeContextMenu(id: string): Promise<void> {
  try {
    await browser.contextMenus.remove(id);
  } catch {
    // Missing menu is expected during first startup.
  }
}

async function syncContextMenu(): Promise<void> {
  await Promise.all([
    removeContextMenu(IMAGE_MENU_ID),
    removeContextMenu(PAGE_MENU_ID),
    removeContextMenu(SELECTION_MENU_ID),
    removeContextMenu(LEGACY_RETRANSLATE_SEGMENT_MENU_ID),
    removeContextMenu(OPEN_PDF_MENU_ID),
  ]);
  const settings = await loadSettings();
  // Firefox folds an extension's context menu into a submenu whenever >=2 items are
  // simultaneously visible in the same context. Keep page, selection, and image actions
  // disjoint so each stays directly clickable in the top-level menu before and after translation.
  browser.contextMenus.create({
    id: SELECTION_MENU_ID,
    title: "PageLingo · 翻译所选内容",
    contexts: ["selection"],
  });
  browser.contextMenus.create({
    id: PAGE_MENU_ID,
    title: "PageLingo · 翻译文字",
    contexts: ["page", "link"],
  });
  browser.contextMenus.create({
    id: OPEN_PDF_MENU_ID,
    title: "PageLingo · 在阅读器中打开 PDF",
    contexts: ["link"],
    targetUrlPatterns: ["http://*/*.pdf*", "https://*/*.pdf*", "http://*/*.PDF*", "https://*/*.PDF*"],
  });
  if (settings.imageTranslationEnabled) {
    browser.contextMenus.create({
      id: IMAGE_MENU_ID,
      title: "PageLingo · 翻译图片",
      contexts: ["image"],
    });
  }
}

function sendContextMessage(
  tabId: number,
  info: browser.contextMenus.OnClickData | ContextMenuFrameInfo,
  message: unknown,
): Promise<unknown> {
  const options = typeof info.frameId === "number" ? { frameId: info.frameId } : undefined;
  return browser.tabs.sendMessage(tabId, message, options);
}

async function refreshContextMenuTitles(
  info: ContextMenuFrameInfo,
  tab?: browser.tabs.Tab,
): Promise<void> {
  if (!tab?.id) return;
  try {
    const state = await sendContextMessage(tab.id, info, {
      type: "get-context-menu-state",
      srcUrl: typeof info.srcUrl === "string" ? info.srcUrl : undefined,
    }) as { pageTranslated?: boolean; imageTranslated?: boolean } | undefined;
    await browser.contextMenus.update(PAGE_MENU_ID, {
      title: state?.pageTranslated ? "PageLingo · 显示原文" : "PageLingo · 翻译文字",
    });
    if (typeof info.srcUrl === "string") {
      try {
        await browser.contextMenus.update(IMAGE_MENU_ID, {
          title: state?.imageTranslated ? "PageLingo · 还原图片" : "PageLingo · 翻译图片",
        });
      } catch {
        // Image translation may be disabled, so the image menu may not exist.
      }
    }
    if (typeof browser.contextMenus.refresh === "function") await browser.contextMenus.refresh();
  } catch {
    try {
      await browser.contextMenus.update(PAGE_MENU_ID, { title: "PageLingo · 翻译文字" });
      if (typeof browser.contextMenus.refresh === "function") await browser.contextMenus.refresh();
    } catch {
      // Ignore if menu is not ready yet.
    }
  }
}

export function initializeImageTranslation(): void {
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab?.id) return;
    if (info.menuItemId === SELECTION_MENU_ID) {
      const selectionText = typeof info.selectionText === "string" ? info.selectionText : undefined;
      void sendFrameMessage(tab.id, info.frameId ?? 0, {
        type: "translate-selection",
        selectionText,
      }).catch(() => undefined);
      return;
    }
    if (info.menuItemId === OPEN_PDF_MENU_ID && typeof info.linkUrl === "string") {
      const readerUrl = `${browser.runtime.getURL("reader.html")}?url=${encodeURIComponent(info.linkUrl)}`;
      void browser.tabs.create({ url: readerUrl }).catch(() => undefined);
      return;
    }
    if (info.menuItemId === IMAGE_MENU_ID && typeof info.srcUrl === "string") {
      void sendFrameMessage(tab.id, info.frameId ?? 0, { type: "toggle-image-translation", srcUrl: info.srcUrl }).catch(() => undefined);
      return;
    }
    if (info.menuItemId === PAGE_MENU_ID) {
      void sendFrameMessage(tab.id, info.frameId ?? 0, { type: "toggle-page-translation" }).catch(() => undefined);
    }
  });
  browser.contextMenus.onShown?.addListener((info, tab) => {
    void refreshContextMenuTitles(info, tab);
  });
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.imageTranslationEnabled) void syncContextMenu();
  });
  browser.runtime.onInstalled.addListener(() => void syncContextMenu());
  browser.runtime.onStartup.addListener(() => void syncContextMenu());
  void syncContextMenu();
}
