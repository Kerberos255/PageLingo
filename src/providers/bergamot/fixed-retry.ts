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
  fallback?: string;
  restore(translatedHtml: string): string | undefined;
}

function standaloneTerm(body: HTMLElement, selector: string): Element | undefined {
  const slot = body.firstElementChild;
  const marker = slot?.firstElementChild;
  if (body.childNodes.length !== 1 || !slot?.matches('span[data-flt-text-id="0"]') || slot.attributes.length !== 1
    || slot.childElementCount !== 1 || !marker?.matches(selector) || marker.attributes.length !== 1
    || marker.childElementCount) return;
  return marker;
}

function surroundingText(marker: Element): string {
  return [...marker.parentNode!.childNodes]
    .filter(node => node.nodeType === Node.TEXT_NODE)
    .map(node => node.textContent)
    .join("");
}

/**
 * Term spans can absorb surrounding prose or collapse to empty markers while Bergamot
 * transliterates the protected name outside the span (e.g. "Claude and GPT models" ->
 * "<span id=0></span><span id=1></span>克劳德和GPT模型"). Retry those slots with opaque
 * <code data-flt-term-id> markers so Bergamot never translates or duplicates the names.
 */
function retryAbsorbedTerm(sourceHtml: string, outputHtml: string): FixedRetry | undefined {
  if (!sourceHtml.startsWith('<span data-flt-text-id="0">') || sourceHtml.length > 320
    || !sourceHtml.includes("data-flt-term-id=") || !outputHtml.includes("data-flt-term-id=")) return;
  const parser = new DOMParser();
  const source = parser.parseFromString(sourceHtml, "text/html");
  const previous = parser.parseFromString(outputHtml, "text/html");
  if (source.head.childNodes.length || previous.head.childNodes.length) return;

  const sourceSlot = source.body.firstElementChild;
  const previousSlot = previous.body.firstElementChild;
  if (source.body.childNodes.length !== 1 || previous.body.childNodes.length !== 1
    || !sourceSlot?.matches('span[data-flt-text-id="0"]') || sourceSlot.attributes.length !== 1
    || !previousSlot?.matches('span[data-flt-text-id="0"]') || previousSlot.attributes.length !== 1) return;

  const sourceMarkers = [...sourceSlot.children].filter((el) => el.matches(termSelector) && el.attributes.length === 1 && !el.childElementCount);
  const previousMarkers = [...previousSlot.children].filter((el) => el.matches(termSelector) && el.attributes.length === 1 && !el.childElementCount);
  if (!sourceMarkers.length || sourceMarkers.length !== previousMarkers.length) return;
  if (sourceSlot.childElementCount !== sourceMarkers.length || previousSlot.childElementCount !== previousMarkers.length) return;

  const expectedById = new Map<string, Element>();
  for (const marker of sourceMarkers) {
    const id = marker.getAttribute("data-flt-term-id");
    if (!id || expectedById.has(id)) return;
    expectedById.set(id, marker);
  }
  const previousIds = previousMarkers.map((el) => el.getAttribute("data-flt-term-id"));
  if (previousIds.some((id) => !id || !expectedById.has(id)) || new Set(previousIds).size !== expectedById.size) return;

  const sourceOutside = surroundingText(sourceMarkers[0]!);
  const previousOutside = surroundingText(previousMarkers[0]!);
  const absorbedSingle = sourceMarkers.length === 1
    && /\p{Script=Latin}/u.test(sourceOutside)
    && !/\p{L}/u.test(previousOutside)
    && /\p{Script=Han}/u.test(previousMarkers[0]!.textContent ?? "");
  const emptyMisaligned = previousMarkers.some((marker) => {
    if (marker.textContent?.trim()) return false;
    const id = marker.getAttribute("data-flt-term-id")!;
    const name = expectedById.get(id)?.textContent ?? "";
    return Boolean(name) && /\p{Script=Han}/u.test(previousOutside);
  });
  if (!absorbedSingle && !emptyMisaligned) return;

  for (const marker of sourceMarkers) {
    const id = marker.getAttribute("data-flt-term-id")!;
    const code = source.createElement("code");
    code.setAttribute("data-flt-term-id", id);
    code.textContent = marker.textContent;
    marker.replaceWith(code);
  }

  return {
    html: source.body.innerHTML,
    fallback: sourceHtml,
    restore(translatedHtml) {
      const result = parser.parseFromString(translatedHtml, "text/html");
      const resultSlot = result.body.firstElementChild;
      if (result.head.childNodes.length || result.body.childNodes.length !== 1
        || !resultSlot?.matches('span[data-flt-text-id="0"]') || resultSlot.attributes.length !== 1) return;
      const translatedCodes = [...resultSlot.children].filter((el) => el.matches("code[data-flt-term-id]") && el.attributes.length === 1 && !el.childElementCount);
      if (translatedCodes.length !== expectedById.size || resultSlot.childElementCount !== translatedCodes.length) return;
      if (!/\p{Script=Han}/u.test(surroundingText(translatedCodes[0]!))) return;
      const seen = new Set<string>();
      for (const code of translatedCodes) {
        const id = code.getAttribute("data-flt-term-id");
        if (!id || seen.has(id) || !expectedById.has(id)) return;
        const origName = expectedById.get(id)!.textContent ?? "";
        if (code.textContent?.trim() && code.textContent !== origName) return;
        seen.add(id);
      }
      for (const code of translatedCodes) {
        const id = code.getAttribute("data-flt-term-id")!;
        code.replaceWith(result.importNode(expectedById.get(id)!, true));
      }
      return result.body.innerHTML;
    },
  };
}

