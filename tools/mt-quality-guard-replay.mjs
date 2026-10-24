import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile, writeFile, mkdir} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {parseArgs} from "node:util";
import {fixtureDom, projectRoot, qualityRuntime, readCases} from "./mt-quality-runtime.mjs";

const {values} = parseArgs({options: {
  "before-root": {type: "string"}, input: {type: "string", multiple: true}, out: {type: "string"},
}});
if (!values["before-root"] || !values.input?.length || !values.out)
  throw new Error("Use --before-root FROZEN_CHECKOUT --input FIXED_RESULTS [--input ...] --out FILE");
const beforeRoot = path.resolve(values["before-root"]);
const beforeRuntime = await import(pathToFileURL(path.join(beforeRoot, "tools/mt-quality-runtime.mjs")).href);
const before = await beforeRuntime.qualityRuntime(), after = await qualityRuntime();
const cases = await readCases("eval/mt-quality/cases.json");
assert.deepEqual(JSON.parse(await readFile(path.join(beforeRoot, "eval/mt-quality/cases.json"), "utf8")).cases, cases,
  "Before/after corpora must be identical");
const hash = value => createHash("sha256").update(value).digest("hex");
const source = async root => Object.fromEntries(await Promise.all([
  "src/providers/pagelingo-mt/fixed-text.ts", "src/providers/pagelingo-mt/inference.ts",
  "src/providers/pagelingo-mt/sentence-plan.ts", "src/core/page-translator.ts", "src/core/rich-segment.ts",
].map(async file => [file, hash(await readFile(path.join(root, file)))])));
const result = {schema_version: 1, created_utc: new Date().toISOString(),
  scope: "Identical recorded Q5 outputs replayed through both production decoders/renderers; no new inference or performance measurement.",
  before: {root: beforeRoot, files: await source(beforeRoot)}, after: {root: projectRoot, files: await source(projectRoot)}, runs: []};
for (const input of values.input) {
  const raw = await readFile(input), run = JSON.parse(raw);
  assert.equal(run.mode, "fixed");
  const output = {model: run.model, input_sha256: hash(raw), cases: []};
  for (const recorded of run.cases) {
    assert.ok(!recorded.error, `${recorded.id}: failed inference cannot be replayed`);
    const sample = cases.find(row => row.id === recorded.id);
    assert.ok(sample, `Unknown case: ${recorded.id}`);
    const dom = fixtureDom(sample.context_url);
    try {
      const p = before.prepareQualityCase(sample), q = after.prepareQualityCase(sample);
      assert.deepEqual(p.request, recorded.request, `${sample.id}: recorded request changed`);
      assert.deepEqual(q.request, p.request, `${sample.id}: new production request changed`);
      const plan = before.qualityCallPlan(p.request);
      assert.deepEqual(after.qualityCallPlan(q.request), plan, `${sample.id}: call plan changed`);
      assert.equal(plan.length, recorded.completions.length);
      for (const [index, completion] of recorded.completions.entries()) {
        assert.equal(completion.grammar, plan[index].grammar);
        assert.equal(completion.budget, plan[index].max_tokens);
        assert.ok(completion.prompt.includes(plan[index].messages[0].content), "Recorded prompt differs from plan");
      }
      p.scope.remove(); q.scope.remove();
      const completions = recorded.completions.map(row => ({text: row.text, finish_reason: row.stop_type === "eos" ? "stop" : "length"}));
      const old = await before.replayQualityCase(sample, completions), updated = await after.replayQualityCase(sample, completions);
      assert.equal(old.displayed, recorded.displayed, `${sample.id}: baseline replay differs`);
      assert.equal(old.translated_html, recorded.translated_html, `${sample.id}: baseline HTML differs`);
      for (const replay of [old, updated]) {
        assert.ok(replay.original_structure_unchanged && replay.code_unchanged && replay.restored_exact,
          `${sample.id}: structure/code/restore failed`);
      }
      output.cases.push({id: sample.id, split: sample.split, call_plan_unchanged: true, before: old, after: updated});
    } finally {dom.window.close();}
  }
  output.summary = Object.fromEntries(["before", "after"].map(key => [key, {
    displayed: output.cases.filter(row => row[key].displayed).length,
    retained: output.cases.filter(row => !row[key].displayed).length,
    label_issues: output.cases.reduce((total, row) => total + row[key].label_issues.length, 0),
    structure_code_restore_passed: output.cases.length,
  }]));
  result.runs.push(output);
}
const out = path.resolve(values.out);
await mkdir(path.dirname(out), {recursive: true});
await writeFile(out, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result.runs.map(run => ({model: run.model, ...run.summary})), null, 2));
