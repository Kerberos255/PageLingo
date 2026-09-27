const TOOLTIP_SELECTOR = "tool-tip,[role='tooltip']";
const INTERACTIVE_SELECTOR = "a,button,input,select,textarea,[contenteditable]:not([contenteditable='false']),[role='button'],[role='menuitem'],[role='option']";

type TooltipReference = {
  id: string;
  relation: "describedby" | "controls";
};

export interface TooltipControllerOptions {
  timeoutMs?: number;
  translate: (element: HTMLElement) => Promise<boolean>;
}

function referencedTargets(trigger: Element): TooltipReference[] {
  const references: TooltipReference[] = [];
  const seen = new Set<string>();
  for (const [name, relation] of [
    ["aria-describedby", "describedby"],
    ["aria-controls", "controls"],
  ] as const) {
    for (const token of (trigger.getAttribute(name) ?? "").split(/\s+/)) {
      const id = token.trim();
      if (!id) continue;
      const key = `${relation}:\0${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      references.push({ id, relation });
    }
  }
  return references;
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

function isSafeTooltipCandidate(
  element: Element,
  relation: TooltipReference["relation"] | "inserted",
): element is HTMLElement {
  if (!(element instanceof HTMLElement) || !element.isConnected) return false;
  if (relation === "inserted" && !element.matches(TOOLTIP_SELECTOR)) return false;
  if (element.matches(INTERACTIVE_SELECTOR) || element.querySelector(INTERACTIVE_SELECTOR)) return false;

  const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 600 || !/\p{L}/u.test(text)) return false;
  if (!isVisibleEnough(element)) return false;

  const view = element.ownerDocument.defaultView;
  const style = view?.getComputedStyle(element);
  if (
    relation === "controls" &&
    !element.matches(TOOLTIP_SELECTOR) &&
    !element.hasAttribute("popover") &&
    style?.position !== "absolute" &&
    style?.position !== "fixed"
  ) {
    return false;
  }

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
  #probeTimers: Array<ReturnType<typeof setTimeout>> = [];
  #started = false;
  #disposed = false;
  #generation = 0;
  #active = new WeakSet<HTMLElement>();

  constructor(doc: Document, options: TooltipControllerOptions) {
    this.#doc = doc;
    this.#translate = options.translate;
    this.#timeoutMs = Math.max(100, options.timeoutMs ?? 700);
  }

  start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    // pointerover/focusin are delegated so dynamically mounted controls need no scanning.
    // We never observe class/style/attributes; only a short child-list watch is armed by
    // an actual user interaction.
    this.#doc.addEventListener("pointerover", this.#onTrigger, true);
    this.#doc.addEventListener("focusin", this.#onTrigger, true);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#stopWatch();
    if (this.#started) {
      this.#doc.removeEventListener("pointerover", this.#onTrigger, true);
      this.#doc.removeEventListener("focusin", this.#onTrigger, true);
    }
    this.#started = false;
  }

  #onTrigger = (event: Event): void => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || this.#disposed) return;
    const trigger = target.closest("[aria-describedby],[aria-controls]") ?? target;
    if (event.type === "pointerover" && event instanceof MouseEvent) {
      const related = event.relatedTarget;
      if (related instanceof Node && trigger.contains(related)) return;
    }
    void this.#handleTrigger(trigger);
  };

  async #handleTrigger(trigger: Element): Promise<void> {
    this.#generation += 1;
    const generation = this.#generation;
    this.#stopWatch();

    const references = referencedTargets(trigger);
    if (this.#disposed || !this.#doc.body) return;

    // Arm the bounded child-list watch synchronously before the first await. A site may
    // insert a portal tooltip in its own handler for this same hover/focus event.
    this.#observer = new MutationObserver((mutations) => {
      void this.#inspectAddedNodes(mutations, references, generation).then((translated) => {
        if (translated) this.#finishWatch(generation);
      });
    });
    this.#observer.observe(this.#doc.body, { childList: true, subtree: true });

    // Existing tooltip nodes are often revealed by class/style changes. Do not observe those
    // attributes; re-check only the current trigger's explicit references for a few moments.
    for (const delay of [50, 150, 350]) {
      this.#probeTimers.push(setTimeout(() => {
        void this.#inspectReferences(references, generation).then((translated) => {
          if (translated) this.#finishWatch(generation);
        });
      }, delay));
    }
    this.#timer = setTimeout(() => this.#finishWatch(generation), this.#timeoutMs);

    if (await this.#inspectReferences(references, generation)) {
      this.#finishWatch(generation);
    }
  }

  async #inspectReferences(references: TooltipReference[], generation: number): Promise<boolean> {
    if (this.#disposed || generation !== this.#generation) return false;
    for (const reference of references) {
      const candidate = this.#doc.getElementById(reference.id);
      if (!candidate || !isSafeTooltipCandidate(candidate, reference.relation)) continue;
      if (await this.#translateOnce(candidate)) return generation === this.#generation;
    }
    return false;
  }

  async #inspectAddedNodes(
    mutations: MutationRecord[],
    references: TooltipReference[],
    generation: number,
  ): Promise<boolean> {
    if (this.#disposed || generation !== this.#generation) return false;
    if (await this.#inspectReferences(references, generation)) return true;

    const candidates = new Set<HTMLElement>();
    for (const mutation of mutations) {
      for (const added of Array.from(mutation.addedNodes)) {
        if (!(added instanceof Element)) continue;
        if (isSafeTooltipCandidate(added, "inserted")) candidates.add(added);
        for (const nested of Array.from(added.querySelectorAll(TOOLTIP_SELECTOR))) {
          if (isSafeTooltipCandidate(nested, "inserted")) candidates.add(nested);
        }
      }
    }

    for (const candidate of candidates) {
      if (this.#disposed || generation !== this.#generation) return false;
      if (await this.#translateOnce(candidate)) return generation === this.#generation;
    }
    return false;
  }

  async #translateOnce(candidate: HTMLElement): Promise<boolean> {
    if (this.#active.has(candidate)) return false;
    this.#active.add(candidate);
    try {
      return await this.#translate(candidate);
    } catch (error) {
      console.warn("[PageLingo] Tooltip translation failed", error);
      return false;
    } finally {
      this.#active.delete(candidate);
    }
  }

  #finishWatch(generation: number): void {
    if (generation !== this.#generation) return;
    this.#generation += 1;
    this.#stopWatch();
  }

  #stopWatch(): void {
    this.#observer?.disconnect();
    this.#observer = null;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    for (const timer of this.#probeTimers) clearTimeout(timer);
    this.#probeTimers = [];
  }
}
