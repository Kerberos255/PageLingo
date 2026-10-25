import type { TranslationRequest } from "../../core/provider";
import { mtPrompt } from "./protocol";
import { isOptionalEnglishArticle } from "../../core/translation-quality";
import { MT_WORD_CHAR_RANGES } from "./word-ranges";

interface TextSlot { id: number; node: Text; source: string }
interface FixedPart { token: string; text?: TextSlot }
export interface FixedMtText {
  body: HTMLElement;
  source: string;
  parts: FixedPart[];
  texts: TextSlot[];
  protectedCount: number;
}

const protectedTags = new Set(["CODE", "KBD", "SAMP", "VAR", "BR", "WBR"]);
const boundary = /^__FLT_LINK_(?:START|END)_\d+__$/;
const reserved = /[⟦⟧⟪⟫⟨⟩]/u;
// Closing/P markers sometimes emerge using ordinary East Asian brackets instead
// of the reserved glyphs. Keep book titles such as 《1984》 valid.
const markerLookalike = /[〈〉《》⟬⟭【】〔〕「」\[\](]\s*(?:\/\s*(?:P\s*)?\d+|P\s*(?:\d+|n)(?=\s*[〈〉《》⟬⟭【】〔〕「」\[\])]))/u;
const standaloneNegation = /^(?:no|not|never|none|neither|without|cannot|can't|do not|does not|did not|is not|are not|was not|were not)$/iu;
const translatedNegation = /[不没無无未非别勿否莫毋零]|\b(?:no|not|never|none|neither|without|cannot|can't|don't|doesn't|didn't|isn't|aren't)\b/iu;
const isLabelSlot = (slot: TextSlot) => Boolean(slot.node.parentElement?.closest("a,em,strong,b,i,mark"));

export function encodeFixedMtText(html: string): FixedMtText {
  const body = new DOMParser().parseFromString(html, "text/html").body;
  const texts: TextSlot[] = [];
  const parts: FixedPart[] = [];
  let source = "";
  let protectedCount = 0;
  const protect = () => {
    const token = `⟪P${protectedCount++}⟫`;
    parts.push({token}); source += token;
  };
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? "";
      if (!value) return;
      if (!/\p{L}/u.test(value) || reserved.test(value) || markerLookalike.test(value)) { protect(); return; }
      const text = {id: texts.length, node: node as Text, source: value};
      if (text.id >= 32) throw new Error("MT text-slot budget exceeded");
      texts.push(text);
      const token = `⟦${text.id}⟧`;
      parts.push({token, text}); source += token + value + `⟦/${text.id}⟧`;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    if (protectedTags.has(element.tagName) || element.hasAttribute("data-flt-term-id") || element.hasAttribute("data-flt-fixed")) {
      // Link sentinels belong to the application and never go through generation.
      if (protectedTags.has(element.tagName) && boundary.test((element.textContent ?? "").trim())) return;
      protect(); return;
    }
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  for (const child of Array.from(body.childNodes)) walk(child);
  if (protectedCount > 32) throw new Error("MT protected-slot budget exceeded");
  return {body, source, parts, texts, protectedCount};
}

export function fixedMtPrompt(encoded: FixedMtText, request: TranslationRequest): string {
  const base = mtPrompt(encoded.source, request.terminology, request.context);
  const start = base.indexOf("Rules:\n");
  const end = base.indexOf("English:\n", start);
  return base.slice(0, start) + `Rules:
1. Each numbered pair ⟦n⟧...⟦/n⟧ is one fixed text node. Translate its text using the whole sentence as context. Keep every pair exactly once, in the original order. Do not move words between pairs.
2. Copy every protected token ⟪Pn⟫ exactly once in its original position between pairs. Do not put protected tokens inside a pair.
3. Put all translated words inside their original numbered pairs. Output only the translation with these markers. Do not add HTML, explanations, labels, or commentary.
` + base.slice(end);
}

export function fixedMtMaxTokens(encoded: FixedMtText): number {
  const chars = encoded.texts.reduce((sum, slot) => sum + slot.source.length, 0);
  return Math.min(768, Math.max(48, Math.min(384, Math.ceil(chars * 1.5)))
    + 10 * encoded.texts.length + 6 * encoded.protectedCount + 24);
}

export function fixedMtGrammar(encoded: FixedMtText): string {
  const parts = encoded.parts.map(part => {
    const token = JSON.stringify(part.token);
    if (!part.text) return token;
    const rule = isLabelSlot(part.text) ? "label" : isOptionalEnglishArticle(part.text.source) ? "text" : "required";
    return `${token} ${rule} ${JSON.stringify(`⟦/${part.text.id}⟧`)}`;
  });
  const whitespace = String.raw`\t\n\x0b\x0c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff`;
  // Values are trimmed by the decoder; source edge whitespace belongs to the DOM.
  // Bounded internal gaps and no trailing root whitespace prevent a completed
  // frame from spending its remaining budget on whitespace instead of EOS.
  return `root ::= ws ${parts.join(" ws ")}\nws ::= gap?\n`
    + `gap ::= [${whitespace}]{1,4}\nchar ::= [^⟦⟧⟪⟫⟨⟩<>${whitespace}]\n`
    + `text ::= required?\nrequired ::= char (gap? char)*\nlabel ::= (nonword gap?)* word (gap? char)*\n`
    + `word ::= [${MT_WORD_CHAR_RANGES}]\nnonword ::= [^⟦⟧⟪⟫⟨⟩<>${whitespace}${MT_WORD_CHAR_RANGES}]\n`;
}

export function decodeFixedMtText(encoded: FixedMtText, output: string): string {
  const values: string[] = [];
  let cursor = 0;
  for (const part of encoded.parts) {
    while (/\s/u.test(output[cursor] ?? "") && cursor < output.length) cursor++;
    if (!output.startsWith(part.token, cursor)) throw new Error("MT fixed text-slot order or count mismatch");
    cursor += part.token.length;
    if (!part.text) continue;
    const closing = `⟦/${part.text.id}⟧`;
    const end = output.indexOf(closing, cursor);
    if (end < 0) throw new Error("MT unclosed text slot");
    const value = output.slice(cursor, end).trim();
    const isLabel = isLabelSlot(part.text);
    if (isLabel && !/[\p{L}\p{N}]/u.test(value)) throw new Error("MT link/emphasis text became empty or punctuation-only");
    if (isLabel && standaloneNegation.test(part.text.source.trim()) && !translatedNegation.test(value)) {
      throw new Error("MT standalone link/emphasis negation was lost; original paragraph retained");
    }
    if ((!value && !isOptionalEnglishArticle(part.text.source)) || reserved.test(value) || markerLookalike.test(value) || /[<>]/u.test(value)) throw new Error("MT invalid text-slot content");
    if (/^(?:中文|译文|翻译|translation|chinese)\s*[:：]/iu.test(value)) throw new Error("MT translation label in text slot");
    values.push(value); cursor = end + closing.length;
  }
  if (output.slice(cursor).trim()) throw new Error("MT unassigned text or malformed marker");
  for (const [index, slot] of encoded.texts.entries()) {
    const leading = slot.source.match(/^\s*/u)?.[0] ?? "";
    const trailing = slot.source.match(/\s*$/u)?.[0] ?? "";
    slot.node.data = leading + values[index]! + trailing;
  }
  return encoded.body.innerHTML;
}
