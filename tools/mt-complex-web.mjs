import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile, writeFile, mkdir, readdir} from "node:fs/promises";
import path from "node:path";
import {parseArgs} from "node:util";
import {execFileSync} from "node:child_process";
import {projectRoot} from "./mt-quality-runtime.mjs";

const sha = s => createHash("sha256").update(s).digest("hex");
const read = async p => JSON.parse(await readFile(p, "utf8"));
async function write(p, value) {await mkdir(path.dirname(path.resolve(p)), {recursive: true}); await writeFile(p, JSON.stringify(value, null, 2) + "\n", {flag: "wx"});}
async function sourceFiles(directory) {
  return (await Promise.all((await readdir(path.join(projectRoot, directory), {withFileTypes: true})).map(e => e.isDirectory()
    ? sourceFiles(directory + "/" + e.name) : e.name.endsWith(".ts") ? [directory + "/" + e.name] : []))).flat();
}
const extraSources = ["eval/mt-quality/complex-web.ts", "eval/mt-quality/frozen-span-projection.ts", "eval/mt-quality/protocol.ts",
  "eval/mt-quality/semantic-rewrite.ts", "tools/mt-complex-web.mjs", "tools/mt-complex-web-firefox.py", "tools/mt-frozen-align.py",
  "tools/mt-sentence-native.py", "tools/mt-source-diagnostic-guard.py", "eval/mt-quality/external/complex-web-v10-sites.json"];
