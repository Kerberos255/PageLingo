import {replayFrozenProjection, type TargetSpan} from "./frozen-span-projection";
import {frozenProjectionFixtures} from "./frozen-projection-fixtures";
interface Input {
  model: string; sample: {id: string; html: string}; target: string; spans: TargetSpan[];
  expected: {displayed: boolean; translated_text: string | null};
}
export async function runFrozenProjectionBrowser(inputs: Input[]) {
  const actual = [];
  for (const row of inputs) {
    const result = await replayFrozenProjection(row.sample, row.target, row.spans);
    actual.push({model: row.model, ...result, node_text_matches: result.translated_text === row.expected.translated_text,
      node_display_matches: result.displayed === row.expected.displayed});
  }
  const fixtures = [];
  for (const row of frozenProjectionFixtures) {
    const result = await replayFrozenProjection(row, row.target, row.spans);
    fixtures.push({...result, expected_display_matches: row.displayed === result.displayed});
  }
  return {kind: "recorded-frozen-target-projection-firefox", translator_inference: false, aligner_inference: false,
    scope_semantics_automatically_proven: false, actual, manual_structure_fixtures: fixtures};
}
