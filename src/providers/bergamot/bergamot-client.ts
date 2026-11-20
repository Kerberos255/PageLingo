import { loadModelPair } from "./model-cache";
import { ShortTranslationCache } from "./translation-cache";
import { prepareBergamotFixedHtml, repairBergamotFixedHtml } from "./fixed-html";
import { prepareBergamotFixedRetry, restoreBergamotSentenceLines } from "./fixed-retry";
import type { TranslationRoute } from "./model-manifest";
import type { BergamotWorkerRequest, BergamotWorkerResponse, WorkerModelBundle } from "./protocol";

interface PendingRequest {
  resolve: (html: string) => void;
  reject: (error: Error) => void;
}

interface PendingBatchRequest {
  resolve: (htmls: string[]) => void;
  reject: (error: Error) => void;
  inputCount: number;
}

export interface BergamotPerformanceStats {
  inferenceCount: number;
  inferenceMilliseconds: number;
  translatedInputs: number;
}

class RouteSession {
  readonly #route: TranslationRoute;
  #worker: Worker | null = null;
  #ready: Promise<void> | null = null;
  #nextId = 1;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #pendingBatches = new Map<number, PendingBatchRequest>();
  #performance: BergamotPerformanceStats = {
    inferenceCount: 0,
    inferenceMilliseconds: 0,
    translatedInputs: 0,
  };

  constructor(route: TranslationRoute) {
    this.#route = route;
  }

  async translateHtml(html: string): Promise<string> {
    await this.#ensureReady();
    const worker = this.#worker;
    if (!worker) throw new Error("Bergamot worker is unavailable");

    const id = this.#nextId++;
    const result = new Promise<string>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    const message: BergamotWorkerRequest = { type: "translate", id, html };
    worker.postMessage(message);
    return result;
  }

  async translateHtmlBatch(htmls: string[]): Promise<string[]> {
    if (htmls.length === 0) return [];
    await this.#ensureReady();
    const worker = this.#worker;
    if (!worker) throw new Error("Bergamot worker is unavailable");

    const id = this.#nextId++;
    const result = new Promise<string[]>((resolve, reject) => {
      this.#pendingBatches.set(id, { resolve, reject, inputCount: htmls.length });
    });
    const message: BergamotWorkerRequest = { type: "translate-batch", id, htmls };
    worker.postMessage(message);
    return result;
  }

  performanceStats(): BergamotPerformanceStats {
    return { ...this.#performance };
  }

  resetPerformanceStats(): void {
    this.#performance = {
      inferenceCount: 0,
      inferenceMilliseconds: 0,
      translatedInputs: 0,
    };
  }

  terminate(): void {
    this.#worker?.terminate();
    this.#worker = null;
    this.#ready = null;
    const error = new Error("Bergamot session reset");
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const pending of this.#pendingBatches.values()) pending.reject(error);
    this.#pendingBatches.clear();
  }

  #ensureReady(): Promise<void> {
    if (this.#ready) return this.#ready;
    this.#ready = this.#initialize();
    return this.#ready;
  }

  async #initialize(): Promise<void> {
    const worker = new Worker(browser.runtime.getURL("bergamot-worker.js"));
    this.#worker = worker;

    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const readySignal = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });

    worker.addEventListener("message", (event: MessageEvent<BergamotWorkerResponse>) => {
      const message = event.data;
      if (message.type === "ready") {
        readyResolve();
        return;
      }
      if (message.type === "result") {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        this.#performance.inferenceCount += 1;
        this.#performance.inferenceMilliseconds += message.inferenceMilliseconds;
        this.#performance.translatedInputs += 1;
        pending.resolve(message.html);
        return;
      }
      if (message.type === "batch-result") {
        const pending = this.#pendingBatches.get(message.id);
        if (!pending) return;
        this.#pendingBatches.delete(message.id);
        this.#performance.inferenceCount += 1;
        this.#performance.inferenceMilliseconds += message.inferenceMilliseconds;
        this.#performance.translatedInputs += pending.inputCount;
        pending.resolve(message.htmls);
        return;
      }
      if (message.type === "error") {
        const error = new Error(message.error);
        if (message.id !== undefined) {
          const pending = this.#pending.get(message.id);
          if (pending) {
            this.#pending.delete(message.id);
            pending.reject(error);
            return;
          }
          const batch = this.#pendingBatches.get(message.id);
          if (batch) {
            this.#pendingBatches.delete(message.id);
            batch.reject(error);
          }
        } else {
          readyReject(error);
        }
      }
    });

    worker.addEventListener("error", (event) => {
      const error = new Error(event.message || "Bergamot worker failed");
      readyReject(error);
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
      for (const pending of this.#pendingBatches.values()) pending.reject(error);
      this.#pendingBatches.clear();
    });

    try {
      const models: WorkerModelBundle[] = [];
      for (const pair of this.#route.models) models.push(await loadModelPair(pair));
      const transfer = models.flatMap((model) => model.files.map((file) => file.buffer));
      const message: BergamotWorkerRequest = {
        type: "initialize",
        routeKind: this.#route.kind,
        models,
      };
      worker.postMessage(message, transfer);
      await readySignal;
    } catch (error) {
      worker.terminate();
      this.#worker = null;
      this.#ready = null;
      throw error;
    }
  }
}

