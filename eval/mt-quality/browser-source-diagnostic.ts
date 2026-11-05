// Native outputs replayed in Firefox; this never starts a wllama model.
import {prepareSourceDiagnostic, replaySourceDiagnostic, type SourceDiagnosticCase} from "./source-diagnostic";
import type {RecordedQualityCompletion} from "./protocol";

interface BrowserReplayInput {
  model: string;
  variant: "production" | "context-research";
  sample: SourceDiagnosticCase;
  fixed_source: string;
  completions: RecordedQualityCompletion[];
  expected: {displayed: boolean; translated_text: string | null};
}

export async function replaySourceFramesInBrowser(inputs: BrowserReplayInput[]) {
  const results = [];
  for (const input of inputs) {
    // Regenerate the local replay request for this document's URL. No inference
    // takes place here; assert the serialized source equals the native source.
    const sample = {...input.sample, context_url: document.location.href};
    const p = prepareSourceDiagnostic(sample);
    const sourceMatches = p.semantic.fixed.source === input.fixed_source;
    p.scope.remove();
    if (!sourceMatches) throw new Error("Firefox source differs from captured native input: " + sample.id);
    const result = await replaySourceDiagnostic(sample, input.completions);
    results.push({model: input.model, variant: input.variant, native_serialized_source_matches: sourceMatches,
      node_replay_text_matches: result.translated_text === input.expected.translated_text,
      node_replay_display_matches: result.displayed === input.expected.displayed, ...result});
  }
  return {kind: "recorded-native-output-firefox-dom-replay", new_wllama_inference: false,
    requests_regenerated_for_local_url: true, results};
}
