import {isOptionalEnglishArticle} from "./translation-quality";

const asciiWhitespace = /^[\t\n\f\r ]*$/u;
const attributes = (element: Element) => [...element.attributes]
  .map(a => [a.name, a.value]).sort(([a], [b]) => a!.localeCompare(b!));

/** Provider HTML is a transport: only the original text slots may supply words. */
function checkFixedTextHtml(sourceHtml: string, translatedHtml: string, restoreAtoms: boolean): string {
  const source = new DOMParser().parseFromString(sourceHtml, "text/html");
  const target = new DOMParser().parseFromString(translatedHtml, "text/html");
  if (target.head.childNodes.length) throw new Error("Translation added content outside the source template");
  const slots = new Set<string>();
  const children = (node: Node) => [...node.childNodes].filter(n =>
    n.nodeType !== Node.TEXT_NODE || !asciiWhitespace.test(n.textContent ?? ""));
  const fail = () => { throw new Error("Translation changed the original text-slot template; original paragraph retained"); };
  const compare = (a: Node, b: Node) => {
    if (a.nodeType !== b.nodeType) return fail();
    if (a.nodeType !== Node.ELEMENT_NODE) {
      if (a.textContent !== b.textContent) fail();
      return;
    }
    const from = a as Element, to = b as Element;
    if (from.tagName !== to.tagName || JSON.stringify(attributes(from)) !== JSON.stringify(attributes(to))) fail();
    if (restoreAtoms && !from.childElementCount && !to.childElementCount
      && [...from.childNodes, ...to.childNodes].every(n => n.nodeType === Node.TEXT_NODE)) {
      const original = from.textContent ?? "", received = to.textContent ?? "";
      // The fixed payload stays exact. HTML translation engines may only collapse ASCII padding
      // around it (e.g. " | " -> "|"); restore that source-owned padding locally.
      const trimAscii = (value: string) => value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu, "");
      if (from.hasAttribute("data-flt-fixed") && trimAscii(original) === trimAscii(received)) to.textContent = original;
      // Some HTML translation engines omit non-linguistic markers. The original atom
      // belongs to the application; a different marker or a translated word
      // still fails. No source node or model text is rewritten here.
      if (/^(CODE|KBD|SAMP|VAR)$/u.test(from.tagName)
        && /^__FLT_(?:OPAQUE|LINK_START|LINK_END)_\d+__$/u.test(original) && !received.trim()) to.textContent = original;
      const punctuation = (s: string) => s.trim()
        .replace(/[。．]/gu, ".")
        .replace(/，/gu, ",")
        .replace(/：/gu, ":")
        .replace(/；/gu, ";")
        .replace(/！/gu, "!")
        .replace(/？/gu, "?")
        .replace(/（/gu, "(")
        .replace(/）/gu, ")")
        .replace(/【/gu, "[")
        .replace(/】/gu, "]")
        .replace(/[“”「」『』]/gu, '"')
        .replace(/[‘’]/gu, "'");
      if (from.hasAttribute("data-flt-fixed") && /^[.,:;!?()\[\]"'-]+$/u.test(punctuation(original))
        && punctuation(original) === punctuation(received)) to.textContent = original;
    }
    const id = from.getAttribute("data-flt-text-id");
    if (id !== null) {
      if (from.tagName !== "SPAN" || !/^\d+$/u.test(id) || slots.has(id)) fail();
      slots.add(id);
      const isTermSpan = (el: Element) => el.tagName === "SPAN"
        && el.attributes.length === 1
        && /^\d+$/u.test(el.getAttribute("data-flt-term-id") ?? "")
        && el.childElementCount === 0
        && [...el.childNodes].every(n => n.nodeType === Node.TEXT_NODE);
      if (from.childElementCount === 0) {
        if (to.childElementCount || [...to.childNodes].some(n => n.nodeType !== Node.TEXT_NODE)) fail();
      } else {
        const fromChildren = [...from.childNodes];
        const toChildren = [...to.childNodes];
        if (fromChildren.some(n => n.nodeType !== Node.TEXT_NODE && (n.nodeType !== Node.ELEMENT_NODE || !isTermSpan(n as Element)))) fail();
        if (toChildren.some(n => n.nodeType !== Node.TEXT_NODE && (n.nodeType !== Node.ELEMENT_NODE || !isTermSpan(n as Element)))) fail();
        const fromTerms = fromChildren.filter(n => n.nodeType === Node.ELEMENT_NODE) as Element[];
        const toTerms = toChildren.filter(n => n.nodeType === Node.ELEMENT_NODE) as Element[];
        const fromIds = fromTerms.map(el => el.getAttribute("data-flt-term-id")!).sort();
        const toIds = toTerms.map(el => el.getAttribute("data-flt-term-id")!).sort();
        if (fromIds.length !== toIds.length || fromIds.some((tid, i) => tid !== toIds[i])) fail();
        if (restoreAtoms) {
          // If an engine emitted an empty term marker without repeating the term
          // in surrounding text, populate the expected protected text so non-empty
          // slot and completeness checks see the full sentence. If the term is
          // already present in surrounding text, leave the empty marker intact for
          // validateTranslatedHtml's tag skeleton check; restoreTerminology will
          // deduplicate it safely right afterward.
          const termTextById = new Map(fromTerms.map(el => [el.getAttribute("data-flt-term-id")!, el.textContent ?? ""]));
          const outsideText = toChildren.filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent ?? "").join("");
          for (const termEl of toTerms) {
            const tid = termEl.getAttribute("data-flt-term-id")!;
            const expectedText = termTextById.get(tid) ?? "";
            if (!termEl.textContent?.trim() && expectedText && !outsideText.includes(expectedText)) {
              termEl.textContent = expectedText;
            }
          }
        }
      }
      if (!(to.textContent ?? "").trim() && !isOptionalEnglishArticle(from.textContent ?? "")) fail();
      if (restoreAtoms && to.childElementCount === 0) {
        const original = from.textContent ?? "";
        to.textContent = (original.match(/^\s*/u)?.[0] ?? "") + (to.textContent ?? "").trim() + (original.match(/\s*$/u)?.[0] ?? "");
      }
      return;
    }
    const left = children(from), right = children(to);
    if (left.length !== right.length) fail();
    left.forEach((child, i) => compare(child, right[i]!));
  };
  compare(source.body, target.body);
  if (!slots.size) throw new Error("Translation has no original text slots");
  const balanced = (value: string, opening: string, closing: string) => {
    let depth = 0;
    for (const c of value.normalize("NFKC")) {
      if (c === opening) depth++;
      if (c === closing && --depth < 0) return false;
    }
    return depth === 0;
  };
  // Check across text slots, since a source parenthesis can span a link or
  // emphasis node. Incomplete source excerpts do not authorize bracket repair.
  for (const [opening, closing] of [["(", ")"], ["[", "]"], ["{", "}"], ["【", "】"], ["〔", "〕"], ["⟬", "⟭"]]) {
    if (balanced(source.body.textContent ?? "", opening!, closing!) && !balanced(target.body.textContent ?? "", opening!, closing!)) {
      throw new Error("Translation introduced unbalanced brackets; original paragraph retained");
    }
  }
  return target.body.innerHTML;
}

export function validateFixedTextHtml(sourceHtml: string, translatedHtml: string): void {
  checkFixedTextHtml(sourceHtml, translatedHtml, false);
}

/** Restore source-owned atoms and edge whitespace in a detached transport. */
export function restoreFixedHtmlTransport(sourceHtml: string, translatedHtml: string): string {
  return checkFixedTextHtml(sourceHtml, translatedHtml, true);
}
