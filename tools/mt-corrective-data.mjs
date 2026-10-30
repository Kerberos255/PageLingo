import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {parseArgs} from "node:util";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";
import {fixtureDom, projectRoot, readCases} from "./mt-quality-runtime.mjs";
import {correctiveCases, assertCorrectiveReference} from "../training/mt-fixed-slots/corrective-v5.mjs";
import {semanticCases} from "../training/mt-fixed-slots/semantic-v4.mjs";
import {targetedCases as v3} from "../training/mt-fixed-slots/targeted-v3.mjs";
import {targetedCases as v2} from "../training/mt-fixed-slots/targeted-v2.mjs";
import {releaseCases} from "../eval/mt-quality/release-v2.mjs";
const {values} = parseArgs({options: {out: {type: "string", default: "artifacts/mt-quality/corrective-v5"}}});
const output = path.resolve(values.out), hash = raw => createHash("sha256").update(raw).digest("hex");
const runtime = path.join(projectRoot, "artifacts/mt-quality/corrective-data-runtime.mjs"); await mkdir(path.dirname(runtime), {recursive: true});
await build({stdin: {contents: ['export * from "./eval/mt-quality/protocol.ts";', 'export * from "./eval/mt-quality/semantic-rewrite.ts";',
  'export {serializeRichSegment} from "./src/core/rich-segment.ts";', 'export {collectTranslationRoots} from "./src/core/dom-policy.ts";',
  'export {encodeFixedMtText} from "./src/providers/pagelingo-mt/fixed-text.ts";'].join("\n"), resolveDir: projectRoot},
  bundle: true, platform: "node", format: "esm", outfile: runtime, logLevel: "silent"});
const api = await import(pathToFileURL(runtime).href + "?t=" + Date.now());
const excluded = [...semanticCases(), ...v3(), ...v2(), ...releaseCases(), ...await readCases("eval/mt-quality/cases.json"),
  ...await readCases("training/mt-fixed-slots/seed.json"), ...await readCases("eval/mt-quality/external/flores200-32.json")];
const forbidden = new Set(), forbiddenWire = new Set();
for (const sample of excluded) {
  const dom = fixtureDom(sample.context_url);
  try {
    const holder = document.createElement("article"); holder.innerHTML = sample.html; document.body.append(holder);
    forbidden.add(api.canonicalSource(sample));
    const roots = api.collectTranslationRoots(holder, {preserveInlineContext: true}); assert.equal(roots.length, 1, sample.id);
    forbiddenWire.add(api.encodeFixedMtText(api.serializeRichSegment(roots[0], {fixedTextSlots: true}).html).source); holder.remove();
  } finally {dom.window.close();}
}
const cases = correctiveCases(), ids = new Set(), sources = new Set(), wires = new Set(), families = new Map();
const rows = {legacy: {train: [], validation: []}, roles: {train: [], validation: []}}, validation = [], caseCounts = {train: 0, validation: 0, holdout: 0};
const review = ["# v5 fixed-slot reference review", "", "Assistant-authored/audited synthetic references, not independently human reviewed.",
  "Legacy and roles candidates use the SAME source order, reference slots, loss and optimizer settings. Only their prompts differ. No natural or rewrite target enters optimization.",
  "Explicit lexical/scope assertions and production decoding are necessary checks, not proof of general semantic equivalence.", ""];
