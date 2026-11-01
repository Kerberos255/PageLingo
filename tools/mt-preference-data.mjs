import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {parseArgs} from "node:util";
import {fixtureDom, projectRoot, qualityRuntime, readCases} from "./mt-quality-runtime.mjs";
import {preferenceCases, assertPreferenceReference} from "../training/mt-fixed-slots/preference-v6.mjs";
import {targetedCases as v2} from "../training/mt-fixed-slots/targeted-v2.mjs";
import {targetedCases as v3} from "../training/mt-fixed-slots/targeted-v3.mjs";
import {semanticCases} from "../training/mt-fixed-slots/semantic-v4.mjs";
import {correctiveCases} from "../training/mt-fixed-slots/corrective-v5.mjs";
import {releaseCases} from "../eval/mt-quality/release-v2.mjs";
const {values} = parseArgs({options: {out: {type: "string", default: "artifacts/mt-quality/preference-v6"}}});
const output = path.resolve(values.out), api = await qualityRuntime(), hash = raw => createHash("sha256").update(raw).digest("hex");
const pins = {train: "883f8496501c31d74ae7336defdc16ab53416321c7aa5ab740d3d2d11cb9f725", validation: "149401c637f721a54caaf6a5609cdaac1c237ba66e466ed2a997d9440549fc6d"};
const oldRows = {};
for (const split of ["train", "validation"]) {
  const raw = await readFile(path.join(projectRoot, "artifacts/mt-quality/targeted-v2", split + ".jsonl"));
  assert.equal(hash(raw), pins[split], "Replay must come from the exact old-r16 fixed-slot corpus");
  oldRows[split] = raw.toString().trim().split("\n").map(line => JSON.parse(line));
}
const forbidden = new Set(), forbiddenWire = new Set();
const excluded = [...v2(), ...v3(), ...semanticCases(), ...correctiveCases(), ...releaseCases(),
  ...await readCases("eval/mt-quality/cases.json"), ...await readCases("training/mt-fixed-slots/seed.json"), ...await readCases("eval/mt-quality/external/flores200-32.json")];
for (const sample of excluded) {
  const dom = fixtureDom(sample.context_url);
  try {const p = api.prepareQualityCase(sample); forbidden.add(api.canonicalSource(sample)); forbiddenWire.add(p.source); p.scope.remove();}
  finally {dom.window.close();}
}
const cases = preferenceCases(), rows = {train: [], validation: []}, sources = new Set(), wires = new Set(), families = new Map(), ids = new Set();
const counts = {train: 0, validation: 0, holdout: 0}, review = ["# v6 semantic preference references", "",
  "Assistant-authored/audited synthetic contrast sets; no independent human review. Both alternatives must decode with the exact production frame.",
  "Declared checks establish the intended minimal corruption, not a general automatic semantic-equivalence proof. Topic variants are correlated.", ""];
