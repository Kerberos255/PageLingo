import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {parseArgs} from "node:util";
import {projectRoot} from "./mt-quality-runtime.mjs";
const {values} = parseArgs({options: {out: {type: "string", default: "artifacts/mt-semantic-v4-kit"}, "allow-dirty": {type: "boolean", default: false}, "runtime-models": {type: "string"}, "reuse-ce": {type: "string"}}});
const hash = raw => createHash("sha256").update(raw).digest("hex");
const git = args => execFileSync("git", args, {cwd: projectRoot, encoding: "utf8"}).trim();
const sourceCommit = git(["rev-parse", "HEAD"]), dirty = Boolean(git(["status", "--porcelain", "--untracked-files=normal"]));
if ((dirty || values["runtime-models"]) && !values["allow-dirty"]) throw new Error("Commit source before exporting a runnable GPU kit; local model overrides are check-only");
const output = path.resolve(values.out), relativePackage = `training-packages/quality-v4-${sourceCommit.slice(0, 12)}`, folder = path.join(output, relativePackage);
const data = path.join(projectRoot, "artifacts/mt-quality/semantic-v4"), dataManifest = JSON.parse(await readFile(path.join(data, "manifest.json"), "utf8"));
assert.equal(dataManifest.protocol, "semantic-rewrite-multitask-v1");
for (const [file, digest] of Object.entries(dataManifest.source_hashes)) assert.equal(hash(await readFile(path.join(projectRoot, file))), digest, "Regenerate data after source changes");
for (const record of [...Object.values(dataManifest.files), dataManifest.evaluation_cases]) assert.equal(hash(await readFile(path.join(data, record.file))), record.sha256);
const plan = JSON.parse(await readFile(path.join(data, "evaluation-plan.json"), "utf8"));
for (const [file, digest] of Object.entries(plan.source_hashes)) assert.equal(hash(await readFile(path.join(projectRoot, file))), digest, "Regenerate evaluation plan after source changes");
assert.ok(plan.cases.every(c => c.split !== "train"));
await mkdir(path.dirname(folder), {recursive: true}); await mkdir(folder);
const manifest = {schema_version: 1, source_commit: sourceCommit, source_dirty: dirty || Boolean(values["runtime-models"]),
  purpose: "Paired fresh-base 32-step LoRA pilots and four-arm GPU evidence only; no automatic selection, conversion, browser or upload", files: {}};
async function put(name, contents) {
  const raw = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  await mkdir(path.dirname(path.join(folder, name)), {recursive: true}); await writeFile(path.join(folder, name), raw);
  manifest.files[name] = {bytes: raw.length, sha256: hash(raw)};
}
let models = {base: {directory: "models/hy-mt2-1.8b", sha256: "29e9117a44c79f81857613601968ff482d8a23c2d6736a1710bba9e5ca4762e5"},
  adapters: {old_r16: {directory: "outputs/pagelingo-quality-v2b-run-20261026-163645-a532c4/fresh-r16-lr3e5/adapter",
    sha256: "85546101dce5baae57f472b92e8b722f68c4c26550b396187e0b0e5d3e844b02", config_sha256: "5af5e26dc0354cff9ebdd9b2d3534fa66542aa751db866dd99db0d23bedc2663"}}};
if (values["runtime-models"]) models = JSON.parse(await readFile(values["runtime-models"], "utf8"));
for (const [label, filename] of [["ce_v4", "config-semantic-ce-v4.json"], ["marker025_v4", "config-semantic-marker025-v4.json"]]) {
  await put(label + ".json", await readFile(path.join(projectRoot, "training/mt-fixed-slots", filename)));
}
for (const name of ["train.py", "training_options.py", "semantic_loss.py", "validation_metrics.py", "evaluate_gpu.py", "evaluate_matrix.py", "curriculum_workflow.py", "evaluate_semantic.py", "semantic_workflow.py"]) {
  await put(name, await readFile(path.join(projectRoot, "training/mt-fixed-slots", name)));
}
for (const name of ["train.jsonl", "validation.jsonl", "manifest.json", "reference-review.md", "evaluation-cases.json"]) await put("data/" + name, await readFile(path.join(data, name)));
await put("evaluation-plan.json", JSON.stringify(plan, null, 2) + "\n");
await put("research_v2.py", "from semantic_workflow import main\nif __name__ == '__main__': raise SystemExit(main())\n");
await put("README.md", await readFile(path.join(projectRoot, "training/mt-fixed-slots/SEMANTIC_V4.md")));
const workflow = {run_prefix: "pagelingo-quality-v4", base: models.base, old_r16: models.adapters.old_r16,
  candidates: ["ce_v4", "marker025_v4"], maximum_generations: plan.jobs.length * 4, automatic_selection: false, automatic_upload: false};
if (values["reuse-ce"]) {
  const record = JSON.parse(await readFile(values["reuse-ce"], "utf8"));
  for (const directory of [record.directory, record.package.directory]) {
    assert.ok(typeof directory === "string" && !path.posix.isAbsolute(directory) && !path.win32.isAbsolute(directory) && !directory.includes("\\") && !directory.split("/").includes(".."), "Recovery paths must be project-relative");
  }
  assert.match(record.package.source_commit, /^[a-f0-9]{40}$/u); assert.match(record.package.manifest_sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(record.files).sort(), ["training-result.json", "initialization.json", "adapter/adapter_model.safetensors", "adapter/adapter_config.json"].sort());
  for (const identity of Object.values(record.files)) {assert.match(identity.sha256, /^[a-f0-9]{64}$/u); assert.ok(Number.isSafeInteger(identity.bytes) && identity.bytes > 0);}
  workflow.run_prefix = "pagelingo-quality-v4-recovery";
  workflow.reuse_candidates = {ce_v4: record};
}
await put("workflow.json", JSON.stringify(workflow, null, 2) + "\n");
const rawManifest = JSON.stringify(manifest, null, 2) + "\n";
await writeFile(path.join(folder, "package-manifest.json"), rawManifest);
const control = path.join(output, "tools/mt-control"); await mkdir(control, {recursive: true});
await writeFile(path.join(control, "launcher.py"), await readFile(path.join(projectRoot, "training/mt-fixed-slots/windows/launcher.py")));
await writeFile(path.join(control, "current-task.json"), JSON.stringify({schema_version: 1, description: values["reuse-ce"] ? "v4 recovery: verify and reuse completed CE control; train marker025 for 32 steps; four-arm BF16 evidence" : "v4 paired natural/fixed/rewrite pilot: fresh LoRA, two 32-step loss controls, four-arm BF16 evidence",
  package: relativePackage, run_prefix: workflow.run_prefix, source_commit: sourceCommit, manifest_sha256: hash(rawManifest)}, null, 2) + "\n");
await writeFile(path.join(output, "x.cmd"), (await readFile(path.join(projectRoot, "training/mt-fixed-slots/windows/x.cmd"), "utf8")).replace(/\r?\n/gu, "\r\n"));
console.log(JSON.stringify({output, package: relativePackage, source_commit: sourceCommit, source_dirty: manifest.source_dirty,
  manifest_sha256: hash(rawManifest), runtime_files: Object.keys(manifest.files).length, steps_each: 32, reuse_candidates: Object.keys(workflow.reuse_candidates ?? {}), cases: plan.cases.length,
  maximum_generations: plan.jobs.length * 4, automatic_selection: false}));
