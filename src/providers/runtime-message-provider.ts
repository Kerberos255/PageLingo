import type { TranslationProvider, TranslationRequest } from "../core/provider";
import { sendRuntimeMessage } from "../shared/runtime-message";

interface TranslationResponse {
  ok?: boolean;
  html?: string;
  htmls?: string[];
  batchUnsupported?: boolean;
  error?: string;
}

interface TranslationEngineStateResponse {
  ok?: boolean;
  state?: {
    structuralSplittingSafe?: boolean;
    prefersWholeSentenceHtml?: boolean;
  };
}

interface PendingTranslation {
  request: TranslationRequest;
  resolve: (html: string) => void;
  reject: (error: Error) => void;
}

export class RuntimeMessageProvider implements TranslationProvider {
  readonly #pending: PendingTranslation[] = [];
  #flushQueued = false;

  async prefersWholeSentenceHtml(): Promise<boolean> {
    try {
      const response = await sendRuntimeMessage<TranslationEngineStateResponse>({type: "get-translation-engines"});
      return response?.ok === true && response.state?.prefersWholeSentenceHtml === true;
    } catch { return false; }
  }

  async supportsStructuralSplitting(): Promise<boolean> {
    try {
      const response = await sendRuntimeMessage<TranslationEngineStateResponse>({
        type: "get-translation-engines",
      });
      return response?.ok === true && response.state?.structuralSplittingSafe === true;
    } catch {
      return false;
    }
  }

  translateHtml(request: TranslationRequest): Promise<string> {
    if (request.signal?.aborted) return Promise.reject(new Error("Translation aborted"));
    return new Promise<string>((resolve, reject) => {
      this.#pending.push({ request, resolve, reject });
      if (this.#flushQueued) return;
      this.#flushQueued = true;
      queueMicrotask(() => void this.#flush());
    });
  }

  async #flush(): Promise<void> {
    this.#flushQueued = false;
    const pending = this.#pending.splice(0);
    if (pending.length === 0) return;

    const groups = new Map<string, PendingTranslation[]>();
    for (const item of pending) {
      const key = `${item.request.sourceLanguage}\u0000${item.request.targetLanguage}`;
      const group = groups.get(key);
      if (group) group.push(item);
      else groups.set(key, [item]);
    }

    await Promise.all(Array.from(groups.values()).map((group) => this.#flushGroup(group)));
  }

  async #flushGroup(group: PendingTranslation[]): Promise<void> {
    for (let offset = 0; offset < group.length; offset += 32) {
      await this.#flushChunk(group.slice(offset, offset + 32));
    }
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
        for (let index = 0; index < active.length; index += 1) {
          active[index]!.resolve(response.htmls[index] ?? "");
        }
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
