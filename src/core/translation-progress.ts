export class TranslationProgress {
  readonly #document: Document;
  readonly #pending = new Map<Element, {anchor: Text; icon: HTMLElement | null}>();
  #frame = 0;

  constructor(document: Document) {
    this.#document = document;
  }

  show(root: Element, anchor: Text): () => void {
    const view = this.#document.defaultView;
    if (!view) return () => {};
    // Fast local replies do not need a flash of an activity indicator.
    const timer = view.setTimeout(() => {
      if (!this.#pending.size) {
        view.addEventListener("scroll", this.#schedule, true);
        view.addEventListener("resize", this.#schedule);
      }
      this.#pending.set(root, {anchor, icon: null});
      this.#schedule();
    }, 120);
    return () => {
      view.clearTimeout(timer);
      this.#pending.get(root)?.icon?.remove();
      this.#pending.delete(root);
      if (!this.#pending.size) this.clear();
    };
  }

  #schedule = (): void => {
    const view = this.#document.defaultView;
    if (!view || this.#frame) return;
    this.#frame = view.requestAnimationFrame(() => {
      this.#frame = 0;
      const vw = view.innerWidth;
      const vh = view.innerHeight;
      const range = this.#document.createRange();
      const visibleEntries: Array<{ root: Element; entry: { anchor: Text; icon: HTMLElement | null }; rect: DOMRect }> = [];
      const hiddenIcons: Array<{ entry: { anchor: Text; icon: HTMLElement | null } }> = [];

      // Phase 1: Pure READ pass (zero DOM mutations between getClientRects calls).
      for (const [root, entry] of this.#pending) {
        let rect: DOMRect | undefined;
        if (visibleEntries.length < 16 && entry.anchor.isConnected && root.contains(entry.anchor)) {
          range.selectNodeContents(entry.anchor);
          const rects = range.getClientRects();
          rect = rects[rects.length - 1];
        }
        if (!rect || rect.bottom <= 0 || rect.top >= vh || rect.right <= 0 || rect.left >= vw) {
          if (entry.icon) hiddenIcons.push({ entry });
          continue;
        }
        visibleEntries.push({ root, entry, rect });
      }

      // Phase 2: Pure WRITE pass.
      for (const { entry } of hiddenIcons) {
        entry.icon?.remove();
        entry.icon = null;
      }
      for (const { root, entry, rect } of visibleEntries) {
        if (!entry.icon) {
          const icon = this.#document.createElement("span");
          icon.dataset.fltGenerated = "progress";
          icon.setAttribute("aria-hidden", "true");
          (root.closest("dialog[open]") ?? this.#document.body).append(icon);
          entry.icon = icon;
        }
        entry.icon.style.setProperty("left", `${Math.max(2, Math.min(rect.right + 4, vw - 14))}px`, "important");
        entry.icon.style.setProperty("top", `${Math.max(2, (rect.top + rect.bottom - 11) / 2)}px`, "important");
      }
    });
  };

  clear(): void {
    const view = this.#document.defaultView;
    view?.cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    view?.removeEventListener("scroll", this.#schedule, true);
    view?.removeEventListener("resize", this.#schedule);
    for (const entry of this.#pending.values()) entry.icon?.remove();
    this.#pending.clear();
  }
}
