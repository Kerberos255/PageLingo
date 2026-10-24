import {afterEach, describe, expect, it} from "vitest";
import {PageTranslator} from "../src/core/page-translator";
import {serializeRichSegment} from "../src/core/rich-segment";
import {decodeFixedMtText, encodeFixedMtText} from "../src/providers/pagelingo-mt/fixed-text";
import {inferMtHtml} from "../src/providers/pagelingo-mt/inference";
import type {TranslationRequest} from "../src/core/provider";
import {collectTranslationTelemetry} from "../src/core/translation-telemetry";

afterEach(() => document.body.replaceChildren());

function translatedSlots(html: string): string {
  const body = new DOMParser().parseFromString(html, "text/html").body;
  for (const slot of body.querySelectorAll("[data-flt-text-id]")) slot.textContent = `译文${slot.getAttribute("data-flt-text-id")}`;
  return body.innerHTML;
}
function provider() {
  const requests: TranslationRequest[] = [];
  return {requests, prefersWholeSentenceHtml: async () => true, translateHtml: async (request: TranslationRequest) => {
    requests.push(request); return translatedSlots(request.html);
  }};
}

describe("MT fixed text protocol", () => {
  it("owns tags, attributes, code and link boundaries independently of generation", () => {
    const html = 'Read the <a class="custom" href="/guide"><code>__FLT_LINK_START_0__</code>guide<code>__FLT_LINK_END_0__</code></a> with <code>npm run build</code>.';
    const encoded = encodeFixedMtText(html);
    expect(encoded.source).toBe('⟦0⟧Read the ⟦/0⟧⟦1⟧guide⟦/1⟧⟦2⟧ with ⟦/2⟧⟪P0⟫⟪P1⟫');
    const result = decodeFixedMtText(encoded, '⟦0⟧阅读⟦/0⟧⟦1⟧指南⟦/1⟧⟦2⟧使用⟦/2⟧⟪P0⟫⟪P1⟫');
    const body = new DOMParser().parseFromString(result, 'text/html').body;
    expect(body.querySelector('a')?.outerHTML).toBe('<a class="custom" href="/guide"><code>__FLT_LINK_START_0__</code>指南<code>__FLT_LINK_END_0__</code></a>');
    expect(body.lastElementChild?.textContent).toBe('npm run build');
    expect(body.textContent).toContain('npm run build.');
  });

  it.each([
    ['expanded link replacing all surrounding text', '⟦1⟧阅读指南然后继续。⟦/1⟧⟪P0⟫'],
    ['empty surrounding text', '⟦0⟧⟦/0⟧⟦1⟧阅读指南然后继续。⟦/1⟧⟦2⟧。⟦/2⟧'],
    ['duplicate pair', '⟦0⟧阅读⟦/0⟧⟦1⟧指南⟦/1⟧⟦1⟧指南⟦/1⟧⟦2⟧继续。⟦/2⟧'],
    ['reordered pair', '⟦1⟧指南⟦/1⟧⟦0⟧阅读⟦/0⟧⟦2⟧继续。⟦/2⟧'],
    ['malformed protected marker', '⟦0⟧阅读⟦/0⟧⟦1⟧指南⟦/1⟧⟦2⟧继续。⟦/2⟧⟦P2⟫'],
    ['lookalike marker fragment', '⟦0⟧阅读⟦/0⟧⟦1⟧指南⟦/1⟧⟦2⟧ ⟨/2⟦/2⟧'],
    ['words outside pairs', '阅读⟦0⟧请⟦/0⟧⟦1⟧指南⟦/1⟧⟦2⟧继续。⟦/2⟧'],
    ['HTML inside pair', '⟦0⟧<a>阅读</a>⟦/0⟧⟦1⟧指南⟦/1⟧⟦2⟧继续。⟦/2⟧'],
    ['nested unknown pair', '⟦0⟧阅读⟦9⟧注入⟦/9⟧⟦/0⟧⟦1⟧指南⟦/1⟧⟦2⟧继续。⟦/2⟧'],
  ])("rejects %s atomically", (_name, output) => {
    const encoded = encodeFixedMtText('Read the <a href="/guide">guide</a> before continuing.');
    const before = encoded.body.innerHTML;
    expect(() => decodeFixedMtText(encoded, output)).toThrow();
    expect(encoded.body.innerHTML).toBe(before);
  });

  it("rejects protected tokens moved into or across text slots", () => {
    const encoded = encodeFixedMtText('Use <code>HTTP</code> headers.');
    expect(() => decodeFixedMtText(encoded, '⟦0⟧使用⟪P0⟫⟦/0⟧⟦1⟧标头。⟦/1⟧')).toThrow();
    expect(() => decodeFixedMtText(encoded, '⟦0⟧使用⟦/0⟧⟦1⟧标头。⟦/1⟧⟪P0⟫')).toThrow();
  });

  it("keeps proper names in individual slots while assessing the whole translation", async () => {
    const result = await inferMtHtml({html: 'Read <a>PageLingo</a> documentation.', sourceLanguage: 'en', targetLanguage: 'zh-Hans'}, async () => ({choices: [{finish_reason: 'stop', message: {content: '⟦0⟧阅读⟦/0⟧⟦1⟧PageLingo⟦/1⟧⟦2⟧文档。⟦/2⟧'}}]}));
    expect(result.accepted).toBe(true);
    expect(result.html).toContain('<a>PageLingo</a>');
  });

  it("protects literal protocol glyphs in source rather than interpreting them", () => {
    const encoded = encodeFixedMtText('The literal ⟦P2⟫ is reserved.');
    expect(encoded.texts).toHaveLength(0);
    expect(decodeFixedMtText(encoded, '⟪P0⟫')).toBe('The literal ⟦P2⟫ is reserved.');
  });

  it.each(["a", "em", "strong"])("rejects punctuation replacing a meaningful %s label atomically", tag => {
    const encoded = encodeFixedMtText(`Read <${tag}>the guide</${tag}> now.`);
    const before = encoded.body.innerHTML;
    expect(() => decodeFixedMtText(encoded, "⟦0⟧阅读⟦/0⟧⟦1⟧。⟦/1⟧⟦2⟧现在。⟦/2⟧")).toThrow(/link\/emphasis/);
    expect(encoded.body.innerHTML).toBe(before);
  });

  it("keeps an article-only linked node visible instead of omitting its label", () => {
    const encoded = encodeFixedMtText('Read <a href="/title">The</a> now.');
    expect(() => decodeFixedMtText(encoded, "⟦0⟧阅读⟦/0⟧⟦1⟧⟦/1⟧⟦2⟧现在。⟦/2⟧")).toThrow(/link\/emphasis/);
  });

  it("permits numeric labels and punctuation conjunctions outside protected label scopes", () => {
    const number = encodeFixedMtText('See <a>two</a> examples.');
    expect(decodeFixedMtText(number, "⟦0⟧查看⟦/0⟧⟦1⟧2⟦/1⟧⟦2⟧个示例。⟦/2⟧")).toContain("<a>2</a>");
    const list = encodeFixedMtText('Use <a>readers</a> and <a>writers</a>.');
    expect(decodeFixedMtText(list, "⟦0⟧使用⟦/0⟧⟦1⟧读者⟦/1⟧⟦2⟧、⟦/2⟧⟦3⟧作者⟦/3⟧⟪P0⟫")).toContain("、");
  });

  it("permits omission of a standalone article while retaining its original text node", async () => {
    const encoded = encodeFixedMtText('The <code>&lt;h1&gt;</code> heading.');
    expect(decodeFixedMtText(encoded, '⟦0⟧⟦/0⟧⟪P0⟫⟦1⟧标题。⟦/1⟧')).toBe(' <code>&lt;h1&gt;</code> 标题。');
    document.body.innerHTML = '<p>The <em>heading</em>.</p>';
    const root = document.querySelector('p')!; const article = root.firstChild;
    const translator = new PageTranslator(document, {prefersWholeSentenceHtml: async () => true, translateHtml: async (request:TranslationRequest) => {
      const body = new DOMParser().parseFromString(translatedSlots(request.html), 'text/html').body;
      body.querySelector('[data-flt-text-id="0"]')!.textContent = ' '; return body.innerHTML;
    }}, {displayMode: 'translation'});
    await translator.translateAll();
    expect(translator.translatedCount).toBe(1); expect(root.firstChild).toBe(article);
    translator.restore(); expect(root.innerHTML).toBe('The <em>heading</em>.');
  });
});

