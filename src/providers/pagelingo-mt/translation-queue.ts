import type {CheckedTranslationResult, TranslationRequest} from "../../core/provider";
import {ShortTranslationCache} from "../bergamot/translation-cache";

/** Serialize CPU work and reuse only successful results for the same full input.
 * Memory only: at most 256 entries / 2,097,152 retained UTF-16 code units. */
export class MtTranslationQueue {
  readonly #cache = new ShortTranslationCache(256, 8192, 2_097_152);
  readonly #translate: (request: TranslationRequest) => Promise<CheckedTranslationResult>;
  readonly #namespace: string;
  #tail: Promise<unknown> = Promise.resolve();
  #epoch = 0;

  constructor(namespace: string, translate: (request: TranslationRequest) => Promise<CheckedTranslationResult>) {
    this.#namespace = namespace;
    this.#translate = translate;
  }

  translate(request: TranslationRequest): Promise<CheckedTranslationResult> {
    // Snapshot before waiting: a caller cannot change the cache key or the model
    // input by mutating an object while another paragraph is being generated.
    const snapshot: TranslationRequest = {...request};
    if (request.terminology) snapshot.terminology = request.terminology.map(entry => ({...entry}));
    const epoch = this.#epoch;
    const key = JSON.stringify([this.#namespace, snapshot.sourceLanguage, snapshot.targetLanguage,
      snapshot.context ?? null, snapshot.terminology ?? []]);
    if (snapshot.signal?.aborted) return Promise.reject(new Error("Translation aborted"));
    const ready = this.#cache.get(key, snapshot.html);
    if (ready !== undefined) return Promise.resolve().then(() => {
      if (snapshot.signal?.aborted) throw new Error("Translation aborted");
      return {html: ready, accepted: true};
    });
    const run = this.#tail.then(async () => {
      if (snapshot.signal?.aborted) throw new Error("Translation aborted");
      const cached = epoch === this.#epoch ? this.#cache.get(key, snapshot.html) : undefined;
      if (cached !== undefined) return {html: cached, accepted: true};
      const result = await this.#translate(snapshot);
      if (result.accepted && epoch === this.#epoch && !snapshot.signal?.aborted) {
        this.#cache.set(key, snapshot.html, result.html);
      }
      return result;
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  clear(): void {
    this.#epoch++;
    this.#cache.clear();
  }
}
