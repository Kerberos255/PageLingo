// Deterministic production rendering regressions in a real browser; no model calls.
import {PageTranslator} from "../../src/core/page-translator";
import {inferMtHtml} from "../../src/providers/pagelingo-mt/inference";
import type {TranslationRequest} from "../../src/core/provider";

export async function runBrowserStructureRegressions() {
  const rows: Array<{id: string; passed: boolean; calls: number}> = [];
  const check = (value: unknown, message: string) => {if (!value) throw new Error(message);};
  const provider = () => {
    const requests: TranslationRequest[] = [];
    return {requests, prefersWholeSentenceHtml: async () => true, translateHtml: async (request: TranslationRequest) => {
      requests.push(request);
      const body = new DOMParser().parseFromString(request.html, "text/html").body;
      for (const slot of body.querySelectorAll("[data-flt-text-id]")) slot.textContent = `第${requests.length}次译文`;
      return body.innerHTML;
    }};
  };
  const fixture = (html: string) => {document.body.innerHTML = html;};
  fixture("<p>Hello world.</p>");
  const observed = provider(), observing = new PageTranslator(document, observed, {displayMode: "translation",
    shouldTranslateRoot: (root: HTMLElement) => !/[\u3400-\u9fff]/u.test(root.textContent ?? "")});
  try {
    observing.observe(); await observing.translateAll(); await new Promise(resolve => setTimeout(resolve, 100));
    check(observed.requests.length === 1 && observing.translatedCount === 1, "Own text mutations caused a translation/restoration cycle");
    rows.push({id: "observed-language-eligibility", passed: true, calls: observed.requests.length});
  } finally {observing.restore();}
  check(document.querySelector("p")!.textContent === "Hello world.", "Observed source was not restored");

  for (const subtree of [false, true]) {
    fixture('<p id="from"><em>Original text.</em></p><p id="to"></p>');
    const fake = provider(), translator = new PageTranslator(document, fake, {displayMode: "translation"});
    const moved = subtree ? document.querySelector("em")! : document.querySelector("em")!.firstChild!;
    try {
      await translator.translateAll(); document.querySelector("#to")!.append(moved); await translator.translateAll(document.querySelector("#to")!);
      check(fake.requests.length === 2 && fake.requests[1]!.html.includes("Original text."), "Moved text was retranslated from Chinese");
      rows.push({id: subtree ? "move-subtree-to-new-root" : "move-text-to-new-root", passed: true, calls: fake.requests.length});
    } finally {translator.restore();}
    check(document.querySelector("#to")!.textContent === "Original text.", "Moved source was lost");
  }
  fixture("<p>Original text.</p>");
  const changed = provider(), changing = new PageTranslator(document, changed, {displayMode: "translation"});
  await changing.translateAll();
  const original = document.querySelector("p")!.firstChild!, wrapper = document.createElement("span");
  document.querySelector("p")!.append(wrapper); wrapper.append(original); original.textContent = "Website replacement.";
  changing.restore(); check(original.textContent === "Website replacement.", "Restore overwrote website replacement");
  rows.push({id: "moved-website-edit-wins", passed: true, calls: changed.requests.length});

  for (const displayMode of ["translation", "bilingual"]) {
    fixture('<nav><a href="/guide"><span>Read</span> more</a></nav>');
    const before = document.body.innerHTML, fake = provider(), translator = new PageTranslator(document, fake, {displayMode});
    try {
      await translator.translateAll(); check(fake.requests.length === 1 && translator.translatedCount === 1, "Overlapping standalone link roots");
      rows.push({id: `standalone-link-${displayMode}`, passed: true, calls: fake.requests.length});
    } finally {translator.restore();}
    check(document.body.innerHTML === before, "Standalone link restore mismatch");
  }
  for (const deep of [false, true]) for (const displayMode of ["translation", "bilingual"]) {
    fixture(`<div><span id="owner">${deep ? '<strong><span>Read</span> the</strong> guide' : '<span>Read</span> more'}</span><p>Independent paragraph.</p></div>`);
    const before = document.body.innerHTML, owner = document.querySelector("#owner")!;
    const original = [owner, ...owner.querySelectorAll("*")].map(node => ({node, children: [...node.childNodes], attrs: JSON.stringify([...node.attributes].map(a => [a.name, a.value]))}));
    const fake = provider(), translator = new PageTranslator(document, fake, {displayMode, concurrency: 2});
    try {
      await translator.translateAll(); check(fake.requests.length === 2 && translator.translatedCount === 2, "Overlapping nested fallback span roots");
      check(fake.requests[0]!.html.includes("Read") && fake.requests[0]!.html.includes(deep ? " guide" : " more"), "Outer span lost part of its source");
      check(original.every(item => item.node.isConnected && item.attrs === JSON.stringify([...item.node.attributes].map(a => [a.name, a.value]))
        && item.children.length === item.node.childNodes.length && item.children.every((child, index) => child === item.node.childNodes[index])), "Nested span original DOM changed");
      rows.push({id: `fallback-span-${deep ? "deep" : "simple"}-${displayMode}`, passed: true, calls: fake.requests.length});
    } finally {translator.restore();}
    check(document.body.innerHTML === before, "Nested span exact restore mismatch");
  }
  const sentences = Array.from({length: 24}, (_, index) => `Sentence ${index} describes translating a long paragraph while keeping the original text node and inline formatting intact. `).join("");
  for (const nested of [false, true]) {
    fixture(`<p>${nested ? `<a id="guide" href="/guide"><em>${sentences}</em></a><code>keep()</code>` : sentences}</p>`);
    const before = document.body.innerHTML, root = document.querySelector("p")!;
    const nodes = [root, ...root.querySelectorAll("*")].map(node => ({node, children: [...node.childNodes], attrs: JSON.stringify([...node.attributes].map(a => [a.name, a.value]))}));
    let calls = 0;
    const translator = new PageTranslator(document, {prefersWholeSentenceHtml: async () => true, translateHtml: async (request: TranslationRequest) => {
      const result = await inferMtHtml(request, async options => {
        calls++;
        const source = options.messages[0].content.split("English:\n")[1].split("\nChinese:")[0];
        const content = source.replace(/⟦(\d+)⟧([\s\S]*?)⟦\/\1⟧/gu, (_all: string, id: string, value: string) =>
          `⟦${id}⟧${Array.from(value.matchAll(/Sentence (\d+)/gu), match => `第${match[1]}句介绍如何翻译长段落，同时保持原始文本节点和行内格式。`).join("")}⟦/${id}⟧`);
        return {choices: [{finish_reason: "stop", message: {content}}]};
      });
      if (!result.accepted) throw new Error(result.reason);
      return result.html;
    }}, {displayMode: "translation", sourceLanguage: "en", targetLanguage: "zh-Hans"});
    try {
      await translator.translateAll(); check(calls > 1 && translator.translatedCount === 1, "Wrapped long paragraph was not reassembled");
      check(nodes.every(item => item.node.isConnected && item.attrs === JSON.stringify([...item.node.attributes].map(a => [a.name, a.value])) && item.children.length === item.node.childNodes.length && item.children.every((child, index) => child === item.node.childNodes[index])), "Long paragraph changed original DOM");
      check(root.textContent!.includes("第0句") && root.textContent!.includes("第23句"), "Long paragraph omitted an endpoint");
      if (nested) check(root.querySelector("code")!.textContent === "keep()", "Long paragraph code changed");
      translator.setDisplayMode("bilingual"); translator.setDisplayMode("translation");
      rows.push({id: nested ? "long-slot-nested-link-code" : "long-slot-plain", passed: true, calls});
    } finally {translator.restore();}
    check(document.body.innerHTML === before, "Long paragraph exact restore failed");
  }
  return {scope: "Deterministic production rendering and sentence-assembly regression checks. Model completion is stubbed; no new translation-quality or wllama inference measurement.", rows};
}
