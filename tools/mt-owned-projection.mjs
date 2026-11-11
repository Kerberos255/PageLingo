import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile, writeFile, mkdir, readdir} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {parseArgs} from "node:util";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";
import {projectRoot} from "./mt-quality-runtime.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const read = async p => JSON.parse(await readFile(p, "utf8"));
async function write(p, value) {await mkdir(path.dirname(path.resolve(p)), {recursive: true}); await writeFile(p, JSON.stringify(value, null, 2) + "\n", {flag: "wx"});}
async function filesIn(dir) {return (await Promise.all((await readdir(path.join(projectRoot, dir), {withFileTypes: true})).map(e => e.isDirectory()
  ? filesIn(dir + "/" + e.name) : e.name.endsWith(".ts") ? [dir + "/" + e.name] : []))).flat();}
const files = ["eval/mt-quality/owned-projection.ts", "eval/mt-quality/browser-owned-projection.ts", "eval/mt-quality/semantic-rewrite.ts",
  "eval/mt-quality/complex-web.ts", "tools/mt-owned-projection.mjs", "tools/mt-owned-projection-firefox.py", "tools/mt_public_firefox.py",
  "tools/mt-frozen-align.py", "tools/mt_owned_projection.py"];
async function runtime() {
  const outfile = path.join(projectRoot, "artifacts/mt-quality/owned-projection.mjs"); await mkdir(path.dirname(outfile), {recursive: true});
  await build({entryPoints: [path.join(projectRoot, "eval/mt-quality/owned-projection.ts")], bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent"});
  return import(pathToFileURL(outfile).href + "?t=" + Date.now());
}
async function checkSources(plan) {for (const [file, expected] of Object.entries(plan.source_hashes)) assert.equal(sha(await readFile(path.join(projectRoot, file))), expected, file);}
async function plan(parentFile, captureFile, nativeFile, output) {
  const parent = await read(parentFile), capture = await read(captureFile), native = await read(nativeFile), api = await runtime();
  assert.equal(parent.protocol, "source-format-diagnostic-v8"); assert.equal(parent.optimizer_inputs_approved, false);
  assert.equal(capture.mode, "capture"); assert.equal(capture.accept_insecure_certs, false); assert.ok(capture.finished_utc && !capture.site_errors.length);
  assert.equal(capture.parent_plan_sha256, sha(await readFile(parentFile)));
  assert.equal(native.plan_sha256, sha(await readFile(parentFile))); assert.ok(native.finished_utc);
  assert.ok(["8f8734198ad9332db97101de3ae7216daa3b59218522c4e0beebdfb4999924cc", "748c66dee23ec95583d0c84bd49bd3e516b0d2c1d242fbf4e152ff710e0f62bb"].includes(native.model.sha256));
  assert.equal(native.generations.length, parent.jobs.length);
  parent.jobs.forEach((j, i) => {const g = native.generations[i]; assert.equal(g.case_id, j.case_id); assert.equal(g.variant, j.variant);
    assert.equal(g.request_sha256, j.request_sha256); assert.equal(g.request_sha256, sha(JSON.stringify(j.request)));});
  const captured = capture.sites.flatMap(s => s.results), cases = [], excluded = [], candidate_refusals = [], source_cases = [];
  assert.equal(captured.length, parent.cases.length);
  for (const old of parent.cases) {
    const c = captured.find(c => c.id === old.id); assert.ok(c);
    if (c.status !== "supported" || !c.cached_natural_request_matches) {
      excluded.push({id: old.id, status: c.status, reason: c.reason ?? "Cached natural request differs; no previous target reuse"}); continue;
    }
    assert.ok(c.wire_unchanged_by_trace);
    const natural = native.generations.find(g => g.case_id === old.id && g.variant === "natural-visible"); assert.ok(natural);
    const candidate = {text: natural.text, finish_reason: natural.finish_reason};
    const base = {id: old.id, site_id: old.site_id, locator: old.locator, context_url: c.url, html: c.html,
      source_text: c.source_text, source_words: c.source_words, annotations: c.annotations, source_contract: c.source_contract,
      natural_request: c.natural_request, punctuation_policy: c.punctuation_policy ?? "strict", whitespace_policy: c.whitespace_policy ?? "literal", allocation_policy: c.allocation_policy ?? "fixed", scope_policy: c.scope_policy ?? "alignment-v1", candidate, frozen_target: natural.text, target_sha256: sha(natural.text),
      request_sha256: natural.request_sha256, group: "recorded_translation_rebound_to_current_owned_source",
      prior_experiment: parent.experiment ?? null, prior_group: old.group ?? null};
    source_cases.push(base);
    try {
      const quality = api.assessOwnedCandidate({sourceText: c.source_text, annotations: c.annotations}, candidate);
      cases.push({...base, candidate_quality: quality.quality,
        ...(c.scope_policy && c.scope_policy !== "alignment-v1" ? {scope_constraints: api.deriveSourceScopeConstraints(c.source_text, c.annotations, natural.text, quality.immutable)} : {}),
        target_words: [...new Intl.Segmenter("zh", {granularity: "word"}).segment(natural.text)].filter(x => x.segment.trim())
          .map(x => ({text: x.segment, start: x.index, end: x.index + x.segment.length, lexical: x.isWordLike === true}))});
    } catch (error) {candidate_refusals.push({id: old.id, reason: String(error), target_sha256: base.target_sha256});}
  }
  const paths = [...new Set([...await filesIn("src"), ...await filesIn("eval/mt-quality"), ...files])];
  const typedPunctuation = capture.punctuation_policy === "prose-v1";
  const collapseWhitespace = capture.whitespace_policy === "collapse-v1";
  const proseGaps = capture.allocation_policy === "prose-gaps-v1";
  const constrainedScope = ["source-constraints-v1", "source-constraints-v2"].includes(capture.scope_policy);
  const relatedConcepts = capture.scope_policy === "source-constraints-v2";
  const result = {protocol: relatedConcepts ? "source-constrained-projection-v16" : constrainedScope ? "source-constrained-projection-v15" : proseGaps ? "frozen-prose-gaps-v14" : collapseWhitespace ? "collapsible-whitespace-projection-v13" : typedPunctuation ? "typed-punctuation-projection-v12" : "production-owned-projection-v11", evaluation_only: true, optimizer_inputs_approved: false,
    production_enabled: false, new_translation_generations: 0, source_commit: execFileSync("git", ["rev-parse", "HEAD"], {cwd: projectRoot, encoding: "utf8"}).trim(),
    parent_plan_sha256: sha(await readFile(parentFile)), capture_sha256: sha(await readFile(captureFile)), capture_runtime_sha256: capture.runtime_sha256,
    native_run_sha256: sha(await readFile(nativeFile)), translator: native.model,
    rules: {min_cosine: 0.55, required_content_word_coverage: 1, source_articles_ignored_for_coverage: ["a", "an", "the"],
      source_scope_constraints: constrainedScope, full_parent_formats_inherit_source_scope: constrainedScope,
      related_source_concepts_require_witness: relatedConcepts,
      frozen_target_rewriting_allowed: false, only_production_owned_text_nodes_editable: !typedPunctuation && !collapseWhitespace,
      additional_write_authority: proseGaps ? "same-parent original prose gaps may carry frozen target words or become empty, with complete-target witness; no new nodes or model slots" : collapseWhitespace ? "bounded prose punctuation and collapsible ASCII whitespace; no new model slots or request changes" : typedPunctuation ? "bounded standalone prose punctuation; no added model slots or request changes" : null,
      literal_readonly_anchors_exact: true, prose_punctuation_policy: typedPunctuation ? "prose-v1" : "strict",
      allocation_policy: proseGaps ? "prose-gaps-v1" : "fixed", collapsible_whitespace_policy: collapseWhitespace ? "collapse-v1" : "literal", source_label_colon_closure: typedPunctuation, source_sentence_punctuation_closure: proseGaps, full_parent_flows_inherit_only_parent_span: true, live_scope_review_required: true},
    source_hashes: Object.fromEntries(await Promise.all(paths.map(async p => [p, sha(await readFile(path.join(projectRoot, p)))]))),
    excluded_sources: excluded, candidate_refusals, source_cases, cases};
  await write(output, result); return {source_supported_cache_matches: source_cases.length, source_excluded: excluded.length, candidates_rejected: candidate_refusals.length, encoder_pairs: cases.length};
}
async function input(planFile, runFile, model, output) {
  const plan = await read(planFile), run = await read(runFile); await checkSources(plan);
  assert.equal(run.plan_sha256, sha(await readFile(planFile))); assert.ok(run.finished_utc);
  assert.equal(run.rows.length, plan.cases.length);
  const rows = plan.source_cases.map(c => {
    const a = run.rows.find(a => a.id === c.id), refusal = plan.candidate_refusals.find(r => r.id === c.id);
    if (a) assert.equal(a.target_sha256, c.target_sha256);
    return {...c, model, alignment_status: a?.status ?? "candidate_rejected", alignment_reason: a?.reason ?? refusal?.reason,
      spans: a?.spans ?? [], alignment_run_sha256: sha(JSON.stringify(a ?? refusal))};
  });
  await write(output, rows); return {records: rows.length};
}
const {values} = parseArgs({options: {mode: {type: "string", default: "plan"}, parent: {type: "string"}, capture: {type: "string"}, native: {type: "string"},
  plan: {type: "string"}, run: {type: "string"}, model: {type: "string"}, out: {type: "string"}}});
console.log(JSON.stringify(values.mode === "plan" ? await plan(values.parent, values.capture, values.native, values.out)
  : values.mode === "input" ? await input(values.plan, values.run, values.model, values.out) : (() => {throw Error("Unknown owned mode");})()));
