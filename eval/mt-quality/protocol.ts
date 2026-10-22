import type {TranslationRequest} from "../../src/core/provider";
import {collectTranslationRoots} from "../../src/core/dom-policy";
import {serializeRichSegment, terminologyForText} from "../../src/core/rich-segment";
import {contextualTerminology, translationContextForUrl} from "../../src/core/translation-context";
import {decodeFixedMtText, encodeFixedMtText, fixedMtGrammar, fixedMtMaxTokens, fixedMtPrompt} from "../../src/providers/pagelingo-mt/fixed-text";

export interface ContentProbe {
  id: string;
  slot?: number;
  any?: string[];
  none?: string[];
  equals?: string[];
  description: string;
}
export interface QualityCase {
  id: string;
  split: "holdout" | "diagnostic" | "train" | "validation";
  family: string;
  category: string;
  html: string;
  context_url: string;
  origin: {kind: "authored" | "web_excerpt"; url?: string; captured_utc?: string};
  reference_slots: string[];
  probes: ContentProbe[];
  review_status: "assistant_authored_needs_human_review" | "human_reviewed";
}

export function prepareQualityCase(sample: QualityCase, doc: Document = document) {
  const scope = doc.createElement("article");
  scope.innerHTML = sample.html;
  doc.body.append(scope);
  const roots = collectTranslationRoots(scope, {preserveInlineContext: true});
  if (roots.length !== 1) throw new Error(`${sample.id}: expected one owned translation root`);
  const root = roots[0] as HTMLElement;
  const segment = serializeRichSegment(root, {fixedTextSlots: true});
  const context = translationContextForUrl(sample.context_url);
  const request: TranslationRequest = {
    html: segment.html, sourceLanguage: "en", targetLanguage: "zh-Hans",
    terminology: terminologyForText(contextualTerminology(context), segment.fingerprint),
    ...(context ? {context} : {}),
  };
  const encoded = encodeFixedMtText(request.html);
  if (encoded.texts.length !== sample.reference_slots.length || encoded.texts.length !== segment.textSlots?.length) {
    throw new Error(`${sample.id}: reference must map one-to-one to original text slots`);
  }
  const target = encoded.parts.map(part => part.token + (part.text
    ? sample.reference_slots[part.text.id]! + `⟦/${part.text.id}⟧` : "")).join("");
  // Validate references with the production decoder before exporting training targets.
  const referenceHtml = decodeFixedMtText(encoded, target);
  return {scope, root, segment, request, source: encodeFixedMtText(request.html).source,
    prompt: fixedMtPrompt(encoded, request), grammar: fixedMtGrammar(encoded),
    maxTokens: fixedMtMaxTokens(encoded), target, referenceHtml};
}

const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
export function checkContentProbes(sample: QualityCase, html: string) {
  const body = new DOMParser().parseFromString(html, "text/html").body;
  return sample.probes.map(probe => {
    const node = probe.slot === undefined ? body : body.querySelector(`[data-flt-text-id="${probe.slot}"]`);
    const value = normalize(node?.textContent ?? "");
    const passed = Boolean(node)
      && (!probe.any || probe.any.some(term => value.includes(term)))
      && (!probe.none || probe.none.every(term => !value.includes(term)))
      && (!probe.equals || probe.equals.some(term => value === normalize(term)));
    return {id: probe.id, description: probe.description, slot: probe.slot, passed, observed: value};
  });
}

export function canonicalSource(sample: QualityCase): string {
  return normalize(new DOMParser().parseFromString(sample.html, "text/html").body.textContent ?? "").toLowerCase();
}
