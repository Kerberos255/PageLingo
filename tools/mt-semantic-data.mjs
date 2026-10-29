import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {parseArgs} from "node:util";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";
import {fixtureDom, projectRoot, readCases} from "./mt-quality-runtime.mjs";
import {semanticCases, assertDeclaredSlotContracts} from "../training/mt-fixed-slots/semantic-v4.mjs";
import {targetedCases as previous} from "../training/mt-fixed-slots/targeted-v3.mjs";
import {targetedCases as older} from "../training/mt-fixed-slots/targeted-v2.mjs";
import {releaseCases} from "../eval/mt-quality/release-v2.mjs";
const hash = raw => createHash("sha256").update(raw).digest("hex");
const {values} = parseArgs({options: {out: {type: "string", default: "artifacts/mt-quality/semantic-v4"}}});
const output = path.resolve(values.out), runtime = path.join(projectRoot, "artifacts/mt-quality/semantic-data-runtime.mjs");
await mkdir(path.dirname(runtime), {recursive: true});
await build({stdin: {contents: ['export * from "./eval/mt-quality/protocol.ts";', 'export * from "./eval/mt-quality/semantic-rewrite.ts";',
  'export {serializeRichSegment} from "./src/core/rich-segment.ts";', 'export {collectTranslationRoots} from "./src/core/dom-policy.ts";',
  'export {encodeFixedMtText} from "./src/providers/pagelingo-mt/fixed-text.ts";'].join("\n"), resolveDir: projectRoot},
  bundle: true, format: "esm", platform: "node", outfile: runtime, logLevel: "silent"});
const api = await import(pathToFileURL(runtime).href + "?t=" + Date.now());
const excluded = [...await readCases("eval/mt-quality/cases.json"), ...releaseCases(), ...await readCases("training/mt-fixed-slots/seed.json"),
  ...await readCases("eval/mt-quality/external/flores200-32.json"), ...previous(), ...older()];
const canonical = sample => sample.html.replace(/<[^>]*>/gu, "").replace(/\s+/gu, " ").trim().toLowerCase();
const forbidden = new Set(excluded.map(canonical)), forbiddenWire = new Set();
for (const sample of excluded) {
  const dom = fixtureDom(sample.context_url);
  try {
    const holder = document.createElement("article"); holder.innerHTML = sample.html; document.body.append(holder);
    // Old references may be obsolete. Build the source with the production
    // serializer without validating or silently skipping their target strings.
    const roots = api.collectTranslationRoots(holder, {preserveInlineContext: true});
    assert.equal(roots.length, 1, "Excluded case must have one source owner: " + sample.id);
    const segment = api.serializeRichSegment(roots[0], {fixedTextSlots: true});
    forbiddenWire.add(api.encodeFixedMtText(segment.html).source); holder.remove();
  } finally {dom.window.close();}
}
const ids = new Set(), sourceSplits = new Map(), wireSplits = new Map(), familySplits = new Map(), prompts = new Set();
const splits = {train: [], validation: []}, cases = semanticCases();
const review = ["# v4 paired semantic reference review", "", "Authored/audited synthetic pairs; not independently human reviewed. Three task views and contrastive drafts are not independent examples.",
  "Natural references and constrained paraphrases are separate. Checks below validate explicit per-slot terms, code identity and production decoding; they are not a general semantic equivalence checker.", ""];
