import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {parseArgs} from "node:util";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";
import {fixtureDom, projectRoot} from "./mt-quality-runtime.mjs";
const hash = raw => createHash("sha256").update(raw).digest("hex");
const {values, positionals} = parseArgs({allowPositionals: true, options: {input: {type: "string"}, output: {type: "string"}, results: {type: "string"}, ids: {type: "string"}}});
const mode = positionals[0];
if (!values.input || !values.output || !["plan", "chain", "replay"].includes(mode)) throw new Error("plan --input CASES --output PLAN [--ids IDS]; chain/replay --input PLAN --results RUN --output FILE");
const files = ["eval/mt-quality/semantic-rewrite.ts", "eval/mt-quality/protocol.ts", "src/core/page-translator.ts", "src/providers/pagelingo-mt/fixed-text.ts"];
const outfile = path.join(projectRoot, "artifacts/mt-quality/semantic-runtime.mjs");
await mkdir(path.dirname(outfile), {recursive: true});
await build({stdin: {contents: files.map(file => `export * from ${JSON.stringify("./" + file)};`).join("\n"), resolveDir: projectRoot},
  bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent"});
const api = await import(pathToFileURL(outfile).href + "?t=" + Date.now());
const sourceFiles = [...files, "tools/mt-semantic-rewrite.mjs", "tools/mt-sentence-native.py", "src/core/rich-segment.ts", "src/core/fixed-text-render.ts", "src/core/translation-quality.ts", "src/providers/pagelingo-mt/word-ranges.ts"];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await readFile(path.join(projectRoot, file)))])));
const raw = await readFile(values.input), input = JSON.parse(raw);
let result;
if (mode === "plan") {
  const ids = values.ids ? new Set(values.ids.split(",")) : null;
  const cases = input.cases.filter(sample => !ids || ids.has(sample.id));
  assert.ok(cases.length && (!ids || cases.length === ids.size));
  const jobs = [];
  for (const sample of cases) {
    const dom = fixtureDom(sample.context_url);
    try {
      const p = api.prepareQualityCase(sample), encoded = api.prepareSemanticRewrite(p.request, p.segment.opaque);
      for (const variant of ["natural", "direct"]) jobs.push({case_id: sample.id, variant,
        request: {messages: [{role: "user", content: variant === "natural" ? api.naturalTranslationPrompt(encoded) : api.semanticFixedPrompt(encoded)}],
          grammar: variant === "natural" ? null : encoded.grammar, max_tokens: encoded.maxTokens}});
      p.scope.remove();
    } finally {dom.window.close();}
  }
  result = {schema_version: 1, protocol: "sentence-alignment-research-v1", method: "semantic-roles-and-own-draft-v1", stage: "natural-and-direct",
    scope: "Known-failure mechanism diagnostic, not blind accuracy. Role/context/prompt change together. Natural translations are not directly renderable.",
    input_sha256: hash(raw), source_hashes: sourceHashes, cases, jobs};
} else {
  assert.deepEqual(sourceHashes, input.source_hashes, "Frozen research source changed");
  const runRaw = await readFile(values.results), run = JSON.parse(runRaw);
  assert.equal(run.plan_sha256, hash(raw)); assert.equal(run.generations.length, input.jobs.length);
  if (input.model_binding_sha256) assert.equal(run.model.sha256, input.model_binding_sha256);
  for (const [index, job] of input.jobs.entries()) {
    const row = run.generations[index]; assert.equal(row.case_id, job.case_id); assert.equal(row.variant, job.variant);
    assert.equal(row.request_sha256, hash(JSON.stringify(job.request)));
  }
  if (mode === "chain") {
    assert.equal(input.stage, "natural-and-direct");
    const jobs = [];
    for (const sample of input.cases) {
      const dom = fixtureDom(sample.context_url);
      try {
        const p = api.prepareQualityCase(sample), encoded = api.prepareSemanticRewrite(p.request, p.segment.opaque);
        const draft = run.generations.find(row => row.case_id === sample.id && row.variant === "natural");
        assert.equal(draft.finish_reason, "stop", "Do not compile a truncated draft");
        jobs.push({case_id: sample.id, variant: "rewrite", draft_text_sha256: hash(draft.text),
          request: {messages: [{role: "user", content: api.semanticFixedPrompt(encoded, draft.text)}], grammar: encoded.grammar, max_tokens: encoded.maxTokens}});
        p.scope.remove();
      } finally {dom.window.close();}
    }
    result = {...input, stage: "rewrite-from-actual-own-draft", input_sha256: hash(raw), parent_run_sha256: hash(runRaw), model_binding_sha256: run.model.sha256, jobs};
  } else {
    const rows = [];
    for (const [index, job] of input.jobs.entries()) {
      if (job.variant === "natural") continue;
      const dom = fixtureDom(input.cases.find(sample => sample.id === job.case_id).context_url);
      try {
        const sample = input.cases.find(sample => sample.id === job.case_id), p = api.prepareQualityCase(sample), before = p.scope.innerHTML;
        const nodes = [p.root, ...p.root.querySelectorAll("*")].map(node => ({node, children: [...node.childNodes], attrs: JSON.stringify([...node.attributes].map(a => [a.name, a.value]))}));
        const code = [...p.root.querySelectorAll("code,kbd,samp,var")].map(node => ({node, html: node.outerHTML}));
        let reason = null, calls = 0;
        const translator = new api.PageTranslator(document, {prefersWholeSentenceHtml: async () => true, translateHtml: async request => {
          calls++; assert.equal(request.html, p.request.html);
          try {return api.checkSemanticFixed(api.prepareSemanticRewrite(request, p.segment.opaque), run.generations[index].text, run.generations[index].finish_reason);}
          catch (error) {reason = String(error); throw error;}
        }}, {displayMode: "translation", sourceLanguage: "en", targetLanguage: "zh-Hans", concurrency: 1});
        const warn = console.warn; console.warn = () => {};
        try {
          await translator.translateAll(p.scope); assert.equal(calls, 1);
          const row = {case_id: sample.id, variant: job.variant, displayed: translator.translatedCount === 1, reason,
            translated_text: p.scope.textContent, translated_html: p.scope.innerHTML,
            labels: [...p.root.querySelectorAll("a,em,strong,b,i,mark")].map(node => ({tag: node.tagName, target: node.textContent})),
            original_structure_unchanged: nodes.every(x => x.node.isConnected && x.attrs === JSON.stringify([...x.node.attributes].map(a => [a.name, a.value])) && x.children.length === x.node.childNodes.length && x.children.every((child, i) => child === x.node.childNodes[i])),
            code_unchanged: code.every(x => x.node.isConnected && x.html === x.node.outerHTML)};
          translator.setDisplayMode("bilingual"); translator.setDisplayMode("translation"); translator.restore();
          row.restored_exact = p.scope.innerHTML === before;
          assert.ok(row.original_structure_unchanged && row.code_unchanged && row.restored_exact);
          rows.push(row);
        } finally {console.warn = warn; p.scope.remove();}
      } finally {dom.window.close();}
    }
    result = {schema_version: 1, plan_sha256: hash(raw), run_sha256: hash(runRaw), model: run.model, stage: input.stage, rows};
  }
}
await mkdir(path.dirname(path.resolve(values.output)), {recursive: true});
await writeFile(values.output, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({output: values.output, jobs: result.jobs?.length, rows: result.rows?.length}));
