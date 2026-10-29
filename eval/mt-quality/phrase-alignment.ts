// Research only: independent phrase translation is evidence for an alignment,
// not a semantic correctness proof. No production provider imports this module.
import {decodeSentenceAlignment, type SentenceAlignment} from "./sentence-alignment";

export function sentenceAlignmentLabels(encoded: SentenceAlignment): Array<{id: number; source: string}> {
  const stack: Array<{id: number; start: number}> = [];
  const labels: Array<{id: number; source: string}> = [];
  for (const match of encoded.source.matchAll(/⟦(\/?)(\d+)⟧/gu)) {
    const id = Number(match[2]);
    if (!match[1]) stack.push({id, start: match.index + match[0].length});
    else {
      const opening = stack.pop();
      if (!opening || opening.id !== id) throw new Error("Malformed source formatting");
      labels.push({id, source: encoded.source.slice(opening.start, match.index).replace(/⟦\/?\d+⟧/gu, "")});
    }
  }
  if (stack.length) throw new Error("Incomplete source formatting");
  return labels.sort((a, b) => a.id - b.id);
}

/** Exact unique substrings only; no word-length ratios, fuzzy scores or model
 * asserted confidence. Nested formatting must still match original event order.
 * Returns the marker projection for audit; decode reuses production guards. */
export function alignTranslatedPhrases(encoded: SentenceAlignment, draft: string, phrases: ReadonlyMap<number, string>): {html: string; aligned: string} {
  if (/[⟦⟧⟨⟩<>]/u.test(draft)) throw new Error("Phrase alignment draft contains formatting markers or HTML");
  const insertions: Array<{position: number; token: string; order: number}> = [];
  const protectedSpans = Array.from(draft.matchAll(/⟪P\d+⟫/gu)).map(match => [match.index, match.index + match[0].length]);
  for (const label of sentenceAlignmentLabels(encoded)) {
    const target = phrases.get(label.id)?.trim();
    if (!target || /[⟦⟧⟨⟩<>]/u.test(target) || /(?:^|[\r\n])\s*(?:中文|译文|翻译|translation|chinese)\s*[:：]/iu.test(target)) {
      throw new Error("Phrase alignment missing or invalid independent phrase translation");
    }
    const position = draft.indexOf(target);
    if (position < 0 || draft.indexOf(target, position + 1) >= 0) throw new Error("Phrase alignment target absent or ambiguous; original paragraph retained");
    const end = position + target.length;
    if (protectedSpans.some(([start, stop]) => position > start! && position < stop! || end > start! && end < stop!)) {
      throw new Error("Phrase alignment split protected token");
    }
    for (const [token, point] of [[`⟦${label.id}⟧`, position], [`⟦/${label.id}⟧`, end]] as const) {
      const order = encoded.events.indexOf(token);
      if (order < 0) throw new Error("Phrase alignment unknown source boundary");
      insertions.push({position: point, token, order});
    }
  }
  insertions.sort((a, b) => a.position - b.position || a.order - b.order);
  let cursor = 0, aligned = "";
  for (const insertion of insertions) {
    aligned += draft.slice(cursor, insertion.position) + insertion.token;
    cursor = insertion.position;
  }
  aligned += draft.slice(cursor);
  return {html: decodeSentenceAlignment(encoded, aligned), aligned};
}
