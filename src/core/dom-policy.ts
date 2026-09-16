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

export function isGeneratedNode(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentElement;
  return Boolean(element?.closest("[data-flt-generated]"));
}

export function isTranslationRootElement(element: Element): boolean {
  return ROOT_TAGS.has(element.tagName);
}

export function isEligibleTextNode(node: Text): boolean {
  if (!node.data.trim()) return false;
  const parent = node.parentElement;
  if (!parent || parent.closest(SKIP_SELECTOR)) return false;
  return /[\p{L}\p{N}]/u.test(node.data);
}

function isFallbackLeafContainer(element: Element): boolean {
  if (!["DIV", "SPAN", "A", "LABEL"].includes(element.tagName)) return false;
  if (element.closest(SKIP_SELECTOR)) return false;
  return !Array.from(element.children).some((child) => isTranslationRootElement(child));
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

export function collectTranslationRoots(scope: ParentNode): HTMLElement[] {
  const doc = scope instanceof Document ? scope : scope.ownerDocument;
  if (!doc) return [];

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
