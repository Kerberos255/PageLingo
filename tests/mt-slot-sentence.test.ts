import {afterEach, describe, expect, it} from "vitest";
import {PageTranslator} from "../src/core/page-translator";
import {serializeRichSegment} from "../src/core/rich-segment";
import {assembleMtSentences, planMtSentences} from "../src/providers/pagelingo-mt/sentence-plan";
import {inferMtHtml} from "../src/providers/pagelingo-mt/inference";
import type {TranslationRequest} from "../src/core/provider";

afterEach(() => document.body.replaceChildren());
const sentences = Array.from({length: 24}, (_, index) => `Sentence ${index} describes translating a long paragraph while keeping the original text node and inline formatting intact. `);
const translated = (index: string) => `第${index}句介绍如何翻译长段落，同时保持原始文本节点和行内格式。`;

describe("complete sentences inside production text-slot wrappers", () => {
  it("plans complete sentences from a serialized original Text node", () => {
    document.body.innerHTML = `<p>${sentences.join("")}</p>`;
    const segment = serializeRichSegment(document.querySelector("p")!, {fixedTextSlots: true});
    const units = planMtSentences({html: segment.html, sourceLanguage: "en", targetLanguage: "zh-Hans"});
    expect(units.length).toBeGreaterThan(1);
    const bodies = units.map(unit => new DOMParser().parseFromString(unit, "text/html").body);
    expect(bodies.every(body => body.textContent!.trim().endsWith("intact."))).toBe(true);
    expect(bodies.map(body => body.textContent).join("")).toBe(sentences.join(""));
    expect(bodies.every(body => body.querySelector("span[data-flt-text-id='0']"))).toBe(true);
    expect(bodies.flatMap(body => [...body.querySelectorAll("span[data-flt-text-id='0']")].map(span => span.textContent)).join(""))
      .toBe(sentences.join(""));
  });
  it.each([false, true])("reassembles one original slot, retaining nested links/code when present: %s", async nested => {
    document.body.innerHTML = `<p id="long">${nested ? `<a id="guide" href="/guide"><em>${sentences.join("")}</em></a><code>keep()</code>` : sentences.join("")}</p>`;
    const root = document.querySelector<HTMLElement>("p")!, text = nested ? root.querySelector("em")!.firstChild : root.firstChild, before = root.outerHTML;
    const nodes = [root, ...root.querySelectorAll("*")].map(node => ({node, children: [...node.childNodes], attrs: node.getAttributeNames().map(name => [name, node.getAttribute(name)])}));
    let calls = 0;
    const translator = new PageTranslator(document, {prefersWholeSentenceHtml: async () => true, translateHtml: async (request: TranslationRequest) => {
      const checked = await inferMtHtml(request, async options => {
        calls++;
        const source = options.messages[0].content.split("English:\n")[1].split("\nChinese:")[0];
        const output = source.replace(/⟦(\d+)⟧([\s\S]*?)⟦\/\1⟧/gu, (_all: string, id: string, content: string) =>
          `⟦${id}⟧${Array.from(content.matchAll(/Sentence (\d+)/gu), match => translated(match[1]!)).join("")}⟦/${id}⟧`);
        return {choices: [{finish_reason: "stop", message: {content: output}}]};
      });
      if (!checked.accepted) throw new Error(checked.reason);
      return checked.html;
    }}, {displayMode: "translation", sourceLanguage: "en", targetLanguage: "zh-Hans"});
    await translator.translateAll();
    expect(calls).toBeGreaterThan(1); expect(translator.translatedCount).toBe(1);
    for (const {node, children, attrs} of nodes) {
      expect([...node.childNodes]).toEqual(children);
      expect(node.getAttributeNames().map(name => [name, node.getAttribute(name)])).toEqual(attrs);
    }
    expect(root.textContent!.replace(/\s/gu, "")).toBe(sentences.map((_sentence, index) => translated(String(index))).join("") + (nested ? "keep()" : ""));
    translator.setDisplayMode("bilingual"); translator.setDisplayMode("translation"); translator.restore();
    expect(root.outerHTML).toBe(before); expect(nested ? root.querySelector("em")!.firstChild : root.firstChild).toBe(text);
  });
  it.each([
    ["missing source", '<span data-flt-text-id="0">One. Two.</span>', ['<span data-flt-text-id="0">One.</span>', '<span data-flt-text-id="0"></span>']],
    ["reordered source", '<span data-flt-text-id="0">One.</span><span data-flt-text-id="1">Two.</span>', ['<span data-flt-text-id="1">Two.</span>', '<span data-flt-text-id="0">One.</span>']],
    ["unknown slot", '<span data-flt-text-id="0">One. Two.</span>', ['<span data-flt-text-id="0">One. </span>', '<span data-flt-text-id="1">Two.</span>']],
  ] as const)("rejects %s before assembly", (_name, source, units) => {
    expect(() => assembleMtSentences(source, [...units], [...units])).toThrow(/coverage|reordered|identity/);
  });
  it("rejects target markup introduced inside a partial slot", () => {
    const units = ['<span data-flt-text-id="0">One. </span>', '<span data-flt-text-id="0">Two.</span>'];
    expect(() => assembleMtSentences('<span data-flt-text-id="0">One. Two.</span>', units,
      ['<span data-flt-text-id="0">一。</span>', '<span data-flt-text-id="0"><b>二。</b></span>'])).toThrow(/rich structure|identity/);
  });
  it("retains the entire wrapped paragraph when a later unit is truncated", async () => {
    const html = `<span data-flt-text-id="0">${sentences.join("")}</span>`;
    let calls = 0;
    const result = await inferMtHtml({html, sourceLanguage: "en", targetLanguage: "zh-Hans"}, async options => {
      calls++;
      return {choices: [{finish_reason: calls === 2 ? "length" : "stop", message: {content:
        options.messages[0].content.split("English:\n")[1].split("\nChinese:")[0]}}]};
    });
    expect(calls).toBe(2); expect(result.accepted).toBe(false); expect(result.html).toBe(html);
  });
});
