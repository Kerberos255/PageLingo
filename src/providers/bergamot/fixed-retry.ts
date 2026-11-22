import {restoreFixedHtmlTransport} from "../../core/fixed-html-transport";
import {isOptionalEnglishArticle} from "../../core/translation-quality";
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

type SlotPiece =
  | { kind: "literal"; text: string }
  | { kind: "translate"; core: string; innerBalanced: boolean };

function findUnmatchedBracketIndices(value: string): Set<number> {
  const unmatched = new Set<number>();
  const chars = Array.from(value);
  // Map code-unit offsets for each Unicode character.
  const offsets: number[] = [];
  let cursor = 0;
  for (const ch of chars) {
    offsets.push(cursor);
    cursor += ch.length;
  }

  for (const [open, close] of BRACKET_PAIRS) {
    const stack: number[] = [];
    for (let i = 0; i < chars.length; i += 1) {
      const norm = chars[i]!.normalize("NFKC");
      if (norm === open) {
        stack.push(i);
      } else if (norm === close) {
        if (stack.length > 0) stack.pop();
        else unmatched.add(offsets[i]!);
      }
    }
    for (const openIdx of stack) unmatched.add(offsets[openIdx]!);
  }
  return unmatched;
}

function planBracketSafePieces(raw: string): SlotPiece[] {
  const leading = raw.match(/^\s*/u)?.[0] ?? "";
  const trailing = raw.match(/\s*$/u)?.[0] ?? "";
  let inner = raw.slice(leading.length, raw.length - trailing.length);
  if (!inner) return [{ kind: "literal", text: raw }];

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

  // Split on every unmatched bracket (leading, trailing, or mid-slot) whose partner
  // lives in an adjacent fixed atom or sibling slot, e.g.:
  //   "... without a working auth path ("  + <a>architecture</a> + ", " + <a>network model</a> + ")."
  //   "... exposed bind (pair that with auth - see the " + <a>runbook</a> + "), and ..."
  //   "). The " + <a>Codex plugin</a>
  const unmatchedOffsets = findUnmatchedBracketIndices(inner);
  const pieces: SlotPiece[] = [];
  const pushLiteral = (text: string) => {
    if (!text) return;
    const prev = pieces.at(-1);
    if (prev && prev.kind === "literal") prev.text += text;
    else pieces.push({ kind: "literal", text });
  };
  const pushTranslatableSlice = (slice: string, afterLeadingCloseBracket: boolean) => {
    if (!slice) return;
    let lead = slice.match(/^\s*/u)?.[0] ?? "";
    const trail = slice.match(/\s*$/u)?.[0] ?? "";
    let core = slice.slice(lead.length, slice.length - trail.length);
    if (!core || !/\p{L}/u.test(core)) {
      pushLiteral(slice);
      return;
    }
    // Right after an unmatched closing bracket (e.g. `). The` or `), so ...`), keep
    // sentence-boundary punctuation with the bracket so Bergamot translates clean prose
    // and optional articles like "The" are recognized cleanly if omitted.
    if (afterLeadingCloseBracket) {
      const punctMatch = core.match(/^([.,;:!?]+[\t\n\f\r ]+)(.+)$/su);
      if (punctMatch && /\p{L}/u.test(punctMatch[2]!)) {
        lead += punctMatch[1]!;
        core = punctMatch[2]!;
      }
    }
    pushLiteral(lead);
    pieces.push({ kind: "translate", core, innerBalanced: bracketsBalanced(core) });
    pushLiteral(trail);
  };

  pushLiteral(prefix);
  if (unmatchedOffsets.size === 0) {
    pushTranslatableSlice(inner, false);
  } else {
    const sorted = Array.from(unmatchedOffsets).sort((a, b) => a - b);
    let pos = 0;
    let prevWasClose = false;
    for (const offset of sorted) {
      if (offset > pos) {
        pushTranslatableSlice(inner.slice(pos, offset), prevWasClose);
      }
      const ch = inner[offset]!;
      const norm = ch.normalize("NFKC");
      pushLiteral(ch);
      prevWasClose = BRACKET_PAIRS.some(([, close]) => close === norm);
      pos = offset + ch.length;
    }
    if (pos < inner.length) {
      pushTranslatableSlice(inner.slice(pos), prevWasClose);
    }
  }
  pushLiteral(suffix);

  // If splitting produced zero translatable pieces, keep original as a single piece.
  if (!pieces.some((p) => p.kind === "translate")) {
    return [
      ...(leading ? [{ kind: "literal" as const, text: leading }] : []),
      { kind: "translate", core: inner, innerBalanced: bracketsBalanced(inner) },
      ...(trailing ? [{ kind: "literal" as const, text: trailing }] : []),
    ];
  }
  return pieces;
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

function peelTermSlotEdgeBrackets(slotClone: HTMLElement): { prefix: string; suffix: string } {
  const full = slotClone.textContent ?? "";
  const unmatched = findUnmatchedBracketIndices(full);
  if (unmatched.size === 0) return { prefix: "", suffix: "" };
  let prefix = "";
  let suffix = "";

  const first = slotClone.firstChild;
  if (first && first.nodeType === Node.TEXT_NODE) {
    const data = first.textContent ?? "";
    const leading = data.match(/^\s*/u)?.[0] ?? "";
    const rest = data.slice(leading.length);
    if (rest && unmatched.has(leading.length)) {
      const ch = rest[0]!;
      prefix = leading + ch;
      first.textContent = rest.slice(ch.length);
    }
  }
  const last = slotClone.lastChild;
  if (last && last.nodeType === Node.TEXT_NODE) {
    const data = last.textContent ?? "";
    const trailing = data.match(/\s*$/u)?.[0] ?? "";
    const head = data.slice(0, data.length - trailing.length);
    const fullBeforeTrail = full.length - (full.match(/\s*$/u)?.[0]?.length ?? 0);
    if (head && unmatched.has(fullBeforeTrail - 1)) {
      const ch = head.at(-1)!;
      const beforeCh = head.slice(0, -1);
      const innerTrail = beforeCh.match(/\s*$/u)?.[0] ?? "";
      suffix = innerTrail + ch + trailing;
      last.textContent = beforeCh.slice(0, beforeCh.length - innerTrail.length);
    }
  }
  return { prefix, suffix };
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
 * enclosing/cross-slot parentheses. Re-inserts validated per-slot translations into
 * a clean clone of the exact original HTML template so every tag, link, fixed atom,
 * and protected term remains untouched.
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

  interface PreparedUnit {
    sourceSlotHtml: string;
    preparedSlotHtml: string;
    usedOpaque: boolean;
    coreText: string;
    innerBalanced: boolean;
  }

  const units: PreparedUnit[] = [];
  const slotPlans: Array<
    | {
        kind: "plain";
        id: string;
        originalText: string;
        pieces: Array<{ kind: "literal"; text: string } | { kind: "unit"; unitIndex: number }>;
      }
    | {
        kind: "terms";
        id: string;
        originalText: string;
        prefix: string;
        suffix: string;
        unitIndex: number;
      }
  > = [];

  for (const slot of sourceSlots) {
    const id = slot.getAttribute("data-flt-text-id");
    if (!id || !/^\d+$/u.test(id)) return;
    const hasTerms = slot.childElementCount > 0;
    const originalText = slot.textContent ?? "";

    if (!hasTerms) {
      const rawPieces = planBracketSafePieces(originalText);
      const mappedPieces: Array<{ kind: "literal"; text: string } | { kind: "unit"; unitIndex: number }> = [];
      for (const piece of rawPieces) {
        if (piece.kind === "literal") {
          mappedPieces.push(piece);
        } else {
          const sourceSlotHtml = `<span data-flt-text-id="0">${escapeHtml(piece.core)}</span>`;
          const preparedSlotHtml = prepareOpaque(sourceSlotHtml);
          const unitIndex = units.length;
          units.push({
            sourceSlotHtml,
            preparedSlotHtml,
            usedOpaque: preparedSlotHtml !== sourceSlotHtml,
            coreText: piece.core,
            innerBalanced: piece.innerBalanced,
          });
          mappedPieces.push({ kind: "unit", unitIndex });
        }
      }
      slotPlans.push({ kind: "plain", id, originalText, pieces: mappedPieces });
    } else {
      const clone = slot.cloneNode(true) as HTMLElement;
      clone.setAttribute("data-flt-text-id", "0");
      const { prefix, suffix } = peelTermSlotEdgeBrackets(clone);
      const sourceSlotHtml = clone.outerHTML;
      const preparedSlotHtml = prepareOpaque(sourceSlotHtml);
      const unitIndex = units.length;
      const coreText = clone.textContent ?? "";
      units.push({
        sourceSlotHtml,
        preparedSlotHtml,
        usedOpaque: preparedSlotHtml !== sourceSlotHtml,
        coreText,
        innerBalanced: bracketsBalanced(coreText),
      });
      slotPlans.push({ kind: "terms", id, originalText, prefix, suffix, unitIndex });
    }
  }

  return {
    slotSources: units.map((item) => item.sourceSlotHtml),
    slotPrepared: units.map((item) => item.preparedSlotHtml),
    restore(translatedSlots: string[]) {
      if (translatedSlots.length !== units.length) return;
      const resultBody = source.body.cloneNode(true) as HTMLElement;
      const targetSlots = new Map(
        [...resultBody.querySelectorAll(slotSelector)].map((el) => [el.getAttribute("data-flt-text-id")!, el]),
      );

      let anyChanged = false;
      for (const plan of slotPlans) {
        const targetSlot = targetSlots.get(plan.id);
        if (!targetSlot) return;

        if (plan.kind === "plain") {
          let combined = "";
          let nonEmptyTranslatedCount = 0;
          let translatedUnitCount = 0;
          for (const piece of plan.pieces) {
            if (piece.kind === "literal") {
              combined += piece.text;
              continue;
            }
            translatedUnitCount += 1;
            const unit = units[piece.unitIndex]!;
            const raw = translatedSlots[piece.unitIndex];
            if (typeof raw !== "string") return;

            let repaired: string;
            try {
              repaired = repairSlot(unit.sourceSlotHtml, raw, unit.usedOpaque);
            } catch {
              return;
            }
            const parsed = parser.parseFromString(repaired, "text/html");
            if (parsed.head.childNodes.length) return;
            // For plain text slots, Bergamot can move trailing newlines or punctuation
            // outside <span data-flt-text-id="0">. Accept the complete body text as long
            // as no foreign elements were injected.
            const unexpectedElement = [...parsed.body.querySelectorAll("*")].some(
              (el) => !el.matches('span[data-flt-text-id="0"]'),
            );
            if (unexpectedElement) return;
            const slotText = (parsed.body.textContent ?? "").replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu, "");
            if (/\uFFFD/u.test(slotText)) return;
            if (!slotText && !isOptionalEnglishArticle(unit.coreText)) return;
            if (unit.innerBalanced && !bracketsBalanced(slotText)) return;
            if (slotText) nonEmptyTranslatedCount += 1;
            combined += slotText;
          }

          if (translatedUnitCount === 1 && nonEmptyTranslatedCount === 0) {
            const firstPiece = plan.pieces[0];
            const lastPiece = plan.pieces.at(-1);
            const leadingWs = firstPiece?.kind === "literal" ? firstPiece.text : "";
            const trailingWs = lastPiece?.kind === "literal" ? lastPiece.text : "";
            if (plan.pieces.length === 3 && /^\s+$/u.test(leadingWs) && /^\s+$/u.test(trailingWs)) {
              combined = leadingWs;
            }
          }

          targetSlot.textContent = combined;
          if (combined.trim() !== plan.originalText.trim()) anyChanged = true;
          continue;
        }

        const unit = units[plan.unitIndex]!;
        const raw = translatedSlots[plan.unitIndex];
        if (typeof raw !== "string") return;
        let repaired: string;
        try {
          repaired = repairSlot(unit.sourceSlotHtml, raw, unit.usedOpaque);
        } catch {
          return;
        }
        const parsed = parser.parseFromString(repaired, "text/html");
        if (parsed.head.childNodes.length) return;
        const meaningfulChildren = [...parsed.body.childNodes].filter(
          (node) => node.nodeType !== Node.TEXT_NODE || (node.textContent ?? "").trim() !== "",
        );
        const parsedSlot = meaningfulChildren.length === 1 ? meaningfulChildren[0] as Element : null;
        if (!parsedSlot || parsedSlot.nodeType !== Node.ELEMENT_NODE || !parsedSlot.matches('span[data-flt-text-id="0"]')) {
          return;
        }
        const slotText = parsedSlot.textContent ?? "";
        if (/\uFFFD/u.test(slotText)) return;
        if (!slotText.trim() && !isOptionalEnglishArticle(unit.coreText)) return;
        if (unit.innerBalanced && !bracketsBalanced(slotText)) return;

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
