import {
  CacheManager,
  LoggerWithoutDebug,
  ModelManager,
  ModelValidationStatus,
  Wllama,
} from "@wllama/wllama/esm/index.js";
import type {
  CheckedTranslationResult,
  TranslationProvider,
  TranslationRequest,
} from "../../core/provider";
import {
  mtRouteSupported,
} from "./protocol";
import {
  PageLingoOpfsBackend,
  describeMtError,
  ensureMtStorageCapacity,
} from "./opfs-backend";
import {inferMtHtml} from "./inference";
import {MT_CONTEXT_TOKENS} from "./sentence-plan";
import {MtTranslationQueue} from "./translation-queue";

export const PAGELINGO_MT_ENGINE_ID = "pagelingo-mt";
export const PAGELINGO_MT_MODEL_REPO = "kerberos255/PageLingo-Translate-1.8B";
export const PAGELINGO_MT_MODEL_FILE = "PageLingo-Translate-1.8B-v0.2.2-Q5_K_M.gguf";
export const PAGELINGO_MT_MODEL_URL =
  `https://huggingface.co/${PAGELINGO_MT_MODEL_REPO}/resolve/main/${PAGELINGO_MT_MODEL_FILE}`;
export const PAGELINGO_MT_MODEL_SIZE = 1_298_755_616;
export const PAGELINGO_MT_MODEL_SHA256 = "8f8734198ad9332db97101de3ae7216daa3b59218522c4e0beebdfb4999924cc";

export type PageLingoMtRuntimePhase = "idle" | "opening-cache" | "loading-wasm" | "ready" | "inference" | "error";

export interface PageLingoMtStatus {
  installed: boolean;
  valid: boolean;
  downloading: boolean;
  loadedBytes: number;
  totalBytes: number;
  modelBytes: number;
  modelFile: string;
  modelSha256: string;
  error?: string;
  runtimePhase: PageLingoMtRuntimePhase;
  runtimeSince: number;
  crossOriginIsolated: boolean;
  requestedThreads: number;
  actualThreads: number;
  lastLoadMs: number;
  lastInferenceMs: number;
}

