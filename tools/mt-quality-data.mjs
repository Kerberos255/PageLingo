import {mkdir, readFile, writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";
import {parseArgs} from "node:util";
import {fixtureDom, projectRoot, qualityRuntime, readCases} from "./mt-quality-runtime.mjs";

const {values} = parseArgs({options: {out: {type: "string", default: "artifacts/mt-quality/data"}}});
const directory = path.resolve(values.out);
await mkdir(directory, {recursive: true});
const api = await qualityRuntime();
const evaluation = await readCases("eval/mt-quality/cases.json");
const seed = await readCases("training/mt-fixed-slots/seed.json");
const sourceGroups = new Map(), wireGroups = new Map(), ids = new Set(), families = new Map(), output = new Map();
for (const sample of [...evaluation, ...seed]) {
  const dom = fixtureDom(sample.context_url);
  try {
    if (ids.has(sample.id)) throw new Error("Duplicate sample ID: " + sample.id);
    ids.add(sample.id);
    const canonical = api.canonicalSource(sample);
    if (sourceGroups.has(canonical)) throw new Error("Duplicate/cross-split English source: " + sample.id);
    sourceGroups.set(canonical, sample.id);
    const previous = families.get(sample.family);
    if (previous && previous !== sample.split) throw new Error("Cross-split template family: " + sample.family);
    families.set(sample.family, sample.split);
    const item = api.prepareQualityCase(sample);
    const wireKey = item.prompt + "\u0000" + item.grammar;
    if (wireGroups.has(wireKey)) throw new Error("Duplicate actual inference prompt: " + sample.id + " / " + wireGroups.get(wireKey));
    wireGroups.set(wireKey, sample.id);
    const failed = api.checkContentProbes(sample, item.referenceHtml).filter(row => !row.passed);
    if (failed.length) throw new Error("Reference fails its own declared probes: " + sample.id + " " + failed.map(x => x.id));
    const row = {id: sample.id, split: sample.split, family: sample.family, category: sample.category,
      origin: sample.origin, review_status: sample.review_status, source_html: sample.html,
      messages: [{role: "user", content: item.prompt}, {role: "assistant", content: item.target}]};
    const rows = output.get(sample.split) ?? []; rows.push(row); output.set(sample.split, rows);
  } finally {dom.window.close();}
}
const manifest = {schema_version: 1, protocol: "production-fixed-text-v1", generated_utc: new Date().toISOString(),
  provenance: "Assistant-authored references; human review pending. Not a production training corpus or accuracy benchmark.",
  checks: {unique_ids: true, unique_canonical_sources: true, unique_inference_prompts: true, disjoint_template_families: true,
    production_decoder: true, reference_probes: true}, files: {}};
for (const [split, rows] of output) {
  const contents = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  const filename = split + ".jsonl";
  await writeFile(path.join(directory, filename), contents);
  manifest.files[split] = {file: filename, rows: rows.length, sha256: createHash("sha256").update(contents).digest("hex")};
}
manifest.source_hashes = {};
for (const file of ["eval/mt-quality/cases.json", "training/mt-fixed-slots/seed.json", "src/providers/pagelingo-mt/fixed-text.ts", "src/providers/pagelingo-mt/sentence-plan.ts", "src/core/rich-segment.ts"])
  manifest.source_hashes[file] = createHash("sha256").update(await readFile(path.join(projectRoot, file))).digest("hex");
await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({directory, splits: Object.fromEntries([...output].map(([key, rows]) => [key, rows.length])), checks: manifest.checks}));
