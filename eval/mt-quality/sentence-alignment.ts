// Research only. This module is never imported by the extension.
import type {CheckedTranslationResult, TranslationRequest} from "../../src/core/provider";
import {assessTranslationQuality, isOptionalEnglishArticle} from "../../src/core/translation-quality";
import {richHtmlStructureCompatible} from "../../src/core/rich-segment-splitter";
import {decodeFixedMtText, encodeFixedMtText} from "../../src/providers/pagelingo-mt/fixed-text";
import {mtPrompt} from "../../src/providers/pagelingo-mt/protocol";

const protectedTags = new Set(["CODE", "KBD", "SAMP", "VAR", "BR", "WBR"]);
const formattingTags = new Set(["A", "EM", "STRONG", "B", "I", "MARK", "SPAN", "SUB", "SUP", "SMALL", "S", "U", "DEL", "INS"]);
const markerPattern = /⟦\/?\d+⟧|⟪P\d+⟫/gu;
const reserved = /[⟦⟧⟪⟫⟨⟩<>]/u;
type TextSlot = ReturnType<typeof encodeFixedMtText>["texts"][number];

export interface SentenceAlignment {
  fixed: ReturnType<typeof encodeFixedMtText>;
  source: string;
  events: string[];
  regions: TextSlot[][];
  protectedContext: Array<{token: string; text: string}>;
}

/** Only formatting/immutable boundaries are exposed; transport Text spans are transparent.
 * A region may contain one editable node. Multiple-node regions reject conservatively:
 * dividing a translated phrase by source lengths is not an alignment algorithm.
 */
export function encodeSentenceAlignment(html: string, opaque: readonly {text: string}[] = []): SentenceAlignment {
  const fixed = encodeFixedMtText(html);
  const byNode = new Map(fixed.texts.map(slot => [slot.node, slot]));
  const events: string[] = [], regions: TextSlot[][] = [[]], protectedContext: SentenceAlignment["protectedContext"] = [];
  let source = "", partIndex = 0, formatId = 0;
  const event = (token: string) => {events.push(token); regions.push([]); source += token;};
  const walk = (node: Node): void => {
    const slot = byNode.get(node as Text);
    if (slot) {
      if (fixed.parts[partIndex++]?.text !== slot) throw new Error("Sentence alignment traversal mismatch");
      regions[regions.length - 1]!.push(slot); source += slot.source; return;
    }
    if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.ELEMENT_NODE &&
      (protectedTags.has((node as Element).tagName) || (node as Element).hasAttribute("data-flt-term-id") || (node as Element).hasAttribute("data-flt-fixed"))) {
      const text = node.textContent ?? "";
      if (node.nodeType === Node.TEXT_NODE && !text) return;
      if (node.nodeType === Node.ELEMENT_NODE && protectedTags.has((node as Element).tagName) && /^__FLT_LINK_(?:START|END)_\d+__$/.test(text.trim())) return;
      const part = fixed.parts[partIndex++];
      if (!part || part.text) throw new Error("Sentence alignment protected traversal mismatch");
      // Keep whitespace nodes untouched without making layout whitespace a model token.
      if (node.nodeType === Node.TEXT_NODE && /^\s+$/u.test(text)) {source += text; return;}
      event(part.token);
      protectedContext.push({token: part.token, text: text.replace(/__FLT_OPAQUE_(\d+)__/g,
        (whole, index: string) => opaque[Number(index)]?.text ?? whole)});
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    const formatted = formattingTags.has(element.tagName) && !element.hasAttribute("data-flt-text-id");
    const id = formatted ? formatId++ : -1;
    if (formatId > 32) throw new Error("Sentence alignment formatting budget exceeded");
    if (formatted) event(`⟦${id}⟧`);
    for (const child of Array.from(node.childNodes)) walk(child);
    if (formatted) event(`⟦/${id}⟧`);
  };
  for (const child of Array.from(fixed.body.childNodes)) walk(child);
  if (partIndex !== fixed.parts.length) throw new Error("Sentence alignment incomplete traversal");
  if (regions.some(region => region.length > 1)) throw new Error("Sentence alignment ambiguous multi-node region; original paragraph retained");
  return {fixed, source, events, regions, protectedContext};
}