/** Bergamot can coalesce consecutive standalone lines into the last span. */
export function restoreBergamotSentenceLines(sourceHtml: string, translatedHtml: string): string | undefined {
  if (!sourceHtml.startsWith('<span><span data-flt-text-id="') || sourceHtml.length > 900
      || !/<span data-flt-text-id="\d+">\s*<\/span>/u.test(translatedHtml)) return;
  const parser = new DOMParser();
  const source = parser.parseFromString(sourceHtml, "text/html");
  const target = parser.parseFromString(translatedHtml, "text/html");
  if (source.head.childNodes.length || target.head.childNodes.length) return;

  const slots = (body: HTMLElement) => [...body.children].map(wrapper => {
    const slot = wrapper.firstElementChild;
    if (wrapper.matches("span") && !wrapper.attributes.length && wrapper.childNodes.length === 1
      && slot?.matches(slotSelector) && slot.attributes.length === 1
      && [...slot.childNodes].every(node => node.nodeType === Node.TEXT_NODE)) return slot;
  });
  const from = slots(source.body), to = slots(target.body);
  if (from.length < 2 || from.length > 4 || from.length !== to.length
      || from.some((slot, i) => !slot || !to[i]
        || slot.getAttribute("data-flt-text-id") !== to[i]!.getAttribute("data-flt-text-id"))
      || to.slice(0, -1).some(slot => slot!.textContent?.trim())) return;

  const sourceSegmenter = new Intl.Segmenter("en", {granularity: "sentence"});
  const counts = from.map(slot => {
    const text = (slot!.textContent ?? "").trim();
    return /[.!?][^\p{L}\p{N}]*$/u.test(text)
      ? [...sourceSegmenter.segment(text)].filter(({segment}) => /\p{Script=Latin}/u.test(segment)).length
      : 0;
  });
  if (counts.some(count => count === 0)) return;

  const sentences: string[] = [];
  const combined = (to.at(-1)!.textContent ?? "").trim();
  if (!combined || combined.includes("\uFFFD")) return;
  for (const {segment} of new Intl.Segmenter("zh-Hans", {granularity: "sentence"}).segment(combined)) {
    if (/\p{L}/u.test(segment)) sentences.push(segment);
    else if (sentences.length) sentences[sentences.length - 1] += segment;
    else return;
  }
  if (sentences.length !== counts.reduce((sum, count) => sum + count, 0)) return;

  let offset = 0;
  for (const [i, count] of counts.entries()) {
    const value = sentences.slice(offset, offset + count).join("");
    const symbols = /\p{Extended_Pictographic}/gu;
    if (!/\p{Script=Han}/u.test(value)
      || JSON.stringify(value.match(symbols)) !== JSON.stringify(from[i]!.textContent?.match(symbols))) return;
    to[i]!.textContent = value;
    offset += count;
  }
  try {
    return restoreFixedHtmlTransport(sourceHtml, target.body.innerHTML);
  } catch {
    return;
  }
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
  const termRetry = retryAbsorbedTerm(sourceHtml, outputHtml);
  if (termRetry) return termRetry;
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

const BRACKET_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
  ["【", "】"],
  ["〔", "〕"],
  ["⟬", "⟭"],
];

