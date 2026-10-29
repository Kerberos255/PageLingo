// Recorded native generations replayed through the real Firefox DOM renderer.
// This is not a new Firefox/wllama inference measurement.
import type {TranslationRequest} from "../../src/core/provider";
import {PageTranslator} from "../../src/core/page-translator";
import {inferMtHtml} from "../../src/providers/pagelingo-mt/inference";
import {prepareQualityCase, type QualityCase} from "./protocol";
import {checkSentenceAlignment, encodeSentenceAlignment} from "./sentence-alignment";
import {alignTranslatedPhrases, sentenceAlignmentLabels} from "./phrase-alignment";

interface Generation {case_id: string; variant: string; text: string; finish_reason: string}
export async function replayAlignmentInBrowser(sample: QualityCase, generations: Generation[], variant: string) {
  const p = prepareQualityCase(sample), before = p.scope.innerHTML;
  const nodes = [p.root, ...p.root.querySelectorAll("*")].map(node => ({node, children: [...node.childNodes],
    attrs: JSON.stringify([...node.attributes].map(attribute => [attribute.name, attribute.value]))}));
  const code = [...p.root.querySelectorAll("code,kbd,samp,var")].map(node => ({node, html: node.outerHTML}));
  const labels = [...p.root.querySelectorAll("a,em,strong,b,i,mark")].map(node => ({node, source: node.textContent}));
  const anchor = p.root.querySelector("a");
  let clicks = 0, calls = 0, reason: string | null = null;
  let serializedSourceMatches = true;
  const handleClick = (event: Event) => {event.preventDefault(); clicks++;};
  anchor?.addEventListener("click", handleClick);
  const translator = new PageTranslator(document, {prefersWholeSentenceHtml: async () => true,
    translateHtml: async (request: TranslationRequest) => {
      calls++;
      try {
        if (request.html !== p.request.html) {
          serializedSourceMatches = false;
          throw new Error("Browser serialized HTML differs from frozen fixture");
        }
        const row = generations.find(generation => generation.variant === variant);
        let checked;
        if (variant === "phrase_alignment") {
          if (generations.some(generation => generation.finish_reason !== "stop")) throw new Error("Draft or phrase truncated");
          const encoded = encodeSentenceAlignment(request.html, p.segment.opaque);
          const phrases = new Map(sentenceAlignmentLabels(encoded).map(label => {
            const text = /^(?:⟪P\d+⟫|\s)+$/u.test(label.source) ? label.source.trim()
              : generations.find(generation => generation.variant === `phrase_${label.id}`)?.text.trim();
            if (!text) throw new Error("Independent phrase missing");
            return [label.id, text];
          }));
          const draft = generations.find(generation => generation.variant === "draft");
          if (!draft) throw new Error("Draft missing");
          const aligned = alignTranslatedPhrases(encoded, draft.text, phrases).aligned;
          checked = checkSentenceAlignment(request, encodeSentenceAlignment(request.html, p.segment.opaque), aligned, "stop");
        } else {
          if (!row) throw new Error("Recorded output missing");
          checked = variant.startsWith("sentence_")
            ? checkSentenceAlignment(request, encodeSentenceAlignment(request.html, p.segment.opaque), row.text, row.finish_reason)
            : await inferMtHtml(request, async () => ({choices: [{finish_reason: row.finish_reason, message: {content: row.text}}]}));
        }
        if (!checked.accepted) throw new Error(checked.reason);
        return checked.html;
      } catch (error) {reason = String(error); throw error;}
    }}, {displayMode: "translation", concurrency: 1, sourceLanguage: "en", targetLanguage: "zh-Hans"});
  try {
    await translator.translateAll(p.scope);
    if (anchor) anchor.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true}));
    const row = {case_id: sample.id, variant, displayed: translator.translatedCount === 1, reason,
      translated_text: p.scope.textContent, labels: labels.map(label => ({tag: label.node.tagName, source: label.source, target: label.node.textContent})),
      original_structure_unchanged: nodes.every(item => item.node.isConnected && item.attrs === JSON.stringify([...item.node.attributes].map(attribute => [attribute.name, attribute.value]))
        && item.children.length === item.node.childNodes.length && item.children.every((child, index) => child === item.node.childNodes[index])),
      code_unchanged: code.every(item => item.node.isConnected && item.node.outerHTML === item.html),
      link_listener_preserved: !anchor || clicks === 1, serialized_source_matches: serializedSourceMatches, calls};
    translator.setDisplayMode("bilingual"); translator.setDisplayMode("translation"); translator.restore();
    return {...row, restored_exact: p.scope.innerHTML === before};
  } finally {anchor?.removeEventListener("click", handleClick); p.scope.remove();}
}
