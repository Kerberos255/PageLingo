import {restoreFixedHtmlTransport} from "../../core/fixed-html-transport";
import {escapeHtml, protectTerminologyInFragment, restoreTerminology, termOccurrenceCount} from "../../core/rich-segment";

const slotSelector = "span[data-flt-text-id]";
const termSelector = "span[data-flt-term-id]";
const quoteCharacters = /[“”«»「」"]/u;
const shortLabel = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} \u2010-\u2015-]{0,39}$/u;
const compact = (value: string) => value.replace(/[\t\n\f\r ]+/gu, " ");
const lineWrappedParenthesis = /\([^()]*[\r\n][^()]*\)/gu;

interface Slot {
  element: Element;
  quoted: boolean;
}

interface FixedRetry {
  html: string;
  restore(translatedHtml: string): string | undefined;
}

function translatedParts(text: string): Array<{text: string; quoted: boolean}> {
  const parts: Array<{text: string; quoted: boolean}> = [];
  let end = 0;
  for (const match of text.matchAll(/“[^“”]+”|«[^«»]+»|「[^「」]+」|"[^"]+"/gu)) {
    const preceding = text.slice(end, match.index).trim();
    if (preceding) parts.push({text: preceding, quoted: false});
    parts.push({text: match[0].slice(1, -1).trim(), quoted: true});
    end = match.index! + match[0].length;
  }
  const trailing = text.slice(end).trim();
  if (trailing) parts.push({text: trailing, quoted: false});
  return parts;
}

function fillSlot(slot: Element, text: string): boolean {
  const markers = [...slot.querySelectorAll(termSelector)];
  if (!markers.length) {
    slot.textContent = text;
    return true;
  }
  const idsByName = new Map<string, string[]>();
  for (const marker of markers) {
    const name = marker.textContent ?? "";
    const ids = idsByName.get(name) ?? [];
    ids.push(marker.getAttribute("data-flt-term-id")!);
    idsByName.set(name, ids);
  }
  if ([...idsByName].some(([name, ids]) => !name || termOccurrenceCount(text, name, true) !== ids.length)) return false;
  const entries = [...idsByName.keys()].map(source => ({source, target: source, mode: "protect", caseSensitive: true}));
  const content = slot.ownerDocument.createDocumentFragment();
  content.append(text);
  protectTerminologyInFragment(content, entries);
  for (const marker of content.querySelectorAll(termSelector)) {
    const id = idsByName.get(marker.textContent ?? "")?.shift();
    if (id === undefined) return false;
    marker.setAttribute("data-flt-term-id", id);
  }
  if ([...idsByName.values()].some(ids => ids.length)) return false;
  slot.replaceChildren(content);
  return true;
}

