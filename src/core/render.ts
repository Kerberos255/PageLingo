import type { LinkSnapshot, OpaqueSnapshot } from "./rich-segment";

const ALLOWED_TAGS = new Set([
  "A", "SPAN", "STRONG", "EM", "B", "I", "U", "S", "SMALL",
  "SUB", "SUP", "MARK", "ABBR", "CITE", "Q", "DEL", "INS",
  "CODE", "KBD", "SAMP", "VAR", "BR", "WBR",
]);

function setOrRemove(element: Element, name: string, value: string | null): void {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

function sanitizeTree(container: HTMLElement): void {
  const elements = Array.from(container.querySelectorAll("*"));
  for (const element of elements) {
    if (!ALLOWED_TAGS.has(element.tagName)) {
      element.replaceWith(...Array.from(element.childNodes));
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      element.removeAttribute(attribute.name);
    }
  }
}

function restoreLinks(container: HTMLElement, links: LinkSnapshot[]): void {
  const anchors = Array.from(container.querySelectorAll("a"));
  anchors.forEach((anchor, index) => {
    const source = links[index];
    if (!source) {
      anchor.replaceWith(...Array.from(anchor.childNodes));
      return;
    }
    setOrRemove(anchor, "href", source.href);
    setOrRemove(anchor, "target", source.target);
    setOrRemove(anchor, "rel", source.rel);
    setOrRemove(anchor, "title", source.title);
    setOrRemove(anchor, "class", source.className || null);
    anchor.addEventListener("click", (event) => {
      if (
        event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
        !source.sourceElement.isConnected
      ) return;
      event.preventDefault();
      source.sourceElement.click();
    });
  });
}

function restoreOpaque(container: HTMLElement, opaque: OpaqueSnapshot[]): void {
  const nodes = Array.from(container.querySelectorAll("code,kbd,samp,var"));
  nodes.forEach((node, index) => {
    const source = opaque[index];
    if (!source) return;
    node.textContent = source.text;
  });
}

export function createSafeTranslatedFragment(
  doc: Document,
  translatedHtml: string,
  links: LinkSnapshot[],
  opaque: OpaqueSnapshot[],
): DocumentFragment {
  const parsed = new DOMParser().parseFromString(translatedHtml, "text/html");
  const holder = doc.createElement("div");
  for (const child of Array.from(parsed.body.childNodes)) {
    holder.append(doc.importNode(child, true));
  }
  sanitizeTree(holder);
  restoreLinks(holder, links);
  restoreOpaque(holder, opaque);

  const fragment = doc.createDocumentFragment();
  while (holder.firstChild) fragment.append(holder.firstChild);
  return fragment;
}

export function mountTranslation(
  root: HTMLElement,
  fragment: DocumentFragment,
  targetLanguage: string,
): HTMLElement {
  const node = root.ownerDocument.createElement("span");
  node.className = "flt-translation";
  node.dataset.fltGenerated = "translation";
  node.lang = targetLanguage;
  node.append(fragment);

  if (["LI", "TD", "TH"].includes(root.tagName)) {
    root.append(node);
  } else {
    root.insertAdjacentElement("afterend", node);
  }

  return node;
}
