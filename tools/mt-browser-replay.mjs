// Compare a new decoder against recorded browser outputs, verifying actual inputs first.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {parseArgs} from "node:util";
import {fixtureDom, qualityRuntime} from "./mt-quality-runtime.mjs";
const {values} = parseArgs({options: {results: {type: "string"}, plan: {type: "string"}, out: {type: "string"}}});
if (!values.results || !values.plan || !values.out) throw new Error("Use --results FILE --plan FILE --out FILE");
const raw = await readFile(values.results), original = JSON.parse(raw), planRaw = await readFile(values.plan), plan = JSON.parse(planRaw);
assert.equal(original.plan_sha256, createHash("sha256").update(planRaw).digest("hex"));
assert.ok(original.completed && !original.failures.length);
const api = await qualityRuntime(), rows = [];
for (const recorded of original.audit.cases) {
  const sample = plan.cases.find(c => c.id === recorded.id); assert.ok(sample);
  const dom = fixtureDom(sample.context_url);
  try {
    const p = api.prepareQualityCase(sample), calls = api.qualityCallPlan(p.request); p.scope.remove();
    assert.equal(calls.length, recorded.calls.length);
    for (const [index, call] of calls.entries()) {
      assert.deepEqual(call.messages, recorded.calls[index].messages);
      assert.equal(call.grammar, recorded.calls[index].grammar);
      assert.equal(call.max_tokens, recorded.calls[index].budget);
    }
    const after = await api.replayQualityCase(sample, recorded.calls.map(c => ({text: c.text, finish_reason: c.finish_reason})));
    assert.ok(after.original_structure_unchanged && after.code_unchanged && after.restored_exact);
    rows.push({id: sample.id, call_plan_unchanged: true, before: {displayed: recorded.displayed, translated_text: recorded.translated_text}, after});
  } finally {dom.window.close();}
}
await mkdir(path.dirname(path.resolve(values.out)), {recursive: true});
await writeFile(values.out, JSON.stringify({scope: "Recorded real Firefox outputs; identical messages, grammar and budgets; decoder/rendering replay only, no new inference.",
  raw_sha256: createHash("sha256").update(raw).digest("hex"), cases: rows}, null, 2) + "\n");
console.log(JSON.stringify(rows.map(c => ({id: c.id, before: c.before.displayed, after: c.after.displayed, reason: c.after.reason}))));
