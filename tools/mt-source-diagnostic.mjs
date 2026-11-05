import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {build} from "esbuild";
import {mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {parseArgs} from "node:util";
import {fixtureDom, projectRoot, readCases} from "./mt-quality-runtime.mjs";
import {preferenceCases} from "../training/mt-fixed-slots/preference-v6.mjs";
import {correctiveCases} from "../training/mt-fixed-slots/corrective-v5.mjs";
import {semanticCases} from "../training/mt-fixed-slots/semantic-v4.mjs";
import {targetedCases as v2} from "../training/mt-fixed-slots/targeted-v2.mjs";
import {targetedCases as v3} from "../training/mt-fixed-slots/targeted-v3.mjs";
import {releaseCases} from "../eval/mt-quality/release-v2.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const json = async file => JSON.parse(await readFile(file, "utf8"));
const canonical = (api, sample) => api.canonicalSource(sample);
async function runtime() {
  const outfile = path.join(projectRoot, "artifacts/mt-quality/source-diagnostic-runtime.mjs");
  await mkdir(path.dirname(outfile), {recursive: true});
  await build({stdin: {contents: ['export * from "./eval/mt-quality/source-diagnostic.ts";',
    'export * from "./eval/mt-quality/protocol.ts";', 'export * from "./eval/mt-quality/semantic-rewrite.ts";'].join("\n"), resolveDir: projectRoot},
    bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent"});
  return import(pathToFileURL(outfile).href + "?t=" + Date.now());
}
async function sourceFiles(directory) {
  const entries = await readdir(path.join(projectRoot, directory), {withFileTypes: true});
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? sourceFiles(directory + "/" + entry.name)
    : entry.name.endsWith(".ts") ? [directory + "/" + entry.name] : []))).flat();
}
async function exportPlan(output) {
  const api = await runtime(), fresh = (await readCases("eval/mt-quality/external/source-format-v8.json"));
  const known = [...v2(), ...v3(), ...semanticCases(), ...correctiveCases(), ...preferenceCases(), ...releaseCases(),
    ...await readCases("eval/mt-quality/cases.json"), ...await readCases("training/mt-fixed-slots/seed.json"),
    ...await readCases("eval/mt-quality/external/flores200-32.json")];
  const reserved = new Set(), reservedWire = new Set();
  for (const sample of known) {
    const dom = fixtureDom(sample.context_url);
    try {const p = api.prepareQualityCase(sample); reserved.add(canonical(api, sample)); reservedWire.add(p.source); p.scope.remove();}
    finally {dom.window.close();}
  }
  const controlIds = ["v6-train-temporal-snapshot-after-code", "v6-train-temporal-sample-after-text",
    "v6-train-temporal-snapshot-before-text", "v5-train-nonce-lifetimes-0"];
  const controls = controlIds.map(id => {
    const c = known.find(row => row.id === id); assert.ok(c && c.split === "train");
    return {id: c.id, html: c.html, context_url: c.context_url, family: c.family, category: c.category,
      split: "diagnostic", group: "known_training_control", original_split: "train", meaning_reference: null,
      origin: {kind: "known_training_source", source_id: c.id}, review_status: "diagnostic_control_no_reference_target"};
  });
  const jobs = [], cases = [], ids = new Set(), sources = new Set(), wires = new Set();
  const contextChecks = new Set(["web-v8-sqlite-close", "web-v8-sqlite-context", "web-v8-abort-before",
    "v6-train-temporal-snapshot-after-code", "v6-train-temporal-sample-after-text"]);
  for (const sample of [...fresh, ...controls]) {
    const dom = fixtureDom(sample.context_url);
    try {
      assert.equal(sample.split, "diagnostic"); assert.ok(!ids.has(sample.id)); ids.add(sample.id);
      const p = api.prepareSourceDiagnostic(sample), source = canonical(api, sample);
      if (sample.group === "fresh_web_excerpt") {
        assert.ok(!reserved.has(source) && !reservedWire.has(p.semantic.fixed.source), "Previously used web source: " + sample.id);
      }
      assert.ok(!sources.has(source) && !wires.has(p.semantic.fixed.source), "Repeated source");
      sources.add(source); wires.add(p.semantic.fixed.source);
      assert.ok(p.calls.length > 0 && p.natural.max_tokens > 0);
      const add = (variant, request) => jobs.push({case_id: sample.id, variant, request,
        request_sha256: hash(JSON.stringify(request))});
      add("natural-visible", p.natural);
      p.calls.forEach((call, index) => add("production-fixed:" + index,
        {messages: call.messages, max_tokens: call.max_tokens, grammar: call.grammar}));
      if (contextChecks.has(sample.id)) {
        assert.equal(p.calls.length, 1, "Context research uses one complete frame");
        add("context-fixed", {messages: [{role: "user", content: api.semanticFixedPrompt(p.semantic)}],
          max_tokens: p.calls[0].max_tokens, grammar: p.calls[0].grammar});
      }
      cases.push({...sample, source_text: p.root.textContent, visible_source_sha256: hash(source),
        model_visible_fixed_source: p.semantic.fixed.source, fixed_calls: p.calls.length,
        context_check: contextChecks.has(sample.id),
        protected_code: [...p.root.querySelectorAll("code,kbd,samp,var")].map(node => node.textContent),
        source_labels: [...p.root.querySelectorAll("a,em,strong,b,i,mark")].map(node => ({tag: node.tagName, text: node.textContent}))});
      p.scope.remove();
    } finally {dom.window.close();}
  }
  const files = [...await sourceFiles("src"), "eval/mt-quality/source-diagnostic.ts", "eval/mt-quality/protocol.ts",
    "eval/mt-quality/semantic-rewrite.ts", "eval/mt-quality/external/source-format-v8.json", "tools/mt-source-diagnostic.mjs",
    "tools/mt-source-diagnostic-guard.py", "tools/mt-sentence-native.py", "tools/mt-quality-runtime.mjs",
    "training/mt-fixed-slots/preference-v6.mjs", "training/mt-fixed-slots/corrective-v5.mjs",
    "training/mt-fixed-slots/semantic-v4.mjs", "training/mt-fixed-slots/targeted-v2.mjs", "training/mt-fixed-slots/targeted-v3.mjs",
    "eval/mt-quality/cases.json", "training/mt-fixed-slots/seed.json", "eval/mt-quality/external/flores200-32.json", "eval/mt-quality/release-v2.mjs"];
  const plan = {schema_version: 1, protocol: "source-format-diagnostic-v8", evaluation_only: true, optimizer_inputs_approved: false,
    purpose: "Compare natural visible-text translation against production fixed slots; meaning references are never inference inputs.",
    limitations: ["Small selected sample; no blind human review.", "Natural sees original code; production sees opaque code sentinels. Differences can arise from both context and output constraints.",
      "Production-fixed calls retain production prompts, grammar and budgets. Natural uses the same total budget, capped at 768; model native chat templates are applied by the runner.",
      "Five preselected context-fixed probes expose code context and richer instructions while retaining the same grammar/budget. This changes both context and instructions, and is research only."],
    source_hashes: Object.fromEntries(await Promise.all(files.map(async name => [name, hash(await readFile(path.join(projectRoot, name)))]))), cases, jobs};
  await mkdir(path.dirname(path.resolve(output)), {recursive: true}); await writeFile(output, JSON.stringify(plan, null, 2) + "\n");
  return {cases: cases.length, fresh_web_cases: fresh.length, known_training_controls: controls.length, jobs: jobs.length, optimizer_executed: false};
}
async function replay(planFile, runFile, output) {
  const api = await runtime(), plan = await json(planFile), run = await json(runFile);
  assert.equal(plan.protocol, "source-format-diagnostic-v8"); assert.equal(run.protocol, plan.protocol);
  assert.equal(run.plan_sha256, hash(await readFile(planFile))); assert.ok(run.finished_utc);
  for (const [name, expected] of Object.entries(plan.source_hashes)) assert.equal(hash(await readFile(path.join(projectRoot, name))), expected, name);
  assert.equal(run.generations.length, plan.jobs.length);
  const rows = new Map();
  for (let i = 0; i < plan.jobs.length; i++) {
    const job = plan.jobs[i], row = run.generations[i];
    assert.equal(row.case_id, job.case_id); assert.equal(row.variant, job.variant); assert.equal(row.request_sha256, job.request_sha256);
    const key = row.case_id + "\0" + row.variant; assert.ok(!rows.has(key)); rows.set(key, row);
  }
  const results = [];
  for (const sample of plan.cases) {
    const dom = fixtureDom(sample.context_url);
    try {
      const natural = rows.get(sample.id + "\0natural-visible"); assert.ok(natural);
      const fixed = Array.from({length: sample.fixed_calls}, (_, i) => rows.get(sample.id + "\0production-fixed:" + i));
      assert.ok(fixed.every(Boolean));
      const context = rows.get(sample.id + "\0context-fixed");
      results.push({id: sample.id, group: sample.group, source_text: sample.source_text, meaning_reference: sample.meaning_reference,
        natural: {text: natural.text, finish_reason: natural.finish_reason,
          protected_code_occurrences_preserved: sample.protected_code.every(code => natural.text.split(code).length - 1 >= sample.protected_code.filter(c => c === code).length)},
        production: await api.replaySourceDiagnostic(sample, fixed),
        ...(context ? {context_research: {mode: "research_prompt_then_production_decoder_only",
          replay: await api.replaySourceDiagnostic(sample, [context])}} : {})});
    } finally {dom.window.close();}
  }
  const result = {protocol: plan.protocol, plan_sha256: run.plan_sha256, run_sha256: hash(await readFile(runFile)), model: run.model, results};
  await mkdir(path.dirname(path.resolve(output)), {recursive: true}); await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  return {cases: results.length, displayed: results.filter(r => r.production.displayed).length,
    structure_code_restore: results.every(r => r.production.original_structure_unchanged && r.production.code_unchanged && r.production.restored_exact),
    semantic_accuracy: "Requires reading actual output; never inferred from DOM checks."};
}
const {values} = parseArgs({options: {mode: {type: "string", default: "plan"}, plan: {type: "string"}, run: {type: "string"},
  out: {type: "string", default: "artifacts/mt-quality/source-format-v8/plan.json"}}});
console.log(JSON.stringify(values.mode === "plan" ? await exportPlan(values.out) : await replay(values.plan, values.run, values.out)));
