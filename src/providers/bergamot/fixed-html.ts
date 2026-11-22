import { termOccurrenceCount } from "../../core/rich-segment";
import { getHtmlParser, parseHtmlDocument } from "../../shared/html-parser";

const textSlot = "span[data-flt-text-id]";
const term = "span[data-flt-term-id]";
const shortLabel = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} \u2010-\u2015-]{0,39}$/u;
const labelPrefix = /^<(?:strong|b)><span data-flt-text-id="0">/u;
const termId = (element: Element) => element.getAttribute("data-flt-term-id");

function keepTermsInTranslatedText(source: HTMLElement, target: HTMLElement): void {
  const targetSlots = [...target.querySelectorAll(textSlot)];
  for (const sourceSlot of source.querySelectorAll(textSlot)) {
    const markers = [...sourceSlot.children].filter((element) => element.matches(term));
    if (!markers.length) continue;
    const matching = targetSlots.filter((slot) => slot.getAttribute("data-flt-text-id") === sourceSlot.getAttribute("data-flt-text-id"));
    if (matching.length !== 1) continue;
    const translatedSlot = matching[0]!;
    const translatedMarkers = [...translatedSlot.children].filter((element) => element.matches(term));
    if (JSON.stringify(markers.map(termId)) !== JSON.stringify(translatedMarkers.map(termId))) continue;
    const original = sourceSlot.textContent ?? "", translated = translatedSlot.textContent ?? "";
    const names = new Set(markers.map((marker) => marker.textContent ?? ""));
    if ([...names].every((name) => {
      if (!name) return false;
      const count = termOccurrenceCount(original, name, true);
      return count > 0 && count === termOccurrenceCount(translated, name, true);
    })) {
      // Bergamot can preserve every word while assigning the term tags to different
      // words. Keep the full translated slot if the original names are already there.
      for (const marker of translatedMarkers) marker.replaceWith(...marker.childNodes);
      continue;
    }

    // Per-marker deduplication: if an engine emitted an empty term span while the
    // exact protected name already survives in the slot text outside term markers,
    // remove the empty marker so restoreTerminology never duplicates the name.
    const outsideText = [...translatedSlot.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? "")
      .join("");
    for (let i = 0; i < markers.length; i += 1) {
      const sourceMarker = markers[i]!;
      const translatedMarker = translatedMarkers[i]!;
      const name = sourceMarker.textContent ?? "";
      if (!name || translatedMarker.textContent?.trim()) continue;
      const expected = termOccurrenceCount(original, name, true);
      if (expected > 0 && termOccurrenceCount(outsideText, name, true) === expected) {
        const sameNameMarkers = markers.filter((m) => (m.textContent ?? "") === name);
        const allEmpty = sameNameMarkers.every((m) => {
          const idx = markers.indexOf(m);
          return !translatedMarkers[idx]?.textContent?.trim();
        });
        if (allEmpty) translatedMarker.remove();
      }
    }
  }
}

function labelSlots(body: HTMLElement): [Element, Element] | undefined {
  const [emphasis, description] = body.children;
  const label = emphasis?.firstElementChild;
  if (body.children.length !== 2 || !emphasis?.matches("strong,b") || emphasis.childNodes.length !== 1
      || !label?.matches('span[data-flt-text-id="0"]') || label.childElementCount
      || !description?.matches('span[data-flt-text-id="1"]')) return undefined;
  return [label, description];
}

/**
 * Convert protected term spans into opaque <code> markers before calling Bergamot WASM.
 * Bergamot translates text inside <span> and projects span boundaries via soft alignment,
 * which can transliterate brand names ("Claude" -> "克劳德") and emit empty leading spans,
 * causing duplicated output such as "ClaudeGPT克劳德和GPT模型". Bergamot treats <code> as
 * an opaque non-translatable token and places it cleanly in target word order.
 */
export function prepareBergamotFixedHtml(html: string): string {
  if (!html.includes("data-flt-term-id=")) return html;
  const doc = parseHtmlDocument(html);
  if (doc.head.childNodes.length) return html;
  let changed = false;
  for (const marker of [...doc.body.querySelectorAll(term)]) {
    if (marker.childElementCount > 0 || marker.closest("code,kbd,samp,var")) continue;
    const id = termId(marker);
    if (!id || !/^\d+$/u.test(id)) continue;
    const code = doc.createElement("code");
    code.setAttribute("data-flt-term-id", id);
    code.textContent = marker.textContent;
    marker.replaceWith(code);
    changed = true;
  }
  return changed ? doc.body.innerHTML : html;
}