for (const sample of cases) {
  const dom = fixtureDom(sample.context_url);
  try {
    assertPreferenceReference(sample); assert.ok(!ids.has(sample.id)); ids.add(sample.id);
    const canonical = api.canonicalSource(sample); assert.ok(!forbidden.has(canonical) && !sources.has(canonical), sample.id + ": reused source"); sources.add(canonical);
    const p = api.prepareQualityCase(sample), negative = api.prepareQualityCase({...sample, reference_slots: sample.rejected_slots});
    assert.ok(!forbiddenWire.has(p.source) && !wires.has(p.source), sample.id + ": reused delexicalized input"); wires.add(p.source);
    assert.equal(p.prompt, negative.prompt); assert.notEqual(p.target, negative.target);
    const frame = text => text.match(/⟦\/?\d+⟧|⟪P\d+⟫/gu);
    assert.deepEqual(frame(p.target), frame(negative.target));
    const calls = api.qualityCallPlan(p.request); assert.equal(calls.length, 1); assert.equal(calls[0].messages[0].content, p.prompt);
    for (const target of [p.target, negative.target]) {
      const replay = await api.replayQualityCase(sample, [{text: target, finish_reason: "stop"}]);
      assert.ok(replay.displayed && replay.original_structure_unchanged && replay.code_unchanged && replay.restored_exact,
        sample.id + ": both alternatives must pass the actual production rendering path");
    }
    if (families.has(sample.family)) assert.equal(families.get(sample.family), sample.split); families.set(sample.family, sample.split); counts[sample.split]++;
    if (sample.split !== "holdout") rows[sample.split].push({id: sample.id, pair_id: sample.id, family: sample.family, split: sample.split,
      kind: "contrast", task: "fixed", prompt_variant: "legacy", source_html: sample.html, review_status: sample.review_status,
      semantic_contract: sample.semantic_contract, rejected_error: sample.rejected_error,
      messages: [{role: "user", content: p.prompt}, {role: "assistant", content: p.target}], rejected: negative.target});
    review.push(`## ${sample.id} (${sample.split})`, "", sample.html, "", sample.semantic_contract, "", "Chosen: " + p.target,
      "", "Rejected: " + negative.target, "", sample.rejected_error, "");
    p.scope.remove(); negative.scope.remove();
  } finally {dom.window.close();}
}
assert.deepEqual(counts, {train: 96, validation: 16, holdout: 16});
const replay = {train: [], validation: []};
for (const split of ["train", "validation"]) {
  const grouped = Map.groupBy(oldRows[split], row => row.family), groups = [...grouped.values()];
  const selected = split === "train" ? [...groups.map(g => g[0]), ...groups.slice(0, 36).map(g => g[1])] : groups.map(g => g[0]);
  assert.equal(selected.length, split === "train" ? 96 : 16);
  for (const original of selected) {
    assert.equal(original.split, split); const oldCase = v2().find(c => c.id === original.id); assert.ok(oldCase);
    const dom = fixtureDom(oldCase.context_url);
    try {
      const p = api.prepareQualityCase(oldCase); assert.equal(p.prompt, original.messages[0].content); assert.equal(p.target, original.messages[1].content); p.scope.remove();
    } finally {dom.window.close();}
    if (families.has(original.family)) assert.equal(families.get(original.family), split); families.set(original.family, split);
    replay[split].push({id: "v6-replay/" + original.id, pair_id: original.id, source_id: original.id, family: original.family, split,
      kind: "replay", task: "fixed", prompt_variant: "legacy", source_html: original.source_html, review_status: original.review_status,
      messages: original.messages, rejected: null});
  }
  assert.equal(rows[split].length, replay[split].length);
  rows[split] = rows[split].flatMap((row, index) => [row, replay[split][index]]);
}
const sourceFiles = ["training/mt-fixed-slots/preference-v6.mjs", "tools/mt-preference-data.mjs", "eval/mt-quality/protocol.ts",
  "src/providers/pagelingo-mt/fixed-text.ts", "src/core/rich-segment.ts", "src/core/dom-policy.ts", "src/core/fixed-text-render.ts", "src/core/translation-quality.ts",
  "training/mt-fixed-slots/targeted-v2.mjs", "training/mt-fixed-slots/targeted-v2b.mjs", "training/mt-fixed-slots/targeted-v3.mjs",
  "training/mt-fixed-slots/semantic-v4.mjs", "training/mt-fixed-slots/corrective-v5.mjs", "eval/mt-quality/cases.json", "training/mt-fixed-slots/seed.json",
  "eval/mt-quality/release-v2.mjs", "eval/mt-quality/external/flores200-32.json"];
const manifest = {schema_version: 1, corpus: "semantic-preference-v6", protocol: "production-fixed-text-v1", prompt_variant: "legacy",
  review_status: "assistant_audited_synthetic", independently_human_reviewed: false, new_case_counts: counts,
  replay_source_sha256: pins, replay_selection: "All 60 old train families' first row plus the first 36 families' second row; all 16 old validation families' first row. No old validation row trains.",
  source_hashes: Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name, hash(await readFile(path.join(projectRoot, name)))]))),
  checks: {both_alternatives_production_decode: true, both_alternatives_production_dom_replay: true, identical_marker_and_protected_sequence: true, new_sources_exclude_old_train_and_eval: true,
    new_delexicalized_inputs_unique: true, family_disjoint: true, replay_exact_old_training_only: true, no_reserved_main_pc_data_trains: true,
    semantic_equivalence_automatically_proven: false}, files: {}};
await mkdir(output, {recursive: true});
for (const split of ["train", "validation"]) {
  const raw = rows[split].map(row => JSON.stringify(row)).join("\n") + "\n", file = split + ".jsonl";
  await writeFile(path.join(output, file), raw); manifest.files[split] = {file, rows: rows[split].length, sha256: hash(raw),
    kinds: {contrast: rows[split].filter(r => r.kind === "contrast").length, replay: replay[split].length}};
}
const evalRaw = JSON.stringify({schema_version: 1, cases: cases.filter(c => c.split !== "train")}, null, 2) + "\n";
await writeFile(path.join(output, "evaluation-cases.json"), evalRaw);
manifest.evaluation_cases = {file: "evaluation-cases.json", rows: 32, sha256: hash(evalRaw), optimizer_input: false};
await writeFile(path.join(output, "reference-review.md"), review.join("\n"));
await writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({output, new_cases: counts, optimizer_rows: 192, validation_rows: 32, replay_rows: 96, both_references_decode: true}));
