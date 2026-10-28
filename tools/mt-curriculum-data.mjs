import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {fixtureDom, projectRoot, qualityRuntime, readCases} from './mt-quality-runtime.mjs';
import {targetedCases, repairedFamilies, trainTemplates, validationTemplates, assertSlotOwnership} from '../training/mt-fixed-slots/targeted-v3.mjs';
import {targetedCases as legacyCases} from '../training/mt-fixed-slots/targeted-v2.mjs';
import {releaseCases} from '../eval/mt-quality/release-v2.mjs';

const {values} = parseArgs({options: {out: {type: 'string', default: 'artifacts/mt-quality/targeted-v3'}}});
const hash = raw => createHash('sha256').update(raw).digest('hex');
const api = await qualityRuntime(), output = path.resolve(values.out);
const excluded = [...await readCases('eval/mt-quality/cases.json'), ...releaseCases(),
  ...await readCases('training/mt-fixed-slots/seed.json'), ...await readCases('eval/mt-quality/external/flores200-32.json'),
  ...legacyCases().filter(sample => sample.split === 'validation')];
const sources = new Set(), prompts = new Set(), ids = new Set(), families = new Map(), splits = {train: [], validation: []};
for (const sample of excluded) {
  const dom = fixtureDom(sample.context_url);
  try {sources.add(api.canonicalSource(sample)); prompts.add(api.prepareQualityCase(sample).prompt);}
  finally {dom.window.close();}
}
const review = ['# v3 reference ownership review', '',
  'Assistant-authored and audited synthetic curriculum; no independent human review. Noun variants are not independent examples.',
  'The production prompt, grammar and DOM renderer are unchanged. Earlier v2 exports remain reproducible.',
  'Both new splits exclude the frozen release, seed, FLORES and all 64 old validation source sentences.',
  'v3 reuses training sentences from v2, with the following reference-only repairs. Corrections keep actions before protected code in their original source slots.',
  '', 'Repaired families: ' + repairedFamilies.join(', '), ''];
let repairedRows = 0, annotatedRows = 0;
for (const sample of targetedCases()) {
  assertSlotOwnership(sample);
  const dom = fixtureDom(sample.context_url);
  try {
    assert.ok(!ids.has(sample.id), 'Duplicate id: ' + sample.id); ids.add(sample.id);
    const canonical = api.canonicalSource(sample);
    assert.ok(!sources.has(canonical), 'Duplicate or frozen evaluation overlap: ' + sample.id); sources.add(canonical);
    assert.ok(!families.has(sample.family) || families.get(sample.family) === sample.split, 'Cross-split template family');
    families.set(sample.family, sample.split);
    const prepared = api.prepareQualityCase(sample), calls = api.qualityCallPlan(prepared.request);
    assert.equal(calls.length, 1, 'Expected one production call: ' + sample.id);
    assert.equal(calls[0].messages[0].content, prepared.prompt);
    assert.ok(!prompts.has(prepared.prompt), 'Duplicate or frozen prompt overlap: ' + sample.id); prompts.add(prepared.prompt);
    const sourceSlots = [...prepared.source.matchAll(/⟦(\d+)⟧([\s\S]*?)⟦\/\1⟧/gu)].map(match => match[2]);
    assert.equal(sourceSlots.length, sample.reference_slots.length);
    const row = {id: sample.id, split: sample.split, family: sample.family, category: sample.category,
      origin: sample.origin, review_status: sample.review_status, semantic_contract: sample.semantic_contract,
      source_html: sample.html, slot_contracts: sample.slot_contracts ?? [],
      messages: [{role: 'user', content: prepared.prompt}, {role: 'assistant', content: prepared.target}]};
    splits[sample.split].push(row);
    repairedRows += Number(Boolean(sample.reference_repaired)); annotatedRows += Number(Boolean(sample.slot_contracts?.length));
    if (sample.id.endsWith('-0')) {
      review.push('## ' + sample.family + ' (' + sample.split + ')', '', sample.semantic_contract, '',
        sample.html, '', '```json', JSON.stringify(sourceSlots.map((source, slot) => ({slot, source, reference: sample.reference_slots[slot]})), null, 2), '```', '');
    }
    prepared.scope.remove();
  } finally {dom.window.close();}
}
await mkdir(output, {recursive: true});
const manifest = {schema_version: 1, protocol: 'production-fixed-text-v1', corpus: 'targeted-synthetic-v3',
  dataset_revision: 'v3-source-slot-ownership', generated_utc: new Date().toISOString(),
  provenance: 'Assistant-authored references, not independently human reviewed; experimental candidates only.',
  repaired_families: repairedFamilies, repaired_training_rows: repairedRows, annotated_rows: annotatedRows,
  template_families: {train: trainTemplates.length, validation: validationTemplates.length},
  checks: {unique_ids: true, unique_sources_and_prompts: true, disjoint_template_families: true,
    frozen_evaluation_and_legacy_validation_overlap: false, production_decoder: true, actual_call_plan: true,
    annotated_slot_ownership: true, production_prompt_changed: false}, files: {}, source_hashes: {}};
for (const [split, rows] of Object.entries(splits)) {
  const raw = rows.map(row => JSON.stringify(row)).join('\n') + '\n', file = split + '.jsonl';
  await writeFile(path.join(output, file), raw);
  manifest.files[split] = {file, rows: rows.length, sha256: hash(raw)};
}
for (const file of ['training/mt-fixed-slots/targeted-v2.mjs', 'training/mt-fixed-slots/targeted-v2b.mjs', 'training/mt-fixed-slots/targeted-v3.mjs',
  'eval/mt-quality/protocol.ts', 'src/core/translation-quality.ts', 'src/providers/pagelingo-mt/fixed-text.ts',
  'src/providers/pagelingo-mt/inference.ts', 'src/providers/pagelingo-mt/word-ranges.ts', 'src/providers/pagelingo-mt/sentence-plan.ts',
  'src/core/rich-segment.ts', 'src/core/page-translator.ts']) manifest.source_hashes[file] = hash(await readFile(path.join(projectRoot, file)));
await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(path.join(output, 'template-review.md'), review.join('\n'));
console.log(JSON.stringify({output, rows: Object.fromEntries(Object.entries(splits).map(([split, rows]) => [split, rows.length])),
  families: manifest.template_families, repaired_training_rows: repairedRows, annotated_rows: annotatedRows}));