/** Retry bounded inline phrases as sentence text while retaining their original HTML template. */
export function prepareBergamotFixedRetry(sourceHtml: string, outputHtml: string): FixedRetry | undefined {
  if (!sourceHtml.includes("data-flt-text-id=") || !/<(?:a |strong>|b>|em>|i>)/u.test(sourceHtml)
    || (!sourceHtml.includes("\n") && !/<span data-flt-text-id="\d+">\s*<\/span>/u.test(outputHtml))) return;

  const parser = new DOMParser();
  const source = parser.parseFromString(sourceHtml, "text/html");
  const previous = parser.parseFromString(outputHtml, "text/html");
  if ((source.body.textContent ?? "").length > 600 || source.head.childNodes.length || previous.head.childNodes.length
    || [...source.body.childNodes].some(node => node.nodeType !== Node.ELEMENT_NODE && node.textContent?.trim())) return;

  const replacements: string[] = [];
  for (const marker of source.body.querySelectorAll(termSelector)) {
    replacements[Number(marker.getAttribute("data-flt-term-id"))] = marker.textContent ?? "";
  }
  const withoutTerms = (body: HTMLElement) => {
    const clone = body.cloneNode(true) as HTMLElement;
    restoreTerminology(clone, replacements);
    return clone.innerHTML;
  };
  const template = withoutTerms(source.body);
  try {
    restoreFixedHtmlTransport(template, withoutTerms(previous.body));
    return;
  } catch {
    // Only retry a paragraph that the original structure checks would reject.
  }

  const groups: Slot[][] = [[]];
  const atoms: Element[] = [];
  const chunks: string[] = [];
  const parentheticalBreaks = (source.body.textContent ?? "").search(lineWrappedParenthesis) !== -1;
  const normalizeSpacing = parentheticalBreaks
    ? (value: string) => value.replace(lineWrappedParenthesis, compact)
    : compact;
  let labels = 0, links = 0;
  for (const element of source.body.children) {
    if (element.matches("code,kbd,samp,var") && /^__FLT_OPAQUE_\d+__$/u.test(element.textContent ?? "")) {
      atoms.push(element);
      groups.push([]);
      chunks.push(element.outerHTML);
      continue;
    }
    const quoted = !element.matches(slotSelector);
    const slot = quoted ? element.querySelector(slotSelector) : element;
    if (!slot || !/^\d+$/u.test(slot.getAttribute("data-flt-text-id") ?? "")
      || (quoted && (!element.matches("a[data-flt-link-id],strong,b,em,i")
      || element.querySelectorAll(slotSelector).length !== 1))) return;
    // A line break inside an English list can split its parentheses across model sentences.
    const original = quoted ? compact(slot.textContent ?? "") : normalizeSpacing(slot.textContent ?? "");
    if (quoteCharacters.test(original) || (quoted && !shortLabel.test(original.trim()))) return;
    groups.at(-1)!.push({element: slot, quoted});
    chunks.push(quoted ? escapeHtml(original.replace(original.trim(), `«${original.trim()}»`)) : escapeHtml(original));
    if (quoted) labels++;
    if (element.matches("a")) links++;
  }
  // Multiple interactive labels need independent identification.
  if (!labels || labels > 3 || atoms.length > 2 || (links && labels !== 1)) return;
  return {
    html: chunks.join(""),
    restore(translatedHtml) {
      const translated = parser.parseFromString(translatedHtml, "text/html");
      if (translated.head.childNodes.length || !/\p{Script=Han}/u.test(translated.body.textContent ?? "")) return;
      const runs = [""];
      for (const node of translated.body.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          runs[runs.length - 1] += node.textContent ?? "";
          continue;
        }
        const atom = atoms[runs.length - 1];
        if (node.nodeType !== Node.ELEMENT_NODE || !atom) return;
        const element = node as Element;
        if (element.tagName !== atom.tagName || element.attributes.length || element.childElementCount
          || (element.textContent?.trim() && element.textContent !== atom.textContent)) return;
        runs.push("");
      }
      if (runs.length !== groups.length) return;

      const result = source.body.cloneNode(true) as HTMLElement;
      const editable = new Map([...result.querySelectorAll(slotSelector)].map(element => [element.getAttribute("data-flt-text-id"), element]));
      for (const [index, slots] of groups.entries()) {
        const parts = translatedParts(runs[index]!);
        if (parts.length !== slots.length) return;
        for (const [position, slot] of slots.entries()) {
          const part = parts[position]!;
          if (part.quoted !== slot.quoted || !part.text || /\uFFFD/u.test(part.text) || quoteCharacters.test(part.text)) return;
          let text = part.text;
          if (slot.quoted && links && text === slot.element.textContent?.trim()) {
            // A quoted title can remain English even when the first pass supplied a valid link label.
            const id = slot.element.getAttribute("data-flt-text-id");
            const [old, duplicate] = previous.body.querySelectorAll(`${slotSelector}[data-flt-text-id="${id}"]`);
            const label = old?.textContent?.trim() ?? "";
            if (!duplicate && old?.parentElement?.getAttribute("data-flt-link-id") === slot.element.parentElement?.getAttribute("data-flt-link-id")
              && shortLabel.test(label) && /\p{Script=Han}/u.test(label)) text = label;
          }
          const element = editable.get(slot.element.getAttribute("data-flt-text-id"));
          if (!element || !fillSlot(element, text)) return;
        }
      }
      const restored = result.innerHTML;
      try {
        restoreFixedHtmlTransport(template, withoutTerms(result));
        return restored;
      } catch {
        return;
      }
    },
  };
}
