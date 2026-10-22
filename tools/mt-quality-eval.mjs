import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {parseArgs} from "node:util";
import {fixtureDom, qualityRuntime, readCases} from "./mt-quality-runtime.mjs";

const {values} = parseArgs({options: {
  server: {type: "string"}, model: {type: "string"}, out: {type: "string"},
  split: {type: "string", default: "all"}, mode: {type: "string", default: "fixed"},
}});
if (!values.server || !values.model || !values.out) throw new Error("Use --server URL --model LABEL --out FILE [--mode fixed|plain] [--split all|holdout|diagnostic]");
if (!["fixed", "plain"].includes(values.mode)) throw new Error("Unsupported mode");
if (!["all", "holdout", "diagnostic"].includes(values.split)) throw new Error("Unsupported split");
const api = await qualityRuntime();
const cases = (await readCases("eval/mt-quality/cases.json")).filter(c => values.split === "all" || values.split === c.split);
const out = path.resolve(values.out); await mkdir(path.dirname(out), {recursive: true});
const post = async (endpoint, body) => {
  const response = await fetch(values.server.replace(/\/$/, "") + endpoint, {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) throw new Error(`${endpoint}: ${response.status} ${await response.text()}`);
  return response;
};
const result = {schema_version: 1, model: values.model, mode: values.mode, created_utc: new Date().toISOString(),
  settings: {context: 3072, temperature: 0, top_k: 1, seed: 42, cache_prompt: false},
  interpretation: "Content probes are auditable keyword/slot checks, not semantic accuracy or human review.", cases: []};
const save = () => writeFile(out, JSON.stringify(result, null, 2) + "\n");
let active;
const complete = async options => {
  const applied = await (await post("/apply-template", {messages: options.messages, add_generation_prompt: true})).json();
  if (typeof applied.prompt !== "string") throw new Error("Server did not return an applied chat template");
  const start = performance.now(); let first = null, content = "", pending = "", final = null;
  const response = await post("/completion", {prompt: applied.prompt, n_predict: options.max_tokens,
    temperature: 0, top_k: 1, seed: 42, cache_prompt: false, stream: true,
    ...(options.grammar ? {grammar: options.grammar} : {})});
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, {stream: true}); let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
      if (!line.startsWith("data:")) continue;
      const text = line.slice(5).trim(); if (text === "[DONE]") continue;
      const data = JSON.parse(text);
      if (data.error) throw new Error(JSON.stringify(data.error));
      if (data.content) {if (first === null) first = performance.now(); content += data.content;}
      if (data.stop) final = data;
    }
  }
  if (!final) throw new Error("Missing final completion event");
  active.completions.push({prompt: applied.prompt, grammar: options.grammar ?? null, budget: options.max_tokens,
    text: content, stop_type: final.stop_type, timings: final.timings,
    wall_s: (performance.now() - start) / 1000, ttft_s: first === null ? null : (first - start) / 1000});
  await save();
  return {choices: [{message: {role: "assistant", content}, finish_reason: final.stop_type === "eos" ? "stop" : "length"}]};
};
for (const sample of cases) {
  const dom = fixtureDom(sample.context_url);
  active = {id: sample.id, split: sample.split, category: sample.category, reference_status: sample.review_status, completions: [], events: []};
  result.cases.push(active);
  const originalWarn = console.warn; console.warn = (...args) => active.events.push(args.map(String).join(" "));
  try {
    const prepared = api.prepareQualityCase(sample);
    active.source_text = prepared.scope.textContent;
    active.request = prepared.request;
    const before = prepared.scope.innerHTML;
    if (values.mode === "plain") {
      const response = await complete({messages: [{role: "user", content: "Translate the following English text into Simplified Chinese. Output only the translation.\n\n" + active.source_text}], max_tokens: 512});
      active.raw_plain_text = response.choices[0].message.content;
      active.finished_normally = response.choices[0].finish_reason === "stop";
      active.content_probes = null; // Slot-specific checks do not apply to plain translations.
    } else {
      const nodes = [prepared.root, ...prepared.root.querySelectorAll("*")].map(node => ({node, children: [...node.childNodes], attrs: JSON.stringify([...node.attributes].map(a => [a.name, a.value]))}));
      const codes = [...prepared.scope.querySelectorAll("code,kbd,samp,var")].map(node => ({node, html: node.outerHTML}));
      const provider = {prefersWholeSentenceHtml: async () => true, translateHtml: async request => {
        const checked = await api.inferMtHtml(request, complete); active.checked = checked;
        if (!checked.accepted) throw new Error(checked.reason); return checked.html;
      }};
      const translator = new api.PageTranslator(document, provider, {displayMode: "translation", concurrency: 1, sourceLanguage: "en", targetLanguage: "zh-Hans"});
      await translator.translateAll(prepared.scope);
      active.displayed = translator.translatedCount === 1;
      active.translated_text = prepared.scope.textContent;
      active.translated_html = prepared.scope.innerHTML;
      active.content_probes = active.displayed ? api.checkContentProbes(sample, active.checked.html) : null;
      active.all_content_probes_passed = active.displayed && active.content_probes.every(p => p.passed);
      active.original_structure_unchanged = nodes.every(x => x.node.isConnected && x.attrs === JSON.stringify([...x.node.attributes].map(a => [a.name, a.value])) && x.children.length === x.node.childNodes.length && x.children.every((n, i) => n === x.node.childNodes[i]));
      active.code_unchanged = codes.every(x => x.node.isConnected && x.node.outerHTML === x.html);
      translator.setDisplayMode("bilingual"); translator.setDisplayMode("translation"); translator.restore();
      active.restored_exact = prepared.scope.innerHTML === before;
    }
  } catch (error) {active.error = String(error);}
  finally {console.warn = originalWarn; dom.window.close();}
  await save();
  console.log(JSON.stringify({id: active.id, mode: values.mode, displayed: active.displayed, probes: active.all_content_probes_passed, reason: active.checked?.reason, error: active.error}));
}
result.finished_utc = new Date().toISOString(); await save();
if (result.cases.some(c => c.error)) process.exitCode = 1;
