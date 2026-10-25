import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {parseArgs} from "node:util";
import {fixtureDom, projectRoot, qualityRuntime} from "./mt-quality-runtime.mjs";
const {values} = parseArgs({options: {results: {type: "string"}, plan: {type: "string"}, out: {type: "string"},
  "allow-decoder-only": {type: "boolean", default: false}}});
if (!values.results || !values.plan || !values.out) throw new Error("Use --results DIR --plan FILE --out FILE");
const hash = raw => createHash("sha256").update(raw).digest("hex");
const planRaw = await readFile(values.plan), plan = JSON.parse(planRaw);
const manifest = JSON.parse(await readFile(path.join(values.results, "runs.json"), "utf8"));
assert.ok(manifest.finished_utc && manifest.protocol === "Q5-production-grammar-v2" && manifest.grammar_applied);
assert.equal(manifest.plan_sha256, hash(planRaw));
const sourceChanges = {}, replaySourceHashes = {};
for (const [file, digest] of Object.entries(plan.source_hashes)) {
  const actual = hash(await readFile(path.join(projectRoot, file))); replaySourceHashes[file] = actual;
  if (actual !== digest) {
    assert.ok(values["allow-decoder-only"] && file === "src/providers/pagelingo-mt/fixed-text.ts", "Source changed: " + file);
    sourceChanges[file] = {recorded: digest, replayed: actual};
  }
}
const labels = manifest.models.map(m => m.label), models = {}, jobs = plan.jobs.filter(j => j.mode === "fixed");
for (const label of labels) {
  assert.match(label, /^[A-Za-z0-9_-]+$/);
  const record = manifest.files[label]; assert.equal(record.file, label + ".json");
  const raw = await readFile(path.join(values.results, record.file)); assert.equal(hash(raw), record.sha256);
  const value = JSON.parse(raw); assert.ok(value.finished_utc && value.token_check.passed);
  assert.equal(value.generations.length, jobs.length);
  const index = new Map(value.generations.map(row => [row.key, row])); assert.equal(index.size, jobs.length);
  for (const job of jobs) {
    const row = index.get(job.key); assert.ok(row);
    assert.equal(row.request_sha256, job.request_sha256); assert.equal(row.grammar_sha256, hash(job.production_grammar));
    assert.equal(row.max_tokens, job.request.max_tokens);
  }
  models[label] = {value, index};
}
for (const job of jobs) for (const label of labels)
  assert.equal(models[label].index.get(job.key).actual_prompt_sha256, models[labels[0]].index.get(job.key).actual_prompt_sha256);
const api = await qualityRuntime(), cases = [];
for (const sample of plan.cases) {
  const dom = fixtureDom(sample.context_url);
  try {
    const selected = jobs.filter(j => j.case_id === sample.id).sort((a, b) => a.unit - b.unit);
    const prepared = api.prepareQualityCase(sample), actual = api.qualityCallPlan(prepared.request);
    assert.deepEqual(actual.map(c => ({messages: c.messages, max_tokens: c.max_tokens, grammar: c.grammar})),
      selected.map(j => ({...j.request, grammar: j.production_grammar})), "Production call changed: " + sample.id);
    prepared.scope.remove();
    const row = {id: sample.id, category: sample.category, semantic_contract: sample.semantic_contract ?? null,
      reference_status: sample.review_status, probes_declared: sample.probes.length, models: {}};
    for (const label of labels) row.models[label] = await api.replayQualityCase(sample, selected.map(j => models[label].index.get(j.key)));
    cases.push(row);
  } finally {dom.window.close();}
}
await mkdir(path.dirname(path.resolve(values.out)), {recursive: true});
await writeFile(values.out, JSON.stringify({scope: "Actual native GGUF/grammar outputs replayed through hash-locked production validation and renderer. Model identities distinguish Q5 from any unquantized diagnostic arm. Display counts are not semantic accuracy.",
  identities: manifest.models, source_hashes: plan.source_hashes, replay_source_hashes: replaySourceHashes,
  decoder_only_replay: values["allow-decoder-only"], source_changes: sourceChanges, cases}, null, 2) + "\n");
console.log(JSON.stringify(labels.map(label => ({label, displayed: cases.filter(c => c.models[label].displayed).length,
  cases: cases.length, dom_code_restore: cases.filter(c => c.models[label].original_structure_unchanged && c.models[label].code_unchanged && c.models[label].restored_exact).length}))));
