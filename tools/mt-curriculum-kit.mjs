import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {fixtureDom, projectRoot, qualityRuntime} from './mt-quality-runtime.mjs';
import {targetedCases as oldCases} from '../training/mt-fixed-slots/targeted-v2.mjs';
import {targetedCases as newCases} from '../training/mt-fixed-slots/targeted-v3.mjs';

const {values} = parseArgs({options: {out: {type: 'string', default: 'artifacts/mt-curriculum-v3'}, 'allow-dirty': {type: 'boolean', default: false}}});
const git = args => execFileSync('git', args, {cwd: projectRoot, encoding: 'utf8'}).trim();
const hash = raw => createHash('sha256').update(raw).digest('hex');
const sourceCommit = git(['rev-parse', 'HEAD']), dirty = Boolean(git(['status', '--porcelain', '--untracked-files=normal']));
if (dirty && !values['allow-dirty']) throw new Error('Commit the reviewed source before exporting an executable GPU package; --allow-dirty is for development checks only');
const output = path.resolve(values.out), relativePackage = `training-packages/quality-v3-${sourceCommit.slice(0, 12)}`, folder = path.join(output, relativePackage);
const data = path.join(projectRoot, 'artifacts/mt-quality/targeted-v3');
const dataManifest = JSON.parse(await readFile(path.join(data, 'manifest.json'), 'utf8'));
assert.equal(dataManifest.corpus, 'targeted-synthetic-v3');
for (const [file, digest] of Object.entries(dataManifest.source_hashes)) assert.equal(hash(await readFile(path.join(projectRoot, file))), digest, 'Regenerate v3 data after changing source');
for (const record of Object.values(dataManifest.files)) assert.equal(hash(await readFile(path.join(data, record.file))), record.sha256);
const plan = JSON.parse(await readFile(path.join(projectRoot, 'artifacts/mt-quality/research-v2-plan.json'), 'utf8'));
for (const [file, digest] of Object.entries(plan.source_hashes)) assert.equal(hash(await readFile(path.join(projectRoot, file))), digest, 'Frozen release plan differs from source');
const api = await qualityRuntime();
for (const sample of [...oldCases().filter(s => s.split === 'validation'), ...newCases().filter(s => s.split === 'validation')]) {
  const dom = fixtureDom(sample.context_url);
  try {
    const prepared = api.prepareQualityCase(sample), calls = api.qualityCallPlan(prepared.request);
    assert.equal(calls.length, 1);
    plan.cases.push({...sample, evaluation_group: sample.id.startsWith('v3-') ? 'new_validation' : 'legacy_validation'});
    for (const [unit, call] of calls.entries()) plan.jobs.push({key: `fixed/${sample.id}/${unit}`, case_id: sample.id, mode: 'fixed',
      split: sample.split, unit, request: {messages: call.messages, max_tokens: call.max_tokens}, production_grammar: call.grammar});
    prepared.scope.remove();
  } finally {dom.window.close();}
}
assert.equal(new Set(plan.cases.map(c => c.id)).size, plan.cases.length);
assert.equal(new Set(plan.jobs.map(j => j.key)).size, plan.jobs.length);
for (const job of plan.jobs) job.request_sha256 = hash(JSON.stringify(job.request));
plan.provenance = 'Four-arm v3 comparison. New validation, legacy validation and frozen release/diagnostic prompts never enter training. Already-observed release failures informed curriculum types; release results are regression evidence, not blind accuracy.';
plan.source_hashes = {...plan.source_hashes, ...dataManifest.source_hashes};

await mkdir(path.dirname(folder), {recursive: true}); await mkdir(folder);
const manifest = {schema_version: 1, source_commit: sourceCommit, source_dirty: dirty,
  purpose: 'Two 64-step v3 LoRA updates and four-arm BF16 evidence; no automatic winner, browser, conversion or upload', files: {}};
