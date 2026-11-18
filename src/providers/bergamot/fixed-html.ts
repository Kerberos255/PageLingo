import {termOccurrenceCount} from "../../core/rich-segment";

const textSlot = "span[data-flt-text-id]";
const term = "span[data-flt-term-id]";
const shortLabel = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} \u2010-\u2015-]{0,39}$/u;
const labelPrefix = /^<(?:strong|b)><span data-flt-text-id="0">/u;
const termId = (element: Element) => element.getAttribute("data-flt-term-id");

function keepTermsInTranslatedText(source: HTMLElement, target: HTMLElement): void {
  const targetSlots = [...target.querySelectorAll(textSlot)];
  for (const sourceSlot of source.querySelectorAll(textSlot)) {
    const markers = [...sourceSlot.children].filter(element => element.matches(term));
    if (!markers.length) continue;
    const matching = targetSlots.filter(slot => slot.getAttribute("data-flt-text-id") === sourceSlot.getAttribute("data-flt-text-id"));
    if (matching.length !== 1) continue;
    const translatedSlot = matching[0]!;
    const translatedMarkers = [...translatedSlot.children].filter(element => element.matches(term));
    if (JSON.stringify(markers.map(termId)) !== JSON.stringify(translatedMarkers.map(termId))) continue;
    const original = sourceSlot.textContent ?? "", translated = translatedSlot.textContent ?? "";
    const names = new Set(markers.map(marker => marker.textContent ?? ""));
    if (![...names].every(name => {
      if (!name) return false;
      const count = termOccurrenceCount(original, name, true);
      return count > 0 && count === termOccurrenceCount(translated, name, true);
    })) continue;

    // Bergamot can preserve every word while assigning the term tags to different
    // words. Keep the full translated slot if the original names are already there.
    for (const marker of translatedMarkers) marker.replaceWith(...marker.childNodes);
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

export function prepareBergamotFixedHtml(html: string): string {
  if (!labelPrefix.test(html) || !html.includes("data-flt-term-id=")) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const slots = labelSlots(doc.body);
  if (!slots || !shortLabel.test(slots[0].textContent?.trim() ?? "") || !/^[:：]\s*\S/u.test(slots[1].textContent ?? "")) return html;
  const markers = [...slots[1].children].filter(element => element.matches(term));
  if (!markers.length) return html;
  // A protected name just after a bold label can absorb the label into its own
  // span. Bergamot preserves code as an opaque item, leaving the label as prose.
  for (const marker of markers) {
    const code = doc.createElement("code");
    code.setAttribute("data-flt-term-id", termId(marker)!);
    code.textContent = marker.textContent;
    marker.replaceWith(code);
  }
  return doc.body.innerHTML;
}

function restoreLabelTerms(source: HTMLElement, target: HTMLElement): boolean {
  const from = labelSlots(source), to = labelSlots(target);
  if (!from || !to) return false;
  const expected = [...from[1].children].filter(element => element.matches(term));
  const code = [...to[1].children].filter(element => element.matches("code[data-flt-term-id]"));
  if (code.length !== expected.length || code.some((item, i) => {
    const text = item.textContent?.trim();
    return termId(item) !== termId(expected[i]!) || item.childElementCount > 0
      || Boolean(text && text !== expected[i]!.textContent);
  })) return false;
  for (const item of code) {
    const span = target.ownerDocument.createElement("span");
    span.setAttribute("data-flt-term-id", termId(item)!);
    span.textContent = item.textContent;
    item.replaceWith(span);
  }
  return true;
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

export function repairBergamotFixedHtml(sourceHtml: string, translatedHtml: string, labelTermsAreOpaque = false): string {
  const hasTerms = sourceHtml.includes("data-flt-text-id=") && sourceHtml.includes("data-flt-term-id=");
  const hasLabel = labelPrefix.test(sourceHtml);
  if (!hasTerms && !hasLabel) return translatedHtml;
  const parser = new DOMParser();
  const source = parser.parseFromString(sourceHtml, "text/html");
  const target = parser.parseFromString(translatedHtml, "text/html");
  if (target.head.childNodes.length) return translatedHtml;
  if (labelTermsAreOpaque && !restoreLabelTerms(source.body, target.body)) {
    throw new Error("译文缺少受保护术语，已保留原文");
  }
  if (hasTerms) keepTermsInTranslatedText(source.body, target.body);
  if (hasLabel) restoreLabel(source.body, target.body);
  return target.body.innerHTML;
}
