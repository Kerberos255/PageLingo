import {createHash} from "node:crypto";
import assert from "node:assert/strict";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {parseArgs} from "node:util";
import {fixtureDom, projectRoot, qualityRuntime} from "./mt-quality-runtime.mjs";

const {values} = parseArgs({options: {results: {type: "string"}, plan: {type: "string", default: "artifacts/mt-quality/gpu-evaluation-plan.json"},
  out: {type: "string", default: "artifacts/mt-quality/bf16-comparison"}, "allow-decoder-only": {type: "boolean", default: false}}});
if (!values.results) throw new Error("Use --results DIR [--plan FILE] [--out DIR]");
const hash = raw => createHash("sha256").update(raw).digest("hex");
const planRaw = await readFile(values.plan), plan = JSON.parse(planRaw);
const manifest = JSON.parse(await readFile(path.join(values.results, "runs.json"), "utf8"));
if (manifest.protocol !== plan.protocol || manifest.grammar_applied !== false || !manifest.finished_utc
  || manifest.check_only || manifest.plan_sha256 !== hash(planRaw)) throw new Error("Incomplete/mismatched BF16 evaluation");
const sourceChanges = {}, replaySourceHashes = {};
for (const [file, sha] of Object.entries(plan.source_hashes)) {
  const actual = hash(await readFile(path.join(projectRoot, file))); replaySourceHashes[file] = actual;
  if (actual !== sha) {
    if (!values["allow-decoder-only"] || file !== "src/providers/pagelingo-mt/fixed-text.ts")
      throw new Error("Production source differs from recorded plan: " + file);
    sourceChanges[file] = {recorded: sha, replayed: actual};
  }
}
const labels = ["base", "v022", "probe"], models = {}, indexes = {};
for (const label of labels) {
  const file = manifest.files[label];
  if (!file || file.file !== label + ".json") throw new Error("Missing model output: " + label);
  const raw = await readFile(path.join(values.results, file.file));
  if (hash(raw) !== file.sha256) throw new Error("Changed model output: " + label);
  const value = JSON.parse(raw);
  if (!value.finished_utc || value.grammar_applied !== false || value.model !== label
    || value.generations.length !== plan.jobs.length) throw new Error("Incomplete model generation");
  const index = new Map(value.generations.map(row => [row.key, row]));
  if (index.size !== plan.jobs.length) throw new Error("Duplicate generation key");
  for (const job of plan.jobs) {
    const row = index.get(job.key);
    if (!row || row.request_sha256 !== job.request_sha256 || row.max_tokens !== job.request.max_tokens
      || row.new_tokens > row.max_tokens || !["stop", "length", "other"].includes(row.finish_reason)
      || (row.finish_reason === "stop" && row.last_token_id !== 120020)) throw new Error("Unexpected generation input/stop metadata");
  }
  models[label] = value; indexes[label] = index;
}
for (const job of plan.jobs) {
  const rows = labels.map(label => indexes[label].get(job.key));
  if (!rows.every(row => row.prompt_sha256 === rows[0].prompt_sha256 && row.input_ids_sha256 === rows[0].input_ids_sha256))
    throw new Error("Actual prompt/token inputs differ across arms: " + job.key);
}
const api = await qualityRuntime();
const report = {schema_version: 1, protocol: plan.protocol, grammar_applied: false,
  test_fixture: Boolean(manifest.test_fixture),
  interpretation: "Unconstrained BF16 generation replayed through production validation. Keyword probes are not semantic accuracy. References need human review.",
  source_commit: manifest.package_source_commit, gpu: manifest.gpu, identities: manifest.identities,
  decoder_only_replay: values["allow-decoder-only"], source_changes: sourceChanges, replay_source_hashes: replaySourceHashes,
  paired_actual_prompt_and_token_hashes_equal: true, summary: {}, cases: [], plain_diagnostics: []};
