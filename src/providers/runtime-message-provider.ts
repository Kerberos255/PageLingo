import type { TranslationExecutionProfile, TranslationProvider, TranslationRequest } from "../core/provider";
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
    executionProfile?: Partial<TranslationExecutionProfile>;
  };
}

interface PendingTranslation {
  request: TranslationRequest;
  resolve: (html: string) => void;
  reject: (error: Error) => void;
}

const DEFAULT_EXECUTION_PROFILE: TranslationExecutionProfile = {
  isExternal: false,
  isLlm: false,
  supportsBatch: true,
  supportsPromptTerminology: false,
  recommendedConcurrency: 4,
  batchMaxItems: 32,
  batchMaxChars: 16000,
  batchConcurrency: 1,
};

function normalizeExecutionProfile(raw?: Partial<TranslationExecutionProfile>): TranslationExecutionProfile {
  if (!raw) return { ...DEFAULT_EXECUTION_PROFILE };
  return {
    isExternal: raw.isExternal === true,
    isLlm: raw.isLlm === true,
    supportsBatch: raw.supportsBatch !== false,
    supportsPromptTerminology: raw.supportsPromptTerminology === true,
    recommendedConcurrency: Math.max(1, Number(raw.recommendedConcurrency) || DEFAULT_EXECUTION_PROFILE.recommendedConcurrency),
    batchMaxItems: Math.max(1, Math.min(32, Number(raw.batchMaxItems) || DEFAULT_EXECUTION_PROFILE.batchMaxItems)),
    batchMaxChars: Math.max(200, Number(raw.batchMaxChars) || DEFAULT_EXECUTION_PROFILE.batchMaxChars),
    batchConcurrency: Math.max(1, Number(raw.batchConcurrency) || DEFAULT_EXECUTION_PROFILE.batchConcurrency),
  };
}

export class RuntimeMessageProvider implements TranslationProvider {
  readonly #pending: PendingTranslation[] = [];
  #flushQueued = false;
  #engineStatePromise: Promise<TranslationEngineStateResponse | null> | null = null;
  #executionProfile: TranslationExecutionProfile | null = null;
  #batchSupportedOverride: boolean | null = null;

  #loadEngineState(): Promise<TranslationEngineStateResponse | null> {
    if (!this.#engineStatePromise) {
      this.#engineStatePromise = sendRuntimeMessage<TranslationEngineStateResponse>({
        type: "get-translation-engines",
      })
        .then((response) => {
          if (response?.ok === true && response.state?.executionProfile) {
            this.#executionProfile = normalizeExecutionProfile(response.state.executionProfile);
          }
          return response ?? null;
        })
        .catch(() => null);
    }
    return this.#engineStatePromise;
  }

  async getExecutionProfile(): Promise<TranslationExecutionProfile> {
    if (this.#executionProfile) return this.#executionProfile;
    const response = await this.#loadEngineState();
    const profile = normalizeExecutionProfile(response?.state?.executionProfile);
    this.#executionProfile = profile;
    return profile;
  }

  async supportsStructuralSplitting(): Promise<boolean> {
    const response = await this.#loadEngineState();
    return response?.ok === true && response.state?.structuralSplittingSafe === true;
  }

  async supportsPromptTerminology(): Promise<boolean> {
    const profile = await this.getExecutionProfile();
    return profile.supportsPromptTerminology;
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

  #partitionChunks(group: readonly PendingTranslation[], maxItems: number, maxChars: number): PendingTranslation[][] {
    const chunks: PendingTranslation[][] = [];
    let current: PendingTranslation[] = [];
    let currentChars = 0;

    for (const item of group) {
      const itemChars = item.request.html.length;
      if (current.length > 0 && (current.length >= maxItems || currentChars + itemChars > maxChars)) {
        chunks.push(current);
        current = [];
        currentChars = 0;
      }
      current.push(item);
      currentChars += itemChars;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  async #flushGroup(group: PendingTranslation[]): Promise<void> {
    const profile = this.#executionProfile ?? DEFAULT_EXECUTION_PROFILE;
    const batchAllowed = this.#batchSupportedOverride ?? profile.supportsBatch;

    if (!batchAllowed) {
      await this.#runPool(group, Math.max(1, profile.batchConcurrency), (item) => this.#translateSingle(item));
      return;
    }

    const chunks = this.#partitionChunks(group, profile.batchMaxItems, profile.batchMaxChars);
    await this.#runPool(chunks, Math.max(1, profile.batchConcurrency), (chunk) => this.#flushChunk(chunk));
  }

  async #runPool<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
    if (items.length === 0) return;
    if (concurrency <= 1 || items.length === 1) {
      for (const item of items) await worker(item);
      return;
    }
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        if (item !== undefined) await worker(item);
      }
    });
    await Promise.all(workers);
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

    if (this.#batchSupportedOverride === false) {
      await Promise.all(active.map((item) => this.#translateSingle(item)));
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
        this.#batchSupportedOverride = false;
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
