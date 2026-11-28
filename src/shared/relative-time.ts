const RELATIVE_TIME_SELECTOR = "relative-time,time-ago,local-time";

export const RELATIVE_TIME_PRUNE_DELAY_MS = 4000;

export function relativeTimeElements(scope: Document | Element = document): Element[] {
  const elements: Element[] = [];
  if (scope instanceof Element && scope.matches(RELATIVE_TIME_SELECTOR)) elements.push(scope);
  if ("querySelectorAll" in scope) {
    elements.push(...Array.from(scope.querySelectorAll(RELATIVE_TIME_SELECTOR)));
  }
  return elements;
}

function hasAncestorInSet(node: Element, set: ReadonlySet<Element>): boolean {
  for (let cursor = node.parentElement; cursor; cursor = cursor.parentElement) {
    if (set.has(cursor)) return true;
  }
  return false;
}

interface RelativeTimeLangEntry {
  originalLang: string | null;
  appliedLocale: string;
}

export class RelativeTimeLocalizer {
  readonly #doc: Document;
  readonly #pruneDelayMs: number;
  readonly #snapshots = new Map<Element, RelativeTimeLangEntry>();
  #observer: MutationObserver | null = null;
  #pruneTimer: ReturnType<typeof setTimeout> | null = null;
  #activeLocale: string | null = null;

  constructor(doc: Document = document, pruneDelayMs = RELATIVE_TIME_PRUNE_DELAY_MS) {
    this.#doc = doc;
    this.#pruneDelayMs = pruneDelayMs;
  }

  get trackedCount(): number {
    return this.#snapshots.size;
  }

  localizeScope(scope: Document | Element = this.#doc): void {
    const locale = this.#activeLocale;
    if (!locale) return;
    for (const element of relativeTimeElements(scope)) {
      if (!element.isConnected) continue;
      const existing = this.#snapshots.get(element);
      if (!existing) {
        this.#snapshots.set(element, {
          originalLang: element.getAttribute("lang"),
          appliedLocale: locale,
        });
      } else {
        existing.appliedLocale = locale;
      }
      if (element.getAttribute("lang") !== locale) {
        element.setAttribute("lang", locale);
      }
    }
  }

  start(locale: string): void {
    this.#observer?.disconnect();
    this.#observer = null;
    if (!locale) return;
    this.#activeLocale = locale;
    this.localizeScope(this.#doc);
    const body = this.#doc.body;
    if (!body) return;
    const ObserverCtor = this.#doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    if (typeof ObserverCtor !== "function") return;
    this.#observer = new ObserverCtor((mutations) => {
      const addedElements = new Set<Element>();
      let sawRemovedNodes = false;
      for (const mutation of mutations) {
        if (mutation.removedNodes && mutation.removedNodes.length > 0) {
          sawRemovedNodes = true;
        }
        for (const added of Array.from(mutation.addedNodes)) {
          if (added.nodeType === Node.ELEMENT_NODE && (added as Element).isConnected) {
            addedElements.add(added as Element);
          }
        }
      }
      for (const added of addedElements) {
        if (!added.isConnected || hasAncestorInSet(added, addedElements)) continue;
        this.localizeScope(added);
      }
      if (sawRemovedNodes && this.#snapshots.size > 0) {
        this.#schedulePrune();
      }
    });
    this.#observer.observe(body, { childList: true, subtree: true });
  }

  #schedulePrune(): void {
    if (this.#pruneTimer !== null) return;
    this.#pruneTimer = setTimeout(() => {
      this.#pruneTimer = null;
      this.pruneDetached();
    }, this.#pruneDelayMs);
  }

  #restoreElement(element: Element, entry: RelativeTimeLangEntry): void {
    if (element.getAttribute("lang") !== entry.appliedLocale) return;
    if (entry.originalLang === null) element.removeAttribute("lang");
    else element.setAttribute("lang", entry.originalLang);
  }

  pruneDetached(): number {
    let removed = 0;
    for (const [element, entry] of this.#snapshots) {
      if (element.isConnected) continue;
      this.#restoreElement(element, entry);
      this.#snapshots.delete(element);
      removed += 1;
    }
    return removed;
  }

  stop(): void {
    this.#observer?.disconnect();
    this.#observer = null;
    if (this.#pruneTimer !== null) {
      clearTimeout(this.#pruneTimer);
      this.#pruneTimer = null;
    }
    for (const [element, entry] of this.#snapshots) {
      this.#restoreElement(element, entry);
    }
    this.#snapshots.clear();
    this.#activeLocale = null;
  }
}
