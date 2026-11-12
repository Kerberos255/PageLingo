export interface TranslationQualityAssessment {
  accepted: boolean;
  reasons: string[];
  sourceChars: number;
  translatedChars: number;
  expansionRatio: number;
  unexpectedKana: boolean;
  placeholderGarbage: boolean;
  repeatedOutput: boolean;
  targetLanguageMismatch: boolean;
  suspiciouslyShort: boolean;
  incompleteAgentClause: boolean;
}

// Chinese can omit a standalone English article. Do not extend this exception
// to arbitrary words: an empty content-bearing slot must reject the paragraph.
export function isOptionalEnglishArticle(source: string): boolean {
  return /^(?:a|an|the)$/iu.test(source.trim());
}

function normalizeTransportText(value: string): string {
  return String(value || "")
    .replace(/__FLT_(?:OPAQUE_\d+|LINK_(?:START|END)_\d+)__/g, " ")
    .replace(/⟪P\d+⟫/g, " ")
    .replace(/⟦\/?\d+⟧/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function repeatedOutput(value: string): boolean {
  const repeatedLatin =
    /\b([A-Za-z]{3,})(?:[\s.,;:!?，。！？、]+\1){4,}\b/iu.test(value);
  const repeatedCjk =
    /([\u3400-\u9fff]{2,8})(?:[\s.,;:!?，。！？、]*\1){3,}/u.test(value);
  return repeatedLatin || repeatedCjk;
}

export function assessTranslationQuality(input: {
  sourceText: string;
  translatedText: string;
  sourceLanguage?: string;
  targetLanguage?: string;
}): TranslationQualityAssessment {
  const source = normalizeTransportText(input.sourceText);
  const translated = normalizeTransportText(input.translatedText);
  const sourceChars = source.length;
  const translatedChars = translated.length;
  const expansionRatio = translatedChars / Math.max(1, sourceChars);
  const targetLanguage = String(input.targetLanguage || "").toLowerCase();

  const sourceHasKana = /[\u3040-\u30ff]/u.test(source);
  const translatedHasKana = /[\u3040-\u30ff]/u.test(translated);
  const unexpectedKana =
    /^zh(?:-|$)/i.test(targetLanguage) &&
    !sourceHasKana &&
    translatedHasKana;

  const placeholderGarbage = /(?:_{3,}|＿{3,})/u.test(translated);
  const hasRepeatedOutput = repeatedOutput(translated);

  const sourceLatinChars = (source.match(/[A-Za-z]/g) ?? []).length;
  const translatedLatinChars = (translated.match(/[A-Za-z]/g) ?? []).length;
  const translatedCjkChars = (translated.match(/[\u3400-\u9fff]/gu) ?? []).length;
  const targetLanguageMismatch =
    /^zh(?:-|$)/i.test(targetLanguage) &&
    sourceLatinChars >= 20 &&
    translatedLatinChars >= 20 &&
    translatedCjkChars < Math.max(3, Math.floor(translatedLatinChars * 0.15));

  const suspiciouslyShort =
    sourceChars >= 80 &&
    translatedChars > 0 &&
    expansionRatio < 0.12;

  // A narrow English -> Chinese omission signal: a passive predicate became
  // "由 <Latin name>, 并且 ..." with no Chinese predicate. This does not require
  // a preferred translation, and must not treat ordinary names/lists as errors.
  const incompleteAgentClause =
    /^zh(?:-|$)/i.test(targetLanguage) &&
    (!input.sourceLanguage || /^(?:en(?:-|$)|auto$)/iu.test(input.sourceLanguage)) &&
    /\b(?:described|defined|specified|documented|written|provided|maintained|developed|created)\s+by\b/iu.test(source) &&
    /[,;]\s*(?:and|but)\s+(?:requires?|needs?|depends?|supports?|provides?|uses?)\b/iu.test(source) &&
    /由\s*[A-Za-z0-9][^\u3400-\u9fff,，;；。!?！？“”"「」]{0,120}[,，;；。](?=\s*(?:并且|而且|同时|此外|$))/u.test(translated);

  const reasons: string[] = [];
  if (sourceChars >= 8 && expansionRatio > 4) reasons.push("expansion_ratio_gt_4");
  if (unexpectedKana) reasons.push("unexpected_kana");
  if (placeholderGarbage) reasons.push("placeholder_garbage");
  if (hasRepeatedOutput) reasons.push("repeated_output");
  if (targetLanguageMismatch) reasons.push("target_language_mismatch");
  if (suspiciouslyShort) reasons.push("suspiciously_short");
  if (incompleteAgentClause) reasons.push("incomplete_agent_clause");

  return {
    accepted: reasons.length === 0,
    reasons,
    sourceChars,
    translatedChars,
    expansionRatio,
    unexpectedKana,
    placeholderGarbage,
    repeatedOutput: hasRepeatedOutput,
    targetLanguageMismatch,
    suspiciouslyShort,
    incompleteAgentClause,
  };
}
