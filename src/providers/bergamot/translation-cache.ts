export class ShortTranslationCache {
  readonly #maxEntries: number;
  readonly #maxInputCharacters: number;
  readonly #maxCharacters: number;
  readonly #entries = new Map<string, string>();
  #characters = 0;

  constructor(maxEntries = 1024, maxInputCharacters = 4096, maxCharacters = 2_097_152) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("maxEntries must be a positive integer");
    if (!Number.isInteger(maxInputCharacters) || maxInputCharacters < 1) {
      throw new Error("maxInputCharacters must be a positive integer");
    }
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) throw new Error("maxCharacters must be a positive integer");
    this.#maxEntries = maxEntries;
    this.#maxInputCharacters = maxInputCharacters;
    this.#maxCharacters = maxCharacters;
  }

  get(routeKey: string, html: string): string | undefined {
    if (!this.#isCacheable(html)) return undefined;
    const key = this.#key(routeKey, html);
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(routeKey: string, html: string, translatedHtml: string): void {
    if (!this.#isCacheable(html)) return;
    const key = this.#key(routeKey, html);
    this.#delete(key);
    const size = key.length + translatedHtml.length;
    if (size > this.#maxCharacters) return;
    this.#entries.set(key, translatedHtml);
    this.#characters += size;
    while (this.#entries.size > this.#maxEntries || this.#characters > this.#maxCharacters) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#delete(oldest.value);
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#characters = 0;
  }

  size(): number {
    return this.#entries.size;
  }

  retainedCharacters(): number { return this.#characters; }

  #delete(key: string): void {
    const value = this.#entries.get(key);
    if (value === undefined) return;
    this.#characters -= key.length + value.length;
    this.#entries.delete(key);
  }

  #isCacheable(html: string): boolean {
    return html.length > 0 && html.length <= this.#maxInputCharacters;
  }

  #key(routeKey: string, html: string): string {
    return `${routeKey}\u0000${html}`;
  }
}
