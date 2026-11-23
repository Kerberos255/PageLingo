import { parseHtmlDocument } from "../shared/html-parser";

// Matches a leading list/section ordinal followed by ASCII whitespace and a remaining body:
//   - "1. Service", "13. Term and Termination.", "1.2. Overview", "2.3.1. Scope"
//   - "1) First step", "(1) First step", "[1] Reference"
// Restricts each numeric segment to 1–3 digits so 4-digit years like "2026. That was..." are never treated as ordinals.
const LEADING_LIST_MARKER_RE = /^([ \t\r\n]*)(\d{1,3}(?:\.\d{1,3})*\.|\d{1,3}\)|\(\d{1,3}\)|\[\d{1,3}\])([ \t]+)([\s\S]+)$/u;
const LINE_LEADING_DOT_ORDINAL_RE = /^([ \t]*)(\d{1,3}(?:\.\d{1,3})*)\.([ \t]+)(?=\S)/u;
const DIGIT_DOT_DIGIT_SOURCE_RE = /\d\.\d/u;
const DIGIT_CJK_DOT_DIGIT_RE = /(?<=\d)[。．](?=\d)/gu;
const OPAQUE_TAG_SET = new Set(["CODE", "KBD", "SAMP", "VAR"]);

export interface ProtectedListMarker {
  slotId: string | null;
  textIndex: number;
  leading: string;
  marker: string;
  separator: string;
}

export interface ProtectedHtmlMarkers {
  html: string;
  markers: ProtectedListMarker[];
}

export interface ProtectedTextMarker {
  text: string;
  prefix: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function matchLeadingListMarker(text: string): { leading: string; marker: string; separator: string; rest: string } | null {
  const match = text.match(LEADING_LIST_MARKER_RE);
  if (!match) return null;
  const [, leading = "", marker = "", separator = " ", rest = ""] = match;
  if (!/\p{L}/u.test(rest)) return null;
  return { leading, marker, separator, rest };
}

function stripDuplicateEchoedMarker(translated: string, marker: string): string {
  const trimmed = translated.replace(/^[ \t]+/u, "");
  const numericDot = marker.match(/^(\d{1,3}(?:\.\d{1,3})*)\.$/u);
  if (numericDot) {
    const dupRe = new RegExp(`^${escapeRegExp(numericDot[1]!)}[。．.][ \\t]*`, "u");
    const stripped = trimmed.replace(dupRe, "");
    if (stripped.trim()) return stripped;
  } else {
    const dupRe = new RegExp(`^${escapeRegExp(marker)}[ \\t]*`, "u");
    const stripped = trimmed.replace(dupRe, "");
    if (stripped.trim()) return stripped;
  }
  return trimmed;
}

/**
 * Restores ASCII decimal/version dots (e.g. "3。14" -> "3.14", "1。2。3" -> "1.2.3")
 * and consistent line-leading numeric ordinal punctuation/spacing (e.g. "1。 服务" or
 * "4.发布内容" -> "1. 服务" / "4. 发布内容") whenever the source used ASCII dots.
 */
export function normalizeNumericDotPunctuation(sourceText: string, translatedText: string): string {
  let result = translatedText;
  if (DIGIT_DOT_DIGIT_SOURCE_RE.test(sourceText)) {
    result = result.replace(DIGIT_CJK_DOT_DIGIT_RE, ".");
  }
  if (!sourceText.includes(".") || !/\d/u.test(sourceText)) {
    return result;
  }
  const sourceLines = sourceText.split("\n");
  const translatedLines = result.split("\n");
  if (sourceLines.length === translatedLines.length) {
    let changed = false;
    for (let i = 0; i < sourceLines.length; i += 1) {
      const m = sourceLines[i]!.match(LINE_LEADING_DOT_ORDINAL_RE);
      if (!m) continue;
      const [, srcLead = "", srcNum = "", srcSep = " "] = m;
      const tLine = translatedLines[i]!;
      const ordRe = new RegExp(`^([ \\t]*)${escapeRegExp(srcNum)}[。．.]([ \\t]*)(?=\\S)`, "u");
      const replaced = tLine.replace(ordRe, `${srcLead}${srcNum}.${srcSep}`);
      if (replaced !== tLine) {
        translatedLines[i] = replaced;
        changed = true;
      }
    }
    if (changed) result = translatedLines.join("\n");
  }
  return result;
}

function isSlotAtLineStart(slot: Element, body: HTMLElement): boolean {
  let cursor: Node = slot;
  while (cursor && cursor !== body) {
    let prev = cursor.previousSibling;
    while (prev) {
      if (prev.nodeType === Node.ELEMENT_NODE) {
        const el = prev as Element;
        if (el.tagName === "BR") return true;
        if (OPAQUE_TAG_SET.has(el.tagName) && /^__FLT_LINK_START_\d+__$/u.test((el.textContent ?? "").trim())) {
          prev = prev.previousSibling;
          continue;
        }
        if ((el.textContent ?? "").trim()) return false;
      } else if (prev.nodeType === Node.TEXT_NODE && (prev.textContent ?? "").trim()) {
        return false;
      }
      prev = prev.previousSibling;
    }
    if (!cursor.parentElement) break;
    cursor = cursor.parentElement;
  }
  return true;
}

function collectNonOpaqueTextNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      nodes.push(node as Text);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (OPAQUE_TAG_SET.has((node as Element).tagName)) return;
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  walk(root);
  return nodes;
}

/**
 * Strips leading list/section ordinals ("1. ", "1.2. ", "1) ", "(1) ") from line-start
 * slots/text nodes before translation so models translate clean prose without converting
 * ordinal dots into "。" or eating the separator space.
 */