export class PageLingoMtClient implements TranslationProvider {
  readonly #cacheManager = new CacheManager([new PageLingoOpfsBackend() as any]);
  readonly #modelManager = new ModelManager({
    cacheManager: this.#cacheManager,
    logger: LoggerWithoutDebug,
    parallelDownloads: 1,
  });

  #wllama: Wllama | null = null;
  #loadPromise: Promise<Wllama> | null = null;
  readonly #translations = new MtTranslationQueue(PAGELINGO_MT_MODEL_SHA256, request => this.#translateSerial(request));
  #downloading = false;
  #loadedBytes = 0;
  #totalBytes = PAGELINGO_MT_MODEL_SIZE;
  #lastError = "";
  #requestedThreads = 0;
  #actualThreads = 0;
  #lastLoadMs = 0;
  #lastInferenceMs = 0;
  #runtimePhase: PageLingoMtRuntimePhase = "idle";
  #runtimeSince = Date.now();

  async status(): Promise<PageLingoMtStatus> {
    try {
      const model = await this.#findModel(true);
      const valid = Boolean(model && this.#modelIsExpected(model));
      return {
        installed: valid,
        valid,
        downloading: this.#downloading,
        loadedBytes: this.#loadedBytes,
        totalBytes: this.#totalBytes,
        modelBytes: valid ? model!.size : 0,
        modelFile: PAGELINGO_MT_MODEL_FILE,
        modelSha256: PAGELINGO_MT_MODEL_SHA256,
        runtimePhase: this.#runtimePhase,
        runtimeSince: this.#runtimeSince,
        crossOriginIsolated: Boolean(globalThis.crossOriginIsolated),
        requestedThreads: this.#requestedThreads,
        actualThreads: this.#actualThreads,
        lastLoadMs: this.#lastLoadMs,
        lastInferenceMs: this.#lastInferenceMs,
        ...(this.#lastError ? { error: this.#lastError } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        installed: false,
        valid: false,
        downloading: this.#downloading,
        loadedBytes: this.#loadedBytes,
        totalBytes: this.#totalBytes,
        modelBytes: 0,
        modelFile: PAGELINGO_MT_MODEL_FILE,
        modelSha256: PAGELINGO_MT_MODEL_SHA256,
        runtimePhase: this.#runtimePhase,
        runtimeSince: this.#runtimeSince,
        crossOriginIsolated: Boolean(globalThis.crossOriginIsolated),
        requestedThreads: this.#requestedThreads,
        actualThreads: this.#actualThreads,
        lastLoadMs: this.#lastLoadMs,
        lastInferenceMs: this.#lastInferenceMs,
        error: message,
      };
    }
  }

  async download(): Promise<PageLingoMtStatus> {
    this.#translations.clear();
    this.#lastError = "";
    this.#downloading = true;
    this.#loadedBytes = 0;
    this.#totalBytes = PAGELINGO_MT_MODEL_SIZE;
    try {
      await ensureMtStorageCapacity(PAGELINGO_MT_MODEL_SIZE + 64 * 1024 * 1024);
      const model = await this.#modelManager.getModelOrDownload(
        { url: PAGELINGO_MT_MODEL_URL },
        {
          progressCallback: ({ loaded, total }) => {
            this.#loadedBytes = loaded;
            if (total > 0) this.#totalBytes = total;
          },
        },
      );
      await this.#assertExpectedModel(model);
      this.#loadedBytes = model.size;
      this.#totalBytes = model.size;
      return await this.status();
    } catch (error) {
      this.#lastError = describeMtError(error);
      try {
        const model = await this.#findModel(true);
        if (model) await model.remove();
      } catch {}
      throw new Error(this.#lastError);
    } finally {
      this.#downloading = false;
    }
  }

  async remove(): Promise<PageLingoMtStatus> {
    await this.close();
    const model = await this.#findModel(true);
    if (model) await model.remove();
    this.#loadedBytes = 0;
    this.#totalBytes = PAGELINGO_MT_MODEL_SIZE;
    this.#lastError = "";
    return await this.status();
  }

  async supportsStructuralSplitting(): Promise<boolean> {
    return false;
  }

  async prefersWholeSentenceHtml(): Promise<boolean> { return true; }

  async translateHtml(request: TranslationRequest): Promise<string> {
    const checked = await this.translateHtmlChecked(request);
    if (!checked.accepted) {
      throw new Error(checked.reason ?? "PageLingo MT rejected the translation");
    }
    return checked.html;
  }

  async translateHtmlChecked(request: TranslationRequest): Promise<CheckedTranslationResult> {
    if (!mtRouteSupported(request)) {
      return { html: request.html, accepted: false, reason: "PageLingo MT currently supports English → Simplified Chinese only" };
    }
    return this.#translations.translate(request);
  }

  async close(): Promise<void> {
    this.#translations.clear();
    const current = this.#wllama;
    this.#wllama = null;
    this.#loadPromise = null;
    if (current) {
      try {
        await current.exit();
      } catch {}
    }
  }

  async #translateSerial(request: TranslationRequest): Promise<CheckedTranslationResult> {
    const engine = await this.#ensureLoaded();
    this.#setRuntimePhase("inference");
    const inferenceStarted = performance.now();
    let response: any;
    try {
      response = await inferMtHtml(request, options => engine.createChatCompletion(options));
      this.#lastInferenceMs = performance.now() - inferenceStarted;
      this.#lastError = "";
      this.#setRuntimePhase("ready");
    } catch (error) {
      this.#lastError = describeMtError(error);
      this.#setRuntimePhase("error");
      throw error;
    }
    return response;
  }

  async #ensureLoaded(): Promise<Wllama> {
    if (this.#wllama?.isModelLoaded()) return this.#wllama;
    if (this.#loadPromise) return this.#loadPromise;

    this.#loadPromise = (async () => {
      const model = await this.#findModel(false);
      if (!model) throw new Error("PageLingo MT 模型尚未下载");
      await this.#assertExpectedModel(model);

      this.#setRuntimePhase("opening-cache");
      const blobs = await model.open();
      this.#setRuntimePhase("loading-wasm");
      const engine = new Wllama(
        { default: browser.runtime.getURL("vendor/wllama/wllama.wasm") },
        {
          logger: LoggerWithoutDebug,
          modelManager: this.#modelManager,
        },
      );
      const threads = Math.max(1, Math.min(8, Math.floor((navigator.hardwareConcurrency || 2) / 2) || 1));
      this.#requestedThreads = threads;
      const loadStarted = performance.now();
      await engine.loadModel(blobs, {
        n_ctx: MT_CONTEXT_TOKENS,
        n_threads: threads,
        n_gpu_layers: 0,
      });
      this.#lastLoadMs = performance.now() - loadStarted;
      this.#actualThreads = engine.getNumThreads();
      this.#wllama = engine;
      this.#setRuntimePhase("ready");
      return engine;
    })();

    try {
      return await this.#loadPromise;
    } catch (error) {
      this.#lastError = describeMtError(error);
      this.#setRuntimePhase("error");
      throw error;
    } finally {
      this.#loadPromise = null;
    }
  }

  #setRuntimePhase(phase: PageLingoMtRuntimePhase): void {
    if (this.#runtimePhase === phase) return;
    this.#runtimePhase = phase;
    this.#runtimeSince = Date.now();
  }

  async #findModel(includeInvalid: boolean) {
    const models = await this.#modelManager.getModels({ includeInvalid });
    return models.find((model) => model.url === PAGELINGO_MT_MODEL_URL) ?? null;
  }

  #modelIsExpected(model: any): boolean {
    if (model.validate() !== ModelValidationStatus.VALID) return false;
    if (model.size !== PAGELINGO_MT_MODEL_SIZE) return false;
    if (model.files.length !== 1) return false;
    const sha = model.files[0]?.metadata?.sha256?.toLowerCase();
    return sha === PAGELINGO_MT_MODEL_SHA256;
  }

  async #assertExpectedModel(model: any): Promise<void> {
    if (model.validate() !== ModelValidationStatus.VALID) {
      throw new Error("PageLingo MT 模型缓存不完整，请重新下载");
    }
    if (model.size !== PAGELINGO_MT_MODEL_SIZE) {
      await model.remove();
      throw new Error(`PageLingo MT 模型大小校验失败：${model.size}`);
    }
    const sha = model.files?.[0]?.metadata?.sha256?.toLowerCase();
    if (sha !== PAGELINGO_MT_MODEL_SHA256) {
      await model.remove();
      throw new Error("PageLingo MT SHA256 校验失败，已删除异常缓存");
    }
  }
}
