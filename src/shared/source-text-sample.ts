const SAMPLE_SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "MATH", "CANVAS", "CODE", "PRE",
]);

export function sourceTextSample(
  root: Document | Element,
  maxChars = 4096,
): string {
  const scope = root instanceof Document
    ? (root.querySelector("article, main, [role='main']") ?? root.body)
    : root;
  if (!scope) return "";

  const doc = scope.ownerDocument ?? (root instanceof Document ? root : document);
  const pieces: string[] = [];
  let length = 0;
  const walker = doc.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        if (
          SAMPLE_SKIP_TAGS.has(el.tagName) ||
          el.getAttribute("data-flt-generated") === "translation" ||
          el.hasAttribute("hidden") ||
          el.getAttribute("aria-hidden") === "true"
        ) {
          return NodeFilter.FILTER_REJECT;
        }
        const parent = el.parentElement;
        if (parent && parent.tagName === "DETAILS" && !parent.hasAttribute("open") && el.tagName !== "SUMMARY") {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_SKIP;
      }
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let current = walker.nextNode();
  while (current && length < maxChars) {
    const value = (current.textContent ?? "").replace(/\s+/g, " ").trim();
    if (value) {
      pieces.push(value);
      length += value.length + 1;
    }
    current = walker.nextNode();
  }

  return pieces.join(" ").replace(/\s+/g, " ").trim().slice(0, maxChars);
}
