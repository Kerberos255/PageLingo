import type {TranslationRequest} from "../../src/core/provider";
import {collectTranslationRoots} from "../../src/core/dom-policy";
import {serializeRichSegment, terminologyForText} from "../../src/core/rich-segment";
import {contextualTerminology, translationContextForUrl} from "../../src/core/translation-context";
import {decodeFixedMtText, encodeFixedMtText, fixedMtGrammar, fixedMtMaxTokens, fixedMtPrompt} from "../../src/providers/pagelingo-mt/fixed-text";
import {planMtSentences} from "../../src/providers/pagelingo-mt/sentence-plan";
import {inferMtHtml} from "../../src/providers/pagelingo-mt/inference";
import {PageTranslator} from "../../src/core/page-translator";

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

export function qualityCallPlan(request: TranslationRequest) {
  return planMtSentences(request).flatMap(html => {
    const encoded = encodeFixedMtText(html);
    return encoded.texts.length ? [{messages: [{role: "user", content: fixedMtPrompt(encoded, request)}],
      grammar: fixedMtGrammar(encoded), max_tokens: fixedMtMaxTokens(encoded)}] : [];
  });
}

export interface RecordedQualityCompletion {text: string; finish_reason: string}
export async function replayQualityCase(sample: QualityCase, completions: RecordedQualityCompletion[]) {
  const p = prepareQualityCase(sample);
  const expected = qualityCallPlan(p.request);
  const before = p.scope.innerHTML;
  const nodes = [p.root, ...p.root.querySelectorAll("*")].map(node => ({node, children: [...node.childNodes],
    attrs: JSON.stringify([...node.attributes].map(a => [a.name, a.value]))}));
  const code = [...p.scope.querySelectorAll("code,kbd,samp,var")].map(node => ({node, html: node.outerHTML}));
  const labels = [...p.scope.querySelectorAll("a,em,strong,b,i,mark")].map(node => ({node, source: node.textContent ?? ""}));
  let index = 0, failure: string | undefined, checked: Awaited<ReturnType<typeof inferMtHtml>> | undefined;
  const events: string[] = [];
  const warn = console.warn; console.warn = (...args) => {events.push(args.map(String).join(" "));};
  try {
    const translator = new PageTranslator(document, {prefersWholeSentenceHtml: async () => true,
      translateHtml: async (request: TranslationRequest) => {
        checked = await inferMtHtml(request, async options => {
          const plan = expected[index], row = completions[index++];
          if (!plan || !row || JSON.stringify(options.messages) !== JSON.stringify(plan.messages)
            || options.grammar !== plan.grammar || options.max_tokens !== plan.max_tokens) {
            failure = "Recorded completion does not match the production call plan";
            throw new Error(failure);
          }
          return {choices: [{finish_reason: row.finish_reason, message: {content: row.text}}]};
        });
        if (!checked.accepted) throw new Error(checked.reason);
        return checked.html;
      }}, {displayMode: "translation", concurrency: 1, sourceLanguage: "en", targetLanguage: "zh-Hans"});
    await translator.translateAll(p.scope);
    if (failure || !checked || (checked.accepted && index !== completions.length)) throw new Error(failure ?? "Incomplete replay");
    const displayed = translator.translatedCount === 1;
    const probes = displayed ? checkContentProbes(sample, checked.html) : null;
    const result = {id: sample.id, split: sample.split, displayed, reason: checked.reason ?? null,
      translated_text: p.scope.textContent, translated_html: p.scope.innerHTML,
      original_structure_unchanged: nodes.every(x => x.node.isConnected && x.attrs === JSON.stringify([...x.node.attributes].map(a => [a.name, a.value]))
        && x.children.length === x.node.childNodes.length && x.children.every((n, i) => n === x.node.childNodes[i])),
      code_unchanged: code.every(x => x.node.isConnected && x.node.outerHTML === x.html),
      content_probes: probes, all_content_probes_passed: displayed && probes!.every(x => x.passed),
      label_issues: displayed ? labels.filter(x => /\p{L}/u.test(x.source) && !/[\p{L}\p{N}]/u.test(x.node.textContent ?? ""))
        .map(x => ({tag: x.node.tagName, source: x.source, translated: x.node.textContent ?? ""})) : [],
      consumed_completions: index, events};
    translator.setDisplayMode("bilingual"); translator.setDisplayMode("translation"); translator.restore();
    return {...result, restored_exact: p.scope.innerHTML === before};
  } finally {console.warn = warn; p.scope.remove();}
}
