import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {parseArgs} from "node:util";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";
import {fixtureDom, projectRoot} from "./mt-quality-runtime.mjs";
const {values} = parseArgs({options: {results: {type: "string"}, out: {type: "string"}}});
if (!values.results || !values.out) throw new Error("Use --results unpacked-evidence --out new-report-directory");
const root = path.resolve(values.results), output = path.resolve(values.out), hash = value => createHash("sha256").update(value).digest("hex");
const planRaw = await readFile(path.join(root, "evaluation-plan.json")), plan = JSON.parse(planRaw);
const runs = JSON.parse(await readFile(path.join(root, "comparison/runs.json"), "utf8"));
const profiles = {"BF16-semantic-multitask-v4": ["ce_v4", "marker025_v4"], "BF16-corrective-fixed-v5": ["legacy_v5", "roles_v5"],
  "BF16-semantic-preference-v6": ["sft_v6", "dpo_v6"]};
const candidates = profiles[plan.protocol]; assert.ok(candidates, "Unknown paired evaluation profile");
assert.equal(runs.plan_sha256, hash(planRaw)); assert.equal(runs.grammar_applied, false);
assert.ok(runs.finished_utc); assert.deepEqual(Object.keys(runs.files), ["base", "old_r16", ...candidates]);
for (const [name, digest] of Object.entries(plan.source_hashes)) assert.equal(hash(await readFile(path.join(projectRoot, name))), digest, "Frozen source changed: " + name);
const outfile = path.join(projectRoot, "artifacts/mt-quality/semantic-replay-runtime.mjs"); await mkdir(path.dirname(outfile), {recursive: true});
const entries = ["eval/mt-quality/protocol.ts", "eval/mt-quality/semantic-rewrite.ts", "eval/mt-quality/semantic-evidence.ts", "src/core/page-translator.ts"];
await build({stdin: {contents: entries.map(name => `export * from ${JSON.stringify("./" + name)};`).join("\n"), resolveDir: projectRoot}, bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent"});
const api = await import(pathToFileURL(outfile).href + "?t=" + Date.now()), models = {};
for (const [label, record] of Object.entries(runs.files)) {
  assert.equal(record.file, label + ".json"); const raw = await readFile(path.join(root, "comparison", record.file));
  assert.equal(hash(raw), record.sha256); const data = JSON.parse(raw); assert.ok(data.finished_utc); assert.equal(data.model, label);
  assert.deepEqual(data.identity.base, runs.identities.base); assert.deepEqual(data.identity.adapter, runs.identities.adapters[label] ?? null);
  await api.verifySemanticCapture(plan.jobs, data.generations, hash); models[label] = data;
}
for (const [index, job] of plan.jobs.entries()) if (job.mode !== "rewrite") {
  const first = models.base.generations[index];
  for (const data of Object.values(models)) for (const key of ["actual_request_sha256", "prompt_sha256", "input_ids_sha256", "prompt_tokens", "max_tokens"])
    assert.equal(data.generations[index][key], first[key], "Paired static inputs changed: " + job.key);
}
const trainResults = await Promise.all(candidates.map(async label => JSON.parse(await readFile(path.join(root, "training", label + ".json"), "utf8"))));
assert.equal(trainResults[0].initial_trainable_sha256, trainResults[1].initial_trainable_sha256);
for (const trained of trainResults) {assert.equal(trained.optimizer_steps, plan.protocol === "BF16-semantic-preference-v6" ? 48 : 32); assert.equal(trained.selection.best_checkpoint, null); assert.equal(trained.run_kind, "synthetic_research_candidate");}
if (plan.protocol === "BF16-corrective-fixed-v5") for (const trained of trainResults) {
  assert.equal(trained.base_weights_frozen, true); assert.deepEqual(trained.initial_adapter.sha256, runs.identities.adapters.old_r16.sha256);
  assert.equal(trained.loss_definition.kind, "trainer_default_causal_cross_entropy");
}
if (plan.protocol === "BF16-semantic-preference-v6") {
  assert.equal(trainResults[0].reference_cache_sha256, trainResults[1].reference_cache_sha256);
  assert.equal(trainResults[0].input_manifest_sha256, trainResults[1].input_manifest_sha256);
  for (const [index, trained] of trainResults.entries()) {
    assert.equal(trained.base_weights_frozen, true); assert.equal(trained.dropout_disabled, true);
    assert.equal(trained.initial_adapter.sha256, runs.identities.adapters.old_r16.sha256);
    assert.equal(trained.loss_definition.kind, "chosen_ce_plus_reference_relative_dpo");
    assert.equal(trained.loss_definition.preference_weight, index ? 0.25 : 0);
  }
}
const rows = [], natural = [], referenceCases = {};
for (const [label, data] of Object.entries(models)) for (const sample of plan.cases) {
  const actual = data.generations.filter(row => row.case_id === sample.id), legacy = actual.filter(row => row.mode === "legacy");
  const dom = fixtureDom(sample.context_url);
  try {
    const source = api.prepareQualityCase(sample), expectedLegacy = api.qualityCallPlan(source.request);
    if (!referenceCases[sample.id]) referenceCases[sample.id] = {
      english: new DOMParser().parseFromString(sample.html, "text/html").body.textContent,
      reference: (new DOMParser().parseFromString(source.referenceHtml, "text/html").body.textContent ?? "")
        .replace(/__FLT_OPAQUE_(\d+)__/gu, (_whole, id) => source.segment.opaque[Number(id)].text).replace(/__FLT_LINK_(?:START|END)_\d+__/gu, ""),
      review_status: sample.review_status,
    };
    const frozenLegacy = plan.jobs.filter(job => job.case_id === sample.id && job.mode === "legacy");
    assert.equal(frozenLegacy.length, expectedLegacy.length);
    for (const [index, expected] of expectedLegacy.entries()) {
      assert.deepEqual(frozenLegacy[index].request, {messages: expected.messages, max_tokens: expected.max_tokens});
      assert.equal(frozenLegacy[index].production_grammar, expected.grammar);
    }
    source.scope.remove();
    const baseline = await api.replayQualityCase(sample, legacy.map(row => ({text: row.text, finish_reason: row.finish_reason})));
    rows.push({model: label, mode: "legacy", ...baseline});
    for (const mode of ["direct", "rewrite"]) {
      const generation = actual.find(row => row.mode === mode); if (!generation) continue;
      const p = api.prepareQualityCase(sample), before = p.scope.innerHTML;
      const semantic = api.prepareSemanticRewrite(p.request, p.segment.opaque);
      const draft = actual.find(row => row.mode === "natural");
      if (generation.executed) {
        const prompt = api.semanticFixedPrompt(semantic, mode === "rewrite" ? draft.text : undefined);
        const frozen = plan.jobs.find(job => job.key === generation.key);
        assert.deepEqual(mode === "rewrite" ? generation.actual_messages : frozen.request.messages, [{role: "user", content: prompt}]);
      }
      const nodes = [p.root, ...p.root.querySelectorAll("*")].map(node => ({node, children: [...node.childNodes], attrs: JSON.stringify([...node.attributes].map(a => [a.name, a.value]))}));
      const code = [...p.root.querySelectorAll("code,kbd,samp,var")].map(node => ({node, html: node.outerHTML}));
      let reason = null;
      const translator = new api.PageTranslator(document, {prefersWholeSentenceHtml: async () => true, translateHtml: async request => {
        assert.equal(request.html, p.request.html);
        try {
          if (!generation.executed) throw new Error(generation.skip_reason);
          return api.checkSemanticFixed(api.prepareSemanticRewrite(request, p.segment.opaque), generation.text, generation.finish_reason);
        } catch (error) {reason = String(error); throw error;}
      }}, {displayMode: "translation", sourceLanguage: "en", targetLanguage: "zh-Hans", concurrency: 1});
      const warn = console.warn; console.warn = () => {};
      try {
        await translator.translateAll(p.scope);
        const row = {model: label, mode, id: sample.id, split: sample.split, displayed: translator.translatedCount === 1, reason,
          translated_text: p.scope.textContent, translated_html: p.scope.innerHTML,
          labels: [...p.root.querySelectorAll("a,em,strong,b,i,mark")].map(node => ({tag: node.tagName, target: node.textContent})),
          original_structure_unchanged: nodes.every(x => x.node.isConnected && x.attrs === JSON.stringify([...x.node.attributes].map(a => [a.name, a.value])) && x.children.length === x.node.childNodes.length && x.children.every((child, i) => child === x.node.childNodes[i])),
          code_unchanged: code.every(x => x.node.isConnected && x.html === x.node.outerHTML)};
        translator.setDisplayMode("bilingual"); translator.setDisplayMode("translation"); translator.restore(); row.restored_exact = p.scope.innerHTML === before;
        assert.ok(row.original_structure_unchanged && row.code_unchanged && row.restored_exact); rows.push(row);
      } finally {console.warn = warn; p.scope.remove();}
    }
    const plain = actual.find(row => row.mode === "natural"); if (plain) natural.push({model: label, id: sample.id, ...plain});
  } finally {dom.window.close();}
}
const result = {schema_version: 1, scope: "Actual GPU BF16 captures, no grammar; original-node rendering replay, not new inference. Display counts are not semantic accuracy.",
  plan_sha256: hash(planRaw), actual_generations: Object.values(models).reduce((sum, data) => sum + data.generations.filter(row => row.executed).length, 0),
  validation_loss_by_task: Object.fromEntries(Object.entries(models).map(([label, data]) => [label, data.loss_by_task])),
  validation_loss_by_prompt_variant: Object.fromEntries(Object.entries(models).map(([label, data]) => [label, data.loss_by_prompt_variant ?? null])),
  reference_cases: referenceCases, cases: rows, natural};
await mkdir(output, {recursive: true}); await writeFile(path.join(output, "replay.json"), JSON.stringify(result, null, 2) + "\n");
const escape = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
await writeFile(path.join(output, "comparison.html"), '<!doctype html><meta charset="utf-8"><title>PageLingo MT comparison</title><style>body{font:15px system-ui;margin:24px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbb;padding:8px;vertical-align:top}pre{white-space:pre-wrap}</style><h1>Actual paired recorded output replay</h1><p>BF16 without grammar; not a semantic accuracy score. Reference review status is explicit.</p><table><tr><th>Case / model / mode</th><th>English / reference</th><th>Displayed or retained</th><th>Reason</th></tr>' + rows.map(row => `<tr><td>${escape(row.id)}<br>${escape(row.model)} / ${escape(row.mode)}</td><td><pre>${escape(referenceCases[row.id].english)}</pre><pre>${escape(referenceCases[row.id].reference)}</pre><small>${escape(referenceCases[row.id].review_status)}</small></td><td><pre>${escape(row.translated_text)}</pre></td><td>${escape(row.reason)}</td></tr>`).join("") + "</table>");
console.log(JSON.stringify({actual_generations: result.actual_generations, replayed_paragraphs: rows.length, report: output}));
