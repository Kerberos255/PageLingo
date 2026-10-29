// Cloud-only research harness. Never used by the extension or GPU launcher.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {parseArgs} from "node:util";
import {pathToFileURL} from "node:url";
import path from "node:path";
import {build} from "esbuild";
import {fixtureDom, projectRoot} from "./mt-quality-runtime.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const {values, positionals} = parseArgs({allowPositionals: true, options: {
  input: {type: "string"}, output: {type: "string"}, results: {type: "string"}, ids: {type: "string"},
}});
if (!values.input || !values.output || !["plan", "replay"].includes(positionals[0])) {
  throw new Error("plan --input CORPUS_OR_MATRIX --output PLAN [--ids comma,separated] | replay --input PLAN --results RUN --output REPORT");
}
const entries = ["eval/mt-quality/sentence-alignment.ts", "eval/mt-quality/protocol.ts", "src/core/page-translator.ts",
  "src/providers/pagelingo-mt/fixed-text.ts", "src/providers/pagelingo-mt/inference.ts"];
const outfile = path.join(projectRoot, "artifacts/mt-quality/sentence-alignment.mjs");
await mkdir(path.dirname(outfile), {recursive: true});
await build({stdin: {contents: entries.map(file => `export * from ${JSON.stringify("./" + file)};`).join("\n"), resolveDir: projectRoot},
  bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent"});
const api = await import(pathToFileURL(outfile).href + "?t=" + Date.now());
const sourceFiles = [...entries, "src/providers/pagelingo-mt/protocol.ts", "src/core/rich-segment.ts", "src/core/fixed-text-render.ts",
  "src/core/translation-quality.ts", "src/core/rich-segment-splitter.ts", "tools/mt-sentence-alignment.mjs"];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await readFile(path.join(projectRoot, file)))])));
const raw = await readFile(values.input), input = JSON.parse(raw);
let result;
if (positionals[0] === "plan") {
  const selected = values.ids ? new Set(values.ids.split(",")) : null;
  const cases = input.cases.filter(sample => !selected || selected.has(sample.id));
  if (!cases.length || selected && selected.size !== cases.length) throw new Error("Requested case IDs missing or duplicated");
  const jobs = [];
  for (const sample of cases) {
    const dom = fixtureDom(sample.context_url);
    try {
      const p = api.prepareQualityCase(sample);
      const encoded = api.encodeSentenceAlignment(p.request.html, p.segment.opaque);
      const legend = `Protected context (JSON, reference only; output its token instead of its content):\n${JSON.stringify(encoded.protectedContext)}\n`;
      const variants = [
        {variant: "fixed", messages: [{role: "user", content: p.prompt}], grammar: p.grammar},
        {variant: "fixed_context", messages: [{role: "user", content: p.prompt.replace("English:\n", legend + "English:\n")}], grammar: p.grammar},
        ...["sentence_free", "sentence_ordered"].map(variant => ({variant,
          messages: [{role: "user", content: api.sentenceAlignmentPrompt(encoded, p.request)}],
          grammar: variant === "sentence_ordered" ? api.sentenceAlignmentGrammar(encoded) : null})),
      ];
      for (const {variant, ...options} of variants) jobs.push({case_id: sample.id, variant, request: {...options, max_tokens: p.maxTokens},
        source: encoded.source, protected_context: encoded.protectedContext});
      p.scope.remove();
    } finally {dom.window.close();}
  }
  result = {schema_version: 1, protocol: "sentence-alignment-research-v1", input_sha256: hash(raw), source_hashes: sourceHashes,
    scope: "Known-failure mechanism diagnostic, not a blind accuracy benchmark. Same generation budget per case. Fixed/context isolate context; sentence variants also change framing and instructions. No production activation.",
    cases, jobs};
} else {
  assert.deepEqual(sourceHashes, input.source_hashes, "Research source changed since plan freeze");
  const resultsRaw = await readFile(values.results), run = JSON.parse(resultsRaw);
  assert.equal(run.plan_sha256, hash(raw), "Recorded run belongs to a different frozen plan");
  assert.equal(run.generations.length, input.jobs.length);
  const rows = [];
  for (const [index, job] of input.jobs.entries()) {
    const generation = run.generations[index];
    assert.equal(generation.request_sha256, hash(JSON.stringify(job.request)), "Request provenance mismatch");
    assert.equal(generation.case_id, job.case_id); assert.equal(generation.variant, job.variant);
    const sample = input.cases.find(item => item.id === job.case_id);
    const dom = fixtureDom(sample.context_url);
    try {
      const p = api.prepareQualityCase(sample), before = p.scope.innerHTML;
      const nodes = [p.root, ...p.root.querySelectorAll("*")].map(node => ({node, children: [...node.childNodes],
        attrs: JSON.stringify([...node.attributes].map(attribute => [attribute.name, attribute.value]))}));
      const code = [...p.scope.querySelectorAll("code,kbd,samp,var")].map(node => ({node, html: node.outerHTML}));
      let checked, calls = 0;
      const warnings = [], warn = console.warn;
      console.warn = (...args) => warnings.push(args.map(String).join(" "));
      const translator = new api.PageTranslator(document, {prefersWholeSentenceHtml: async () => true, translateHtml: async request => {
        assert.equal(request.html, p.request.html); calls++;
        checked = job.variant.startsWith("sentence_")
          ? api.checkSentenceAlignment(request, api.encodeSentenceAlignment(request.html, p.segment.opaque), generation.text, generation.finish_reason)
          : await (async () => {
            if (generation.finish_reason !== "stop") return {html: request.html, accepted: false, reason: "Generation incomplete"};
            // Run the production inference checks using the recorded fixed output.
            return api.inferMtHtml(request, async () => ({choices: [{finish_reason: generation.finish_reason, message: {content: generation.text}}]}));
          })();
        if (!checked.accepted) throw new Error(checked.reason);
        return checked.html;
      }}, {displayMode: "translation", concurrency: 1, sourceLanguage: "en", targetLanguage: "zh-Hans"});
      try {
        await translator.translateAll(p.scope);
        assert.equal(calls, 1, "Unexpected paragraph calls");
        const displayed = translator.translatedCount === 1;
        const row = {case_id: job.case_id, variant: job.variant, displayed, reason: checked?.reason ?? null,
          source_text: new dom.window.DOMParser().parseFromString(sample.html, "text/html").body.textContent,
          translated_text: p.scope.textContent, translated_html: p.scope.innerHTML,
          original_structure_unchanged: nodes.every(item => item.node.isConnected && item.attrs === JSON.stringify([...item.node.attributes].map(attribute => [attribute.name, attribute.value]))
            && item.children.length === item.node.childNodes.length && item.children.every((child, i) => child === item.node.childNodes[i])),
          code_unchanged: code.every(item => item.node.isConnected && item.node.outerHTML === item.html), warnings};
        translator.setDisplayMode("bilingual"); translator.setDisplayMode("translation"); translator.restore();
        row.restored_exact = p.scope.innerHTML === before;
        assert.ok(row.original_structure_unchanged && row.code_unchanged && row.restored_exact, "Original DOM/code/restore changed");
        rows.push(row);
      } finally {console.warn = warn; p.scope.remove();}
    } finally {dom.window.close();}
  }
  result = {schema_version: 1, plan_sha256: hash(raw), run_sha256: hash(resultsRaw), model: run.model, rows};
}
await mkdir(path.dirname(path.resolve(values.output)), {recursive: true});
await writeFile(values.output, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({output: values.output, jobs: result.jobs?.length, rows: result.rows?.length}));
