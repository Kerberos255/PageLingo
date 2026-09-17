import { getImageOcrBundle, getImageOcrStatus, deleteImageOcrModels, type ImageOcrBundle } from "./ocr-cache";
import { mergeOcrRegions, type OcrRegion } from "./ocr-layout";
import { loadSettings } from "../shared/settings";

const MENU_ID = "pagelingo-translate-image";

interface ImageRuntimeMessage {
  type?: string;
  url?: unknown;
  width?: unknown;
  height?: unknown;
  pixels?: unknown;
}

interface WorkerProgressMessage {
  type: "progress";
  id: number;
  status: string;
}

interface WorkerResultMessage {
  type: "result";
  id: number;
  regions: OcrRegion[];
}

interface WorkerErrorMessage {
  type: "error";
  id: number;
  error: string;
}

type WorkerMessage = WorkerProgressMessage | WorkerResultMessage | WorkerErrorMessage;

interface PendingOcr {
  resolve: (regions: OcrRegion[]) => void;
  reject: (error: Error) => void;
  progress: (status: string) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

class ImageOcrWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private initializedProfileId = "";
  private readonly pending = new Map<number, PendingOcr>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(browser.runtime.getURL("image-ocr-worker.js"));
    worker.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.type === "progress") {
        pending.progress(message.status);
        return;
      }
      this.pending.delete(message.id);
      globalThis.clearTimeout(pending.timeoutId);
      if (message.type === "error") {
        this.initializedProfileId = "";
        pending.reject(new Error(message.error));
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
    progress: (status: string) => void,
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
        pending.reject(new Error("OCR 处理超时，请重新尝试"));
        this.worker?.terminate();
        this.worker = null;
      }, 120_000);
      this.pending.set(id, { resolve, reject, progress, timeoutId });
      const message = {
        type: "recognize",
        id,
        profileId: bundle.profile.id,
        modelPreset: bundle.profile.modelPreset,
        width,
        height,
        pixels,
        detectionModel: initialize ? bundle.detectionModel : undefined,
        recognitionModel: initialize ? bundle.recognitionModel : undefined,
        dictionary: initialize ? bundle.dictionary : undefined,
      };
      const transfer: Transferable[] = [pixels];
      if (initialize) transfer.push(bundle.detectionModel, bundle.recognitionModel);
      worker.postMessage(message, transfer);
      if (initialize) this.initializedProfileId = bundle.profile.id;
    });
  }

  reset(): void {
    this.initializedProfileId = "";
    this.worker?.postMessage({ type: "reset" });
  }
}

const ocrWorker = new ImageOcrWorkerClient();

async function sendProgress(sender: browser.runtime.MessageSender, status: string): Promise<void> {
  const tabId = sender.tab?.id;
  if (!tabId) return;
  try {
    await browser.tabs.sendMessage(tabId, { type: "image-translation-progress", status });
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

export async function handleImageRuntimeMessage(
  rawMessage: unknown,
  sender: browser.runtime.MessageSender,
): Promise<unknown | undefined> {
  const message = rawMessage as ImageRuntimeMessage;
  if (message.type === "get-image-ocr-status") {
    return { ok: true, status: await getImageOcrStatus() };
  }

  if (message.type === "delete-image-ocr-models") {
    await deleteImageOcrModels();
    ocrWorker.reset();
    return { ok: true, status: await getImageOcrStatus() };
  }

  if (message.type === "fetch-image-bytes") {
    if (typeof message.url !== "string" || !isAllowedImageUrl(message.url)) {
      return { ok: false, error: "不支持的图片地址" };
    }
    try {
      const response = await fetch(message.url, { cache: "force-cache", credentials: "omit" });
      if (!response.ok) throw new Error(`图片读取失败：HTTP ${response.status}`);
      return {
        ok: true,
        bytes: await response.arrayBuffer(),
        contentType: response.headers.get("content-type") ?? "application/octet-stream",
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (message.type === "recognize-image") {
    const width = typeof message.width === "number" ? Math.round(message.width) : 0;
    const height = typeof message.height === "number" ? Math.round(message.height) : 0;
    if (width <= 0 || height <= 0 || !(message.pixels instanceof ArrayBuffer)) {
      return { ok: false, error: "无效的图片像素数据" };
    }
    try {
      const bundle = await getImageOcrBundle(undefined, (status) => {
        void sendProgress(sender, status);
      });
      await sendProgress(sender, "OCR 模型就绪 · 正在识别图片…");
      const regions = await ocrWorker.recognize(width, height, message.pixels, bundle, (status) => {
        void sendProgress(sender, status);
      });
      return {
        ok: true,
        regions: mergeOcrRegions(regions.filter((region) => region.confidence >= 0.25)),
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return undefined;
}

async function syncContextMenu(): Promise<void> {
  try {
    await browser.contextMenus.remove(MENU_ID);
  } catch {
    // Missing menu is expected during first startup.
  }
  const settings = await loadSettings();
  if (!settings.imageTranslationEnabled) return;
  browser.contextMenus.create({
    id: MENU_ID,
    title: "PageLingo · 翻译图片",
    contexts: ["image"],
  });
}

export function initializeImageTranslation(): void {
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_ID || !tab?.id || typeof info.srcUrl !== "string") return;
    void browser.tabs.sendMessage(tab.id, { type: "translate-image", srcUrl: info.srcUrl }).catch(() => undefined);
  });
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.imageTranslationEnabled) void syncContextMenu();
  });
  browser.runtime.onInstalled.addListener(() => void syncContextMenu());
  browser.runtime.onStartup.addListener(() => void syncContextMenu());
  void syncContextMenu();
}