async function checkSources(plan) {
  for (const [name, expected] of Object.entries(plan.source_hashes)) {
    assert.equal(sha(await readFile(path.join(projectRoot, name))), expected, "Frozen source changed: " + name);
  }
}
async function checkRun(planPath, runPath) {
  const plan = await read(planPath), run = await read(runPath);
  await checkSources(plan); assert.equal(run.plan_sha256, sha(await readFile(planPath))); assert.ok(run.finished_utc);
  assert.equal(run.generations.length, plan.jobs.length);
  plan.jobs.forEach((j, i) => {const g = run.generations[i]; assert.equal(g.case_id, j.case_id);
    assert.equal(g.variant, j.variant); assert.equal(g.request_sha256, j.request_sha256);});
  return {plan, run};
}
async function plan(captureFile, previousFile, output, experiment) {
  const captured = await read(captureFile), previous = await read(previousFile);
  assert.equal(captured.mode, "capture"); assert.equal(captured.accept_insecure_certs, false); assert.ok(captured.finished_utc);
  const reserved = new Set(previous.cases.map(c => c.source_text.replace(/\s+/gu, " ").trim().toLowerCase()));
  const sources = new Set(), cases = [], excluded = [], jobs = [];
  for (const site of captured.sites) for (const c of site.captured?.cases ?? []) {
    if (!c.prepared) {excluded.push({id: c.id, reason: c.preparation_reason}); continue;}
    const normalized = c.source_text.replace(/\s+/gu, " ").trim().toLowerCase();
    assert.ok(!reserved.has(normalized), "Previously observed v8 source selected: " + c.id);
    if (sources.has(normalized)) {excluded.push({id: c.id, reason: "Repeated normalized owned source; no duplicate inference"}); continue;}
    sources.add(normalized);
    const sample = {...c, split: "diagnostic", group: "new_live_complex_web", meaning_reference: null,
      fixed_calls: c.fixed_calls.length, captured_fixed_calls: c.fixed_calls, natural_request: c.natural,
      context_check: false, optimizer_inputs_approved: false};
    const add = (variant, request) => jobs.push({case_id: c.id, variant, request, request_sha256: sha(JSON.stringify(request))});
    add("natural-visible", c.natural);
    c.fixed_calls.forEach((call, i) => add("production-fixed:" + i, call)); cases.push(sample);
  }
  const files = [...await sourceFiles("src"), ...extraSources];
  const result = {schema_version: 1, protocol: "source-format-diagnostic-v8", experiment,
    evaluation_only: true, optimizer_inputs_approved: false, source_commit: execFileSync("git", ["rev-parse", "HEAD"], {cwd: projectRoot, encoding: "utf8"}).trim(),
    capture_sha256: sha(await readFile(captureFile)), previous_v8_sha256: sha(await readFile(previousFile)),
    selection_review_before_any_inference: true, prior_capture_retained: true,
    sampling_notes: ["Initial source-only inventory exposed missing table strata; final capture adds one table cell where absent.",
      "RFC #content is only section 6.4, so final source selector uses body.",
      "Selected stress cases are not random webpage sampling or a blind human quality evaluation.",
      "Direct original DOM replay with recorded native completions; no Firefox model inference or installed extension integration."],
    source_hashes: Object.fromEntries(await Promise.all(files.map(async f => [f, sha(await readFile(path.join(projectRoot, f)))]))),
    selected_count: captured.sites.reduce((n, s) => n + (s.captured?.cases.length ?? 0), 0), excluded_before_inference: excluded, cases, jobs};
  await write(output, result); return {selected: result.selected_count, prepared: cases.length, excluded: excluded.length, jobs: jobs.length};
}
async function frozen(planPath, runPath, output) {
  const {plan, run} = await checkRun(planPath, runPath), cases = [], excluded = [];
  for (const c of plan.cases) {
    const g = run.generations.find(g => g.case_id === c.id && g.variant === "natural-visible"); assert.ok(g);
    if (!c.projection.supported || g.finish_reason !== "stop") {
      excluded.push({id: c.id, reason: c.projection.reason ?? "Natural translation did not reach EOS"}); continue;
    }
    cases.push({id: c.id, group: c.group, html: c.html, context_url: c.context_url, source_text: c.projection.source_text,
      frozen_target: g.text, target_sha256: sha(g.text), source_words: c.projection.source_words,
      target_words: [...new Intl.Segmenter("zh", {granularity: "word"}).segment(g.text)].filter(x => x.segment.trim())
        .map(x => ({text: x.segment, start: x.index, end: x.index + x.segment.length, lexical: x.isWordLike === true})),
      annotations: c.projection.annotations, natural_generation_request_sha256: g.request_sha256});
  }
  const result = {protocol: "frozen-target-span-projection-v9", experiment: "new-complex-live-web-v10", evaluation_only: true,
    optimizer_inputs_approved: false, translator: run.model, parent_plan_sha256: run.plan_sha256,
    natural_run_sha256: sha(await readFile(runPath)), source_hashes: plan.source_hashes,
    rules: {min_cosine: 0.55, projection: "mutual-argmax-word-pooling + Inside-Outside shortest-unique span",
      required_content_word_coverage: 1, source_articles_ignored_for_coverage: ["a", "an", "the"],
      original_nodes_attributes_code_order_and_listeners_required: true, frozen_target_rewriting_allowed: false}, excluded, cases};
  await write(output, result); return {cases: cases.length, excluded: excluded.length};
}
async function input(planPath, modelsPath, output) {
  const plan = await read(planPath), models = await read(modelsPath), inputs = [];
  for (const m of models) {
    const {run} = await checkRun(planPath, m.run);
    const frozen = await read(m.frozen_plan), aligned = await read(m.alignment);
    assert.equal(frozen.parent_plan_sha256, sha(await readFile(planPath)));
    assert.equal(frozen.natural_run_sha256, sha(await readFile(m.run)));
    assert.equal(aligned.plan_sha256, sha(await readFile(m.frozen_plan))); assert.ok(aligned.finished_utc);
    assert.equal(aligned.rows.length, frozen.cases.length);
    for (const c of plan.cases) {
      const base = {id: c.id, site_id: c.site_id, model: m.name, locator: c.locator, html: c.html, context_url: c.context_url,
        fixed_source: c.fixed_source, natural: c.natural_request, fixed_calls: c.captured_fixed_calls};
      const completions = run.generations.filter(g => g.case_id === c.id && g.variant.startsWith("production-fixed:"));
      inputs.push({...base, mode: "production", completions});
      const row = aligned.rows.find(r => r.id === c.id), target = run.generations.find(g => g.case_id === c.id && g.variant === "natural-visible");
      if (row) assert.equal(row.target_sha256, sha(target.text));
      inputs.push({...base, mode: "projection", target: target.text, spans: row?.spans ?? [],
        alignment_status: row?.status ?? "unsupported_source", alignment_reason: row?.reason ?? frozen.excluded.find(e => e.id === c.id)?.reason});
    }
  }
  await write(output, inputs); return {models: models.length, live_replay_inputs: inputs.length};
}
const {values} = parseArgs({options: {mode: {type: "string", default: "plan"}, capture: {type: "string"}, previous: {type: "string"},
  experiment: {type: "string", default: "new-complex-live-web-v10"},
  plan: {type: "string"}, run: {type: "string"}, models: {type: "string"}, out: {type: "string"}}});
const result = values.mode === "plan" ? await plan(values.capture, values.previous, values.out, values.experiment)
  : values.mode === "frozen" ? await frozen(values.plan, values.run, values.out)
  : values.mode === "input" ? await input(values.plan, values.models, values.out) : (() => {throw Error("Unknown mode");})();
console.log(JSON.stringify(result));