function peelEdgeBrackets(raw: string): { prefix: string; core: string; suffix: string } {
  const leading = raw.match(/^\s*/u)?.[0] ?? "";
  const trailing = raw.match(/\s*$/u)?.[0] ?? "";
  let inner = raw.slice(leading.length, raw.length - trailing.length);
  if (!inner) return { prefix: "", core: raw, suffix: "" };

  let prefix = leading;
  let suffix = trailing;

  // Peel full enclosing balanced brackets (e.g. "(Sentence 1. Sentence 2.)") so
  // Bergamot cannot drop the closing parenthesis across sentence boundaries.
  for (const [open, close] of BRACKET_PAIRS) {
    if (inner.length >= 3 && inner.startsWith(open) && inner.endsWith(close)) {
      let depth = 0;
      let wrapsWhole = true;
      for (let i = 0; i < inner.length; i += 1) {
        const ch = inner[i]!.normalize("NFKC");
        if (ch === open) depth += 1;
        else if (ch === close) {
          depth -= 1;
          if (depth === 0 && i < inner.length - 1) {
            wrapsWhole = false;
            break;
          }
          if (depth < 0) {
            wrapsWhole = false;
            break;
          }
        }
      }
      if (wrapsWhole && depth === 0) {
        const nextInner = inner.slice(open.length, inner.length - close.length);
        if (nextInner.trim() && /\p{L}/u.test(nextInner)) {
          prefix += open;
          suffix = close + suffix;
          inner = nextInner;
        }
      }
    }
  }

  // Peel unmatched edge brackets whose partner lives in an adjacent fixed atom
  // or sibling slot (e.g. `<span data-flt-fixed>(</span><b>...</b> text.)`).
  for (const [open, close] of BRACKET_PAIRS) {
    let depth = 0;
    let minDepth = 0;
    for (const ch of inner.normalize("NFKC")) {
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth < minDepth) minDepth = depth;
      }
    }
    if (depth < 0 && inner.endsWith(close)) {
      const nextInner = inner.slice(0, inner.length - close.length);
      if (nextInner.trim() && /\p{L}/u.test(nextInner)) {
        suffix = close + suffix;
        inner = nextInner;
      }
    } else if (depth > 0 && minDepth === 0 && inner.startsWith(open)) {
      const nextInner = inner.slice(open.length);
      if (nextInner.trim() && /\p{L}/u.test(nextInner)) {
        prefix += open;
        inner = nextInner;
      }
    }
  }

  return { prefix, core: inner, suffix };
}

function bracketsBalanced(value: string): boolean {
  for (const [open, close] of BRACKET_PAIRS) {
    let depth = 0;
    for (const ch of value.normalize("NFKC")) {
      if (ch === open) depth += 1;
      else if (ch === close && --depth < 0) return false;
    }
    if (depth !== 0) return false;
  }
  return true;
}

export interface BergamotSlotFallbackPlan {
  slotSources: string[];
  slotPrepared: string[];
  restore(translatedSlots: string[]): string | undefined;
}

/**
 * Last-resort safe slot-level fallback for Bergamot when whole-sentence HTML
 * alignment breaks inline formatting (e.g. `<i>“...”</i> narrator, <i>“...”</i>`,
 * `<i>always</i>`, `<span data-flt-fixed>(</span><b>...</b> text.)`) or drops
 * enclosing parentheses. Re-inserts validated per-slot translations into a clean
 * clone of the exact original HTML template so every tag, link, fixed atom, and
 * protected term remains untouched.
 */
