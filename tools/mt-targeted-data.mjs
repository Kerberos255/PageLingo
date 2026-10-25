import assert from "node:assert/strict";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";
import {parseArgs} from "node:util";
import {fixtureDom, projectRoot, qualityRuntime, readCases} from "./mt-quality-runtime.mjs";
import {targetedCases, trainTemplates, validationTemplates} from "../training/mt-fixed-slots/targeted-v2.mjs";
import {releaseCases} from "../eval/mt-quality/release-v2.mjs";

const {values} = parseArgs({options: {out: {type: "string", default: "artifacts/mt-quality/targeted-v2"}}});
const directory = path.resolve(values.out), api = await qualityRuntime();
const cases = targetedCases(), baseline = [...await readCases("eval/mt-quality/cases.json"), ...await readCases("training/mt-fixed-slots/seed.json"),
  ...releaseCases(), ...await readCases("eval/mt-quality/external/flores200-32.json")];
const ids = new Set(), sources = new Set(), prompts = new Set(), families = new Map(), output = new Map();
for (const sample of baseline) {
  const dom = fixtureDom(sample.context_url);
  try {sources.add(api.canonicalSource(sample)); prompts.add(api.prepareQualityCase(sample).prompt);}
  finally {dom.window.close();}
}
const review = ["# Targeted v2 synthetic references", "", "Authored and template-audited by the assistant; no independent human review. Not a semantic accuracy benchmark.",
  "Variants within one family are not independent examples. All families are confined to one split. Existing holdout/diagnostic text is excluded.", ""];
for (const sample of cases) {
  const dom = fixtureDom(sample.context_url);
  try {
    assert.ok(!ids.has(sample.id), "Duplicate ID: " + sample.id); ids.add(sample.id);
    const canonical = api.canonicalSource(sample);
    assert.ok(!sources.has(canonical), "Duplicate or evaluation-source overlap: " + sample.id); sources.add(canonical);
    assert.ok(!families.has(sample.family) || families.get(sample.family) === sample.split, "Cross-split family: " + sample.family);
    families.set(sample.family, sample.split);
    const p = api.prepareQualityCase(sample), plan = api.qualityCallPlan(p.request);
    assert.equal(plan.length, 1, sample.id + ": training target must match one actual production call");
    assert.equal(plan[0].messages[0].content, p.prompt);
    assert.ok(!prompts.has(p.prompt), "Duplicate actual prompt: " + sample.id); prompts.add(p.prompt);
    const row = {id: sample.id, split: sample.split, family: sample.family, category: sample.category,
      origin: sample.origin, review_status: sample.review_status, semantic_contract: sample.semantic_contract,
      source_html: sample.html, messages: [{role: "user", content: p.prompt}, {role: "assistant", content: p.target}]};
    const list = output.get(sample.split) ?? []; list.push(row); output.set(sample.split, list);
    if (sample.id.endsWith("-0")) review.push(`## ${sample.family} (${sample.split})`, "", sample.semantic_contract, "", sample.html, "", "```json", JSON.stringify(sample.reference_slots), "```", "", p.referenceHtml, "");
  } finally {dom.window.close();}
}
await mkdir(directory, {recursive: true});
const manifest = {schema_version: 1, protocol: "production-fixed-text-v1", corpus: "targeted-synthetic-v2",
  generated_utc: new Date().toISOString(), provenance: "Assistant-authored and template-audited synthetic data; no independent human review. Experimental candidates only.",
  checks: {unique_ids: true, unique_canonical_sources: true, unique_inference_prompts: true, disjoint_template_families: true,
    existing_evaluation_and_seed_overlap: false, production_decoder: true, actual_call_plan: true},
  template_families: {train: trainTemplates.length, validation: validationTemplates.length}, files: {}, source_hashes: {}};
for (const [split, rows] of output) {
  const raw = rows.map(row => JSON.stringify(row)).join("\n") + "\n", file = split + ".jsonl";
  await writeFile(path.join(directory, file), raw);
  manifest.files[split] = {file, rows: rows.length, sha256: createHash("sha256").update(raw).digest("hex")};
}
for (const file of ["training/mt-fixed-slots/targeted-v2.mjs", "eval/mt-quality/protocol.ts", "src/core/translation-quality.ts",
  "src/providers/pagelingo-mt/fixed-text.ts", "src/providers/pagelingo-mt/word-ranges.ts", "src/providers/pagelingo-mt/sentence-plan.ts", "src/core/rich-segment.ts"])
  manifest.source_hashes[file] = createHash("sha256").update(await readFile(path.join(projectRoot, file))).digest("hex");
await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
await writeFile(path.join(directory, "template-review.md"), review.join("\n"));
console.log(JSON.stringify({directory, rows: Object.fromEntries([...output].map(([key, rows]) => [key, rows.length])), families: manifest.template_families}));