const taskCounts = {train: {}, validation: {}}, caseCounts = {train: 0, validation: 0, holdout: 0};
for (const sample of cases) {
  const dom = fixtureDom(sample.context_url);
  try {
    assert.ok(!ids.has(sample.id), "Duplicate case ID"); ids.add(sample.id);
    assert.ok(sample.semantic_facts.length, "Missing declared semantic facts");
    assert.ok(!forbidden.has(canonical(sample)), "Existing training/evaluation source reused: " + sample.id);
    assert.ok(!sourceSplits.has(canonical(sample)), "Duplicate English source"); sourceSplits.set(canonical(sample), sample.split);
    assert.ok(!familySplits.has(sample.family) || familySplits.get(sample.family) === sample.split, "Family crosses splits"); familySplits.set(sample.family, sample.split);
    const p = api.prepareQualityCase(sample), encoded = api.prepareSemanticRewrite(p.request, p.segment.opaque);
    assert.ok(!forbiddenWire.has(encoded.fixed.source), "Existing model-visible English reused: " + sample.id);
    assert.ok(!wireSplits.has(encoded.fixed.source), "Duplicate/delexicalized wire source: " + sample.id); wireSplits.set(encoded.fixed.source, sample.split);
    assertDeclaredSlotContracts(sample);
    assert.ok(!/[⟦⟧⟪⟫]/u.test(sample.natural_reference), "Natural reference must not contain transport markers");
    for (const text of new Set(encoded.protectedContext.filter(part => ["code", "kbd", "samp", "var"].includes(part.kind)).map(part => part.text))) {
      assert.equal(sample.natural_reference.split(text).length, encoded.sourceText.split(text).length, "Natural code count changed: " + sample.id);
    }
    caseCounts[sample.split]++;
    const rows = [
      {task: "natural", draft_kind: null, prompt: api.naturalTranslationPrompt(encoded), target: sample.natural_reference},
      {task: "fixed", draft_kind: null, prompt: api.semanticFixedPrompt(encoded), target: p.target},
      {task: "rewrite", draft_kind: "clean_reference", prompt: api.semanticFixedPrompt(encoded, sample.natural_reference), target: p.target},
    ];
    if (sample.contrastive_draft) {
      assert.equal(sample.split, "train", "Corrupt-guide augmentation belongs to training only");
      assert.notEqual(sample.contrastive_draft, sample.natural_reference);
      rows.push({task: "rewrite", draft_kind: "synthetic_contradiction", prompt: api.semanticFixedPrompt(encoded, sample.contrastive_draft), target: p.target});
    }
    if (sample.split !== "holdout") for (const row of rows) {
      assert.ok(!prompts.has(row.prompt), "Duplicate actual task prompt"); prompts.add(row.prompt);
      splits[sample.split].push({id: `${sample.id}/${row.task}/${row.draft_kind ?? "none"}`, pair_id: sample.id, split: sample.split,
        family: sample.family, task: row.task, draft_kind: row.draft_kind, origin: sample.origin, review_status: sample.review_status,
        source_html: sample.html, semantic_facts: sample.semantic_facts, slot_contracts: sample.slot_contracts,
        messages: [{role: "user", content: row.prompt}, {role: "assistant", content: row.target}]});
      taskCounts[sample.split][row.task] = (taskCounts[sample.split][row.task] ?? 0) + 1;
    }
    const restore = value => value.replace(/__FLT_OPAQUE_(\d+)__/gu, (_whole, id) => p.segment.opaque[Number(id)].text).replace(/__FLT_LINK_(?:START|END)_\d+__/gu, "");
    const constrained = restore(new DOMParser().parseFromString(p.referenceHtml, "text/html").body.textContent ?? "");
    review.push(`## ${sample.id} (${sample.split})`, "", "English: " + encoded.sourceText, "", "Natural: " + sample.natural_reference,
      "", "Constrained: " + constrained, "", "Facts: `" + JSON.stringify(sample.semantic_facts) + "`", "", "```json",
      JSON.stringify(encoded.fixed.texts.map(slot => ({id: slot.id, roles: encoded.textRoles[slot.id].roles, english: slot.source, chinese: sample.reference_slots[slot.id]})), null, 2), "```", "");
    p.scope.remove();
  } finally {dom.window.close();}
}
const sourceFiles = ["training/mt-fixed-slots/semantic-v4.mjs", "eval/mt-quality/semantic-rewrite.ts", "eval/mt-quality/protocol.ts", "src/providers/pagelingo-mt/fixed-text.ts",
  "src/core/rich-segment.ts", "src/core/dom-policy.ts", "src/core/fixed-text-render.ts", "src/core/translation-quality.ts", "src/providers/pagelingo-mt/word-ranges.ts", "tools/mt-semantic-data.mjs",
  "training/mt-fixed-slots/targeted-v2.mjs", "training/mt-fixed-slots/targeted-v3.mjs", "training/mt-fixed-slots/seed.json", "eval/mt-quality/release-v2.mjs",
  "eval/mt-quality/cases.json", "eval/mt-quality/external/flores200-32.json"];
const manifest = {schema_version: 1, protocol: "semantic-rewrite-multitask-v1", corpus: "semantic-rewrite-v4", dataset_revision: "v4-paired-meaning-and-node-paraphrase",
  review_status: "assistant_audited_synthetic", independently_human_reviewed: false, case_counts: caseCounts, task_counts: taskCounts,
  scope: "Bounded synthetic training pilot; multiple task views are not independent cases; clean-guide validation loss is not runtime chain accuracy.",
  families: Object.fromEntries(["train", "validation", "holdout"].map(split => [split, [...familySplits].filter(([, value]) => value === split).length])),
  checks: {unique_sources: true, unique_delexicalized_wire: true, unique_task_prompts: true, existing_corpora_overlap: false, disjoint_families: true,
    fixed_reference_decoder: true, annotated_slot_terms: true, natural_code_identity: true, holdout_in_optimizer_inputs: false, semantic_equivalence_automatically_proven: false},
  files: {}, source_hashes: Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await readFile(path.join(projectRoot, file)))])))};
await mkdir(output, {recursive: true});
for (const [split, rows] of Object.entries(splits)) {
  const raw = rows.map(row => JSON.stringify(row)).join("\n") + "\n", file = split + ".jsonl";
  await writeFile(path.join(output, file), raw); manifest.files[split] = {file, rows: rows.length, sha256: hash(raw)};
}
const rawCases = JSON.stringify({schema_version: 1, cases}, null, 2) + "\n";
await writeFile(path.join(output, "evaluation-cases.json"), rawCases);
manifest.evaluation_cases = {file: "evaluation-cases.json", sha256: hash(rawCases), rows: cases.length, optimizer_input: false};
await writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
await writeFile(path.join(output, "reference-review.md"), review.join("\n"));
console.log(JSON.stringify({output, cases: caseCounts, tasks: taskCounts, families: manifest.families, checks: manifest.checks}));
