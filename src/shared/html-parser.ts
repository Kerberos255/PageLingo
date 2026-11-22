// Shared lazy DOMParser singleton to avoid per-paragraph/per-slot parser allocations.

let cachedCtor: typeof DOMParser | null = null;
let cachedParser: DOMParser | null = null;

export function getHtmlParser(): DOMParser {
  const Ctor = globalThis.DOMParser;
  if (!cachedParser || cachedCtor !== Ctor) {
    cachedCtor = Ctor;
    cachedParser = new Ctor();
  }
  return cachedParser;
}

export function parseHtmlDocument(html: string): Document {
  return getHtmlParser().parseFromString(html, "text/html");
}

export function parseHtmlBody(html: string): HTMLElement {
  return parseHtmlDocument(html).body;
}
