import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {parseArgs} from "node:util";
import {fixtureDom, projectRoot, qualityRuntime, readCases} from "./mt-quality-runtime.mjs";

const {values} = parseArgs({options: {out: {type: "string", default: "artifacts/mt-quality/gpu-evaluation-plan.json"}}});
const api = await qualityRuntime();
const cases = await readCases("eval/mt-quality/cases.json");
const plan = {schema_version: 1, protocol: "BF16-production-prompt-unconstrained-v1", grammar_applied: false,
  provenance: "Assistant-authored references; review pending. Diagnostics selected from known failures. No optimizer inputs.",
  cases, jobs: [], source_hashes: {}};
for (const sample of cases) {
  if (!["holdout", "diagnostic"].includes(sample.split)) throw new Error("Only evaluation splits allowed");
  const dom = fixtureDom(sample.context_url);
  try {
    const p = api.prepareQualityCase(sample);
    const calls = api.qualityCallPlan(p.request);
    for (const [unit, call] of calls.entries()) plan.jobs.push({key: `fixed/${sample.id}/${unit}`, case_id: sample.id,
      mode: "fixed", split: sample.split, unit, request: {messages: call.messages, max_tokens: call.max_tokens},
      production_grammar: call.grammar});
    if (sample.split === "diagnostic") plan.jobs.push({key: `plain/${sample.id}/0`, case_id: sample.id,
      mode: "plain", split: sample.split, unit: 0, request: {messages: [{role: "user", content:
        "Translate the following English text into Simplified Chinese. Output only the translation.\n\n" + p.scope.textContent}], max_tokens: 512}});
  } finally {dom.window.close();}
}
for (const job of plan.jobs) job.request_sha256 = createHash("sha256").update(JSON.stringify(job.request)).digest("hex");
for (const name of ["eval/mt-quality/cases.json", "src/providers/pagelingo-mt/inference.ts", "src/providers/pagelingo-mt/fixed-text.ts", "src/providers/pagelingo-mt/sentence-plan.ts", "src/core/page-translator.ts", "src/core/rich-segment.ts"])
  plan.source_hashes[name] = createHash("sha256").update(await readFile(path.join(projectRoot, name))).digest("hex");
await mkdir(path.dirname(path.resolve(values.out)), {recursive: true});
await writeFile(values.out, JSON.stringify(plan, null, 2) + "\n");
console.log(JSON.stringify({out: values.out, cases: cases.length, fixed_calls: plan.jobs.filter(x => x.mode === "fixed").length,
  plain_calls: plan.jobs.filter(x => x.mode === "plain").length, total_generations_for_three_models: plan.jobs.length * 3, grammar_applied: false}));
