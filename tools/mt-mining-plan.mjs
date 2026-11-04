import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {parseArgs} from "node:util";
import {fixtureDom, projectRoot, qualityRuntime, readCases} from "./mt-quality-runtime.mjs";
import {preferenceCases} from "../training/mt-fixed-slots/preference-v6.mjs";
import {correctiveCases} from "../training/mt-fixed-slots/corrective-v5.mjs";
import {semanticCases} from "../training/mt-fixed-slots/semantic-v4.mjs";
import {targetedCases as v2} from "../training/mt-fixed-slots/targeted-v2.mjs";
import {targetedCases as v3} from "../training/mt-fixed-slots/targeted-v3.mjs";
import {releaseCases} from "../eval/mt-quality/release-v2.mjs";

export function trainingMiningCases() {
  const selected = [];
  for (const [category, topicLimit] of [["temporal", 6], ["roles", 2], ["tool", 2], ["polarity", 1]]) {
    const groups = Map.groupBy(preferenceCases().filter(c => c.split === "train" && c.category === "semantic_preference_" + category), c => c.family);
    selected.push(...[...groups.values()].slice(0, topicLimit).flat());
  }
  const old = Map.groupBy(correctiveCases().filter(c => c.split === "train"), c => c.family);
  selected.push(...[...old.values()].flatMap(group => group.slice(0, 2)));
  assert.equal(selected.length, 76);
  return selected;
}

export async function exportMiningPlan(output) {
  const api = await qualityRuntime(), hash = value => createHash("sha256").update(value).digest("hex");
  const forbidden = new Set(), forbiddenWire = new Set();
  const reserved = [...v2().filter(c => c.split !== "train"), ...v3().filter(c => c.split !== "train"), ...semanticCases().filter(c => c.split !== "train"),
    ...correctiveCases().filter(c => c.split !== "train"), ...preferenceCases().filter(c => c.split !== "train"), ...releaseCases(),
    ...await readCases("eval/mt-quality/cases.json"), ...await readCases("training/mt-fixed-slots/seed.json"), ...await readCases("eval/mt-quality/external/flores200-32.json")];
  for (const sample of reserved) {
    const dom = fixtureDom(sample.context_url);
    try {const p = api.prepareQualityCase(sample); forbidden.add(api.canonicalSource(sample)); forbiddenWire.add(p.source); p.scope.remove();}
    finally {dom.window.close();}
  }
  const ids = new Set(), sources = new Set(), wires = new Set(), cases = [], jobs = [];
  for (const sample of trainingMiningCases()) {
    const dom = fixtureDom(sample.context_url);
    try {
      assert.equal(sample.split, "train"); assert.ok(!ids.has(sample.id)); ids.add(sample.id);
      const source = api.canonicalSource(sample); assert.ok(!forbidden.has(source) && !sources.has(source), "Reserved/repeated source: " + sample.id); sources.add(source);
      const p = api.prepareQualityCase(sample), calls = api.qualityCallPlan(p.request);
      assert.equal(calls.length, 1); assert.equal(calls[0].messages[0].content, p.prompt);
      assert.ok(!forbiddenWire.has(p.source) && !wires.has(p.source), "Reserved/repeated model-visible input: " + sample.id); wires.add(p.source);
      // No authored negative enters mining: the rejected candidate must be an actual generation.
      const {rejected_slots, semantic_checks, ...positive} = sample;
      cases.push({...positive, reference_wire: p.target, model_visible_source: p.source});
      const request = {messages: calls[0].messages, max_tokens: calls[0].max_tokens, grammar: calls[0].grammar};
      jobs.push({case_id: sample.id, split: "train", family: sample.family, variant: "production-grammar",
        request, request_sha256: hash(JSON.stringify(request))});
      p.scope.remove();
    } finally {dom.window.close();}
  }
  const files = ["tools/mt-mining-plan.mjs", "tools/mt-sentence-native.py", "tools/mt_mining_guard.py", "eval/mt-quality/protocol.ts", "src/core/dom-policy.ts", "src/core/rich-segment.ts",
    "src/providers/pagelingo-mt/fixed-text.ts", "src/providers/pagelingo-mt/sentence-plan.ts", "src/core/translation-quality.ts",
    "src/core/page-translator.ts", "src/core/fixed-text-render.ts", "training/mt-fixed-slots/preference-v6.mjs", "training/mt-fixed-slots/corrective-v5.mjs",
    "training/mt-fixed-slots/semantic-v4.mjs", "training/mt-fixed-slots/targeted-v2.mjs", "training/mt-fixed-slots/targeted-v3.mjs",
    "training/mt-fixed-slots/seed.json", "eval/mt-quality/cases.json", "eval/mt-quality/external/flores200-32.json", "eval/mt-quality/release-v2.mjs"];
  const plan = {schema_version: 1, protocol: "fixed-training-error-mining-v1", purpose: "Training-source error mining only; no model quality score or optimization.",
    grammar_applied: true, heldout_sources_in_jobs: false, independently_human_reviewed: false,
    source_hashes: Object.fromEntries(await Promise.all(files.map(async name => [name, hash(await readFile(path.join(projectRoot, name)))]))),
    cases, jobs};
  await mkdir(path.dirname(path.resolve(output)), {recursive: true}); await writeFile(output, JSON.stringify(plan, null, 2) + "\n");
  return {cases: cases.length, jobs: jobs.length, source_training_only: true, grammar_applied: true, optimizer_executed: false};
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const {values} = parseArgs({options: {out: {type: "string", default: "artifacts/mt-quality/mining-v7/plan.json"}}});
  console.log(JSON.stringify(await exportMiningPlan(values.out)));
}
