import {mkdir, readFile, writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import path from "node:path";
import {parseArgs} from "node:util";
import {projectRoot} from "./mt-quality-runtime.mjs";

const {values} = parseArgs({options: {out: {type: "string", default: "artifacts/mt-windows-kit"}}});
const output = path.resolve(values.out), staged = path.join(output, "codex-fixed-slots-v1");
const git = args => execFileSync("git", args, {cwd: projectRoot, encoding: "utf8"}).trim();
const manifest = {schema_version: 1, source_commit: git(["rev-parse", "HEAD"]),
  source_dirty: Boolean(git(["status", "--porcelain", "--untracked-files=normal"])),
  purpose: "Non-C-drive Windows launcher; bounded GPU pipeline probe, not a release model", files: {}};
const files = new Map([
  ["train.py", "training/mt-fixed-slots/train.py"], ["config.json", "training/mt-fixed-slots/config.json"],
  ["merge_adapter.py", "training/mt-fixed-slots/merge_adapter.py"], ["mt-gguf-metadata.py", "tools/mt-gguf-metadata.py"],
  ["requirements-reference.txt", "training/mt-fixed-slots/requirements.txt"],
  ["run_local.py", "training/mt-fixed-slots/windows/run_local.py"],
  ["inspect_legacy.cjs", "training/mt-fixed-slots/windows/inspect_legacy.cjs"],
  ["README.md", "training/mt-fixed-slots/windows/README.md"],
  ["evidence/legacy-inventory-2026-10-22.json", "training/mt-fixed-slots/windows/legacy-inventory-2026-10-22.json"],
  ...["train", "validation", "holdout", "diagnostic", "manifest"].map(name => ["data/" + name + (name === "manifest" ? ".json" : ".jsonl"), "artifacts/mt-quality/data/" + name + (name === "manifest" ? ".json" : ".jsonl")]),
]);
await mkdir(staged, {recursive: true});
for (const [target, source] of files) {
  const raw = await readFile(path.join(projectRoot, source));
  const file = path.join(staged, target); await mkdir(path.dirname(file), {recursive: true});
  await writeFile(file, raw);
  manifest.files[target] = {bytes: raw.length, sha256: createHash("sha256").update(raw).digest("hex")};
}
await writeFile(path.join(staged, "package-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
const cmd = (await readFile(path.join(projectRoot, "training/mt-fixed-slots/windows/run-fixed-slots-v1.cmd"), "utf8")).replace(/\r?\n/gu, "\r\n");
await writeFile(path.join(output, "run-fixed-slots-v1.cmd"), cmd);
console.log(JSON.stringify({output, source_commit: manifest.source_commit, source_dirty: manifest.source_dirty, staged_files: files.size + 1}));
