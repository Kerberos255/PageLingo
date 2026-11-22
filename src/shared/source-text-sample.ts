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
  const walker = doc.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('[data-flt-generated="translation"], script, style, noscript, template')) {
        return NodeFilter.FILTER_REJECT;
      }
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
