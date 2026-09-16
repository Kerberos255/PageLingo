import { isTranslationRootElement } from "./dom-policy";

const INLINE_TAGS = new Set([
  "A", "SPAN", "STRONG", "EM", "B", "I", "U", "S", "SMALL",
  "SUB", "SUP", "MARK", "ABBR", "CITE", "Q", "DEL", "INS",
  "CODE", "KBD", "SAMP", "VAR", "BR", "WBR",
]);
const OPAQUE_TAGS = new Set(["CODE", "KBD", "SAMP", "VAR"]);

export interface LinkSnapshot {
  href: string | null;
  target: string | null;
  rel: string | null;
  title: string | null;
}

export interface OpaqueSnapshot {
  tagName: string;
  text: string;
}

export interface RichSegment {
  html: string;
  links: LinkSnapshot[];
  opaque: OpaqueSnapshot[];
  fingerprint: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function serializeChildren(
  parent: ParentNode,
  root: HTMLElement,
  links: LinkSnapshot[],
  opaque: OpaqueSnapshot[],
): string {
  let html = "";

  for (const node of parent.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      html += escapeHtml(node.textContent ?? "");
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    const element = node as HTMLElement;
    if (element.hasAttribute("data-flt-generated")) continue;
    if (element !== root && isTranslationRootElement(element)) continue;

    const tag = element.tagName;
    if (!INLINE_TAGS.has(tag)) {
      html += serializeChildren(element, root, links, opaque);
      continue;
    }

    const lower = tag.toLowerCase();
    if (tag === "BR" || tag === "WBR") {
      html += `<${lower}>`;
      continue;
    }

    if (tag === "A") {
      links.push({
        href: element.getAttribute("href"),
        target: element.getAttribute("target"),
        rel: element.getAttribute("rel"),
        title: element.getAttribute("title"),
      });
    }

    if (OPAQUE_TAGS.has(tag)) {
      const index = opaque.length;
      opaque.push({ tagName: tag, text: element.textContent ?? "" });
      html += `<${lower}>__FLT_OPAQUE_${index}__</${lower}>`;
      continue;
    }

    html += `<${lower}>${serializeChildren(element, root, links, opaque)}</${lower}>`;
  }

  return html;
}

export function serializeRichSegment(root: HTMLElement): RichSegment {
  const links: LinkSnapshot[] = [];
  const opaque: OpaqueSnapshot[] = [];
  const html = serializeChildren(root, root, links, opaque).trim();
  return {
    html,
    links,
    opaque,
    fingerprint: root.textContent ?? "",
  };
}
