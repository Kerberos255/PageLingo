import { collectTranslationRoots, findTranslationRoot, isGeneratedNode } from "./dom-policy";
import type { TranslationProvider } from "./provider";
import { createSafeTranslatedFragment, mountTranslation } from "./render";
import { serializeRichSegment } from "./rich-segment";

export interface PageTranslatorOptions {
  sourceLanguage?: string;
  targetLanguage?: string;
  concurrency?: number;
}

interface RecordEntry {
  translationNode: HTMLElement;
  fingerprint: string;
}

export class PageTranslator {
  readonly #doc: Document;
  readonly #provider: TranslationProvider;
  readonly #sourceLanguage: string;
  readonly #targetLanguage: string;
  readonly #concurrency: number;
  readonly #records = new Map<HTMLElement, RecordEntry>();
  readonly #pending = new Set<HTMLElement>();
  #observer: MutationObserver | null = null;
  #flushQueued = false;

  constructor(doc: Document, provider: TranslationProvider, options: PageTranslatorOptions = {}) {
    this.#doc = doc;
    this.#provider = provider;
    this.#sourceLanguage = options.sourceLanguage ?? "en";
    this.#targetLanguage = options.targetLanguage ?? "zh";
    this.#concurrency = Math.max(1, options.concurrency ?? 4);
  }

  get translatedCount(): number {
    return this.#records.size;
  }

  async translateAll(scope: ParentNode = this.#doc.body): Promise<number> {
    const roots = collectTranslationRoots(scope);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(this.#concurrency, roots.length) }, async () => {
      while (cursor < roots.length) {
        const root = roots[cursor++];
        if (root) await this.translateRoot(root);
      }
    });
    await Promise.all(workers);
    return this.#records.size;
  }

  async translateRoot(root: HTMLElement): Promise<void> {
    if (!root.isConnected || isGeneratedNode(root)) return;

    const segment = serializeRichSegment(root);
    if (!segment.html.trim()) return;

    const previous = this.#records.get(root);
    if (previous?.fingerprint === segment.fingerprint) return;
    if (previous) {
      previous.translationNode.remove();
      this.#records.delete(root);
    }

    const translatedHtml = await this.#provider.translateHtml({
      html: segment.html,
      sourceLanguage: this.#sourceLanguage,
      targetLanguage: this.#targetLanguage,
    });

    if (!root.isConnected || (root.textContent ?? "") !== segment.fingerprint) return;

    const fragment = createSafeTranslatedFragment(
      this.#doc,
      translatedHtml,
      segment.links,
      segment.opaque,
    );
    const translationNode = mountTranslation(root, fragment);
    this.#records.set(root, { translationNode, fingerprint: segment.fingerprint });
  }

  observe(): void {
    if (this.#observer || !this.#doc.body) return;
    this.#observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (isGeneratedNode(mutation.target)) continue;

        if (mutation.type === "characterData" && mutation.target.nodeType === Node.TEXT_NODE) {
          const root = findTranslationRoot(mutation.target as Text);
          if (root) this.#queue(root);
          continue;
        }

        for (const added of Array.from(mutation.addedNodes)) {
          if (isGeneratedNode(added)) continue;
          if (added.nodeType === Node.TEXT_NODE) {
            const root = findTranslationRoot(added as Text);
            if (root) this.#queue(root);
          } else if (added.nodeType === Node.ELEMENT_NODE) {
            for (const root of collectTranslationRoots(added as Element)) this.#queue(root);
          }
        }
      }
    });
    this.#observer.observe(this.#doc.body, { childList: true, subtree: true, characterData: true });
  }

  restore(): void {
    this.#observer?.disconnect();
    this.#observer = null;
    this.#pending.clear();
    for (const { translationNode } of this.#records.values()) translationNode.remove();
    this.#records.clear();
  }

  #queue(root: HTMLElement): void {
    const previous = this.#records.get(root);
    if (previous) {
      previous.translationNode.remove();
      this.#records.delete(root);
    }
    this.#pending.add(root);
    if (this.#flushQueued) return;
    this.#flushQueued = true;
    queueMicrotask(() => void this.#flush());
  }

  async #flush(): Promise<void> {
    this.#flushQueued = false;
    const roots = Array.from(this.#pending);
    this.#pending.clear();
    for (const root of roots) {
      try {
        await this.translateRoot(root);
      } catch (error) {
        console.warn("[Local Immersive Translate] Dynamic translation failed", error);
      }
    }
  }
}
