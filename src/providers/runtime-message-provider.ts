import type { TranslationProvider, TranslationRequest } from "../core/provider";
import { sendRuntimeMessage } from "../shared/runtime-message";

interface TranslationResponse {
  ok?: boolean;
  html?: string;
  htmls?: Array<string | null>;
  batchUnsupported?: boolean;
  retrySingles?: boolean;
  error?: string;
}

interface TranslationEngineStateResponse {
  ok?: boolean;
  state?: {
    structuralSplittingSafe?: boolean;
    prefersWholeSentenceHtml?: boolean;
    batchSize?: number;
    batchHtmlLimit?: number;
    concurrentSegments?: number;
    firstVisibleSingles?: number;
    lazyOffscreen?: boolean;
  };
}

interface PendingTranslation {
  request: TranslationRequest;
  resolve: (html: string) => void;
  reject: (error: Error) => void;
}

export class RuntimeMessageProvider implements TranslationProvider {
  readonly #pending: PendingTranslation[] = [];
  readonly #duplicates = new Map<string, Promise<string>>();
  #flushQueued = false;
  #engineState: Promise<TranslationEngineStateResponse["state"]> | undefined;
  #sentFirstGroup = false;

  #state() {
    this.#engineState ??= sendRuntimeMessage<TranslationEngineStateResponse>({type: "get-translation-engines"})
      .then(response => response?.ok ? response.state : undefined, () => undefined);
    return this.#engineState;
  }

  async prefersWholeSentenceHtml(): Promise<boolean> {
    return (await this.#state())?.prefersWholeSentenceHtml === true;
  }

  async concurrentSegments(): Promise<number> {
    return (await this.#state())?.concurrentSegments ?? 4;
  }

  async prefersLazyOffscreen(): Promise<boolean> {
    return (await this.#state())?.lazyOffscreen === true;
  }

  async supportsStructuralSplitting(): Promise<boolean> {
    return (await this.#state())?.structuralSplittingSafe === true;
  }

  translateHtml(request: TranslationRequest): Promise<string> {
    if (request.signal?.aborted) return Promise.reject(new Error("Translation aborted"));
    const key = request.signal || request.bypassCache ? "" : JSON.stringify(request);
    const existing = key && this.#duplicates.get(key);
    if (existing) return existing;
    const pending = new Promise<string>((resolve, reject) => {
      this.#pending.push({ request, resolve, reject });
      if (this.#flushQueued) return;
      this.#flushQueued = true;
      queueMicrotask(() => void this.#flush());
    });
    if (!key) return pending;
    const shared = pending.finally(() => this.#duplicates.delete(key));
    this.#duplicates.set(key, shared);
    return shared;
  }

  async #flush(): Promise<void> {
    this.#flushQueued = false;
    const pending = this.#pending.splice(0);
    if (pending.length === 0) return;

    const groups = new Map<string, PendingTranslation[]>();
    for (const item of pending) {
      const key = `${item.request.sourceLanguage}\u0000${item.request.targetLanguage}\u0000${item.request.bypassCache ? "1" : "0"}\u0000${item.request.engineId ?? ""}`;
      const group = groups.get(key);
      if (group) group.push(item);
      else groups.set(key, [item]);
    }

    await Promise.all(Array.from(groups.values()).map((group) => this.#flushGroup(group)));
  }

  async #flushGroup(group: PendingTranslation[]): Promise<void> {
    const state = await this.#engineState;
    const maxSize = Math.max(1, Math.min(32, state?.batchSize ?? 32));
    const maxLength = state?.batchHtmlLimit ?? 24_000;
    const batches: Promise<void>[] = [];
    const visibleSingles = this.#sentFirstGroup ? 0 : state?.firstVisibleSingles ?? 0;
    this.#sentFirstGroup = true;
    for (const item of group.splice(0, visibleSingles)) batches.push(this.#translateSingle(item));
    let chunk: PendingTranslation[] = [];
    let length = 0;
    for (const item of group) {
      const size = item.request.html.length;
      if (chunk.length && (chunk.length >= maxSize || length + size > maxLength)) {
        batches.push(this.#flushChunk(chunk));
        chunk = [];
        length = 0;
      }
      chunk.push(item);
      length += size;
    }
    if (chunk.length) batches.push(this.#flushChunk(chunk));
    await Promise.all(batches);
  }

  async #flushChunk(items: PendingTranslation[]): Promise<void> {
    const active = items.filter((item) => {
      if (!item.request.signal?.aborted) return true;
      item.reject(new Error("Translation aborted"));
      return false;
    });
    if (active.length === 0) return;

    if (active.length === 1) {
      await this.#translateSingle(active[0]!);
      return;
    }

    try {
      const requests = active.map(({ request }) => {
        const { signal: _signal, ...wireRequest } = request;
        return wireRequest;
      });
      const response = await sendRuntimeMessage<TranslationResponse>({
        type: "translate-html-batch",
        requests,
      });

      if (response?.ok && Array.isArray(response.htmls) && response.htmls.length === active.length) {
        const retries = [];
        for (let index = 0; index < active.length; index += 1) {
          const item = active[index]!;
          const html = response.htmls[index];
          if (typeof html === "string") item.resolve(html);
          else retries.push(this.#translateSingle(item));
        }
        await Promise.all(retries);
        return;
      }

      if (response?.retrySingles === false) {
        const error = new Error(response.error ?? "Translation batch backend unavailable");
        for (const item of active) item.reject(error);
        return;
      }

      if (response?.batchUnsupported) {
        await Promise.all(active.map((item) => this.#translateSingle(item)));
        return;
      }

      throw new Error(response?.error ?? "Translation batch backend unavailable");
    } catch {
      // A batch can fail because of one malformed/problematic input. Retry each item
      // independently so one root cannot take unrelated translations down with it.
      await Promise.all(active.map((item) => this.#translateSingle(item)));
    }
  }

  async #translateSingle(item: PendingTranslation): Promise<void> {
    try {
      if (item.request.signal?.aborted) throw new Error("Translation aborted");
      const { signal: _signal, ...request } = item.request;
      const response = await sendRuntimeMessage<TranslationResponse>({ type: "translate-html", request });
      if (!response?.ok || typeof response.html !== "string") {
        throw new Error(response?.error ?? "Translation backend unavailable");
      }
      item.resolve(response.html);
    } catch (error) {
      item.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
