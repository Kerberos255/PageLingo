const TOOLTIP_SELECTOR = "tool-tip,[role='tooltip']";
const INTERACTIVE_SELECTOR = "a,button,input,select,textarea,[contenteditable]:not([contenteditable='false']),[role='button'],[role='menuitem'],[role='option']";

export interface TooltipControllerOptions {
  timeoutMs?: number;
  translate: (element: HTMLElement) => Promise<boolean>;
}

function referencedIds(trigger: Element): string[] {
  const ids = new Set<string>();
  for (const name of ["aria-describedby", "aria-controls"]) {
    for (const token of (trigger.getAttribute(name) ?? "").split(/\s+/)) {
      if (token) ids.add(token);
    }
  }
  return Array.from(ids);
}

function isVisibleEnough(element: HTMLElement): boolean {
  const view = element.ownerDocument.defaultView;
  if (!view) return true;
  const style = view.getComputedStyle(element);
  return style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.visibility !== "collapse" &&
    Number.parseFloat(style.opacity || "1") !== 0;
}

function isSafeTooltipCandidate(element: Element, explicitlyReferenced: boolean): element is HTMLElement {
  if (!(element instanceof HTMLElement) || !element.isConnected) return false;
  if (!explicitlyReferenced && !element.matches(TOOLTIP_SELECTOR)) return false;
  if (element.matches(INTERACTIVE_SELECTOR) || element.querySelector(INTERACTIVE_SELECTOR)) return false;
  const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 600 || !/\p{L}/u.test(text)) return false;
  if (!isVisibleEnough(element)) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width > 900 || rect.height > 600) return false;
  return true;
}

export class TooltipController {
  readonly #doc: Document;
  readonly #translate: (element: HTMLElement) => Promise<boolean>;
  readonly #timeoutMs: number;
  #observer: MutationObserver | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  #disposed = false;
  #seen = new WeakSet<HTMLElement>();

  constructor(doc: Document, options: TooltipControllerOptions) {
    this.#doc = doc;
    this.#translate = options.translate;
    this.#timeoutMs = Math.max(100, options.timeoutMs ?? 700);
  }

  start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    this.#doc.addEventListener("pointerover", this.#onTrigger, true);
    this.#doc.addEventListener("focusin", this.#onTrigger, true);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stopWatch();
    if (this.#started) {
      this.#doc.removeEventListener("pointerover", this.#onTrigger, true);
      this.#doc.removeEventListener("focusin", this.#onTrigger, true);
    }
    this.#started = false;
  }

  #onTrigger = (event: Event): void => {
    const trigger = event.target instanceof Element ? event.target : null;
    if (!trigger || this.#disposed) return;
    void this.#handleTrigger(trigger);
  };

  async #handleTrigger(trigger: Element): Promise<void> {
    this.#stopWatch();
    const ids = referencedIds(trigger);
    let translated = false;

    for (const id of ids) {
      const candidate = this.#doc.getElementById(id);
      if (candidate && isSafeTooltipCandidate(candidate, true)) {
        translated = await this.#translateOnce(candidate) || translated;
      }
    }
    if (translated || this.#disposed || !this.#doc.body) return;

    const wantedIds = new Set(ids);
    this.#observer = new MutationObserver((mutations) => {
      void this.#inspectAddedNodes(mutations, wantedIds);
    });
    this.#observer.observe(this.#doc.body, { childList: true, subtree: true });
    this.#timer = setTimeout(() => this.#stopWatch(), this.#timeoutMs);
  }

  async #inspectAddedNodes(mutations: MutationRecord[], wantedIds: Set<string>): Promise<void> {
    if (this.#disposed) return;
    const candidates = new Set<HTMLElement>();

    for (const id of wantedIds) {
      const referenced = this.#doc.getElementById(id);
      if (referenced && isSafeTooltipCandidate(referenced, true)) candidates.add(referenced);
    }

    for (const mutation of mutations) {
      for (const added of Array.from(mutation.addedNodes)) {
        if (!(added instanceof Element)) continue;
        if (isSafeTooltipCandidate(added, false)) candidates.add(added);
        for (const nested of Array.from(added.querySelectorAll(TOOLTIP_SELECTOR))) {
          if (isSafeTooltipCandidate(nested, false)) candidates.add(nested);
        }
      }
    }

    for (const candidate of candidates) {
      if (await this.#translateOnce(candidate)) {
        this.#stopWatch();
        return;
      }
    }
  }

  async #translateOnce(candidate: HTMLElement): Promise<boolean> {
    if (this.#seen.has(candidate)) return true;
    this.#seen.add(candidate);
    try {
      return await this.#translate(candidate);
    } catch (error) {
      console.warn("[PageLingo] Tooltip translation failed", error);
      return false;
    }
  }

  #stopWatch(): void {
    this.#observer?.disconnect();
    this.#observer = null;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