export function prepareBergamotSlotFallback(
  sourceHtml: string,
  outputHtml: string,
  prepareOpaque: (html: string) => string,
  repairSlot: (sourceSlotHtml: string, rawSlotHtml: string, termsAreOpaque: boolean) => string,
): BergamotSlotFallbackPlan | undefined {
  if (!sourceHtml.includes("data-flt-text-id=")) return;
  const parser = new DOMParser();
  const source = parser.parseFromString(sourceHtml, "text/html");
  const previous = parser.parseFromString(outputHtml, "text/html");
  if (source.head.childNodes.length) return;

  const replacements: string[] = [];
  for (const marker of source.body.querySelectorAll(termSelector)) {
    replacements[Number(marker.getAttribute("data-flt-term-id"))] = marker.textContent ?? "";
  }
  const withoutTerms = (body: HTMLElement) => {
    const clone = body.cloneNode(true) as HTMLElement;
    restoreTerminology(clone, replacements);
    return clone.innerHTML;
  };
  const sourceWithoutTerms = withoutTerms(source.body);
  if (!previous.head.childNodes.length) {
    try {
      restoreFixedHtmlTransport(sourceWithoutTerms, withoutTerms(previous.body));
      return;
    } catch {
      // Output failed transport validation; fall back to slot-level recovery.
    }
  }

  const sourceSlots = [...source.body.querySelectorAll(slotSelector)];
  if (!sourceSlots.length) return;

  const slotPlans: Array<{
    id: string;
    sourceSlotHtml: string;
    preparedSlotHtml: string;
    usedOpaque: boolean;
    prefix: string;
    suffix: string;
    innerBalanced: boolean;
    originalText: string;
  }> = [];

  for (const slot of sourceSlots) {
    const id = slot.getAttribute("data-flt-text-id");
    if (!id || !/^\d+$/u.test(id)) return;
    const hasTerms = slot.childElementCount > 0;
    const originalText = slot.textContent ?? "";
    let prefix = "";
    let suffix = "";
    let sourceSlotHtml: string;

    if (!hasTerms) {
      const peeled = peelEdgeBrackets(originalText);
      prefix = peeled.prefix;
      suffix = peeled.suffix;
      sourceSlotHtml = `<span data-flt-text-id="0">${escapeHtml(peeled.core)}</span>`;
    } else {
      const clone = slot.cloneNode(true) as HTMLElement;
      clone.setAttribute("data-flt-text-id", "0");
      sourceSlotHtml = clone.outerHTML;
    }

    const preparedSlotHtml = prepareOpaque(sourceSlotHtml);
    slotPlans.push({
      id,
      sourceSlotHtml,
      preparedSlotHtml,
      usedOpaque: preparedSlotHtml !== sourceSlotHtml,
      prefix,
      suffix,
      innerBalanced: bracketsBalanced(hasTerms ? originalText : originalText.slice(prefix.length, originalText.length - suffix.length)),
      originalText,
    });
  }

  return {
    slotSources: slotPlans.map((item) => item.sourceSlotHtml),
    slotPrepared: slotPlans.map((item) => item.preparedSlotHtml),
    restore(translatedSlots: string[]) {
      if (translatedSlots.length !== slotPlans.length) return;
      const resultBody = source.body.cloneNode(true) as HTMLElement;
      const targetSlots = new Map(
        [...resultBody.querySelectorAll(slotSelector)].map((el) => [el.getAttribute("data-flt-text-id")!, el]),
      );

      let anyChanged = false;
      for (let i = 0; i < slotPlans.length; i += 1) {
        const plan = slotPlans[i]!;
        const targetSlot = targetSlots.get(plan.id);
        const raw = translatedSlots[i];
        if (!targetSlot || typeof raw !== "string") return;

        let repaired: string;
        try {
          repaired = repairSlot(plan.sourceSlotHtml, raw, plan.usedOpaque);
        } catch {
          return;
        }
        const parsed = parser.parseFromString(repaired, "text/html");
        const parsedSlot = parsed.body.firstElementChild;
        if (parsed.head.childNodes.length || parsed.body.childNodes.length !== 1
          || !parsedSlot?.matches('span[data-flt-text-id="0"]')) {
          return;
        }
        const slotText = parsedSlot.textContent ?? "";
        if (!slotText.trim() || /\uFFFD/u.test(slotText)) return;
        if (plan.innerBalanced && !bracketsBalanced(slotText)) return;

        const fragment = resultBody.ownerDocument.createDocumentFragment();
        if (plan.prefix) fragment.append(resultBody.ownerDocument.createTextNode(plan.prefix));
        for (const child of Array.from(parsedSlot.childNodes)) {
          fragment.append(resultBody.ownerDocument.importNode(child, true));
        }
        if (plan.suffix) fragment.append(resultBody.ownerDocument.createTextNode(plan.suffix));
        targetSlot.replaceChildren(fragment);
        if ((targetSlot.textContent ?? "").trim() !== plan.originalText.trim()) anyChanged = true;
      }

      if (!anyChanged) return;
      try {
        restoreFixedHtmlTransport(sourceWithoutTerms, withoutTerms(resultBody));
        return resultBody.innerHTML;
      } catch {
        return;
      }
    },
  };
}
