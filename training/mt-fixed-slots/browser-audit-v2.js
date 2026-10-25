import {Wllama} from "/npm/package/esm/index.js";
import {prepareQualityCase, qualityCallPlan, PageTranslator, inferMtHtml} from "/production-runtime.js";
const audit = window.__candidateAudit;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const attrs = node => [...node.attributes].map(a => [a.name, a.value]);
const children = node => [...node.childNodes].filter(n => n.nodeType !== 1 || !n.hasAttribute("data-flt-generated"));
const font = node => {
  const style = getComputedStyle(node);
  return ["display", "fontFamily", "fontSize", "fontWeight", "lineHeight", "color"].map(key => [key, style[key]]);
};
async function checkpoint(phase) {
  audit.phase = phase; audit.continue = false;
  while (!audit.continue) await new Promise(resolve => setTimeout(resolve, 50));
}
(async () => {
  const descriptor = await (await fetch("/descriptor.json")).json();
  const css = document.createElement("style"); css.textContent = descriptor.css; document.head.append(css);
  audit.requestedThreads = Math.max(1, Math.min(8, Math.floor((navigator.hardwareConcurrency || 2) / 2) || 1));
  audit.hardwareConcurrency = navigator.hardwareConcurrency; audit.crossOriginIsolated = crossOriginIsolated;
  const engine = new Wllama({default: "/npm/package/esm/wasm/wllama.wasm"});
  const fetched = performance.now(), blob = await (await fetch("/model.gguf")).blob();
  audit.modelFetchWallS = (performance.now() - fetched) / 1000;
  if (blob.size !== descriptor.modelBytes) throw new Error("Candidate byte count changed in browser transport");
  const loaded = performance.now();
  await engine.loadModel([blob], {n_ctx: 3072, n_threads: audit.requestedThreads, n_gpu_layers: 0});
  audit.modelLoadWallS = (performance.now() - loaded) / 1000; audit.actualThreads = engine.getNumThreads();
  for (const sample of descriptor.cases) {
    const p = prepareQualityCase(sample), before = p.scope.innerHTML;
    window.__candidateTarget = p.root;
    const nodes = [p.root, ...p.root.querySelectorAll("*")].map(node => ({node, attrs: attrs(node), children: children(node), font: font(node)}));
    const code = [...p.scope.querySelectorAll("code,kbd,samp,var")].map(node => ({node, html: node.outerHTML}));
    const anchors = [...p.scope.querySelectorAll("a")].map(node => ({node, href: node.href, source: node.textContent}));
    let clicks = 0; anchors[0]?.node.addEventListener("click", e => {e.preventDefault(); e.stopImmediatePropagation(); clicks++;}, {capture: true});
    const row = {id: sample.id, source_html: before, source_text: p.scope.textContent, calls: []}; audit.cases.push(row);
    const expected = qualityCallPlan(p.request); let index = 0;
    const checks = () => ({
      structure: nodes.every(x => {const current = children(x.node); return x.node.isConnected && equal(attrs(x.node), x.attrs)
        && current.length === x.children.length && current.every((node, i) => node === x.children[i]);}),
      code: code.every(x => x.node.isConnected && x.node.outerHTML === x.html),
      styles: nodes.every(x => equal(font(x.node), x.font)),
      links: anchors.every(x => x.node.isConnected && x.node.href === x.href),
      overflow: p.root.scrollWidth > p.root.clientWidth + 1,
    });
    await checkpoint("before");
    audit.phase = "inference";
    const translator = new PageTranslator(document, {prefersWholeSentenceHtml: async () => true,
      translateHtml: async request => {
        // This is a local copy of a frozen source block. Retain its source-page context metadata.
        request = {...request, terminology: p.request.terminology, context: p.request.context};
        const result = await inferMtHtml(request, async options => {
          const planned = expected[index++];
          if (!planned || !equal(options.messages, planned.messages) || options.grammar !== planned.grammar || options.max_tokens !== planned.max_tokens)
            throw new Error("Browser production call differs from frozen plan");
          const call = {messages: options.messages, grammar: options.grammar, budget: options.max_tokens, chunks: []}; row.calls.push(call);
          const start = performance.now(); let text = "", finish = null, timings = null;
          await engine.createChatCompletion({...options, stream: true, onData: chunk => {
            const elapsed = (performance.now() - start) / 1000;
            for (const choice of chunk.choices || []) {
              const piece = choice.delta?.content || "";
              if (piece) {
                if (call.firstTokenS === undefined) call.firstTokenS = elapsed;
                if (call.firstCjkS === undefined && /[\u3400-\u9fff]/u.test(piece)) call.firstCjkS = elapsed;
                text += piece;
              }
              if (choice.finish_reason) finish = choice.finish_reason;
            }
            if (chunk.timings) timings = chunk.timings;
            call.chunks.push({elapsed, chunk});
          }});
          Object.assign(call, {text, finish_reason: finish, timings, wallS: (performance.now() - start) / 1000});
          return {choices: [{finish_reason: finish, message: {role: "assistant", content: text}}]};
        });
        row.checked = result;
        if (!result.accepted) throw new Error(result.reason);
        return result.html;
      }}, {displayMode: "translation", sourceLanguage: "en", targetLanguage: "zh-Hans", concurrency: 1});
    await translator.translateAll(p.scope);
    if (!row.checked || !row.calls.length || row.calls.some(call => !call.finish_reason)) throw new Error("Incomplete browser model generation");
    row.displayed = translator.translatedCount === 1; row.translated_text = p.scope.textContent; row.translated_html = p.scope.innerHTML;
    row.translated_checks = checks();
    if (anchors.length) {const count = clicks; anchors[0].node.click(); row.original_click = clicks === count + 1;}
    await checkpoint("translated");
    translator.setDisplayMode("bilingual"); row.bilingual_checks = checks();
    if (anchors.length && row.displayed) {
      const clone = [...p.scope.querySelectorAll(".flt-translation a")].find(a => a.href === anchors[0].href);
      const count = clicks; clone?.click(); row.bilingual_click = clicks === count + 1;
    }
    await checkpoint("bilingual");
    translator.restore(); row.restored_exact = p.scope.innerHTML === before; row.restored_checks = checks();
    if (![row.translated_checks, row.bilingual_checks, row.restored_checks].every(c => c.structure && c.code && c.links && c.styles) || !row.restored_exact)
      throw new Error("Browser structure, code, styles, link or restore invariant failed");
    await checkpoint("restored"); p.scope.remove();
  }
  await engine.exit(); audit.done = true; audit.phase = "complete";
})().catch(error => {audit.errors.push(String(error.stack || error)); audit.done = true; audit.phase = "error";});
