export class ShortTranslationCache {
  readonly #maxEntries: number;
  readonly #maxInputCharacters: number;
  readonly #entries = new Map<string, string>();

  constructor(maxEntries = 1024, maxInputCharacters = 512) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("maxEntries must be a positive integer");
    if (!Number.isInteger(maxInputCharacters) || maxInputCharacters < 1) {
      throw new Error("maxInputCharacters must be a positive integer");
    }
    this.#maxEntries = maxEntries;
    this.#maxInputCharacters = maxInputCharacters;
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
    if (this.#entries.has(key)) this.#entries.delete(key);
    this.#entries.set(key, translatedHtml);
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.#entries.clear();
  }

  size(): number {
    return this.#entries.size;
  }

  #isCacheable(html: string): boolean {
    return html.length > 0 && html.length <= this.#maxInputCharacters;
  }

  #key(routeKey: string, html: string): string {
    return `${routeKey}\u0000${html}`;
  }
}
