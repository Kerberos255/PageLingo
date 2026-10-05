import {
  LoggerWithoutDebug,
  ModelManager,
  ModelValidationStatus,
  Wllama,
} from "@wllama/wllama/esm/index.js";
import { assessTranslationQuality } from "../../core/translation-quality";
import type {
  CheckedTranslationResult,
  TranslationProvider,
  TranslationRequest,
} from "../../core/provider";
import {
  decodeMtHtml,
  encodeMtHtml,
  mtMaxTokens,
  mtPrompt,
  mtRouteSupported,
  validateMtOutput,
} from "./protocol";

export const PAGELINGO_MT_ENGINE_ID = "pagelingo-mt";
export const PAGELINGO_MT_MODEL_REPO = "kerberos255/PageLingo-Translate-1.8B";
export const PAGELINGO_MT_MODEL_FILE = "PageLingo-Translate-1.8B-v0.2.2-Q5_K_M.gguf";
export const PAGELINGO_MT_MODEL_URL =
  `https://huggingface.co/${PAGELINGO_MT_MODEL_REPO}/resolve/main/${PAGELINGO_MT_MODEL_FILE}`;
export const PAGELINGO_MT_MODEL_SIZE = 1_298_755_616;
export const PAGELINGO_MT_MODEL_SHA256 = "8f8734198ad9332db97101de3ae7216daa3b59218522c4e0beebdfb4999924cc";

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
}

function plainText(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  return (parsed.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

export class PageLingoMtClient implements TranslationProvider {
  readonly #modelManager = new ModelManager({
    logger: LoggerWithoutDebug,
    parallelDownloads: 1,
  });

  #wllama: Wllama | null = null;
  #loadPromise: Promise<Wllama> | null = null;
  #tail: Promise<unknown> = Promise.resolve();
  #downloading = false;
  #loadedBytes = 0;
  #totalBytes = PAGELINGO_MT_MODEL_SIZE;
  #lastError = "";

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
        error: message,
      };
    }
  }

  async download(): Promise<PageLingoMtStatus> {
    this.#lastError = "";
    this.#downloading = true;
    this.#loadedBytes = 0;
    this.#totalBytes = PAGELINGO_MT_MODEL_SIZE;
    try {
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
      this.#lastError = error instanceof Error ? error.message : String(error);
      try {
        const model = await this.#findModel(true);
        if (model) await model.remove();
      } catch {}
      throw error;
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
    return true;
  }

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
    const run = this.#tail.then(() => this.#translateSerial(request));
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async close(): Promise<void> {
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
    const encoded = encodeMtHtml(request.html);
    const engine = await this.#ensureLoaded();
    const response: any = await engine.createCompletion({
      prompt: mtPrompt(encoded.source),
      max_tokens: mtMaxTokens(encoded),
      temperature: 0,
      top_k: 1,
      stream: false,
    });
    const raw = String(response?.choices?.[0]?.text ?? "").trim();
    const validation = validateMtOutput(encoded, raw);
    if (!validation.ok) {
      return {
        html: request.html,
        accepted: false,
        reason: validation.errors.join(", ") || "MT protocol validation failed",
      };
    }

    const decoded = decodeMtHtml(encoded, raw);
    const quality = assessTranslationQuality({
      sourceText: plainText(request.html),
      translatedText: plainText(decoded),
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
    });
    if (!quality.accepted) {
      return {
        html: request.html,
        accepted: false,
        reason: quality.reasons.join(", ") || "MT quality validation failed",
      };
    }
    return { html: decoded, accepted: true };
  }

  async #ensureLoaded(): Promise<Wllama> {
    if (this.#wllama?.isModelLoaded()) return this.#wllama;
    if (this.#loadPromise) return this.#loadPromise;

    this.#loadPromise = (async () => {
      const model = await this.#findModel(false);
      if (!model) throw new Error("PageLingo MT 模型尚未下载");
      await this.#assertExpectedModel(model);

      const engine = new Wllama(
        { default: browser.runtime.getURL("vendor/wllama/wllama.wasm") },
        {
          logger: LoggerWithoutDebug,
          modelManager: this.#modelManager,
        },
      );
      const threads = Math.max(1, Math.min(8, Math.floor((navigator.hardwareConcurrency || 2) / 2) || 1));
      await engine.loadModel(model, {
        n_ctx: 1536,
        n_threads: threads,
      });
      this.#wllama = engine;
      return engine;
    })();

    try {
      return await this.#loadPromise;
    } finally {
      this.#loadPromise = null;
    }
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
