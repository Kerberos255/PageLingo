import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {parseArgs} from "node:util";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";
import {projectRoot, fixtureDom} from "./mt-quality-runtime.mjs";
import {correctiveCases} from "../training/mt-fixed-slots/corrective-v5.mjs";
const {values} = parseArgs({options: {out: {type: "string", default: "artifacts/mt-quality/corrective-v5/evaluation-plan.json"}}});
const hash = raw => createHash("sha256").update(raw).digest("hex"), frozen = JSON.parse(await readFile(path.join(projectRoot, "artifacts/mt-quality/semantic-v4/evaluation-plan.json"), "utf8"));
for (const [name, digest] of Object.entries(frozen.source_hashes)) assert.equal(hash(await readFile(path.join(projectRoot, name))), digest, "Regenerate the v4 input plan first: " + name);
const cases = [...frozen.cases, ...correctiveCases().filter(c => c.split !== "train")];
assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
const directIds = new Set([...frozen.jobs.filter(j => j.mode === "direct").map(j => j.case_id), ...correctiveCases().filter(c => c.split === "holdout").map(c => c.id)]);
const runtime = path.join(projectRoot, "artifacts/mt-quality/corrective-plan-runtime.mjs");
await mkdir(path.dirname(runtime), {recursive: true});
await build({stdin: {contents: 'export * from "./eval/mt-quality/protocol.ts"; export * from "./eval/mt-quality/semantic-rewrite.ts";', resolveDir: projectRoot},
  bundle: true, platform: "node", format: "esm", outfile: runtime, logLevel: "silent"});
const api = await import(pathToFileURL(runtime).href + "?t=" + Date.now()), jobs = [];
for (const sample of cases) {
  const dom = fixtureDom(sample.context_url);
  try {
    const p = api.prepareQualityCase(sample);
    for (const [unit, call] of api.qualityCallPlan(p.request).entries()) jobs.push({key: `legacy/${sample.id}/${unit}`, case_id: sample.id, split: sample.split, mode: "legacy",
      request: {messages: call.messages, max_tokens: call.max_tokens}, production_grammar: call.grammar});
    if (directIds.has(sample.id)) {
      const encoded = api.prepareSemanticRewrite(p.request, p.segment.opaque);
      jobs.push({key: `natural/${sample.id}`, case_id: sample.id, split: sample.split, mode: "natural",
        request: {messages: [{role: "user", content: api.naturalTranslationPrompt(encoded)}], max_tokens: encoded.maxTokens}, production_grammar: null});
      jobs.push({key: `direct/${sample.id}`, case_id: sample.id, split: sample.split, mode: "direct",
        request: {messages: [{role: "user", content: api.semanticFixedPrompt(encoded)}], max_tokens: encoded.maxTokens}, production_grammar: encoded.grammar});
    }
    p.scope.remove();
  } finally {dom.window.close();}
}
for (const job of jobs) job.request_sha256 = hash(JSON.stringify(job.request));
const sourceFiles = [...Object.keys(frozen.source_hashes), "training/mt-fixed-slots/corrective-v5.mjs", "tools/mt-corrective-plan.mjs"];
const plan = {schema_version: 1, protocol: "BF16-corrective-fixed-v5", grammar_applied: false,
  scope: "Fixed-only corrective curriculum; four paired model arms; legacy/direct generations, natural diagnostics, no draft rewriting, no reference guide at inference, no automatic winner.",
  previous_plan_sha256: hash(await readFile(path.join(projectRoot, "artifacts/mt-quality/semantic-v4/evaluation-plan.json"))),
  cases, jobs, source_hashes: Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name, hash(await readFile(path.join(projectRoot, name)))])))};
await mkdir(path.dirname(path.resolve(values.out)), {recursive: true}); await writeFile(path.resolve(values.out), JSON.stringify(plan, null, 2) + "\n");
console.log(JSON.stringify({cases: cases.length, jobs_per_arm: jobs.length, direct_cases: directIds.size, maximum_generations: jobs.length * 4, rewrite_jobs: 0}));