export function protectListMarkersHtml(html: string): ProtectedHtmlMarkers {
  if (!/\d(?:\.|\)|\])/u.test(html)) return { html, markers: [] };
  const parsed = parseHtmlDocument(html);
  if (parsed.head.childNodes.length) return { html, markers: [] };

  const markers: ProtectedListMarker[] = [];
  const slots = Array.from(parsed.body.querySelectorAll("span[data-flt-text-id]"));
  if (slots.length > 0) {
    for (const slot of slots) {
      if (slot.childElementCount > 0) continue;
      const slotId = slot.getAttribute("data-flt-text-id");
      if (slotId === null || !isSlotAtLineStart(slot, parsed.body)) continue;
      const raw = slot.textContent ?? "";
      const matched = matchLeadingListMarker(raw);
      if (!matched) continue;
      slot.textContent = matched.rest;
      markers.push({
        slotId,
        textIndex: -1,
        leading: matched.leading,
        marker: matched.marker,
        separator: matched.separator,
      });
    }
    return {
      html: markers.length ? parsed.body.innerHTML : html,
      markers,
    };
  }

  // Legacy (non-slot) HTML path: protect leading ordinal in the first non-empty text node.
  const textNodes = collectNonOpaqueTextNodes(parsed.body);
  for (let i = 0; i < textNodes.length; i += 1) {
    const node = textNodes[i]!;
    const raw = node.data;
    if (!raw.trim()) continue;
    const matched = matchLeadingListMarker(raw);
    if (matched) {
      node.data = matched.rest;
      markers.push({
        slotId: null,
        textIndex: i,
        leading: matched.leading,
        marker: matched.marker,
        separator: matched.separator,
      });
    }
    break;
  }
  return {
    html: markers.length ? parsed.body.innerHTML : html,
    markers,
  };
}

/**
 * Restores protected leading list/section ordinals and normalizes stray CJK full-stop
 * substitutions inside numbers or line-leading ordinals.
 */
export function restoreListMarkersHtml(
  sourceHtml: string,
  translatedHtml: string,
  markers: readonly ProtectedListMarker[],
): string {
  if (!markers.length && !/\d\./u.test(sourceHtml)) return translatedHtml;

  const targetDoc = parseHtmlDocument(translatedHtml);
  if (targetDoc.head.childNodes.length) return translatedHtml;

  const sourceDoc = parseHtmlDocument(sourceHtml);
  let changed = false;

  const targetSlots = Array.from(targetDoc.body.querySelectorAll("span[data-flt-text-id]"));
  if (targetSlots.length > 0) {
    const sourceSlotMap = new Map<string, string>();
    for (const srcSlot of sourceDoc.body.querySelectorAll("span[data-flt-text-id]")) {
      const id = srcSlot.getAttribute("data-flt-text-id");
      if (id !== null) sourceSlotMap.set(id, srcSlot.textContent ?? "");
    }
    const markerBySlot = new Map<string, ProtectedListMarker>();
    for (const marker of markers) {
      if (marker.slotId !== null) markerBySlot.set(marker.slotId, marker);
    }

    for (const slot of targetSlots) {
      if (slot.childElementCount > 0) continue;
      const id = slot.getAttribute("data-flt-text-id");
      if (id === null) continue;
      let text = slot.textContent ?? "";
      const marker = markerBySlot.get(id);
      if (marker) {
        const cleaned = stripDuplicateEchoedMarker(text, marker.marker);
        const restored = `${marker.leading}${marker.marker}${marker.separator}${cleaned}`;
        if (restored !== text) {
          text = restored;
          changed = true;
        }
      }
      const sourceText = sourceSlotMap.get(id);
      if (sourceText) {
        const normalized = normalizeNumericDotPunctuation(sourceText, text);
        if (normalized !== text) {
          text = normalized;
          changed = true;
        }
      }
      if (slot.textContent !== text) slot.textContent = text;
    }
    return changed ? targetDoc.body.innerHTML : translatedHtml;
  }

  // Legacy (non-slot) HTML path
  const textNodes = collectNonOpaqueTextNodes(targetDoc.body);
  for (const marker of markers) {
    const node = textNodes.find((n) => n.data.trim().length > 0);
    if (!node) continue;
    const cleaned = stripDuplicateEchoedMarker(node.data, marker.marker);
    const restored = `${marker.leading}${marker.marker}${marker.separator}${cleaned}`;
    if (restored !== node.data) {
      node.data = restored;
      changed = true;
    }
  }
  const sourceFullText = sourceDoc.body.textContent ?? "";
  if (DIGIT_DOT_DIGIT_SOURCE_RE.test(sourceFullText)) {
    for (const node of textNodes) {
      const normalized = node.data.replace(DIGIT_CJK_DOT_DIGIT_RE, ".");
      if (normalized !== node.data) {
        node.data = normalized;
        changed = true;
      }
    }
  }
  return changed ? targetDoc.body.innerHTML : translatedHtml;
}

export function protectLeadingListMarkerText(line: string): ProtectedTextMarker {
  const matched = matchLeadingListMarker(line);
  if (!matched) return { text: line, prefix: "" };
  return {
    text: matched.rest,
    prefix: `${matched.leading}${matched.marker}${matched.separator}`,
  };
}

export function restoreLeadingListMarkerText(
  sourceLine: string,
  translatedLine: string,
  prefix: string,
): string {
  let result = translatedLine;
  if (prefix) {
    const markerToken = prefix.trim();
    const cleaned = stripDuplicateEchoedMarker(result, markerToken);
    result = `${prefix}${cleaned}`;
  }
  return normalizeNumericDotPunctuation(sourceLine, result);
}
