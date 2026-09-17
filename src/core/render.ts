import type { LinkSnapshot, OpaqueSnapshot } from "./rich-segment";

const ALLOWED_TAGS = new Set([
  "A", "SPAN", "STRONG", "EM", "B", "I", "U", "S", "SMALL",
  "SUB", "SUP", "MARK", "ABBR", "CITE", "Q", "DEL", "INS",
  "CODE", "KBD", "SAMP", "VAR", "BR", "WBR",
]);

interface TextIndexPosition {
  node: Text;
  startOffset: number;
  endOffset: number;
  anchor: HTMLAnchorElement | null;
  rawIndex: number;
}

interface RawTextPosition {
  node: Text;
  startOffset: number;
  endOffset: number;
  char: string;
}

interface LinkTextIndex {
  text: string;
  positions: TextIndexPosition[];
  rawPositions: RawTextPosition[];
}

interface LinkMatch {
  start: number;
  end: number;
}

interface RestoredLinkMatch extends LinkMatch {
  source: LinkSnapshot;
  startNode: Text;
  startOffset: number;
  endNode: Text;
  endOffset: number;
}

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
    for (const attribute of Array.from(element.attributes)) element.removeAttribute(attribute.name);
  }
}

function configureRestoredLink(anchor: HTMLAnchorElement, source: LinkSnapshot): void {
  setOrRemove(anchor, "href", source.href);
  setOrRemove(anchor, "target", source.target);
  setOrRemove(anchor, "rel", source.rel);
  setOrRemove(anchor, "title", source.title);
  setOrRemove(anchor, "class", source.className || null);

  const style = source.linkStyle;
  if (style) {
    if (style.color) anchor.style.color = style.color;
    if (style.textDecorationLine) anchor.style.textDecorationLine = style.textDecorationLine;
    if (style.textDecorationStyle) anchor.style.textDecorationStyle = style.textDecorationStyle;
    if (style.textDecorationColor) anchor.style.textDecorationColor = style.textDecorationColor;
    if (style.textDecorationThickness) anchor.style.textDecorationThickness = style.textDecorationThickness;
    if (style.textUnderlineOffset) anchor.style.textUnderlineOffset = style.textUnderlineOffset;
  }

  anchor.addEventListener("click", (event) => {
    if (
      event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
      !source.sourceElement.isConnected
    ) return;
    event.preventDefault();
    source.sourceElement.click();
  });
}

function normalizeLinkMatchText(value: string): string {
  let normalized = "";
  for (const char of value.normalize("NFKC").toLocaleLowerCase()) {
    if (/[\p{White_Space}\p{P}]/u.test(char)) continue;
    normalized += char;
  }
  return normalized;
}

function buildLinkTextIndex(container: HTMLElement): LinkTextIndex {
  const normalized: string[] = [];
  const positions: TextIndexPosition[] = [];
  const rawPositions: RawTextPosition[] = [];
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();

  while (current) {
    const node = current as Text;
    const text = node.data;
    for (let offset = 0; offset < text.length;) {
      const codePoint = text.codePointAt(offset);
      if (codePoint === undefined) break;
      const char = String.fromCodePoint(codePoint);
      const width = char.length;
      const rawIndex = rawPositions.length;
      rawPositions.push({ node, startOffset: offset, endOffset: offset + width, char });
      for (const part of char.normalize("NFKC").toLocaleLowerCase()) {
        if (/[\p{White_Space}\p{P}]/u.test(part)) continue;
        normalized.push(part);
        positions.push({
          node,
          startOffset: offset,
          endOffset: offset + width,
          anchor: node.parentElement?.closest<HTMLAnchorElement>("a") ?? null,
          rawIndex,
        });
      }
      offset += width;
    }
    current = walker.nextNode();
  }

  return { text: normalized.join(""), positions, rawPositions };
}

const CLOSING_LINK_PUNCTUATION = new Set([")", "）", "]", "】", "}", "》", "〉", "」", "』", "”", "’"]);

function trailingClosingPunctuationCount(value: string): number {
  let count = 0;
  const chars = Array.from(value.trim());
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    if (!CLOSING_LINK_PUNCTUATION.has(chars[index]!)) break;
    count += 1;
  }
  return count;
}

