// Read only known training/validation files and model metadata. Never read auth caches.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "..");
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const load = name => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
const sources = new Map(), families = new Map();
const report = {schema_version: 1, root, generated_utc: new Date().toISOString(),
  scope: "Known train/validation sources and checkpoint metadata only. Holdout/final exam contents and credential caches were not read.",
  files: [], cross_split_source_groups: [], cross_split_template_families: [], models: {}};
const variants = ["hymt-v0.2", "hymt-v0.2.1-repair", "hymt-v0.2.2-micro-repair", "hymt-v0.3-product-envelope",
  "smoke-v1", "smoke-v1.1", "smoke-v1.2", "smoke-v1.2.1"];
for (const split of ["train", "validation"]) for (const variant of variants) {
  const name = `data/${split}/${variant}.jsonl`, file = path.join(root, name);
  if (!fs.existsSync(file)) continue;
  const raw = fs.readFileSync(file), rows = raw.toString("utf8").split(/\r?\n/u).filter(x => x.trim()).map(x => JSON.parse(x));
  let differentSequence = 0, legacyPrompt = 0;
  const prompts = new Set();
  for (const row of rows) {
    const source = row.source ?? "", target = row.target ?? "";
    const tokens = value => value.match(/⟦\/?\d+⟧|⟪P\d+⟫/gu) ?? [];
    if (JSON.stringify(tokens(source)) !== JSON.stringify(tokens(target))) differentSequence++;
    const prompt = row.prompt?.[0]?.content ?? "";
    if (prompt.includes("may move") || prompt.includes("Protected slots may move")) legacyPrompt++;
    prompts.add(digest(prompt));
    const canonical = source.replace(/\s+/gu, " ").trim().toLowerCase();
    const key = digest(canonical), entry = sources.get(key) ?? {source_sha256: key, splits: new Set(), files: new Set(), rows: 0};
    entry.splits.add(split); entry.files.add(name); entry.rows++; sources.set(key, entry);
    const family = (row.template_family ?? "").replace(/^(?:train|validation)[-_]/u, "");
    if (family) {const seen = families.get(family) ?? new Set(); seen.add(split); families.set(family, seen);}
  }
  report.files.push({path: name, bytes: raw.length, sha256: digest(raw), rows: rows.length,
    unique_legacy_prompts: prompts.size, legacy_movable_marker_prompts: legacyPrompt,
    source_target_token_sequence_differs: differentSequence,
    import_status: "Requires production fixed-slot conversion and reference review; never concatenate directly into new training"});
}
for (const entry of sources.values()) if (entry.splits.size > 1)
  report.cross_split_source_groups.push({...entry, splits: [...entry.splits], files: [...entry.files]});
for (const [family, splits] of families) if (splits.size > 1)
  report.cross_split_template_families.push({normalized_family: family, splits: [...splits]});
const adapter = "outputs/pagelingo-hymt-1.8b-v0.2.2-micro-repair/final";
const adapterFile = path.join(root, adapter, "adapter_model.safetensors");
const hashFile = file => new Promise((resolve, reject) => {
  const hash = crypto.createHash("sha256");
  fs.createReadStream(file).on("data", chunk => hash.update(chunk)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
});
(async () => {
  const lock = load("outputs/v022-q5-final-candidate-lock.json");
  const actual = await hashFile(adapterFile);
  report.models.v022_final_adapter = {path: adapter, bytes: fs.statSync(adapterFile).size, sha256: actual,
    locked_checkpoint10_sha256: lock.adapter.sha256, matches_locked_checkpoint10: actual === lock.adapter.sha256,
    adapter_config: load(adapter + "/adapter_config.json"), training_config: load(adapter + "/training_config.json")};
  const base = "models/hy-mt2-1.8b/model.safetensors";
  report.models.base = {path: base, bytes: fs.statSync(path.join(root, base)).size,
    hash_status: "Full base SHA256 is checked on the GPU PC by train.py before optimization; not streamed over SMB here"};
  const packages = path.join(root, ".venv/Lib/site-packages");
  report.installed_package_directories = fs.readdirSync(packages).filter(name => /^(torch|transformers|peft|accelerate|tokenizers|safetensors)-.*dist-info$/u.test(name));
  const outAt = process.argv.indexOf("--out");
  if (outAt >= 0) {
    const output = path.resolve(process.argv[outAt + 1]);
    if (!output.startsWith(path.resolve(__dirname) + path.sep)) throw new Error("Audit output must remain inside the staged kit directory");
    fs.mkdirSync(path.dirname(output), {recursive: true});
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  }
  if (process.argv.includes("--summary")) console.log(JSON.stringify({files: report.files.length,
    train_rows: report.files.filter(r => r.path.startsWith("data/train/")).reduce((s, r) => s + r.rows, 0),
    validation_rows: report.files.filter(r => r.path.startsWith("data/validation/")).reduce((s, r) => s + r.rows, 0),
    legacy_movable_marker_prompts: report.files.reduce((s, r) => s + r.legacy_movable_marker_prompts, 0),
    cross_split_source_groups: report.cross_split_source_groups.length,
    cross_split_template_families: report.cross_split_template_families.length,
    v022_final_adapter: {sha256: actual, matches_locked_checkpoint10: actual === lock.adapter.sha256}}));
  else console.log(JSON.stringify(report, null, 2));
})().catch(error => {console.error(error); process.exitCode = 1;});
