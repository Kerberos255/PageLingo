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
import { fetchBoundedBytes, readResponseBytesWithLimit } from "../shared/bounded-fetch";

const IMAGE_MENU_ID = "pagelingo-translate-image";
const PAGE_MENU_ID = "pagelingo-translate-page";
const SELECTION_MENU_ID = "pagelingo-translate-selection";
const LEGACY_RETRANSLATE_SEGMENT_MENU_ID = "pagelingo-retranslate-segment";
const OPEN_PDF_MENU_ID = "pagelingo-open-pdf-reader";

const DOCUMENT_FETCH_MAX_BYTES = 64 * 1024 * 1024;
const DOCUMENT_FETCH_TIMEOUT_MS = 60_000;
const IMAGE_FETCH_MAX_BYTES = 32 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 30_000;
const OCR_WORKER_IDLE_TIMEOUT_MS = 3 * 60_000;

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

interface ActiveOcrTask {
  id: number;
  generation: number;
  profileId: string;
  layoutPreset?: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  progress: (status: string, progress?: number) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface ContextMenuFrameInfo {
  frameId?: number | undefined;
  srcUrl?: string | undefined;
}

export interface OcrWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerMessage>) => void): void;
  addEventListener(type: "error", listener: (event: { message?: string }) => void): void;
}

