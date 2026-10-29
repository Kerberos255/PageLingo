import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {parseArgs} from "node:util";
import {pathToFileURL} from "node:url";
import path from "node:path";
import {build} from "esbuild";
import {fixtureDom, projectRoot, readCases} from "./mt-quality-runtime.mjs";
import {semanticCases} from "../training/mt-fixed-slots/semantic-v4.mjs";
import {releaseCases} from "../eval/mt-quality/release-v2.mjs";
import {targetedCases} from "../training/mt-fixed-slots/targeted-v2.mjs";
const hash = raw => createHash("sha256").update(raw).digest("hex");
const {values} = parseArgs({options: {out: {type: "string", default: "artifacts/mt-quality/semantic-v4/evaluation-plan.json"}}});
const output = path.resolve(values.out), outfile = path.join(projectRoot, "artifacts/mt-quality/semantic-plan-runtime.mjs");
await mkdir(path.dirname(outfile), {recursive: true});
await build({stdin: {contents: ['export * from "./eval/mt-quality/protocol.ts";', 'export * from "./eval/mt-quality/semantic-rewrite.ts";'].join("\n"), resolveDir: projectRoot}, bundle: true, format: "esm", platform: "node", outfile, logLevel: "silent"});
const api = await import(pathToFileURL(outfile).href + "?t=" + Date.now());
const extraIds = new Set(["release-v2-handoff-order-before", "release-v2-handoff-order-after", "v2-hard-validation-check-before-connect-0",
  "v2-hard-validation-history-before-prune-0", "v2-hard-validation-after-exchange-0", "v2-hard-validation-stop-before-close-0"]);
const extra = [...releaseCases(), ...targetedCases().filter(c => c.split === "validation")].filter(c => extraIds.has(c.id));
assert.equal(extra.length, extraIds.size);
const cases = [...await readCases("eval/mt-quality/cases.json"), ...await readCases("eval/mt-quality/external/flores200-32.json"),
  ...semanticCases().filter(c => c.split !== "train"), ...extra.map(c => ({...c, original_split: c.split, split: "diagnostic"}))];
assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
const chainIds = new Set([...semanticCases().filter(c => c.split === "holdout").map(c => c.id), ...extraIds, "d-html-headings-05", "d-asyncio-task-04", "d-pythread-06"]);
const jobs = [];
for (const sample of cases) {
  const dom = fixtureDom(sample.context_url);
  try {
    const p = api.prepareQualityCase(sample);
    for (const [unit, call] of api.qualityCallPlan(p.request).entries()) jobs.push({key: `legacy/${sample.id}/${unit}`, case_id: sample.id, split: sample.split, mode: "legacy",
      request: {messages: call.messages, max_tokens: call.max_tokens}, production_grammar: call.grammar});
    if (chainIds.has(sample.id)) {
      const encoded = api.prepareSemanticRewrite(p.request, p.segment.opaque);
      jobs.push({key: `natural/${sample.id}`, case_id: sample.id, split: sample.split, mode: "natural",
        request: {messages: [{role: "user", content: api.naturalTranslationPrompt(encoded)}], max_tokens: encoded.maxTokens}, production_grammar: null});
      jobs.push({key: `direct/${sample.id}`, case_id: sample.id, split: sample.split, mode: "direct",
        request: {messages: [{role: "user", content: api.semanticFixedPrompt(encoded)}], max_tokens: encoded.maxTokens}, production_grammar: encoded.grammar});
      const sentinel = JSON.stringify("__PAGELINGO_ACTUAL_DRAFT_JSON__"), prompt = api.semanticFixedPrompt(encoded, "__PAGELINGO_ACTUAL_DRAFT_JSON__");
      const pieces = prompt.split(sentinel); assert.equal(pieces.length, 2);
      jobs.push({key: `rewrite/${sample.id}`, case_id: sample.id, split: sample.split, mode: "rewrite", draft_from_key: `natural/${sample.id}`,
        request_template: {prefix: pieces[0], suffix: pieces[1], max_tokens: encoded.maxTokens}, production_grammar: encoded.grammar});
    }
    p.scope.remove();
  } finally {dom.window.close();}
}
for (const job of jobs) job.request_sha256 = hash(JSON.stringify(job.request ?? job.request_template));
const sources = ["eval/mt-quality/protocol.ts", "eval/mt-quality/semantic-rewrite.ts", "training/mt-fixed-slots/semantic-v4.mjs", "tools/mt-semantic-plan.mjs",
  "src/providers/pagelingo-mt/fixed-text.ts", "src/providers/pagelingo-mt/sentence-plan.ts", "src/providers/pagelingo-mt/inference.ts", "src/providers/pagelingo-mt/word-ranges.ts",
  "src/core/dom-policy.ts", "src/core/translation-quality.ts", "src/core/page-translator.ts", "src/core/rich-segment.ts", "src/core/fixed-text-render.ts"];
const plan = {schema_version: 1, protocol: "BF16-semantic-multitask-v4", grammar_applied: false,
  scope: "Four paired model arms. Legacy production compatibility includes general reference regression. New direct/natural/own-draft chains use new heldout and known failures. No oracle guide is used for chain generations; validation reference NLL is separate. No automatic winner.",
  cases, jobs, source_hashes: Object.fromEntries(await Promise.all(sources.map(async f => [f, hash(await readFile(path.join(projectRoot, f)))])))};
await mkdir(path.dirname(output), {recursive: true}); await writeFile(output, JSON.stringify(plan, null, 2) + "\n");
console.log(JSON.stringify({output, cases: cases.length, jobs_per_model: jobs.length, chain_cases: chainIds.size, maximum_generations_four_models: jobs.length * 4}));
