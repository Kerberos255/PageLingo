import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {parseArgs} from "node:util";
import {projectRoot} from "./mt-quality-runtime.mjs";
const {values} = parseArgs({options: {out: {type: "string", default: "artifacts/mt-preference-v6-kit"}, "allow-dirty": {type: "boolean", default: false}, "runtime-models": {type: "string"}}});
const hash = value => createHash("sha256").update(value).digest("hex"), git = args => execFileSync("git", args, {cwd: projectRoot, encoding: "utf8"}).trim();
const commit = git(["rev-parse", "HEAD"]), dirty = Boolean(git(["status", "--porcelain", "--untracked-files=normal"]));
if ((dirty || values["runtime-models"]) && !values["allow-dirty"]) throw new Error("Commit clean source before exporting a runnable kit; local paths are check-only");
const output = path.resolve(values.out), relativePackage = `training-packages/quality-v6-${commit.slice(0, 12)}`, folder = path.join(output, relativePackage);
const data = path.join(projectRoot, "artifacts/mt-quality/preference-v6"), corpus = JSON.parse(await readFile(path.join(data, "manifest.json")));
assert.equal(corpus.corpus, "semantic-preference-v6");
for (const [name, digest] of Object.entries(corpus.source_hashes)) assert.equal(hash(await readFile(path.join(projectRoot, name))), digest, "Regenerate v6 data: " + name);
const plan = JSON.parse(await readFile(path.join(data, "evaluation-plan.json"))); assert.equal(plan.protocol, "BF16-semantic-preference-v6");
for (const [name, digest] of Object.entries(plan.source_hashes)) assert.equal(hash(await readFile(path.join(projectRoot, name))), digest, "Regenerate v6 plan: " + name);
assert.ok(plan.cases.every(c => c.split !== "train") && plan.jobs.every(j => j.mode !== "rewrite"));
await mkdir(path.dirname(folder), {recursive: true}); await mkdir(folder);
const manifest = {schema_version: 1, source_commit: commit, source_dirty: dirty || Boolean(values["runtime-models"]),
  purpose: "v6 48-step paired SFT versus SFT+DPO from the same old r16 and frozen reference; GPU evidence only, no selection/upload", files: {}};
async function put(name, contents) {
  const raw = Buffer.isBuffer(contents) ? contents : Buffer.from(contents); await mkdir(path.dirname(path.join(folder, name)), {recursive: true});
  await writeFile(path.join(folder, name), raw); manifest.files[name] = {bytes: raw.length, sha256: hash(raw)};
}
const common = JSON.parse(await readFile(path.join(projectRoot, "training/mt-fixed-slots/config-preference-v6.json")));
let models = {base: {directory: "models/hy-mt2-1.8b", sha256: common.base_weight_sha256}, adapters: {old_r16: {
  directory: common.initial_adapter_directory, sha256: common.initial_adapter_sha256, config_sha256: common.initial_adapter_config_sha256}}};
if (values["runtime-models"]) models = JSON.parse(await readFile(values["runtime-models"]));
assert.equal(models.base.sha256, common.base_weight_sha256); assert.equal(models.adapters.old_r16.sha256, common.initial_adapter_sha256);
assert.equal(models.adapters.old_r16.config_sha256, common.initial_adapter_config_sha256);
for (const [label, weight] of [["sft_v6", 0], ["dpo_v6", 0.25]])
  await put(label + ".json", JSON.stringify({...common, preference_weight: weight, initial_adapter_directory: models.adapters.old_r16.directory}, null, 2) + "\n");
for (const record of [...Object.values(corpus.files), corpus.evaluation_cases]) assert.equal(hash(await readFile(path.join(data, record.file))), record.sha256);
for (const name of ["manifest.json", "train.jsonl", "validation.jsonl", "evaluation-cases.json", "reference-review.md"]) await put("data/" + name, await readFile(path.join(data, name)));
for (const name of ["train_preference.py", "preference_contract.py", "preference_loss.py", "preference_workflow.py", "training_options.py", "validation_metrics.py",
  "evaluate_gpu.py", "evaluate_matrix.py", "curriculum_workflow.py", "evaluate_semantic.py"]) await put(name, await readFile(path.join(projectRoot, "training/mt-fixed-slots", name)));
await put("evaluation-plan.json", JSON.stringify(plan, null, 2) + "\n");
await put("research_v2.py", "from preference_workflow import main\nif __name__ == '__main__': raise SystemExit(main())\n");
await put("README.md", await readFile(path.join(projectRoot, "training/mt-fixed-slots/PREFERENCE_V6.md")));
const workflow = {run_prefix: "pagelingo-quality-v6", base: models.base, old_r16: models.adapters.old_r16,
  candidates: ["sft_v6", "dpo_v6"], maximum_generations: plan.jobs.length * 4, automatic_selection: false, automatic_upload: false};
await put("workflow.json", JSON.stringify(workflow, null, 2) + "\n");
const rawManifest = JSON.stringify(manifest, null, 2) + "\n"; await writeFile(path.join(folder, "package-manifest.json"), rawManifest);
const control = path.join(output, "tools/mt-control"); await mkdir(control, {recursive: true});
await writeFile(path.join(control, "launcher.py"), await readFile(path.join(projectRoot, "training/mt-fixed-slots/windows/launcher.py")));
await writeFile(path.join(control, "current-task.json"), JSON.stringify({schema_version: 1,
  description: "v6 semantic pairs and old fixed-slot replay: identical old r16, frozen reference, SFT vs SFT+DPO, two 48-step runs and four-arm BF16 evidence",
  package: relativePackage, run_prefix: workflow.run_prefix, source_commit: commit, manifest_sha256: hash(rawManifest)}, null, 2) + "\n");
await writeFile(path.join(output, "x.cmd"), (await readFile(path.join(projectRoot, "training/mt-fixed-slots/windows/x.cmd"), "utf8")).replace(/\r?\n/gu, "\r\n"));
console.log(JSON.stringify({output, package: relativePackage, source_commit: commit, source_dirty: manifest.source_dirty,
  manifest_sha256: hash(rawManifest), runtime_files: Object.keys(manifest.files).length, steps_each: 48, cases: plan.cases.length,
  maximum_generations: plan.jobs.length * 4, automatic_selection: false}));