export class BergamotClient {
  readonly #sessions = new Map<string, RouteSession>();
  readonly #cache = new ShortTranslationCache();

  async translateHtmlBatch(htmls: string[], route: TranslationRoute): Promise<string[]> {
    if (route.sourceLanguage === route.targetLanguage || htmls.length === 0) return [...htmls];

    const results = [...htmls];
    const missing = new Map<string, { html: string; indexes: number[] }>();
    for (let index = 0; index < htmls.length; index += 1) {
      const html = htmls[index] ?? "";
      if (!html.trim()) continue;

      const cached = this.#cache.get(route.key, html);
      if (cached !== undefined) {
        results[index] = cached;
        continue;
      }

      const existing = missing.get(html);
      if (existing) existing.indexes.push(index);
      else missing.set(html, { html, indexes: [index] });
    }
    if (missing.size === 0) return results;

    const unique = Array.from(missing.values());
    let session = this.#sessions.get(route.key);
    if (!session) {
      session = new RouteSession(route);
      this.#sessions.set(route.key, session);
    }
    const sources = unique.map(({html}) => html);
    const prepared = sources.map(prepareBergamotFixedHtml);
    const translated = await session.translateHtmlBatch(prepared);
    if (translated.length !== unique.length) {
      throw new Error(`Bergamot batch result length mismatch: expected ${unique.length}, got ${translated.length}`);
    }

    const outputs = await this.#repairTranslations(sources, prepared, translated, route, session);
    for (let index = 0; index < unique.length; index += 1) {
      const item = unique[index]!;
      const output = outputs[index]!;
      this.#cache.set(route.key, item.html, output);
      for (const outputIndex of item.indexes) results[outputIndex] = output;
    }
    return results;
  }

  async translateHtml(html: string, route: TranslationRoute): Promise<string> {
    if (!html.trim() || route.sourceLanguage === route.targetLanguage) return html;
    const cached = this.#cache.get(route.key, html);
    if (cached !== undefined) return cached;

    let session = this.#sessions.get(route.key);
    if (!session) {
      session = new RouteSession(route);
      this.#sessions.set(route.key, session);
    }
    const prepared = prepareBergamotFixedHtml(html);
    const [translated] = await this.#repairTranslations([html], [prepared], [await session.translateHtml(prepared)], route, session);
    this.#cache.set(route.key, html, translated!);
    return translated!;
  }

  async #repairTranslations(
    sources: string[], prepared: string[], translations: string[], route: TranslationRoute, session: RouteSession,
  ): Promise<string[]> {
    const canRecoverChinese = route.sourceLanguage === "en" && route.targetLanguage === "zh-Hans";
    const outputs = sources.map((html, index) => {
      const output = repairBergamotFixedHtml(html, translations[index] ?? html, prepared[index] !== html);
      return canRecoverChinese ? restoreBergamotSentenceLines(html, output) ?? output : output;
    });
    if (!canRecoverChinese) return outputs;

    const retries = sources.flatMap((html, index) => {
      const plan = prepareBergamotFixedRetry(html, outputs[index]!);
      return plan ? [{index, plan}] : [];
    });
    if (!retries.length) return outputs;
    let candidates: string[];
    try {
      candidates = await session.translateHtmlBatch(retries.map(({plan}) => plan.html));
    } catch {
      return outputs;
    }
    for (const [index, {index: outputIndex, plan}] of retries.entries()) {
      const candidate = candidates[index];
      if (candidate === undefined) continue;
      outputs[outputIndex] = plan.restore(candidate) ?? outputs[outputIndex]!;
    }
    return outputs;
  }

  performanceStats(): BergamotPerformanceStats {
    const totals: BergamotPerformanceStats = {
      inferenceCount: 0,
      inferenceMilliseconds: 0,
      translatedInputs: 0,
    };
    for (const session of this.#sessions.values()) {
      const stats = session.performanceStats();
      totals.inferenceCount += stats.inferenceCount;
      totals.inferenceMilliseconds += stats.inferenceMilliseconds;
      totals.translatedInputs += stats.translatedInputs;
    }
    return totals;
  }

  resetPerformanceStats(): void {
    for (const session of this.#sessions.values()) session.resetPerformanceStats();
  }

  reset(): void {
    for (const session of this.#sessions.values()) session.terminate();
    this.#sessions.clear();
    this.#cache.clear();
  }
}
