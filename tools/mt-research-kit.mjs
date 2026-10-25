import {build} from "esbuild";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {parseArgs} from "node:util";
import {projectRoot} from "./mt-quality-runtime.mjs";
const {values} = parseArgs({options: {out: {type: "string", default: "artifacts/mt-research-v2"}}});
const output = path.resolve(values.out), staged = path.join(output, "codex-quality-v2");
await mkdir(staged, {recursive: true});
const git = args => execFileSync("git", args, {cwd: projectRoot, encoding: "utf8"}).trim();
const manifest = {schema_version: 1, source_commit: git(["rev-parse", "HEAD"]), source_dirty: Boolean(git(["status", "--porcelain", "--untracked-files=normal"])),
  purpose: "Two bounded synthetic research candidates; no independent human data review, no automatic release or model upload", files: {}};
const files = new Map([
  ...["train.py", "training_options.py", "evaluate_gpu.py", "merge_adapter.py", "native_v2.py", "research_v2.py", "browser_v2.py", "browser-audit-v2.js", "metrics.py", "config-lr1e5-v2.json", "config-lr3e5-v2.json", "evaluation_config.json"]
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
  candidates: [{name: "resume-v022-r32-lr1e5", config: "config-lr1e5-v2.json"}, {name: "fresh-r16-lr3e5", config: "config-lr3e5-v2.json"}],
  old_q5: {directory: "models/pagelingo-hymt-1.8b-v0.2.2-gguf/PageLingo-Translate-1.8B-v0.2.2-Q5_K_M.gguf", sha256: "8f8734198ad9332db97101de3ae7216daa3b59218522c4e0beebdfb4999924cc"},
  server: "tools/llama.cpp/llama-server.exe", quantizer: "tools/llama.cpp/llama-quantize.exe", converter: "tools/llama.cpp-src/convert_hf_to_gguf.py",
  cpu_threads: 8, minimum_free_bytes: 2 * 2 ** 30,
  browser_assets: {wllama: {url: "https://registry.npmjs.org/@wllama/wllama/-/wllama-3.6.1.tgz", digest: "sha512:v6cA0w6sHuaTLmUo9nSU37Sln+5YqZy/OGWp2dXWaR3ts26yLiMnKHGGbjdzQolPSPydPSKUlHHSKZgXK5Prkw==", base64: true},
    geckodriver: {url: "https://github.com/mozilla/geckodriver/releases/download/v0.37.0/geckodriver-v0.37.0-win64.zip", digest: "sha256:9ae5cb90ea9364cd385bb8313b57699e090bbec7c92af4bd65a79d6d8bbc3036"}}};
await writeFile(path.join(staged, "workflow.json"), JSON.stringify(workflow, null, 2) + "\n");
for (const name of ["production-runtime.js", "production.css", "workflow.json"]) {
  const raw = await readFile(path.join(staged, name)); manifest.files[name] = {bytes: raw.length, sha256: createHash("sha256").update(raw).digest("hex")};
}
await writeFile(path.join(staged, "package-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
let cmd = await readFile(path.join(projectRoot, "training/mt-fixed-slots/windows/run-fixed-slots-v1.cmd"), "utf8");
cmd = cmd.replace('set "PLMT_KIND=probe"', 'set "PLMT_KIND=run"').replace(/^if \/I not "%PLMT_KIND%"=="check".*goto :usage$/m, 'if /I not "%PLMT_KIND%"=="check" if /I not "%PLMT_KIND%"=="run" goto :usage')
  .replaceAll("codex-fixed-slots-v1", "codex-quality-v2").replaceAll("run_local.py", "research_v2.py").replaceAll("--kind", "--mode");
const start = cmd.indexOf("\n:help\n") + 1, end = cmd.indexOf("\n:environment_missing\n", start) + 1;
if (start <= 0 || end <= 0) throw new Error("Launcher template changed");
cmd = cmd.slice(0, start) + ':help\necho Open PageLingo-MT.cmd, then run:\necho   .\\run-pagelingo-quality-v2.cmd check\necho   .\\run-pagelingo-quality-v2.cmd\necho GPU training and BF16 only. Q5 and Firefox run on Cloud. No model uploads.\nexit /b 0\n:usage\necho Usage: run-pagelingo-quality-v2.cmd [check^|run]\nexit /b 2\n' + cmd.slice(end);
await writeFile(path.join(output, "run-pagelingo-quality-v2.cmd"), cmd.replace(/\r?\n/gu, "\r\n"));
console.log(JSON.stringify({output, source_commit: manifest.source_commit, source_dirty: manifest.source_dirty, files: Object.keys(manifest.files).length}));
