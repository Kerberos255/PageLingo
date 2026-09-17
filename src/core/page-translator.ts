import { collectTranslationRoots, findTranslationRoot, isGeneratedNode } from "./dom-policy";
import type { TranslationProvider } from "./provider";
import { createSafeTranslatedFragment, mountTranslation } from "./render";
import { serializeRichSegment } from "./rich-segment";
import type { DisplayMode } from "../shared/settings";

export interface PageTranslatorOptions {
  sourceLanguage?: string;
  targetLanguage?: string;
  concurrency?: number;
  displayMode?: DisplayMode;
  shouldTranslateRoot?: (root: HTMLElement) => boolean | Promise<boolean>;
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
  readonly #shouldTranslateRoot: ((root: HTMLElement) => boolean | Promise<boolean>) | null;
  #displayMode: DisplayMode;
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
    this.#shouldTranslateRoot = options.shouldTranslateRoot ?? null;
    this.#displayMode = options.displayMode ?? "bilingual";
  }

  get translatedCount(): number {
    return this.#records.size;
  }

  setDisplayMode(displayMode: DisplayMode): void {
    if (this.#displayMode === displayMode) return;
    this.#displayMode = displayMode;
    for (const [root, record] of this.#records) {
      this.#applyDisplayMode(root, record.translationNode);
    }
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
    if (this.#shouldTranslateRoot && !await this.#shouldTranslateRoot(root)) {
      const previous = this.#records.get(root);
      if (previous) {
        this.#clearDisplayMode(root);
        previous.translationNode.remove();
        this.#records.delete(root);
      }
      return;
    }

    const segment = serializeRichSegment(root);
    if (!segment.html.trim()) return;

    const previous = this.#records.get(root);
    if (previous?.fingerprint === segment.fingerprint) return;
    if (previous) {
      this.#clearDisplayMode(root);
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
    const translationNode = mountTranslation(root, fragment, this.#targetLanguage);
    this.#records.set(root, { translationNode, fingerprint: segment.fingerprint });
    this.#applyDisplayMode(root, translationNode);
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
    for (const [root, { translationNode }] of this.#records) {
      this.#clearDisplayMode(root);
      translationNode.remove();
    }
    this.#records.clear();
  }

  #applyDisplayMode(root: HTMLElement, translationNode: HTMLElement): void {
    this.#clearDisplayMode(root);
    if (this.#displayMode !== "translation") return;

    if (["LI", "TD", "TH"].includes(root.tagName)) {
      const computed = this.#doc.defaultView?.getComputedStyle(root);
      if (computed) {
        root.style.setProperty("--pagelingo-source-font-size", computed.fontSize);
        root.style.setProperty("--pagelingo-source-line-height", computed.lineHeight);
      }
      root.classList.add("flt-source-content-hidden");
      translationNode.dataset.fltDisplayMode = "translation";
      return;
    }

    root.classList.add("flt-source-hidden");
    translationNode.dataset.fltDisplayMode = "translation";
  }

  #clearDisplayMode(root: HTMLElement): void {
    root.classList.remove("flt-source-hidden", "flt-source-content-hidden");
    root.style.removeProperty("--pagelingo-source-font-size");
    root.style.removeProperty("--pagelingo-source-line-height");
  }

  #queue(root: HTMLElement): void {
    const previous = this.#records.get(root);
    if (previous) {
      this.#clearDisplayMode(root);
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