export function sentenceAlignmentPrompt(encoded: SentenceAlignment, request: TranslationRequest): string {
  const base = mtPrompt(encoded.source, request.terminology, request.context);
  const start = base.indexOf("Rules:\n"), end = base.indexOf("English:\n", start);
  return base.slice(0, start) + `Rules:
1. Translate the entire sentence. Numbered pairs mark only the exact words of a link or emphasized phrase. Keep each pair exactly once around its translation, without expanding its meaning.
2. Copy every protected token exactly once and unchanged. Its original content is given below only as context; output the token instead of its content.
3. Keep formatting markers and protected tokens in their original order and nesting. Rephrase the Chinese to fit this order while preserving all actions, participants, negation and temporal relationships.
4. Output only the translation with these markers. Do not add HTML, explanations, labels, or commentary.
Protected context (JSON, reference only):
${JSON.stringify(encoded.protectedContext)}
` + base.slice(end);
}

/** Ordered boundary grammar: ordinary sentence text is unframed. No words may
 * appear in a region which has no original editable Text node. */
export function sentenceAlignmentGrammar(encoded: SentenceAlignment): string {
  const sequence = encoded.regions.flatMap((region, index) => {
    const slot = region[0];
    const text = slot ? isOptionalEnglishArticle(slot.source) ? "text" : "required" : "";
    return [text, encoded.events[index] === undefined ? "" : JSON.stringify(encoded.events[index])].filter(Boolean);
  });
  return `root ::= ws ${sequence.join(" ws ")}\nws ::= [ \\t\\n\\r]{0,4}\nchar ::= [^⟦⟧⟪⟫⟨⟩<> \\t\\n\\r]\ntext ::= required?\nrequired ::= char (ws char)*\n`;
}

function labelCounts(text: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const match of text.matchAll(/(?:^|[\r\n\u2028\u2029])\s*(中文|译文|翻译|translation|chinese)\s*[:：]/giu)) {
    const kind = /^(?:中文|chinese)$/iu.test(match[1]!) ? "chinese" : "translation";
    result.set(kind, (result.get(kind) ?? 0) + 1);
  }
  return result;
}

/** Project onto detached original slots, then reuse all production decoder guards.
 * Exact event order and full text coverage are mandatory; no fuzzy matching or
 * generated DOM is used. All validation precedes the detached Text writes. */
export function decodeSentenceAlignment(encoded: SentenceAlignment, output: string): string {
  const matches = Array.from(output.matchAll(markerPattern));
  if (matches.length !== encoded.events.length || matches.some((match, index) => match[0] !== encoded.events[index])) {
    throw new Error("Sentence alignment non-monotone, missing or duplicate boundary; original paragraph retained");
  }
  const values = new Map<number, string>();
  let cursor = 0;
  const chunks = matches.map(match => {
    const chunk = output.slice(cursor, match.index); cursor = match.index + match[0].length; return chunk;
  });
  chunks.push(output.slice(cursor));
  if (chunks.some(chunk => reserved.test(chunk))) throw new Error("Sentence alignment invalid marker or HTML");
  const sourceLabels = labelCounts(encoded.fixed.body.textContent ?? "");
  if ([...labelCounts(chunks.join(""))].some(([kind, count]) => count > (sourceLabels.get(kind) ?? 0))) {
    throw new Error("Sentence alignment introduced translation label");
  }
  for (const [index, region] of encoded.regions.entries()) {
    const value = chunks[index]!.trim();
    if (!region.length && value) throw new Error("Sentence alignment unassigned text; original paragraph retained");
    if (region.length > 1) throw new Error("Sentence alignment ambiguous region");
    if (region[0]) values.set(region[0].id, value);
  }
  if (values.size !== encoded.fixed.texts.length) throw new Error("Sentence alignment incomplete text coverage");
  const framed = encoded.fixed.parts.map(part => part.token + (part.text
    ? values.get(part.text.id)! + `⟦/${part.text.id}⟧` : "")).join("");
  return decodeFixedMtText(encoded.fixed, framed);
}

export function checkSentenceAlignment(request: TranslationRequest, encoded: SentenceAlignment, output: string, finishReason: string): CheckedTranslationResult {
  const reject = (reason: string) => ({html: request.html, accepted: false, reason});
  if (finishReason !== "stop") return reject("Sentence alignment generation did not finish normally");
  try {
    const html = decodeSentenceAlignment(encoded, output);
    if (!richHtmlStructureCompatible(request.html, html)) return reject("Sentence alignment rich structure changed");
    const plain = (value: string) => new DOMParser().parseFromString(value, "text/html").body.textContent ?? "";
    const quality = assessTranslationQuality({sourceText: plain(request.html), translatedText: plain(html), sourceLanguage: request.sourceLanguage, targetLanguage: request.targetLanguage});
    return quality.accepted ? {html, accepted: true} : reject(quality.reasons.join(", "));
  } catch (error) {return reject(String(error));}
}
