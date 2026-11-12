import {afterEach, describe, expect, it} from "vitest";
import {serializeRichSegment} from "../src/core/rich-segment";
import {PageTranslator} from "../src/core/page-translator";
import type {TranslationRequest} from "../src/core/provider";
import {checkSentenceAlignment, decodeSentenceAlignment, encodeSentenceAlignment} from "../eval/mt-quality/sentence-alignment";

afterEach(() => document.body.replaceChildren());

describe("research sentence alignment onto original Text nodes", () => {
  it("restores real protected context while withholding transport wrappers from generation", () => {
    document.body.innerHTML = '<p>Use <a href="/api"><em>this API</em></a> with <code>cancel()</code>.</p>';
    const segment = serializeRichSegment(document.querySelector("p")!, {fixedTextSlots: true});
    const encoded = encodeSentenceAlignment(segment.html, segment.opaque);
    expect(encoded.source).toBe("Use ⟦0⟧⟦1⟧this API⟦/1⟧⟦/0⟧ with ⟪P0⟫⟪P1⟫");
    expect(encoded.protectedContext).toEqual([{token: "⟪P0⟫", text: "cancel()"}, {token: "⟪P1⟫", text: "."}]);
  });
  it.each([
    ["non-monotone formatting", "⟦0⟧指南⟦/0⟧阅读。"],
    ["duplicate anchor", "阅读⟦0⟧指南⟦/0⟧⟦0⟧指南⟦/0⟧。"],
    ["unknown marker", "阅读⟦9⟧指南⟦/9⟧。"],
    ["missing protected token", "阅读⟦0⟧指南⟦/0⟧。"],
    ["unassigned trailing words", "阅读⟦0⟧指南⟦/0⟧⟪P0⟫添加"],
    ["HTML injection", "<b>阅读</b>⟦0⟧指南⟦/0⟧⟪P0⟫"],
  ])("rejects %s without any detached Text mutation", (_name, output) => {
    const encoded = encodeSentenceAlignment('Read <a href="/guide">the guide</a>.');
    const before = encoded.fixed.body.innerHTML;
    expect(() => decodeSentenceAlignment(encoded, output)).toThrow();
    expect(encoded.fixed.body.innerHTML).toBe(before);
  });
  it("rejects an otherwise valid reordering of two link translations", () => {
    const encoded = encodeSentenceAlignment("Read <a>one</a> and <a>two</a> now.");
    expect(() => decodeSentenceAlignment(encoded, "先阅读⟦1⟧二⟦/1⟧以及⟦0⟧一⟦/0⟧。"))
      .toThrow(/non-monotone/);
  });
  it("rejects ambiguous adjacent Text slots rather than dividing by source length", () => {
    expect(() => encodeSentenceAlignment('<span data-flt-text-id="0">First </span><span data-flt-text-id="1">second.</span>'))
      .toThrow(/ambiguous multi-node/);
  });
  it("retains negation, bracket and translation-label production guards", () => {
    expect(() => decodeSentenceAlignment(encodeSentenceAlignment("The worker <em>never</em> stops."), "工作线程⟦0⟧版本⟦/0⟧停止。"))
      .toThrow(/negation was lost/);
    expect(() => decodeSentenceAlignment(encodeSentenceAlignment("Read the guide."), "阅读〔指南。"))
      .toThrow(/unbalanced/);
    expect(() => decodeSentenceAlignment(encodeSentenceAlignment("Read the guide."), "阅读指南。\n译文：阅读指南。"))
      .toThrow(/translation label/);
  });
  it("rejects a truncated generation before projecting any text", () => {
    const request = {html: "Read now.", sourceLanguage: "en", targetLanguage: "zh-Hans"};
    const encoded = encodeSentenceAlignment(request.html);
    expect(checkSentenceAlignment(request, encoded, "立即阅读。", "length").accepted).toBe(false);
    expect(encoded.fixed.body.innerHTML).toBe(request.html);
  });
  it("uses the real renderer without changing original elements, attributes, code or event listeners", async () => {
    document.body.innerHTML = '<p id="root" class="prose">Read <a id="link" href="/guide"><em>the guide</em></a> with <code>cancel()</code>.</p>';
    const root = document.querySelector<HTMLElement>("p")!, before = root.outerHTML;
    const nodes = [root, ...root.querySelectorAll("*")].map(node => ({node, children: [...node.childNodes], attrs: [...node.attributes].map(a => [a.name, a.value])}));
    const link = root.querySelector("a")!;
    let clicks = 0;
    link.addEventListener("click", event => {event.preventDefault(); clicks++;});
    const translator = new PageTranslator(document, {prefersWholeSentenceHtml: async () => true, translateHtml: async (request: TranslationRequest) => {
      const result = checkSentenceAlignment(request, encodeSentenceAlignment(request.html), "阅读⟦0⟧⟦1⟧指南⟦/1⟧⟦/0⟧并使用⟪P0⟫⟪P1⟫", "stop");
      if (!result.accepted) throw new Error(result.reason);
      return result.html;
    }}, {displayMode: "translation", sourceLanguage: "en", targetLanguage: "zh-Hans"});
    await translator.translateAll();
    expect(translator.translatedCount).toBe(1);
    for (const {node, children, attrs} of nodes) {
      expect([...node.childNodes]).toEqual(children);
      expect([...node.attributes].map(a => [a.name, a.value])).toEqual(attrs);
    }
    link.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true}));
    expect(clicks).toBe(1);
    expect(root.querySelector("code")!.textContent).toBe("cancel()");
    expect(root.textContent).toBe("阅读指南并使用 cancel().");
    translator.setDisplayMode("bilingual"); translator.setDisplayMode("translation"); translator.restore();
    expect(root.outerHTML).toBe(before);
  });
});