for (const sample of plan.cases) {
  const dom = fixtureDom(sample.context_url);
  try {
    const source = new DOMParser().parseFromString(sample.html, "text/html").body.textContent;
    const jobs = plan.jobs.filter(j => j.case_id === sample.id && j.mode === "fixed").sort((a, b) => a.unit - b.unit);
    const prepared = api.prepareQualityCase(sample), actual = api.qualityCallPlan(prepared.request);
    assert.deepEqual(actual.map(c => ({messages: c.messages, max_tokens: c.max_tokens, grammar: c.grammar})),
      jobs.map(j => ({...j.request, grammar: j.production_grammar})), "Production call changed: " + sample.id);
    prepared.scope.remove();
    const row = {id: sample.id, split: sample.split, source_text: source, reference_status: sample.review_status, models: {}};
    for (const label of labels) {
      const records = jobs.map(job => indexes[label].get(job.key));
      row.models[label] = {...await api.replayQualityCase(sample, records), completions: records};
    }
    report.cases.push(row);
    if (sample.split === "diagnostic") {
      const job = plan.jobs.find(j => j.case_id === sample.id && j.mode === "plain");
      report.plain_diagnostics.push({id: sample.id, source_text: source,
        models: Object.fromEntries(labels.map(label => [label, indexes[label].get(job.key)]))});
    }
  } finally {dom.window.close();}
}
for (const label of labels) report.summary[label] = Object.fromEntries(["holdout", "diagnostic"].map(split => {
  const rows = report.cases.filter(c => c.split === split).map(c => c.models[label]);
  return [split, {cases: rows.length, displayed: rows.filter(c => c.displayed).length,
    all_keyword_slot_probes: rows.filter(c => c.all_content_probes_passed).length,
    label_issue_cases: rows.filter(c => c.label_issues.length).length,
    dom_code_restore_passed: rows.filter(c => c.original_structure_unchanged && c.code_unchanged && c.restored_exact).length}];
}));
const out = path.resolve(values.out); await mkdir(out, {recursive: true});
await writeFile(path.join(out, "comparison.json"), JSON.stringify(report, null, 2) + "\n");
const esc = value => String(value ?? "").replace(/[&<>"']/gu, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const parts = ['<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>PageLingo BF16 三组对照</title>',
  '<style>body{font:16px system-ui;margin:24px;background:#fafafa;color:#222}table{width:100%;table-layout:fixed;border-collapse:collapse}td,th{vertical-align:top;padding:12px;border:1px solid #ccc}pre{white-space:pre-wrap;overflow-wrap:anywhere}.issue{color:#a21}details{margin:8px 0}.tools{position:sticky;top:0;background:#fff;padding:12px;border:1px solid #bbb}</style>',
  '<h1>PageLingo BF16 三组对照</h1><p>相同实际提示及 token 输入，贪心生成，无 grammar。已回放生产解码、Text.data 写回及恢复检查。关键词探针不等于准确率；参考译文待人工审核。此条件与旧 Q5/Firefox 测试不同。</p>',
  '<div class="tools"><label>筛选 <input id="q" placeholder="样本 ID 或内容"></label> <label><input type="checkbox" id="issues">只看拒绝、探针或标签异常</label></div>'];
if (report.test_fixture) parts.push('<p class="issue">合成数据自检；不是真实模型生成结果。</p>');
for (const row of report.cases) {
  const issue = labels.some(label => !row.models[label].all_content_probes_passed || row.models[label].label_issues.length);
  parts.push(`<section class="case" data-issue="${issue}"><h2>${esc(row.id)} (${esc(row.split)})</h2><pre>${esc(row.source_text)}</pre><table><tr>${labels.map(label => `<th>${label}</th>`).join("")}</tr><tr>`);
  for (const label of labels) {
    const c = row.models[label];
    parts.push(`<td><strong class="${c.displayed ? "" : "issue"}">${c.displayed ? "显示译文" : "保留原文"}</strong><p>${esc(c.reason)}</p><pre>${esc(c.translated_text)}</pre><details><summary>槽位、探针与标签详情</summary><pre>${esc(JSON.stringify({label_issues: c.label_issues, probes: c.content_probes, raw: c.completions.map(x => x.text)}, null, 2))}</pre></details></td>`);
  }
  parts.push("</tr></table></section>");
}
parts.push("<h1>纯文本诊断对照（无 DOM 映射）</h1>");
for (const row of report.plain_diagnostics) {
  parts.push(`<h2>${esc(row.id)}</h2><table><tr>${labels.map(label => `<th>${label}</th>`).join("")}</tr><tr>${labels.map(label => `<td><pre>${esc(row.models[label].text)}</pre></td>`).join("")}</tr></table>`);
}
parts.push(`<script>function filter(){const q=document.getElementById('q').value.toLowerCase(),only=document.getElementById('issues').checked;document.querySelectorAll('.case').forEach(function(el){el.hidden=!(el.textContent.toLowerCase().includes(q)&&(!only||el.dataset.issue==='true'))})}document.getElementById('q').addEventListener('input',filter);document.getElementById('issues').addEventListener('change',filter);</script></html>`);
await writeFile(path.join(out, "comparison.html"), parts.join("\n"));
console.log(JSON.stringify({out, summary: report.summary, actual_inputs_equal: true, grammar_applied: false}));