describe("MT original-node rendering", () => {
  it("changes only original Text.data, preserving node identities, attributes, code, selectors and events", async () => {
    document.body.innerHTML = '<section><p id="source" class="prose" style="display:flex">Read <a id="guide" href="/guide" class="blue" title="Guide"><em>the guide</em></a> with <code id="cmd">npm run build</code>.</p><p id="neighbor">Next paragraph.</p></section>';
    const before = document.body.innerHTML;
    const root = document.querySelector<HTMLElement>('#source')!;
    const original = [root, ...root.querySelectorAll('*')].map(node => ({node, attributes: Array.from(node.attributes).map(a => [a.name, a.value]), children: Array.from(node.childNodes)}));
    let clicks = 0;
    const anchor = root.querySelector<HTMLAnchorElement>('a')!;
    anchor.addEventListener('click', event => { event.preventDefault(); clicks++; });
    const fake = provider(); const translator = new PageTranslator(document, fake, {displayMode: 'translation'});
    await translator.translateAll(root);
    expect(translator.translatedCount).toBe(1);
    for (const item of original) {
      expect(item.node.isConnected).toBe(true);
      expect(Array.from(item.node.childNodes)).toEqual(item.children);
      expect(Array.from(item.node.attributes).map(a => [a.name, a.value])).toEqual(item.attributes);
    }
    expect(anchor.textContent).toBe('译文1');
    expect(root.querySelector('code')?.textContent).toBe('npm run build');
    expect(document.querySelector('#neighbor')?.matches('p + p')).toBe(true);
    expect(root.querySelector('.flt-translation,[data-flt-text-id]')).toBeNull();
    const translatedHtml = document.body.innerHTML;
    collectTranslationTelemetry(document.body);
    expect(document.body.innerHTML).toBe(translatedHtml);
    anchor.click(); expect(clicks).toBe(1);
    await translator.translateAll(root); expect(fake.requests).toHaveLength(1);
    translator.setDisplayMode('bilingual');
    expect(anchor.textContent).toBe('the guide');
    const translatedAnchor = root.querySelector<HTMLAnchorElement>('.flt-translation a')!;
    expect(translatedAnchor.getAttribute('href')).toBe('/guide');
    expect(translatedAnchor.textContent).toBe('译文1');
    translatedAnchor.click(); expect(clicks).toBe(2);
    expect(document.querySelectorAll('#guide')).toHaveLength(1);
    translator.setDisplayMode('translation'); expect(anchor.textContent).toBe('译文1');
    translator.restore(); expect(document.body.innerHTML).toBe(before);
  });

  it("leaves skipped controls, identifiers and counters out of editable slots", () => {
    document.body.innerHTML = '<p>Open <button>Delete</button><svg><text>Icon label</text></svg><span>42</span><span hidden>Secret</span><code>unchanged()</code></p>';
    const segment = serializeRichSegment(document.querySelector('p'), {fixedTextSlots: true});
    expect(segment.textSlots?.map(slot => slot.source)).toEqual(['Open ']);
    const encoded = encodeFixedMtText(segment.html);
    expect(encoded.texts.map(slot => slot.source)).toEqual(['Open ']);
    expect(segment.html).not.toContain('Secret');
  });

  it("keeps controls and hidden state out of the bilingual clone", async () => {
    document.body.innerHTML = '<p>Open <button id="delete">Delete</button><input value="private"><svg><text>Icon label</text></svg><span hidden>Secret</span><code>unchanged()</code> now.</p>';
    const before = document.body.innerHTML;
    const button = document.querySelector('button');
    const translator = new PageTranslator(document, provider(), {displayMode: 'bilingual'});
    await translator.translateAll();
    const layer = document.querySelector('.flt-translation')!;
    expect(layer).not.toBeNull();
    expect(layer.querySelector('button,input,svg,[hidden]')).toBeNull();
    expect(layer.textContent).not.toContain('Secret');
    expect(layer.querySelector('code')?.textContent).toBe('unchanged()');
    expect(document.querySelector('button')).toBe(button);
    translator.restore(); expect(document.body.innerHTML).toBe(before);
  });

  it("treats nested paragraph and list translations as independent owned text", async () => {
    document.body.innerHTML = '<ul><li id="parent">Parent label.<p id="child">Child description.</p><ul><li id="nested">Nested label.</li></ul></li></ul>';
    const before = document.body.innerHTML;
    const fake = provider();
    const translator = new PageTranslator(document, fake, {displayMode: 'translation', concurrency: 3});
    await translator.translateAll();
    expect(translator.translatedCount).toBe(3); expect(fake.requests).toHaveLength(3);
    expect(document.querySelector('#parent')!.firstChild!.textContent).toBe('译文0');
    expect(document.querySelector('#child')!.textContent).toBe('译文0');
    translator.setDisplayMode('bilingual');
    const parentLayer = document.querySelector('#parent > .flt-translation')!;
    expect(parentLayer.textContent).toBe('译文0');
    expect(parentLayer.querySelector('p,ul,li')).toBeNull();
    expect(document.querySelectorAll('.flt-translation')).toHaveLength(3);
    translator.setDisplayMode('translation'); await translator.translateAll();
    expect(fake.requests).toHaveLength(3);
    translator.restore(); expect(document.body.innerHTML).toBe(before);
  });

  it("retains the whole paragraph when a provider loses a text mapping", async () => {
    document.body.innerHTML = '<p>Read the <a href="/guide">guide</a> before continuing.</p>';
    const before = document.body.innerHTML;
    const translator = new PageTranslator(document, {prefersWholeSentenceHtml: async () => true, translateHtml: async () => '<span data-flt-text-id="1">阅读指南然后继续。</span>'}, {displayMode: 'translation'});
    await translator.translateAll();
    expect(translator.translatedCount).toBe(0);
    expect(document.body.innerHTML).toBe(before);
    translator.restore();
  });

  it("does not overwrite website updates arriving during inference", async () => {
    document.body.innerHTML = '<p>Original paragraph.</p>';
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const translator = new PageTranslator(document, {prefersWholeSentenceHtml: async () => true, translateHtml: async (request:TranslationRequest) => { entered(); await gate; return translatedSlots(request.html); }}, {displayMode: 'translation'});
    const pending = translator.translateAll(); await ready;
    document.querySelector('p')!.firstChild!.textContent = 'Fresh website update.';
    release(); await pending;
    expect(document.querySelector('p')?.textContent).toBe('Fresh website update.');
    expect(translator.translatedCount).toBe(0);
    translator.restore();
  });

  it("retranslates newly inserted content and ignores its own text mutations", async () => {
    document.body.innerHTML = '<p>First paragraph.</p>';
    const fake = provider(); const translator = new PageTranslator(document, fake, {displayMode: 'translation'});
    await translator.translateAll(); translator.observe();
    const root = document.querySelector('p')!;
    const extra = document.createElement('em'); extra.textContent = 'More content.'; root.append(extra);
    await new Promise(resolve => setTimeout(resolve, 70));
    expect(fake.requests).toHaveLength(2);
    expect(extra.textContent).toBe('译文1');
    expect(fake.requests[1]?.html).toContain('First paragraph.');
    translator.restore();
    expect(root.textContent).toBe('First paragraph.More content.');
  });

  it("restores owned text without clobbering later website text", async () => {
    document.body.innerHTML = '<p>Hello <em>world</em>.</p>';
    const translator = new PageTranslator(document, provider(), {displayMode: 'translation'});
    await translator.translateAll();
    document.querySelector('em')!.firstChild!.textContent = 'Website update';
    translator.restore();
    expect(document.querySelector('p')?.textContent).toBe('Hello Website update.');
  });
});
