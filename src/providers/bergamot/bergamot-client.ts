import { loadModelPair } from "./model-cache";
import { ShortTranslationCache } from "./translation-cache";
import { prepareBergamotFixedHtml, repairBergamotFixedHtml } from "./fixed-html";
import { prepareBergamotFixedRetry, prepareBergamotSlotFallback, restoreBergamotSentenceLines } from "./fixed-retry";
import { damagedTerms, directBergamotResult, planTermGuard, protectOnly, type TermGuardPlan } from "./term-guard";
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
  #initialized = false;
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

  get initialized(): boolean { return this.#initialized; }

  terminate(): void {
    this.#worker?.terminate();
    this.#worker = null;
    this.#ready = null;
    this.#initialized = false;
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
      this.#initialized = true;
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

  #session(route: TranslationRoute, workerIndex = 0): RouteSession {
    const key = `${route.key}\u0000${workerIndex}`;
    let session = this.#sessions.get(key);
    if (!session) {
      session = new RouteSession(route);
      this.#sessions.set(key, session);
    }
    return session;
  }

  async #translateGroup(sources: string[], route: TranslationRoute, workerIndex = 0): Promise<string[]> {
    const session = this.#session(route, workerIndex);
    const prepared = sources.map(prepareBergamotFixedHtml);
    const translated = await session.translateHtmlBatch(prepared);
    if (translated.length !== sources.length) {
      throw new Error(`Bergamot batch result length mismatch: expected ${sources.length}, got ${translated.length}`);
    }
    return this.#repairTranslations(sources, prepared, translated, route, session);
  }

  async translateHtmlBatch(htmls: string[], route: TranslationRoute): Promise<string[]> {
    if (route.sourceLanguage === route.targetLanguage || htmls.length === 0) return [...htmls];
    const results = [...htmls];
    const pending: number[] = [];
    for (let index = 0; index < htmls.length; index += 1) {
      const html = htmls[index] ?? "";
      const direct = html.trim() ? directBergamotResult(html, route.sourceLanguage, route.targetLanguage) : html;
      if (direct !== undefined) results[index] = direct;
      else pending.push(index);
    }
    if (!pending.length) return results;

    // Pass 1: plain sentences. Protection spans are unwrapped because Marian already
    // copies most names verbatim and the extra tags damage the surrounding sentence.
    const plans = pending.map((index) => planTermGuard(htmls[index]!));
    const first = await this.#translateCached(pending.map((index, k) => plans[k]?.unprotected ?? htmls[index]!), route);
    const retries: Array<{ index: number; plan: TermGuardPlan; damaged: Set<string> }> = [];
    pending.forEach((index, k) => {
      const plan = plans[k];
      const output = first[k]!;
      const damaged = plan ? damagedTerms(plan, output) : new Set<string>();
      if (!plan || !damaged.size) results[index] = output;
      else retries.push({ index, plan, damaged });
    });
    if (!retries.length) return results;

    // Pass 2: protect only the names that were damaged. If that shifts another name,
    // pass 3 falls back to the fully protected source.
    const partial = await this.#translateCached(retries.map(({ index, damaged }) => protectOnly(htmls[index]!, damaged)), route);
    const full: number[] = [];
    retries.forEach(({ index, plan, damaged }, k) => {
      if (damaged.size === plan.expected.size || !damagedTerms(plan, partial[k]!, damaged).size) results[index] = partial[k]!;
      else full.push(index);
    });
    if (full.length) {
      const protectedOutputs = await this.#translateCached(full.map((index) => htmls[index]!), route);
      full.forEach((index, k) => { results[index] = protectedOutputs[k]!; });
    }
    return results;
  }

  async #translateCached(htmls: string[], route: TranslationRoute): Promise<string[]> {
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
    const sources = unique.map(({html}) => html);
    // Large direct batches can use a second CPU worker while leaving capacity for page rendering.
    const split = route.kind === "direct" && sources.length >= 12 && navigator.hardwareConcurrency >= 3 && this.#session(route).initialized
      ? Math.ceil(sources.length / 2) : sources.length;
    const outputs = split === sources.length
      ? await this.#translateGroup(sources, route)
      : (await Promise.all([
        this.#translateGroup(sources.slice(0, split), route),
        this.#translateGroup(sources.slice(split), route, 1),
      ])).flat();
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

    const session = this.#session(route);
    const prepared = prepareBergamotFixedHtml(html);
    const [translated] = await this.#repairTranslations([html], [prepared], [await session.translateHtml(prepared)], route, session);
    this.#cache.set(route.key, html, translated!);
    return translated!;
  }

  async #repairTranslations(
    sources: string[], prepared: string[], translations: string[], route: TranslationRoute, session: RouteSession,
  ): Promise<string[]> {
    const canRecoverChinese = route.sourceLanguage === "en" && route.targetLanguage === "zh-Hans";
    const opaqueFallbacks: number[] = [];
    const outputs = sources.map((html, index) => {
      const raw = translations[index] ?? html;
      const usedOpaque = prepared[index] !== html;
      try {
        const output = repairBergamotFixedHtml(html, raw, usedOpaque);
        return canRecoverChinese ? restoreBergamotSentenceLines(html, output) ?? output : output;
      } catch {
        if (usedOpaque) opaqueFallbacks.push(index);
        return raw;
      }
    });

    if (opaqueFallbacks.length > 0) {
      try {
        const fallbackTranslations = await session.translateHtmlBatch(opaqueFallbacks.map((index) => sources[index]!));
        for (let i = 0; i < opaqueFallbacks.length; i += 1) {
          const outputIndex = opaqueFallbacks[i]!;
          const html = sources[outputIndex]!;
          const fallbackRaw = fallbackTranslations[i];
          if (fallbackRaw === undefined) continue;
          const repaired = repairBergamotFixedHtml(html, fallbackRaw, false);
          outputs[outputIndex] = canRecoverChinese ? restoreBergamotSentenceLines(html, repaired) ?? repaired : repaired;
        }
      } catch {
        // Leave the raw damaged output so PageTranslator safely keeps only that paragraph in source.
      }
    }

    if (canRecoverChinese) {
      const retries = sources.flatMap((html, index) => {
        const plan = prepareBergamotFixedRetry(html, outputs[index]!);
        return plan ? [{index, plan}] : [];
      });
      if (retries.length) {
        for (const {index, plan} of retries) outputs[index] = plan.fallback ?? outputs[index]!;
        try {
          const candidates = await session.translateHtmlBatch(retries.map(({plan}) => plan.html));
          for (const [index, {index: outputIndex, plan}] of retries.entries()) {
            const candidate = candidates[index];
            if (candidate === undefined) continue;
            outputs[outputIndex] = plan.restore(candidate) ?? outputs[outputIndex]!;
          }
        } catch {
          // Proceed to slot-level recovery below if needed.
        }
      }
    }

    // Last-resort slot-level safe fallback: if Bergamot's HTML tag alignment still
    // broke inline tags or edge brackets on a fixed-text segment, translate each
    // original slot in one batch and re-insert into a clean clone of the source template.
    const slotFallbacks = sources.flatMap((html, index) => {
      const plan = prepareBergamotSlotFallback(html, outputs[index]!, prepareBergamotFixedHtml, repairBergamotFixedHtml);
      return plan ? [{ index, plan }] : [];
    });
    if (!slotFallbacks.length) return outputs;
    const flatPrepared: string[] = [];
    const offsets: Array<{ index: number; start: number; count: number; plan: ReturnType<typeof prepareBergamotSlotFallback> }> = [];
    for (const entry of slotFallbacks) {
      offsets.push({ index: entry.index, start: flatPrepared.length, count: entry.plan.slotPrepared.length, plan: entry.plan });
      flatPrepared.push(...entry.plan.slotPrepared);
    }
    try {
      const flatTranslated = await session.translateHtmlBatch(flatPrepared);
      for (const { index: outputIndex, start, count, plan } of offsets) {
        if (!plan) continue;
        const recovered = plan.restore(flatTranslated.slice(start, start + count));
        if (recovered !== undefined) outputs[outputIndex] = recovered;
      }
    } catch {
      // Leave outputs untouched so PageTranslator safely preserves any unrecoverable root.
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
