import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {parseArgs} from "node:util";
import {fixtureDom, projectRoot, qualityRuntime} from "./mt-quality-runtime.mjs";
import {preferenceCases} from "../training/mt-fixed-slots/preference-v6.mjs";
const {values} = parseArgs({options: {out: {type: "string", default: "artifacts/mt-quality/preference-v6/evaluation-plan.json"}}});
const hash = value => createHash("sha256").update(value).digest("hex"), previous = await readFile(path.join(projectRoot, "artifacts/mt-quality/corrective-v5/evaluation-plan.json"));
const frozen = JSON.parse(previous); assert.equal(frozen.protocol, "BF16-corrective-fixed-v5");
for (const [name, digest] of Object.entries(frozen.source_hashes)) assert.equal(hash(await readFile(path.join(projectRoot, name))), digest, "Regenerate previous plan: " + name);
const extra = preferenceCases().filter(c => c.split !== "train"), cases = [...frozen.cases, ...extra], jobs = [...frozen.jobs], api = await qualityRuntime();
assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
for (const sample of extra) {
  const dom = fixtureDom(sample.context_url);
  try {
    const p = api.prepareQualityCase(sample);
    for (const [unit, call] of api.qualityCallPlan(p.request).entries()) jobs.push({key: `legacy/${sample.id}/${unit}`, case_id: sample.id,
      split: sample.split, mode: "legacy", request: {messages: call.messages, max_tokens: call.max_tokens}, production_grammar: call.grammar});
    p.scope.remove();
  } finally {dom.window.close();}
}
for (const job of jobs) job.request_sha256 = hash(JSON.stringify(job.request));
assert.equal(jobs.filter(j => j.mode === "rewrite").length, 0);
const sources = [...Object.keys(frozen.source_hashes), "training/mt-fixed-slots/preference-v6.mjs", "tools/mt-preference-plan.mjs"];
const plan = {schema_version: 1, protocol: "BF16-semantic-preference-v6", grammar_applied: false,
  scope: "Same frozen v5 legacy/direct/natural diagnostics plus 32 new nontraining semantic contrast sources under the unchanged production prompt. No negative/reference guide at generation; no rewrite or automatic selection.",
  previous_plan_sha256: hash(previous), cases, jobs,
  source_hashes: Object.fromEntries(await Promise.all(sources.map(async name => [name, hash(await readFile(path.join(projectRoot, name)))])))};
await mkdir(path.dirname(path.resolve(values.out)), {recursive: true}); await writeFile(path.resolve(values.out), JSON.stringify(plan, null, 2) + "\n");
console.log(JSON.stringify({cases: cases.length, jobs_per_arm: jobs.length, maximum_generations: jobs.length * 4, rewrite_jobs: 0}));