function extendMatchOverClosingPunctuation(
  index: LinkTextIndex,
  last: TextIndexPosition,
  label: string,
): TextIndexPosition | RawTextPosition {
  let remaining = trailingClosingPunctuationCount(label);
  if (!remaining) return last;
  let extended: TextIndexPosition | RawTextPosition = last;
  for (let cursor = last.rawIndex + 1; cursor < index.rawPositions.length && remaining > 0; cursor += 1) {
    const next = index.rawPositions[cursor]!;
    if (/\p{White_Space}/u.test(next.char)) continue;
    if (!CLOSING_LINK_PUNCTUATION.has(next.char)) break;
    extended = next;
    remaining -= 1;
  }
  return extended;
}

function findLinkMatch(index: LinkTextIndex, label: string): LinkMatch | null {
  const needle = normalizeLinkMatchText(label);
  if (!needle) return null;

  const candidates: LinkMatch[] = [];
  let from = 0;
  while (from <= index.text.length - needle.length) {
    const start = index.text.indexOf(needle, from);
    if (start < 0) break;
    const end = start + needle.length;
    candidates.push({ start, end });
    from = start + 1;
  }

  if (candidates.length === 1) return candidates[0]!;
  const anchored = candidates.filter(({ start, end }) => {
    const first = index.positions[start]?.anchor;
    if (!first) return false;
    for (let cursor = start + 1; cursor < end; cursor += 1) {
      if (index.positions[cursor]?.anchor !== first) return false;
    }
    return true;
  });
  return anchored.length === 1 ? anchored[0]! : null;
}

function restoreLinks(
  container: HTMLElement,
  links: LinkSnapshot[],
  translatedLinkTexts: string[] = [],
): void {
  const index = buildLinkTextIndex(container);
  const matches: RestoredLinkMatch[] = [];

  for (let linkIndex = 0; linkIndex < links.length; linkIndex += 1) {
    const source = links[linkIndex];
    const label = translatedLinkTexts[linkIndex]?.trim();
    if (!source || !label) continue;
    const match = findLinkMatch(index, label);
    if (!match) continue;
    if (matches.some((item) => match.start < item.end && match.end > item.start)) continue;

    const first = index.positions[match.start];
    const last = index.positions[match.end - 1];
    if (!first || !last) continue;
    const extendedLast = extendMatchOverClosingPunctuation(index, last, label);
    matches.push({
      ...match,
      source,
      startNode: first.node,
      startOffset: first.startOffset,
      endNode: extendedLast.node,
      endOffset: extendedLast.endOffset,
    });
  }

  for (const anchor of Array.from(container.querySelectorAll("a"))) {
    anchor.replaceWith(...Array.from(anchor.childNodes));
  }

  matches.sort((a, b) => b.start - a.start);
  for (const match of matches) {
    if (!container.contains(match.startNode) || !container.contains(match.endNode)) continue;
    const range = container.ownerDocument.createRange();
    try {
      range.setStart(match.startNode, match.startOffset);
      range.setEnd(match.endNode, match.endOffset);
      const anchor = container.ownerDocument.createElement("a");
      configureRestoredLink(anchor, match.source);
      anchor.append(range.extractContents());
      range.insertNode(anchor);
    } catch (error) {
      console.warn("[PageLingo] Link restoration skipped", error);
    }
  }
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
  translatedLinkTexts: string[] = [],
): DocumentFragment {
  const parsed = new DOMParser().parseFromString(translatedHtml, "text/html");
  const holder = doc.createElement("div");
  for (const child of Array.from(parsed.body.childNodes)) holder.append(doc.importNode(child, true));
  sanitizeTree(holder);
  restoreLinks(holder, links, translatedLinkTexts);
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

  if (root.tagName === "SPAN" && root.closest("a")) {
    node.style.setProperty("display", "inline", "important");
    node.style.setProperty("margin-block-start", "0", "important");
  }

  if (["LI", "TD", "TH"].includes(root.tagName)) root.append(node);
  else root.insertAdjacentElement("afterend", node);

  return node;
}
