import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {fixtureDom, projectRoot, qualityRuntime} from './mt-quality-runtime.mjs';

const {values} = parseArgs({options: {results: {type: 'string'}, out: {type: 'string', default: 'artifacts/mt-matrix-replay'}}});
if (!values.results) throw new Error('Use --results EVIDENCE_DIRECTORY [--out DIRECTORY]');
const root = path.resolve(values.results), out = path.resolve(values.out);
await mkdir(out, {recursive: true});
const read = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));
const hash = raw => createHash('sha256').update(raw).digest('hex');
const plan = await read('matrix-plan.json'), manifest = await read('matrix/runs.json'), pkg = await read('package-manifest.json'), identities = await read('matrix-models.json');
assert.equal(manifest.plan_sha256, hash(await readFile(path.join(root, 'matrix-plan.json'))));
assert.equal(manifest.plan_sha256, pkg.files['matrix-plan.json'].sha256);
assert.equal(pkg.source_dirty, false);
assert.deepEqual(manifest.identities, identities);
assert.ok(manifest.finished_utc);
assert.equal(manifest.grammar_applied, false);
for (const [file, digest] of Object.entries(plan.source_hashes))
  assert.equal(hash(await readFile(path.join(projectRoot, file))), digest, 'Frozen source changed: ' + file);
const labels = ['old_r16', 'old_r32', 'v3_r16', 'v3_r32'], models = {}, indexes = {};
const validationIds = new Set(plan.cases.filter(row => row.evaluation_group === 'new_validation').map(row => row.id));
assert.ok(validationIds.size);
assert.deepEqual(Object.keys(manifest.files), labels);
for (const label of labels) {
  const record = manifest.files[label], raw = await readFile(path.join(root, 'matrix', record.file));
  assert.equal(hash(raw), record.sha256);
  const model = JSON.parse(raw); models[label] = model;
  assert.equal(model.model, label); assert.ok(model.finished_utc); assert.equal(model.grammar_applied, false);
  assert.equal(model.generations.length, plan.jobs.length);
  assert.deepEqual(model.identity, identities.adapters[label]);
  assert.equal(model.validation_losses.length, validationIds.size);
  assert.deepEqual(new Set(model.validation_losses.map(row => row.id)), validationIds);
  const index = new Map(model.generations.map(row => [row.key, row]));
  assert.equal(index.size, plan.jobs.length); indexes[label] = index;
  for (const job of plan.jobs) {
    const row = index.get(job.key);
    assert.ok(row); assert.equal(row.request_sha256, job.request_sha256); assert.equal(row.max_tokens, job.request.max_tokens);
    assert.ok(row.new_tokens <= row.max_tokens);
    assert.ok(['stop', 'length', 'other'].includes(row.finish_reason));
    if (row.finish_reason === 'stop') assert.equal(row.last_token_id, 120020);
  }
}
for (const job of plan.jobs) {
  const first = indexes[labels[0]].get(job.key);
  for (const label of labels.slice(1)) {
    const row = indexes[label].get(job.key);
    assert.equal(row.prompt_sha256, first.prompt_sha256); assert.equal(row.input_ids_sha256, first.input_ids_sha256);
  }
}
for (const row of models[labels[0]].validation_losses) {
  for (const label of labels.slice(1)) assert.equal(models[label].validation_losses.find(other => other.id === row.id).prompt_sha256, row.prompt_sha256);
}
const report = {scope: 'Recorded real BF16 generation replay through unchanged production decoder and DOM renderer. No new inference; display/probe counts are not semantic accuracy.',
  source_commit: pkg.source_commit, paired_prompt_and_token_hashes_equal: true,
  unchanged_production_calls: true, summary: {}, losses: Object.fromEntries(labels.map(label => [label, models[label].loss_components])), cases: [], plain_diagnostics: []};
