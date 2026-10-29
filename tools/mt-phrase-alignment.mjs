// Cloud research: translate a protected sentence and its formatting labels independently.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {parseArgs} from "node:util";
import {pathToFileURL} from "node:url";
import path from "node:path";
import {build} from "esbuild";
import {fixtureDom, projectRoot} from "./mt-quality-runtime.mjs";

const hash = text => createHash("sha256").update(text).digest("hex");
const {values, positionals} = parseArgs({allowPositionals: true, options: {
  input: {type: "string"}, output: {type: "string"}, results: {type: "string"},
}});
const mode = positionals[0];
if (!values.input || !values.output || !["plan", "replay"].includes(mode)) throw new Error("plan --input SENTENCE_PLAN --output PLAN | replay --input PLAN --results RUN --output REPORT");
const entries = ["eval/mt-quality/phrase-alignment.ts", "eval/mt-quality/sentence-alignment.ts", "eval/mt-quality/protocol.ts", "src/core/page-translator.ts"];
const outfile = path.join(projectRoot, "artifacts/mt-quality/phrase-alignment.mjs");
await mkdir(path.dirname(outfile), {recursive: true});
await build({stdin: {contents: entries.map(file => `export * from ${JSON.stringify("./" + file)};`).join("\n"), resolveDir: projectRoot},
  bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent"});
const api = await import(pathToFileURL(outfile).href + "?t=" + Date.now());
const raw = await readFile(values.input), input = JSON.parse(raw);
const files = [...entries, "tools/mt-phrase-alignment.mjs", "tools/mt-sentence-native.py", "src/providers/pagelingo-mt/fixed-text.ts",
  "src/core/fixed-text-render.ts", "src/core/rich-segment.ts", "src/core/translation-quality.ts"];
const sourceHashes = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(path.join(projectRoot, file)))])));
let result;
if (mode === "plan") {
  const jobs = [];
  for (const sample of input.cases) {
    const dom = fixtureDom(sample.context_url);
    try {
      const p = api.prepareQualityCase(sample), encoded = api.encodeSentenceAlignment(p.request.html, p.segment.opaque);
      const context = `Protected context (JSON, reference only; output tokens, not their contents):\n${JSON.stringify(encoded.protectedContext)}`;
      const full = encoded.source.replace(/⟦\/?\d+⟧/gu, "");
      const prefix = `Translate the following English into Simplified Chinese. Preserve all actions, participants, negation and temporal relationships. Output only the translation. Keep each protected token exactly once and unchanged, in its original order. Do not add HTML, formatting markers, labels or explanations.\n${context}\n`;
      jobs.push({case_id: sample.id, variant: "draft", request: {messages: [{role: "user", content: prefix + "English:\n" + full}], grammar: null, max_tokens: p.maxTokens}});
      for (const label of api.sentenceAlignmentLabels(encoded)) {
        // A code-only link already has an exact immutable target; no model call required.
        if (/^(?:⟪P\d+⟫|\s)+$/u.test(label.source)) continue;
        const content = `Translate only the specified English phrase into Simplified Chinese, using the sentence as context. Output only the phrase translation. Do not translate the rest of the sentence or add labels, HTML or explanations. Preserve any protected tokens exactly.\n${context}\nSentence:\n${full}\nPhrase:\n${label.source}\nChinese phrase:`;
        jobs.push({case_id: sample.id, variant: `phrase_${label.id}`, request: {messages: [{role: "user", content}], grammar: null, max_tokens: 96}});
      }
      p.scope.remove();
    } finally {dom.window.close();}
  }
  result = {schema_version: 1, protocol: "sentence-alignment-research-v1", method: "independent-phrase-exact-unique-monotone",
    scope: "Known failures, not blind accuracy. Independent phrase translation is not proof of meaning. Additional model calls and latency are measured. Ambiguous, absent, non-monotone or unassigned text rejects the paragraph. Not enabled in production.",
    input_sha256: hash(raw), source_hashes: sourceHashes, cases: input.cases, jobs};
} else {
  assert.deepEqual(sourceHashes, input.source_hashes, "Research source changed after freezing plan");
  const runRaw = await readFile(values.results), run = JSON.parse(runRaw);
  assert.equal(run.plan_sha256, hash(raw)); assert.equal(run.generations.length, input.jobs.length);
  for (const [index, job] of input.jobs.entries()) {
    const generation = run.generations[index];
    assert.equal(generation.case_id, job.case_id); assert.equal(generation.variant, job.variant);
    assert.equal(generation.request_sha256, hash(JSON.stringify(job.request)));
  }
  const rows = [];
  for (const sample of input.cases) {
    const dom = fixtureDom(sample.context_url);
    try {
      const p = api.prepareQualityCase(sample), before = p.scope.innerHTML;
      const generations = run.generations.filter(row => row.case_id === sample.id);
      const nodes = [p.root, ...p.root.querySelectorAll("*")].map(node => ({node, children: [...node.childNodes],
        attrs: JSON.stringify([...node.attributes].map(a => [a.name, a.value]))}));
      const code = [...p.scope.querySelectorAll("code,kbd,samp,var")].map(node => ({node, html: node.outerHTML}));
      let calls = 0, reason = null, aligned = null;
      const warnings = [], warn = console.warn; console.warn = (...args) => warnings.push(args.map(String).join(" "));
      const translator = new api.PageTranslator(document, {prefersWholeSentenceHtml: async () => true, translateHtml: async request => {
        calls++; assert.equal(request.html, p.request.html);
        try {
          if (generations.some(row => row.finish_reason !== "stop")) throw new Error("Phrase or draft generation incomplete");
          const encoded = api.encodeSentenceAlignment(request.html, p.segment.opaque);
          const phrases = new Map(api.sentenceAlignmentLabels(encoded).map(label => [label.id,
            /^(?:⟪P\d+⟫|\s)+$/u.test(label.source) ? label.source.trim() : generations.find(row => row.variant === `phrase_${label.id}`)?.text.trim()]));
          const projected = api.alignTranslatedPhrases(encoded, generations.find(row => row.variant === "draft").text, phrases);
          aligned = projected.aligned;
          const checked = api.checkSentenceAlignment(request, api.encodeSentenceAlignment(request.html, p.segment.opaque), projected.aligned, "stop");
          if (!checked.accepted) throw new Error(checked.reason);
          return checked.html;
        } catch (error) {reason = String(error); throw error;}
      }}, {displayMode: "translation", concurrency: 1, sourceLanguage: "en", targetLanguage: "zh-Hans"});
      try {
        await translator.translateAll(p.scope); assert.equal(calls, 1);
        const row = {case_id: sample.id, displayed: translator.translatedCount === 1, reason, aligned,
          translated_text: p.scope.textContent, translated_html: p.scope.innerHTML,
          original_structure_unchanged: nodes.every(item => item.node.isConnected && item.attrs === JSON.stringify([...item.node.attributes].map(a => [a.name, a.value]))
            && item.children.length === item.node.childNodes.length && item.children.every((child, i) => child === item.node.childNodes[i])),
          code_unchanged: code.every(item => item.node.isConnected && item.node.outerHTML === item.html), warnings};
        translator.setDisplayMode("bilingual"); translator.setDisplayMode("translation"); translator.restore();
        row.restored_exact = p.scope.innerHTML === before;
        assert.ok(row.original_structure_unchanged && row.code_unchanged && row.restored_exact);
        rows.push(row);
      } finally {console.warn = warn; p.scope.remove();}
    } finally {dom.window.close();}
  }
  result = {schema_version: 1, plan_sha256: hash(raw), run_sha256: hash(runRaw), model: run.model, rows};
}
await mkdir(path.dirname(path.resolve(values.output)), {recursive: true});
await writeFile(values.output, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({output: values.output, jobs: result.jobs?.length, rows: result.rows?.length}));
