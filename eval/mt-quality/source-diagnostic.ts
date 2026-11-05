// Evaluation only. Meaning references have no relationship to DOM slot counts.
import type {TranslationRequest} from "../../src/core/provider";
import {collectTranslationRoots} from "../../src/core/dom-policy";
import {serializeRichSegment, terminologyForText} from "../../src/core/rich-segment";
import {contextualTerminology, translationContextForUrl} from "../../src/core/translation-context";
import {PageTranslator} from "../../src/core/page-translator";
import {inferMtHtml} from "../../src/providers/pagelingo-mt/inference";
import {qualityCallPlan, type RecordedQualityCompletion} from "./protocol";
import {naturalTranslationPrompt, prepareSemanticRewrite} from "./semantic-rewrite";

export interface SourceDiagnosticCase {
  id: string;
  html: string;
  context_url: string;
}

export function prepareSourceDiagnostic(sample: SourceDiagnosticCase, doc: Document = document) {
  const scope = doc.createElement("article");
  scope.innerHTML = sample.html; doc.body.append(scope);
  try {
    const roots = collectTranslationRoots(scope, {preserveInlineContext: true});
    if (roots.length !== 1) throw new Error(`${sample.id}: expected one translation root`);
    const root = roots[0] as HTMLElement;
    const segment = serializeRichSegment(root, {fixedTextSlots: true});
    const context = translationContextForUrl(sample.context_url);
    const request: TranslationRequest = {html: segment.html, sourceLanguage: "en", targetLanguage: "zh-Hans",
      terminology: terminologyForText(contextualTerminology(context), segment.fingerprint), ...(context ? {context} : {})};
    const calls = qualityCallPlan(request);
    const semantic = prepareSemanticRewrite(request, segment.opaque);
    return {scope, root, segment, request, calls, semantic,
      natural: {messages: [{role: "user", content: naturalTranslationPrompt(semantic)}], grammar: null,
        max_tokens: Math.min(768, calls.reduce((n, call) => n + call.max_tokens, 0))}};
  } catch (error) {scope.remove(); throw error;}
}

// The production provider and renderer consume recorded completions. No reference
// translation, draft alignment or generated HTML is supplied to the renderer.
export async function replaySourceDiagnostic(sample: SourceDiagnosticCase, completions: RecordedQualityCompletion[]) {
  const p = prepareSourceDiagnostic(sample);
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
          const call = p.calls[index], row = completions[index++];
          if (!call || !row || JSON.stringify(options.messages) !== JSON.stringify(call.messages)
            || options.grammar !== call.grammar || options.max_tokens !== call.max_tokens) {
            failure = "Recorded completion differs from production request"; throw new Error(failure);
          }
          return {choices: [{finish_reason: row.finish_reason, message: {content: row.text}}]};
        });
        if (!checked.accepted) throw new Error(checked.reason);
        return checked.html;
      }}, {displayMode: "translation", concurrency: 1, sourceLanguage: "en", targetLanguage: "zh-Hans"});
    await translator.translateAll(p.scope);
    if (failure || !checked || checked.accepted && index !== completions.length) throw new Error(failure ?? "Incomplete recorded replay");
    const result = {id: sample.id, displayed: translator.translatedCount === 1, reason: checked.reason ?? null,
      translated_text: p.scope.textContent, translated_html: p.scope.innerHTML,
      original_structure_unchanged: nodes.every(x => x.node.isConnected && x.attrs === JSON.stringify([...x.node.attributes].map(a => [a.name, a.value]))
        && x.children.length === x.node.childNodes.length && x.children.every((n, i) => n === x.node.childNodes[i])),
      code_unchanged: code.every(x => x.node.isConnected && x.node.outerHTML === x.html),
      labels: labels.map(x => ({tag: x.node.tagName, source: x.source, translated: x.node.textContent ?? ""})),
      consumed_completions: index, events};
    translator.setDisplayMode("bilingual"); translator.setDisplayMode("translation"); translator.restore();
    return {...result, restored_exact: p.scope.innerHTML === before};
  } finally {console.warn = warn; p.scope.remove();}
}
