import type {CheckedTranslationResult, TranslationRequest} from "../../core/provider";
import {assessTranslationQuality} from "../../core/translation-quality";
import {richHtmlStructureCompatible} from "../../core/rich-segment-splitter";
import {decodeFixedMtText, encodeFixedMtText, fixedMtGrammar, fixedMtMaxTokens, fixedMtPrompt} from "./fixed-text";
import {assembleMtSentences, MT_CONTEXT_TOKENS, planMtSentences} from "./sentence-plan";
import {clarifyReturnCondition} from "./return-condition";

export async function inferMtHtml(request: TranslationRequest, complete: (options: any) => Promise<any>,
  options: {clarifyReturnConditions?: boolean} = {}): Promise<CheckedTranslationResult> {
  const reject = (reason: string): CheckedTranslationResult => ({html: request.html, accepted: false, reason});
  let units: string[];
  try { units = planMtSentences(request); } catch (error) { return reject(String(error)); }
  const translations: string[] = [];
  for (const html of units) {
    const encoded = encodeFixedMtText(html);
    if (!encoded.texts.length) { translations.push(html); continue; }
    const budget = fixedMtMaxTokens(encoded);
    // Fit a clarified prompt in the existing one-call plan, including the role template reserve.
    const clarified = options.clarifyReturnConditions && units.length === 1
      ? clarifyReturnCondition(encoded, request, MT_CONTEXT_TOKENS - budget - 8) : undefined;
    const response = await complete({messages: [{role: "user", content: clarified ?? fixedMtPrompt(encoded, request)}],
      grammar: fixedMtGrammar(encoded), max_tokens: budget, temperature: 0, top_k: 1, stream: false});
    const choice = response?.choices?.[0];
    if (choice?.finish_reason !== "stop") return reject("MT generation did not finish normally; original paragraph retained");
    const raw = String(choice.message?.content ?? "").trim();
    try { translations.push(decodeFixedMtText(encoded, raw)); }
    catch (error) { return reject(String(error)); }
  }
  let joined: string;
  try {joined = assembleMtSentences(request.html, units, translations);}
  catch (error) {return reject(String(error));}
  if (!richHtmlStructureCompatible(request.html, joined)) return reject("MT sentence assembly changed rich structure");
  const plain = (html: string) => new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
  const quality = assessTranslationQuality({sourceText: plain(request.html), translatedText: plain(joined), sourceLanguage: request.sourceLanguage, targetLanguage: request.targetLanguage});
  if (!quality.accepted) return reject(quality.reasons.join(", "));
  return {html: joined, accepted: true};
}
