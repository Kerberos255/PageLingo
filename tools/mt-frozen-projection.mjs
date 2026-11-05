import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile, writeFile, mkdir} from "node:fs/promises";
import {parseArgs} from "node:util";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";
import {fixtureDom, projectRoot} from "./mt-quality-runtime.mjs";

const sha = s => createHash("sha256").update(s).digest("hex");
const read = async p => JSON.parse(await readFile(p, "utf8"));
async function runtime() {
  const outfile = path.join(projectRoot, "artifacts/mt-quality/frozen-projection.mjs");
  await mkdir(path.dirname(outfile), {recursive: true});
  await build({stdin: {contents: 'export * from "./eval/mt-quality/frozen-span-projection.ts";\nexport * from "./eval/mt-quality/source-diagnostic.ts";', resolveDir: projectRoot},
    bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent"});
  return import(pathToFileURL(outfile).href + "?t=" + Date.now());
}
const words = (text, language) => [...new Intl.Segmenter(language, {granularity: "word"}).segment(text)]
  .filter(x => x.segment.trim()).map(x => ({text: x.segment, start: x.index, end: x.index + x.segment.length, lexical: x.isWordLike === true}));
async function exportPlan(input, output) {
  const api = await runtime(), old = await read(path.join(input, "plan-final.json")), run = await read(path.join(input, "old_r16_q5/run.json"));
  assert.equal(old.protocol, "source-format-diagnostic-v8"); assert.ok(run.finished_utc);
  assert.equal(run.plan_sha256, sha(await readFile(path.join(input, "plan-final.json"))));
  assert.equal(run.model.sha256, "748c66dee23ec95583d0c84bd49bd3e516b0d2c1d242fbf4e152ff710e0f62bb");
  assert.equal(run.generations.length, old.jobs.length);
  old.jobs.forEach((j, i) => {assert.equal(run.generations[i].case_id, j.case_id); assert.equal(run.generations[i].variant, j.variant);
    assert.equal(run.generations[i].request_sha256, sha(JSON.stringify(j.request)));});
  const cases = [];
  for (const sample of old.cases) {
    const target = run.generations.find(g => g.case_id === sample.id && g.variant === "natural-visible");
    assert.ok(target && target.finish_reason === "stop");
    const dom = fixtureDom(sample.context_url);
    try {
      const p = api.prepareSourceDiagnostic(sample), source = api.captureFrozenSource(p.root);
      assert.equal(source.sourceText, p.semantic.sourceText, "Visible source differs from captured natural input");
      const annotations = source.annotations.map(({node, ...a}) => a);
      cases.push({id: sample.id, group: sample.group, html: sample.html, context_url: sample.context_url,
        source_text: source.sourceText, frozen_target: target.text, target_sha256: sha(target.text),
        source_words: words(source.sourceText, "en"), target_words: words(target.text, "zh"), annotations,
        natural_generation_request_sha256: target.request_sha256});
      p.scope.remove();
    } finally {dom.window.close();}
  }
  const files = ["eval/mt-quality/frozen-span-projection.ts", "tools/mt-frozen-projection.mjs", "tools/mt-frozen-align.py",
    "eval/mt-quality/frozen-projection-fixtures.ts", "eval/mt-quality/browser-frozen-projection.ts",
    "src/core/fixed-text-render.ts", "src/core/translation-quality.ts", "src/core/render.ts"];
  const plan = {protocol: "frozen-target-span-projection-v9", evaluation_only: true, optimizer_inputs_approved: false,
    parent_v8_plan_sha256: run.plan_sha256, natural_run_sha256: sha(await readFile(path.join(input, "old_r16_q5/run.json"))),
    translator: run.model, source_commit: "19de7a2b0bf03f05076d4905970dd101414bec50",
    rules: {min_cosine: 0.55, projection: "mutual-argmax-word-pooling + Inside-Outside shortest-unique span",
      required_content_word_coverage: 1, source_articles_ignored_for_coverage: ["a", "an", "the"],
      original_nodes_attributes_code_order_and_listeners_required: true, frozen_target_rewriting_allowed: false},
    source_hashes: Object.fromEntries(await Promise.all(files.map(async name => [name, sha(await readFile(path.join(projectRoot, name)))]))), cases};
  await mkdir(path.dirname(path.resolve(output)), {recursive: true}); await writeFile(output, JSON.stringify(plan, null, 2) + "\n");
  return {cases: cases.length, frozen_prior_translations: true, new_translation_generations: 0};
}
async function replay(planFile, runFile, output) {
  const api = await runtime(), plan = await read(planFile), run = await read(runFile);
  assert.equal(run.plan_sha256, sha(await readFile(planFile))); assert.ok(run.finished_utc);
  assert.equal(run.rows.length, plan.cases.length);
  for (const [name, expected] of Object.entries(plan.source_hashes)) assert.equal(sha(await readFile(path.join(projectRoot, name))), expected);
  const results = [];
  for (let i = 0; i < plan.cases.length; i++) {
    const sample = plan.cases[i], row = run.rows[i]; assert.equal(row.id, sample.id);
    assert.equal(row.target_sha256, sample.target_sha256);
    const dom = fixtureDom(sample.context_url);
    try {
      const spans = row.status === "projected" ? row.spans : [];
      const result = await api.replayFrozenProjection(sample, sample.frozen_target, spans);
      if (row.status !== "projected") assert.equal(result.displayed, false);
      results.push({...result, alignment_status: row.status, alignment_reason: row.reason ?? null, group: sample.group});
    } finally {dom.window.close();}
  }
  const result = {protocol: plan.protocol, plan_sha256: run.plan_sha256, alignment_run_sha256: sha(await readFile(runFile)),
    automatic_scope_correctness: "Requires separate range audit; structural admission is not semantic proof.", results};
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  return {cases: results.length, displayed: results.filter(x => x.displayed).length,
    frozen_text_exact_when_displayed: results.filter(x => x.displayed).every(x => x.frozen_target_exact),
    structure_code_links_restore: results.every(x => x.original_structure_unchanged && x.code_unchanged && x.original_link_listeners_preserved && x.restored_exact)};
}
const {values} = parseArgs({options: {mode: {type: "string", default: "plan"}, input: {type: "string"}, plan: {type: "string"}, run: {type: "string"}, out: {type: "string"}}});
console.log(JSON.stringify(values.mode === "plan" ? await exportPlan(values.input, values.out) : await replay(values.plan, values.run, values.out)));
