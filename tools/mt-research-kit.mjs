import {build} from "esbuild";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {parseArgs} from "node:util";
import {projectRoot} from "./mt-quality-runtime.mjs";
const {values} = parseArgs({options: {out: {type: "string", default: "artifacts/mt-research-v2"}}});
const git = args => execFileSync("git", args, {cwd: projectRoot, encoding: "utf8"}).trim();
const sourceCommit = git(["rev-parse", "HEAD"]);
const output = path.resolve(values.out), relativePackage = `training-packages/quality-v2b-${sourceCommit.slice(0, 12)}`;
const staged = path.join(output, relativePackage);
await mkdir(path.dirname(staged), {recursive: true});
await mkdir(staged); // A generated kit is immutable; use a fresh output for another export.
const manifest = {schema_version: 1, source_commit: sourceCommit, source_dirty: Boolean(git(["status", "--porcelain", "--untracked-files=normal"])),
  purpose: "v2b complex-slot curriculum, two bounded synthetic candidates; no independent human review, automatic release or model upload", files: {}};
const files = new Map([
  ...["train.py", "training_options.py", "evaluate_gpu.py", "merge_adapter.py", "native_v2.py", "research_v2.py", "browser_v2.py", "browser-audit-v2.js", "metrics.py", "config-lr1e5-v2b.json", "config-lr3e5-v2b.json", "evaluation_config.json"]
    .map(name => [name, "training/mt-fixed-slots/" + name]),
  ["run_local.py", "training/mt-fixed-slots/windows/run_local.py"], ["mt-gguf-metadata.py", "tools/mt-gguf-metadata.py"],
  ["README.md", "training/mt-fixed-slots/RESEARCH_V2.md"],
  ["research-plan.json", "artifacts/mt-quality/research-v2-plan.json"],
  ...["train.jsonl", "validation.jsonl", "manifest.json", "template-review.md"].map(name => ["data/" + name, "artifacts/mt-quality/targeted-v2/" + name]),
]);
for (const [target, source] of files) {
  const raw = await readFile(path.join(projectRoot, source));
  await mkdir(path.dirname(path.join(staged, target)), {recursive: true}); await writeFile(path.join(staged, target), raw);
  manifest.files[target] = {bytes: raw.length, sha256: createHash("sha256").update(raw).digest("hex")};
}
const runtime = await build({stdin: {contents: ["eval/mt-quality/protocol.ts", "src/providers/pagelingo-mt/inference.ts", "src/core/page-translator.ts"]
  .map(file => `export * from ${JSON.stringify("./" + file)};`).join("\n"), resolveDir: projectRoot},
  bundle: true, platform: "browser", format: "esm", write: false, minify: true, target: ["firefox142"]});
await writeFile(path.join(staged, "production-runtime.js"), runtime.outputFiles[0].contents);
const css = (await readFile(path.join(projectRoot, "src/content.ts"), "utf8")).match(/style\.textContent = `([\s\S]*?)`;/)?.[1];
if (!css) throw new Error("Cannot extract production CSS");
await writeFile(path.join(staged, "production.css"), css);
const old = JSON.parse(await readFile(path.join(projectRoot, "training/mt-fixed-slots/evaluation_config.json"), "utf8"));
const workflow = {base_directory: old.base_directory, base_weight_sha256: old.base_weight_sha256, old_adapter: old.old_adapter,
  run_prefix: "pagelingo-quality-v2b",
  candidates: [{name: "resume-v2a-r32-lr1e5", config: "config-lr1e5-v2b.json"}, {name: "fresh-r16-lr3e5", config: "config-lr3e5-v2b.json"}],
  old_q5: {directory: "models/pagelingo-hymt-1.8b-v0.2.2-gguf/PageLingo-Translate-1.8B-v0.2.2-Q5_K_M.gguf", sha256: "8f8734198ad9332db97101de3ae7216daa3b59218522c4e0beebdfb4999924cc"},
  server: "tools/llama.cpp/llama-server.exe", quantizer: "tools/llama.cpp/llama-quantize.exe", converter: "tools/llama.cpp-src/convert_hf_to_gguf.py",
  cpu_threads: 8, minimum_free_bytes: 2 * 2 ** 30,
  browser_assets: {wllama: {url: "https://registry.npmjs.org/@wllama/wllama/-/wllama-3.6.1.tgz", digest: "sha512:v6cA0w6sHuaTLmUo9nSU37Sln+5YqZy/OGWp2dXWaR3ts26yLiMnKHGGbjdzQolPSPydPSKUlHHSKZgXK5Prkw==", base64: true},
    geckodriver: {url: "https://github.com/mozilla/geckodriver/releases/download/v0.37.0/geckodriver-v0.37.0-win64.zip", digest: "sha256:9ae5cb90ea9364cd385bb8313b57699e090bbec7c92af4bd65a79d6d8bbc3036"}}};
await writeFile(path.join(staged, "workflow.json"), JSON.stringify(workflow, null, 2) + "\n");
for (const name of ["production-runtime.js", "production.css", "workflow.json"]) {
  const raw = await readFile(path.join(staged, name)); manifest.files[name] = {bytes: raw.length, sha256: createHash("sha256").update(raw).digest("hex")};
}
const packageManifest = JSON.stringify(manifest, null, 2) + "\n";
await writeFile(path.join(staged, "package-manifest.json"), packageManifest);
const control = path.join(output, "tools/mt-control"); await mkdir(control, {recursive: true});
await writeFile(path.join(control, "launcher.py"), await readFile(path.join(projectRoot, "training/mt-fixed-slots/windows/launcher.py")));
await writeFile(path.join(control, "current-task.json"), JSON.stringify({schema_version: 1, description: "v2b GPU training + BF16 + handoff",
  package: relativePackage, run_prefix: workflow.run_prefix, source_commit: sourceCommit,
  manifest_sha256: createHash("sha256").update(packageManifest).digest("hex")}, null, 2) + "\n");
const cmd = await readFile(path.join(projectRoot, "training/mt-fixed-slots/windows/PageLingo-MT.cmd"), "utf8");
await writeFile(path.join(output, "PageLingo-MT.cmd"), cmd.replace(/\r?\n/gu, "\r\n"));
console.log(JSON.stringify({output, package: relativePackage, entry: "PageLingo-MT.cmd", source_commit: manifest.source_commit, source_dirty: manifest.source_dirty, files: Object.keys(manifest.files).length}));