for (const sample of cases) {
  const dom = fixtureDom(sample.context_url);
  try {
    assertCorrectiveReference(sample); assert.ok(!ids.has(sample.id)); ids.add(sample.id);
    const source = api.canonicalSource(sample); assert.ok(!forbidden.has(source) && !sources.has(source), "Reused English source: " + sample.id); sources.add(source);
    assert.ok(!families.has(sample.family) || families.get(sample.family) === sample.split, "Family crosses split"); families.set(sample.family, sample.split);
    const p = api.prepareQualityCase(sample), encoded = api.prepareSemanticRewrite(p.request, p.segment.opaque);
    assert.ok(!forbiddenWire.has(encoded.fixed.source) && !wires.has(encoded.fixed.source), "Reused model-visible source: " + sample.id); wires.add(encoded.fixed.source);
    assert.ok(!/[⟦⟧⟪⟫]/u.test(sample.natural_reference));
    for (const text of new Set(encoded.protectedContext.filter(part => ["code", "kbd", "samp", "var"].includes(part.kind)).map(part => part.text)))
      assert.equal(sample.natural_reference.split(text).length, encoded.sourceText.split(text).length, "Code literal count changed: " + sample.id);
    caseCounts[sample.split]++;
    if (sample.split !== "holdout") for (const [variant, prompt] of [["legacy", p.prompt], ["roles", api.semanticFixedPrompt(encoded)]]) {
      const row = {id: sample.id + "/fixed/" + variant, pair_id: sample.id, split: sample.split, family: sample.family,
        task: "fixed", prompt_variant: variant, origin: sample.origin, review_status: sample.review_status,
        source_html: sample.html, semantic_facts: sample.semantic_facts, messages: [{role: "user", content: prompt}, {role: "assistant", content: p.target}]};
      rows[variant][sample.split].push(row); if (sample.split === "validation") validation.push(row);
    }
    review.push(`## ${sample.id} (${sample.split})`, "", sample.html, "", "Meaning reference: " + sample.natural_reference,
      "", "Declared facts: " + JSON.stringify(sample.semantic_facts), "", "Slots: " + JSON.stringify(sample.reference_slots), "", p.target, "");
    p.scope.remove();
  } finally {dom.window.close();}
}
assert.deepEqual(caseCounts, {train: 64, validation: 8, holdout: 8});
for (const split of ["train", "validation"]) {
  assert.deepEqual(rows.legacy[split].map(r => r.pair_id), rows.roles[split].map(r => r.pair_id));
  assert.deepEqual(rows.legacy[split].map(r => r.messages[1]), rows.roles[split].map(r => r.messages[1]));
  assert.ok(rows.legacy[split].every((r, i) => r.messages[0].content !== rows.roles[split][i].messages[0].content));
}
const sourceFiles = ["training/mt-fixed-slots/corrective-v5.mjs", "tools/mt-corrective-data.mjs", "eval/mt-quality/protocol.ts", "eval/mt-quality/semantic-rewrite.ts",
  "src/providers/pagelingo-mt/fixed-text.ts", "src/core/rich-segment.ts", "src/core/dom-policy.ts", "src/core/fixed-text-render.ts", "src/core/translation-quality.ts",
  "training/mt-fixed-slots/semantic-v4.mjs", "training/mt-fixed-slots/targeted-v3.mjs", "training/mt-fixed-slots/targeted-v2.mjs", "training/mt-fixed-slots/seed.json",
  "eval/mt-quality/cases.json", "eval/mt-quality/release-v2.mjs", "eval/mt-quality/external/flores200-32.json"];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async f => [f, hash(await readFile(path.join(projectRoot, f)))])));
const checks = {old_corpora_and_v4_holdout_excluded: true, delexicalized_wire_unique: true, disjoint_families: true,
  production_reference_decoder: true, annotated_actions_and_ranges: true, natural_reference_code_identity: true,
  identical_paired_sources_targets_order: true, draft_tasks_in_optimizer: false, semantic_equivalence_automatically_proven: false};
await mkdir(output, {recursive: true}); const variants = {};
for (const variant of ["legacy", "roles"]) {
  const folder = path.join(output, variant); await mkdir(folder, {recursive: true});
  const manifest = {schema_version: 1, protocol: "production-fixed-text-v1", corpus: "corrective-fixed-v5", prompt_variant: variant,
    dataset_revision: "v5-complete-actions-ownership-and-order", review_status: "assistant_audited_synthetic", independently_human_reviewed: false,
    source_hashes: sourceHashes, checks, files: {}, task_counts: {train: {fixed: 64}, validation: {fixed: 8}}};
  for (const split of ["train", "validation"]) {
    const raw = rows[variant][split].map(row => JSON.stringify(row)).join("\n") + "\n", file = split + ".jsonl";
    await writeFile(path.join(folder, file), raw); manifest.files[split] = {file, rows: rows[variant][split].length, sha256: hash(raw)};
  }
  const raw = JSON.stringify(manifest, null, 2) + "\n"; await writeFile(path.join(folder, "manifest.json"), raw);
  variants[variant] = {file: variant + "/manifest.json", sha256: hash(raw)};
}
const evaluationRaw = JSON.stringify({schema_version: 1, cases}, null, 2) + "\n";
await writeFile(path.join(output, "evaluation-cases.json"), evaluationRaw);
const validationRaw = validation.map(row => JSON.stringify(row)).join("\n") + "\n"; await writeFile(path.join(output, "evaluation-validation.jsonl"), validationRaw);
await writeFile(path.join(output, "reference-review.md"), review.join("\n"));
const manifest = {schema_version: 1, corpus: "corrective-fixed-v5", case_counts: caseCounts,
  families: Object.fromEntries(["train", "validation", "holdout"].map(split => [split, [...families.values()].filter(s => s === split).length])),
  variants, source_hashes: sourceHashes, checks, review_status: "assistant_audited_synthetic", independently_human_reviewed: false,
  evaluation_cases: {file: "evaluation-cases.json", rows: cases.length, sha256: hash(evaluationRaw), optimizer_input: false},
  evaluation_validation: {file: "evaluation-validation.jsonl", rows: validation.length, sha256: hash(validationRaw), optimizer_input: false}};
await writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({output, cases: caseCounts, train_rows_each: 64, validation_rows_each: 8, families: manifest.families, checks}));