export interface ImageOcrWorkerClientOptions {
  createWorker?: () => OcrWorkerLike;
  recognizeTimeoutMs?: number;
  documentTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export class ImageOcrWorkerClient {
  private worker: OcrWorkerLike | null = null;
  private workerGeneration = 0;
  private nextId = 1;
  private initializedProfileId = "";
  private initializedLayoutPreset = "";
  private active: ActiveOcrTask | null = null;
  private readonly queue: Array<() => void> = [];
  private running = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly createWorkerFn: () => OcrWorkerLike;
  private readonly recognizeTimeoutMs: number;
  private readonly documentTimeoutMs: number;
  private readonly idleTimeoutMs: number;

  constructor(options: ImageOcrWorkerClientOptions = {}) {
    this.createWorkerFn = options.createWorker
      ?? (() => new Worker(browser.runtime.getURL("image-ocr-worker.js"), { type: "module" }));
    this.recognizeTimeoutMs = Math.max(10, options.recognizeTimeoutMs ?? 120_000);
    this.documentTimeoutMs = Math.max(10, options.documentTimeoutMs ?? 180_000);
    this.idleTimeoutMs = Math.max(0, options.idleTimeoutMs ?? OCR_WORKER_IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      globalThis.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleIdleTeardown(): void {
    this.clearIdleTimer();
    if (this.idleTimeoutMs <= 0 || !this.worker || this.active || this.queue.length > 0) return;
    const expectedGeneration = this.workerGeneration;
    this.idleTimer = globalThis.setTimeout(() => {
      this.idleTimer = null;
      if (expectedGeneration !== this.workerGeneration || this.active || this.queue.length > 0) return;
      this.destroyWorker();
    }, this.idleTimeoutMs);
  }

  private destroyWorker(rejectActiveError?: Error): void {
    this.clearIdleTimer();
    this.workerGeneration += 1;
    const oldWorker = this.worker;
    this.worker = null;
    this.initializedProfileId = "";
    this.initializedLayoutPreset = "";
    const active = this.active;
    this.active = null;
    if (active) {
      globalThis.clearTimeout(active.timeoutId);
      if (rejectActiveError) active.reject(rejectActiveError);
    }
    try {
      oldWorker?.terminate();
    } catch {
      // Ignore worker termination failures.
    }
  }

  private ensureWorker(): { worker: OcrWorkerLike; generation: number } {
    if (this.worker) return { worker: this.worker, generation: this.workerGeneration };
    const worker = this.createWorkerFn();
    const generation = ++this.workerGeneration;
    worker.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
      if (generation !== this.workerGeneration) return;
      const message = event.data;
      const active = this.active;
      if (!active || active.id !== message.id) return;
      if (message.type === "progress") {
        active.progress(message.status, message.progress);
        return;
      }
      this.active = null;
      globalThis.clearTimeout(active.timeoutId);
      if (message.type === "error") {
        this.initializedProfileId = "";
        this.initializedLayoutPreset = "";
        active.reject(new Error(message.error));
        return;
      }
      this.initializedProfileId = active.profileId;
      if (message.type === "document-result") {
        if (active.layoutPreset) this.initializedLayoutPreset = active.layoutPreset;
        active.resolve({ plan: message.plan, regions: message.regions });
        return;
      }
      active.resolve(message.regions);
    });
    worker.addEventListener("error", (event) => {
      if (generation !== this.workerGeneration) return;
      const error = new Error(event.message || "OCR Worker failed");
      this.destroyWorker(error);
    });
    this.worker = worker;
    return { worker, generation };
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.running = true;
        this.clearIdleTimer();
        const finish = () => {
          this.running = false;
          const next = this.queue.shift();
          if (next) next();
          else this.scheduleIdleTeardown();
        };
        task().then(
          (value) => {
            finish();
            resolve(value);
          },
          (error) => {
            finish();
            reject(error);
          },
        );
      };
      if (!this.running) start();
      else this.queue.push(start);
    });
  }

  hasLiveWorker(): boolean {
    return this.worker !== null;
  }

  recognize(
    width: number,
    height: number,
    pixels: ArrayBuffer,
    bundle: ImageOcrBundle,
    progress: (status: string, progress?: number) => void,
  ): Promise<OcrRegion[]> {
    return this.enqueue(() => {
      const { worker, generation } = this.ensureWorker();
      const id = this.nextId++;
      const initialize = this.initializedProfileId !== bundle.profile.id;
      return new Promise<OcrRegion[]>((resolve, reject) => {
        const timeoutId = globalThis.setTimeout(() => {
          if (generation !== this.workerGeneration || this.active?.id !== id) return;
          this.destroyWorker(new Error("OCR 处理超时，请重新尝试"));
        }, this.recognizeTimeoutMs);
        this.active = {
          id,
          generation,
          profileId: bundle.profile.id,
          resolve: resolve as (value: unknown) => void,
          reject,
          progress,
          timeoutId,
        };
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
        if (message.detectionModel && message.recognitionModel) {
          transfer.push(message.detectionModel, message.recognitionModel);
        }
        try {
          worker.postMessage(message, transfer);
        } catch (error) {
          this.destroyWorker(error instanceof Error ? error : new Error(String(error)));
        }
      });
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
    return this.enqueue(() => {
      const { worker, generation } = this.ensureWorker();
      const id = this.nextId++;
      const initOcr = this.initializedProfileId !== ocrBundle.profile.id;
      const initLayout = this.initializedLayoutPreset !== layoutBundle.asset.preset;
      return new Promise<{ plan: LayoutMaskPlan; regions: OcrRegion[] }>((resolve, reject) => {
        const timeoutId = globalThis.setTimeout(() => {
          if (generation !== this.workerGeneration || this.active?.id !== id) return;
          this.destroyWorker(new Error("扫描页 OCR 处理超时，请重试"));
        }, this.documentTimeoutMs);
        this.active = {
          id,
          generation,
          profileId: ocrBundle.profile.id,
          layoutPreset: layoutBundle.asset.preset,
          resolve: resolve as (value: unknown) => void,
          reject,
          progress,
          timeoutId,
        };
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
        try {
          worker.postMessage(message, transfer);
        } catch (error) {
          this.destroyWorker(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  reset(): void {
    this.destroyWorker(new Error("OCR Worker 已重置"));
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
      const fetched = await fetchBoundedBytes(message.url, {
        maxBytes: DOCUMENT_FETCH_MAX_BYTES,
        timeoutMs: DOCUMENT_FETCH_TIMEOUT_MS,
        cache: "force-cache",
        credentials: "omit",
        tooLargeMessage: "文档体积超过 64 MB 限制",
        timeoutMessage: "文档读取超时，请检查网络后重试",
        httpErrorPrefix: "文档读取失败",
      });
      const bytes = fetched.bytes.buffer.slice(
        fetched.bytes.byteOffset,
        fetched.bytes.byteOffset + fetched.bytes.byteLength,
      );
      return {
        ok: true,
        bytes,
        contentType: fetched.contentType || "application/octet-stream",
        finalUrl: fetched.finalUrl,
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
      let rawBytes: Uint8Array;
      let contentType: string;
      if (/^data:/i.test(message.url)) {
        const response = await fetch(message.url, { credentials: "omit" });
        if (!response.ok) throw new Error(`图片读取失败：HTTP ${response.status}`);
        rawBytes = await readResponseBytesWithLimit(
          response,
          IMAGE_FETCH_MAX_BYTES,
          "图片体积超过 32 MB 限制",
        );
        contentType = response.headers.get("content-type") || "application/octet-stream";
      } else {
        const fetched = await fetchBoundedBytes(message.url, {
          maxBytes: IMAGE_FETCH_MAX_BYTES,
          timeoutMs: IMAGE_FETCH_TIMEOUT_MS,
          cache: "force-cache",
          credentials: "omit",
          tooLargeMessage: "图片体积超过 32 MB 限制",
          timeoutMessage: "图片读取超时，请检查网络后重试",
          httpErrorPrefix: "图片读取失败",
        });
        rawBytes = fetched.bytes;
        contentType = fetched.contentType || "application/octet-stream";
      }

      const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (mimeType === "image/svg+xml") {
        const rasterized = await rasterizeSvg(new Blob([rawBytes.slice().buffer], { type: contentType }));
        return {
          ok: true,
          bytes: await rasterized.arrayBuffer(),
          contentType: rasterized.type || "image/png",
        };
      }
      const bytes = rawBytes.buffer.slice(
        rawBytes.byteOffset,
        rawBytes.byteOffset + rawBytes.byteLength,
      );
      return {
        ok: true,
        bytes,
        contentType,
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