function restoreOpaqueTermList(expected: Element[], codes: Element[], doc: Document): boolean {
  if (codes.length !== expected.length) return false;
  const expectedById = new Map<string, string>();
  for (const marker of expected) {
    const id = termId(marker);
    if (!id || expectedById.has(id)) return false;
    expectedById.set(id, marker.textContent ?? "");
  }
  const seen = new Set<string>();
  for (const item of codes) {
    const id = termId(item);
    if (!id || seen.has(id) || !expectedById.has(id) || item.childElementCount > 0) return false;
    const text = item.textContent?.trim();
    const expectedText = expectedById.get(id)!;
    if (text && text !== expectedText) return false;
    seen.add(id);
  }
  if (seen.size !== expectedById.size) return false;

  for (const item of codes) {
    const id = termId(item)!;
    const span = doc.createElement("span");
    span.setAttribute("data-flt-term-id", id);
    span.textContent = item.textContent?.trim() ? item.textContent : expectedById.get(id)!;
    item.replaceWith(span);
  }
  return true;
}

function restoreOpaqueTerms(source: HTMLElement, target: HTMLElement): boolean {
  const allExpected = [...source.querySelectorAll(term)].filter(
    (element) => !element.childElementCount && !element.closest("code,kbd,samp,var"),
  );
  if (!allExpected.length) return true;

  // Prefer strict per-slot validation when text-slot wrappers are present.
  const sourceSlots = [...source.querySelectorAll(textSlot)];
  const targetSlots = [...target.querySelectorAll(textSlot)];
  if (sourceSlots.length > 0 && sourceSlots.length === targetSlots.length) {
    let slotAligned = true;
    const pairs: Array<{ expected: Element[]; codes: Element[] }> = [];
    for (const sourceSlot of sourceSlots) {
      const expected = [...sourceSlot.children].filter((element) => element.matches(term) && !element.childElementCount);
      if (!expected.length) continue;
      const slotId = sourceSlot.getAttribute("data-flt-text-id");
      const matching = targetSlots.filter((slot) => slot.getAttribute("data-flt-text-id") === slotId);
      if (matching.length !== 1) {
        slotAligned = false;
        break;
      }
      const codes = [...matching[0]!.children].filter((element) => element.matches("code[data-flt-term-id]"));
      if (codes.length !== expected.length) {
        slotAligned = false;
        break;
      }
      pairs.push({ expected, codes });
    }
    if (slotAligned && pairs.length > 0) {
      return pairs.every(({ expected, codes }) => restoreOpaqueTermList(expected, codes, target.ownerDocument));
    }
  }

  // Fallback for non-slot HTML (e.g. OCR/tooltips) or coalesced slots before fixed-retry runs.
  const allCodes = [...target.querySelectorAll("code[data-flt-term-id]")];
  return restoreOpaqueTermList(allExpected, allCodes, target.ownerDocument);
}

function restoreLabel(source: HTMLElement, target: HTMLElement): void {
  const original = labelSlots(source), translated = labelSlots(target);
  if (!original || !translated || source.firstElementChild?.tagName !== target.firstElementChild?.tagName) return;
  const [label, description] = translated;
  if (!shortLabel.test(original[0].textContent?.trim() ?? "") || !/^[:：]\s*\S/u.test(original[1].textContent ?? "")
      || label.textContent?.trim() || description.firstChild?.nodeType !== Node.TEXT_NODE) return;

  const leading = description.firstChild as Text;
  const prefix = /^\s*([^:：\n]{1,40})([:：])/u.exec(leading.data);
  const translatedLabel = prefix?.[1]?.trim() ?? "";
  if (!prefix || !shortLabel.test(translatedLabel) || !(description.textContent ?? "").slice(prefix[0].length).trim()) return;

  // The delimiter identifies the same label as the original bold slot.
  // Leave the colon and description in their original text node.
  label.textContent = translatedLabel;
  leading.data = leading.data.slice(prefix[0].length - 1);
}

export function repairBergamotFixedHtml(sourceHtml: string, translatedHtml: string, termsAreOpaque = false): string {
  const hasTerms = sourceHtml.includes("data-flt-term-id=");
  const hasLabel = labelPrefix.test(sourceHtml);
  if (!hasTerms && !hasLabel) return translatedHtml;
  const parser = getHtmlParser();
  const source = parser.parseFromString(sourceHtml, "text/html");
  const target = parser.parseFromString(translatedHtml, "text/html");
  if (target.head.childNodes.length) return translatedHtml;
  if (termsAreOpaque) {
    if (!restoreOpaqueTerms(source.body, target.body)) {
      throw new Error("译文缺少受保护术语，已保留原文");
    }
  } else if (hasTerms) {
    keepTermsInTranslatedText(source.body, target.body);
  }
  if (hasLabel) restoreLabel(source.body, target.body);
  return target.body.innerHTML;
}