async function put(name, contents) {
  const raw = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  await mkdir(path.dirname(path.join(folder, name)), {recursive: true}); await writeFile(path.join(folder, name), raw);
  manifest.files[name] = {bytes: raw.length, sha256: hash(raw)};
}
const base = {directory: 'models/hy-mt2-1.8b', sha256: '29e9117a44c79f81857613601968ff482d8a23c2d6736a1710bba9e5ca4762e5'};
const oldRun = 'outputs/pagelingo-quality-v2b-run-20261026-163645-a532c4/';
const baselines = {
  old_r16: {directory: oldRun + 'fresh-r16-lr3e5/adapter', sha256: '85546101dce5baae57f472b92e8b722f68c4c26550b396187e0b0e5d3e844b02', config_sha256: '5af5e26dc0354cff9ebdd9b2d3534fa66542aa751db866dd99db0d23bedc2663'},
  old_r32: {directory: oldRun + 'resume-v2a-r32-lr1e5/adapter', sha256: 'dfc3874e46f810c9d9951add371cce13cc2987bcb2fd673ade2af62ee22670cb', config_sha256: '23a20853d2ae7500c571c08fb74640e2474ae560e32733bf60a7a44bd97a3e7e'},
};
const common = JSON.parse(await readFile(path.join(projectRoot, 'training/mt-fixed-slots/config-lr3e5-v2b.json'), 'utf8'));
for (const rank of [16, 32]) {
  const initial = baselines['old_r' + rank];
  const config = {...common, learning_rate: 1e-5, lora_r: rank, lora_alpha: rank * 2, candidate_max_steps: 64,
    checkpoint_selection: 'final', initialization: 'resume_verified_adapter',
    initial_adapter_directory: initial.directory, initial_adapter_sha256: initial.sha256, initial_adapter_config_sha256: initial.config_sha256,
    purpose: 'v3 source-slot ownership repair and technical curriculum; fixed-final research comparison, no automatic release'};
  await put(`config-r${rank}.json`, JSON.stringify(config, null, 2) + '\n');
}
for (const name of ['train.py', 'training_options.py', 'evaluate_gpu.py', 'validation_metrics.py', 'evaluate_matrix.py', 'curriculum_workflow.py'])
  await put(name, await readFile(path.join(projectRoot, 'training/mt-fixed-slots', name)));
for (const name of ['train.jsonl', 'validation.jsonl', 'manifest.json', 'template-review.md']) await put('data/' + name, await readFile(path.join(data, name)));
await put('research_v2.py', 'from curriculum_workflow import main\nif __name__ == "__main__": raise SystemExit(main())\n');
await put('README.md', await readFile(path.join(projectRoot, 'training/mt-fixed-slots/CURRICULUM_V3.md')));
await put('matrix-plan.json', JSON.stringify(plan, null, 2) + '\n');
const workflow = {run_prefix: 'pagelingo-quality-v3', base, baselines,
  candidates: [{name: 'r16', config: 'config-r16.json'}, {name: 'r32', config: 'config-r32.json'}],
  planned_generations: plan.jobs.length * 4, automatic_selection: false, automatic_upload: false};
await put('workflow.json', JSON.stringify(workflow, null, 2) + '\n');
const serialized = JSON.stringify(manifest, null, 2) + '\n';
await writeFile(path.join(folder, 'package-manifest.json'), serialized);
const control = path.join(output, 'tools/mt-control'); await mkdir(control, {recursive: true});
await writeFile(path.join(control, 'launcher.py'), await readFile(path.join(projectRoot, 'training/mt-fixed-slots/windows/launcher.py')));
await writeFile(path.join(control, 'current-task.json'), JSON.stringify({schema_version: 1, description: 'v3 ownership curriculum: two 64-step adapter updates and four-arm BF16 comparison',
  package: relativePackage, run_prefix: workflow.run_prefix, source_commit: sourceCommit, manifest_sha256: hash(serialized)}, null, 2) + '\n');
await writeFile(path.join(output, 'x.cmd'), (await readFile(path.join(projectRoot, 'training/mt-fixed-slots/windows/x.cmd'), 'utf8')).replace(/\r?\n/gu, '\r\n'));
console.log(JSON.stringify({output, package: relativePackage, runtime_files: Object.keys(manifest.files).length, source_commit: sourceCommit,
  source_dirty: dirty, manifest_sha256: hash(serialized), cases: plan.cases.length, jobs_per_arm: plan.jobs.length,
  planned_generations: plan.jobs.length * 4, automatic_selection: false}));
