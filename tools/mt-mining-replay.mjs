import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {parseArgs} from "node:util";
import {fixtureDom, projectRoot, qualityRuntime} from "./mt-quality-runtime.mjs";
const {values} = parseArgs({options: {plan: {type: "string"}, run: {type: "string"}, out: {type: "string"}, partial: {type: "boolean", default: false}}});
assert.ok(values.plan && values.run && values.out, "Use --plan frozen-plan --run actual-native-run --out new-report");
const hash = b => createHash("sha256").update(b).digest("hex"), rawPlan = await readFile(values.plan), plan = JSON.parse(rawPlan), rawRun = await readFile(values.run), run = JSON.parse(rawRun);
assert.equal(plan.protocol, "fixed-training-error-mining-v1"); assert.equal(run.protocol, plan.protocol); assert.equal(run.plan_sha256, hash(rawPlan));
assert.equal(plan.heldout_sources_in_jobs, false); assert.equal(plan.grammar_applied, true); assert.ok(plan.cases.every(c => c.split === "train"));
if (!values.partial) assert.ok(run.finished_utc && run.generations.length === plan.jobs.length, "Mining run must finish before final curation");
for (const [name, digest] of Object.entries(plan.source_hashes)) assert.equal(hash(await readFile(path.join(projectRoot, name))), digest, "Frozen source changed: " + name);
const api = await qualityRuntime(), rows = [], seen = new Set();
for (const generation of run.generations) {
  assert.ok(!seen.has(generation.case_id)); seen.add(generation.case_id);
  const sample = plan.cases.find(c => c.id === generation.case_id), job = plan.jobs.find(j => j.case_id === generation.case_id);
  assert.ok(sample && job); assert.equal(sample.split, "train"); assert.equal(job.split, "train");
  assert.equal(generation.request_sha256, job.request_sha256); assert.ok(job.request.grammar);
  const dom = fixtureDom(sample.context_url);
  try {
    const p = api.prepareQualityCase(sample);
    assert.equal(p.source, sample.model_visible_source); assert.equal(p.target, sample.reference_wire);
    assert.equal(p.prompt, job.request.messages[0].content); assert.equal(p.grammar, job.request.grammar);
    const reference = new DOMParser().parseFromString(p.referenceHtml, "text/html").body;
    const referenceText = (reference.textContent ?? "").replace(/__FLT_OPAQUE_(\d+)__/gu, (_whole, id) => p.segment.opaque[Number(id)].text)
      .replace(/__FLT_LINK_(?:START|END)_\d+__/gu, "");
    const labelTags = "a,em,strong,b,i,mark";
    const sourceLabels = [...p.root.querySelectorAll(labelTags)].map(n => ({tag: n.tagName, text: n.textContent}));
    p.scope.remove();
    const replay = await api.replayQualityCase(sample, [{text: generation.text, finish_reason: generation.finish_reason}]);
    assert.ok(replay.original_structure_unchanged && replay.code_unchanged && replay.restored_exact);
    const translated = new DOMParser().parseFromString(replay.translated_html, "text/html").body;
    rows.push({id: sample.id, split: "train", family: sample.family, source_html: sample.html,
      reference_wire: sample.reference_wire, actual_output: generation.text, actual_output_sha256: hash(generation.text),
      reference_text: referenceText, source_labels: sourceLabels,
      translated_labels: [...translated.querySelectorAll(labelTags)].map(n => ({tag: n.tagName, text: n.textContent})),
      semantic_verdict: "unreviewed", different_from_reference: generation.text !== sample.reference_wire,
      generation, replay, note: "Different wording is not a semantic error. Manual factual/scope audit is required before a pair can train."});
  } finally {dom.window.close();}
}
const result = {schema_version: 1, scope: "Training-source actual-output curation; not a model quality test or independent human review.",
  plan_sha256: hash(rawPlan), run_sha256: hash(rawRun), model: run.model, partial: values.partial, independently_human_reviewed: false,
  optimizer_inputs_approved: false, actual_generations: rows.length, displayed: rows.filter(r => r.replay.displayed).length,
  original_structure_code_and_restore_all_passed: true, rows};
await mkdir(path.dirname(path.resolve(values.out)), {recursive: true}); await writeFile(values.out, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({actual_generations: rows.length, displayed: result.displayed, partial: values.partial, semantic_errors_automatically_assumed: false}));