const api = await qualityRuntime();
for (const sample of plan.cases) {
  const dom = fixtureDom(sample.context_url);
  try {
    const prepared = api.prepareQualityCase(sample), actual = api.qualityCallPlan(prepared.request);
    const jobs = plan.jobs.filter(job => job.case_id === sample.id && job.mode === 'fixed').sort((a, b) => a.unit - b.unit);
    assert.deepEqual(actual.map(call => ({messages: call.messages, grammar: call.grammar, max_tokens: call.max_tokens})),
      jobs.map(job => ({...job.request, grammar: job.production_grammar})), 'Call changed: ' + sample.id);
    const referenceText = new DOMParser().parseFromString(prepared.referenceHtml, 'text/html').body.textContent
      .replace(/__FLT_OPAQUE_(\d+)__/gu, (_, index) => prepared.segment.opaque[Number(index)]?.text ?? '')
      .replace(/__FLT_LINK_(?:START|END)_\d+__/gu, '');
    const row = {id: sample.id, group: sample.evaluation_group ?? sample.split, family: sample.family, reference_status: sample.review_status,
      semantic_contract: sample.semantic_contract ?? null, source_html: sample.html, source_text: prepared.scope.textContent,
      reference_text: referenceText, models: {}};
    prepared.scope.remove();
    for (const label of labels) {
      const completions = jobs.map(job => indexes[label].get(job.key));
      row.models[label] = {...await api.replayQualityCase(sample, completions), completions};
    }
    report.cases.push(row);
    const plainJob = plan.jobs.find(job => job.case_id === sample.id && job.mode === 'plain');
    if (plainJob) report.plain_diagnostics.push({id: sample.id, source_text: row.source_text,
      models: Object.fromEntries(labels.map(label => [label, indexes[label].get(plainJob.key)]))});
  } finally {dom.window.close();}
}
const groups = [...new Set(report.cases.map(row => row.group))];
for (const label of labels) {
  report.summary[label] = {};
  for (const group of ['all', ...groups]) {
    const rows = report.cases.filter(row => group === 'all' || row.group === group).map(row => row.models[label]);
    const reasons = {};
    for (const row of rows) if (!row.displayed) reasons[row.reason] = (reasons[row.reason] ?? 0) + 1;
    report.summary[label][group] = {cases: rows.length, displayed: rows.filter(row => row.displayed).length,
      retained_source: rows.filter(row => !row.displayed).length,
      dom_code_restore_passed: rows.filter(row => row.original_structure_unchanged && row.code_unchanged && row.restored_exact).length,
      probed_cases: rows.filter(row => row.content_probes?.length).length,
      all_content_probes_passed: rows.filter(row => row.all_content_probes_passed === true).length,
      rejection_reasons: reasons};
    assert.equal(report.summary[label][group].dom_code_restore_passed, rows.length);
  }
}
await writeFile(path.join(out, 'production-replay.json'), JSON.stringify(report, null, 2) + '\n');
const esc = value => String(value ?? '').replace(/[&<>"']/gu, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const html = ['<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>PageLingo v3 四组译文对照</title>',
  '<style>body{font:16px system-ui;line-height:1.6;margin:24px;color:#202630;background:#f6f7fa}table{border-collapse:collapse;width:100%;table-layout:fixed;background:white}td,th{padding:12px;border:1px solid #ced4de;vertical-align:top}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}.tools{position:sticky;top:0;background:#fff;padding:12px;border:1px solid #ced4de}.bad{color:#a21}small{color:#566}</style>',
  '<h1>v3 四组译文对照</h1><p>真实 GPU BF16 输出，未加 grammar；生产解码与 DOM 回放。显示成功、关键词命中及损失下降均不等于语义正确。旧验证 64、新验证 32、冻结发布与诊断 74 个段落。</p>',
  '<div class="tools"><input id="q" placeholder="搜索句子或 ID"><select id="group"><option value="">全部分组</option>' + groups.concat('plain_diagnostic').map(g => `<option>${esc(g)}</option>`).join('') + '</select><label><input type="checkbox" id="issues">仅格式或探针异常</label></div>'];
for (const row of report.cases) {
  const issue = labels.some(label => {const m = row.models[label]; return !m.displayed || m.all_content_probes_passed === false || m.label_issues.length;});
  html.push(`<section data-group="${esc(row.group)}" data-issue="${issue}"><h2>${esc(row.id)}</h2><small>${esc(row.group)} · ${esc(row.semantic_contract)}</small><pre>${esc(row.source_text)}</pre><details><summary>参考译文（非独立人工审核）</summary><pre>${esc(row.reference_text)}</pre></details><table><tr>${labels.map(label => `<th>${label}</th>`).join('')}</tr><tr>`);
  for (const label of labels) {
    const m = row.models[label];
    html.push(`<td><strong class="${m.displayed ? '' : 'bad'}">${m.displayed ? '显示译文' : '保留原文'}</strong><pre>${esc(m.translated_text)}</pre><small>${esc(m.reason)}</small><details><summary>原始输出与探针</summary><pre>${esc(JSON.stringify({raw: m.completions.map(c => c.text), probes: m.content_probes}, null, 2))}</pre></details></td>`);
  }
  html.push('</tr></table></section>');
}
for (const row of report.plain_diagnostics) {
  html.push(`<section data-group="plain_diagnostic" data-issue="false"><h2>${esc(row.id)} · 纯文本诊断</h2><p>未保留槽位映射，无法直接回填原 DOM。</p><pre>${esc(row.source_text)}</pre><table><tr>${labels.map(label => `<th>${label}</th>`).join('')}</tr><tr>`);
  for (const label of labels) html.push(`<td><pre>${esc(row.models[label].text)}</pre></td>`);
  html.push('</tr></table></section>');
}
html.push('<script>function filter(){const q=document.getElementById("q").value.toLowerCase(),g=document.getElementById("group").value,issue=document.getElementById("issues").checked;for(const s of document.querySelectorAll("section"))s.hidden=!(s.textContent.toLowerCase().includes(q)&&(!g||s.dataset.group===g)&&(!issue||s.dataset.issue==="true"));}for(const e of document.querySelectorAll("input,select"))e.addEventListener("input",filter);</script></html>');
await writeFile(path.join(out, 'comparison.html'), html.join('\n'));
console.log(JSON.stringify({summary: report.summary, losses: report.losses, actual_generations: plan.jobs.length * labels.length}));
