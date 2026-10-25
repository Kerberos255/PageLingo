import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {parseArgs} from "node:util";
import {fixtureDom, projectRoot, qualityRuntime, readCases} from "./mt-quality-runtime.mjs";
import {releaseCases} from "../eval/mt-quality/release-v2.mjs";
const {values} = parseArgs({options: {out: {type: "string", default: "artifacts/mt-quality/research-v2-plan.json"}}});
const api = await qualityRuntime(), external = JSON.parse(await readFile(path.join(projectRoot, "eval/mt-quality/external/flores200-32.json"), "utf8"));
const cases = [...await readCases("eval/mt-quality/cases.json"), ...releaseCases(), ...external.cases];
const plan = {schema_version: 1, protocol: "BF16-production-prompt-unconstrained-v1", grammar_applied: false,
  provenance: "Frozen before candidate training. Existing diagnostic cases, 16 authored contrastive checks and 32 published FLORES-200 references. Never optimizer inputs.",
  external_sources: [external.source], cases, jobs: [], source_hashes: {}};
for (const sample of cases) {
  if (!["holdout", "diagnostic"].includes(sample.split)) throw new Error("Evaluation splits only");
  const dom = fixtureDom(sample.context_url);
  try {
    const p = api.prepareQualityCase(sample);
    for (const [unit, call] of api.qualityCallPlan(p.request).entries()) plan.jobs.push({key: `fixed/${sample.id}/${unit}`, case_id: sample.id,
      mode: "fixed", split: sample.split, unit, request: {messages: call.messages, max_tokens: call.max_tokens}, production_grammar: call.grammar});
    if (sample.split === "diagnostic") plan.jobs.push({key: `plain/${sample.id}/0`, case_id: sample.id, mode: "plain", split: sample.split, unit: 0,
      request: {messages: [{role: "user", content: "Translate the following English text into Simplified Chinese. Output only the translation.\n\n" + p.scope.textContent}], max_tokens: 512}});
  } finally {dom.window.close();}
}
for (const job of plan.jobs) job.request_sha256 = createHash("sha256").update(JSON.stringify(job.request)).digest("hex");
for (const file of ["eval/mt-quality/cases.json", "eval/mt-quality/release-v2.mjs", "eval/mt-quality/external/flores200-32.json",
  "eval/mt-quality/protocol.ts", "src/core/translation-quality.ts",
  "src/providers/pagelingo-mt/inference.ts", "src/providers/pagelingo-mt/fixed-text.ts", "src/providers/pagelingo-mt/word-ranges.ts",
  "src/providers/pagelingo-mt/sentence-plan.ts", "src/core/page-translator.ts", "src/core/rich-segment.ts"])
  plan.source_hashes[file] = createHash("sha256").update(await readFile(path.join(projectRoot, file))).digest("hex");
await mkdir(path.dirname(path.resolve(values.out)), {recursive: true});
await writeFile(values.out, JSON.stringify(plan, null, 2) + "\n");
console.log(JSON.stringify({cases: cases.length, jobs_per_model: plan.jobs.length, planned_bf16_generations: plan.jobs.length * 3, out: values.out}));
