const ROOT_TAGS = new Set([
  "P", "LI", "BLOCKQUOTE", "FIGCAPTION", "TD", "TH", "DT", "DD",
  "H1", "H2", "H3", "H4", "H5", "H6", "SUMMARY",
]);

const SKIP_SELECTOR = [
  "script", "style", "noscript", "template",
  "textarea", "input", "select", "option", "button",
  "pre", "code", "kbd", "samp", "var",
  "svg", "math", "canvas", "video", "audio",
  "[contenteditable]:not([contenteditable='false'])",
  "[data-flt-generated]",
  "[hidden]", "[aria-hidden='true']",
].join(",");

const FALLBACK_STRUCTURAL_SELECTOR = [
  "a", "div", "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "section",
  "article", "header", "footer", "nav", "aside", "figure", "svg", "img", "picture", "video", "canvas",
  "button", "input", "select", "textarea", "iframe",
].join(",");

export function isGeneratedNode(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentElement;
  return Boolean(element?.closest("[data-flt-generated]"));
}

export function isTranslationRootElement(element: Element): boolean {
  return ROOT_TAGS.has(element.tagName);
}

function isEffectivelyHidden(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  let current: Element | null = element;
  while (current) {
    const style = view.getComputedStyle(current);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      style.contentVisibility === "hidden"
    ) return true;
    if (current === current.ownerDocument.documentElement) break;
    current = current.parentElement;
  }
  return false;
}

export function isEligibleTextNode(node: Text): boolean {
  if (!node.data.trim()) return false;
  const parent = node.parentElement;
  if (!parent || parent.closest(SKIP_SELECTOR) || isEffectivelyHidden(parent)) return false;
  return /[\p{L}\p{N}]/u.test(node.data);
}

function isFallbackLeafContainer(element: Element): boolean {
  if (!["DIV", "SPAN", "LABEL"].includes(element.tagName)) return false;
  if (element.closest(SKIP_SELECTOR)) return false;
  if (element.tagName === "DIV" && element.children.length > 0) return false;
  if (element.querySelector(FALLBACK_STRUCTURAL_SELECTOR)) return false;
  return Boolean((element.textContent ?? "").trim());
}

export function findTranslationRoot(node: Text): HTMLElement | null {
  let current = node.parentElement;
  let fallback: HTMLElement | null = null;

  while (current && current !== current.ownerDocument.body) {
    if (current.matches(SKIP_SELECTOR)) return null;
    if (isTranslationRootElement(current)) return current as HTMLElement;
    if (!fallback && isFallbackLeafContainer(current)) fallback = current as HTMLElement;
    current = current.parentElement;
  }

  return fallback;
}

function wrapDirectAnchorTextNodes(scope: ParentNode): void {
  const doc = scope instanceof Document ? scope : scope.ownerDocument;
  if (!doc) return;

  const anchors: HTMLAnchorElement[] = [];
  if (scope instanceof Element && scope.tagName === "A") anchors.push(scope as HTMLAnchorElement);
  if ("querySelectorAll" in scope) anchors.push(...Array.from(scope.querySelectorAll<HTMLAnchorElement>("a")));

  const skipTags = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "INPUT", "SELECT", "OPTION", "BUTTON",
    "PRE", "CODE", "KBD", "SAMP", "VAR", "SVG", "MATH", "CANVAS", "VIDEO", "AUDIO",
  ]);

  for (const anchor of anchors) {
    if (anchor.closest("[data-flt-generated]")) continue;
    const containers = [anchor, ...Array.from(anchor.querySelectorAll<HTMLElement>("*"))];
    for (const container of containers) {
      if (skipTags.has(container.tagName) || container.hasAttribute("data-flt-source-text-wrapper")) continue;
      for (const child of Array.from(container.childNodes)) {
        if (child.nodeType !== Node.TEXT_NODE) continue;
        const text = child.textContent ?? "";
        if (!text.trim() || !/[\p{L}\p{N}]/u.test(text)) continue;
        const wrapper = doc.createElement("span");
        wrapper.dataset.fltSourceTextWrapper = "true";
        child.replaceWith(wrapper);
        wrapper.append(child);
      }
    }
  }
}

export function collectTranslationRoots(scope: ParentNode): HTMLElement[] {
  const doc = scope instanceof Document ? scope : scope.ownerDocument;
  if (!doc) return [];

  wrapDirectAnchorTextNodes(scope);
  const roots = new Set<HTMLElement>();
  const walker = doc.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();

  while (current) {
    const text = current as Text;
    if (isEligibleTextNode(text)) {
      const root = findTranslationRoot(text);
      if (root) roots.add(root);
    }
    current = walker.nextNode();
  }

  return Array.from(roots);
}
