import {afterEach, describe, expect, it} from "vitest";
import type {TranslationRequest} from "../src/core/provider";
import {PageTranslator} from "../src/core/page-translator";
import {serializeRichSegment} from "../src/core/rich-segment";
import {encodeFixedMtText, fixedMtPrompt} from "../src/providers/pagelingo-mt/fixed-text";
import {inferMtHtml} from "../src/providers/pagelingo-mt/inference";
import {clarifyReturnCondition} from "../src/providers/pagelingo-mt/return-condition";

const route = {sourceLanguage: "en", targetLanguage: "zh-Hans"};
const source = 'Returns <code>true</code> if the ordering is not the <a href="/equal"><code>Equal</code></a> variant.';
const response = {choices: [{finish_reason: "stop", message: {content:
  '⟦0⟧返回值为⟦/0⟧⟪P0⟫⟦1⟧，条件是排序不等于⟦/1⟧⟪P1⟫⟦2⟧变体。⟦/2⟧'}}]};
const capture = async (html: string, clarified: boolean) => {
  const calls: unknown[] = [];
  await inferMtHtml({html, ...route}, async options => {
    calls.push(options);
    return {choices: [{finish_reason: "length"}]};
  }, {clarifyReturnConditions: clarified});
  expect(calls).toHaveLength(1);
  return calls[0];
};

afterEach(() => document.body.replaceChildren());

describe("MT return and condition prompt", () => {
  it("submits the new source in one unchanged frame and writes the original nodes", async () => {
    document.body.innerHTML = `<p>${source}</p>`;
    const root = document.querySelector("p")!;
    const before = root.outerHTML;
    const nodes = [...root.childNodes];
    const link = root.querySelector("a")!;
    const linkedCode = link.firstChild;
    const expected = await capture(serializeRichSegment(root, {fixedTextSlots: true}).html, false);
    let calls = 0;
    const translator = new PageTranslator(document, {prefersWholeSentenceHtml: async () => true,
      translateHtml: async (request: TranslationRequest) => {
        const result = await inferMtHtml(request, async options => {
          calls++;
          expect(options.messages[0].content).toContain('The return value is ⟦/0⟧⟪P0⟫⟦1⟧ under this condition: the ordering is not the ');
          expect({...options, messages: undefined}).toEqual({...expected as object, messages: undefined});
          return response;
        }, {clarifyReturnConditions: true});
        expect(result.accepted).toBe(true);
        return result.html;
      }}, {...route, displayMode: "translation", concurrency: 1});

    await translator.translateAll(document.body);
    expect(calls).toBe(1);
    expect(translator.translatedCount).toBe(1);
    expect(root.querySelector("a[href='/equal']")).toBe(link);
    expect(link.firstChild).toBe(linkedCode);
    expect([...root.childNodes]).toEqual(nodes);
    expect(root.textContent).toBe("返回值为 true，条件是排序不等于 Equal 变体。");
    translator.restore();
    expect(root.outerHTML).toBe(before);
  });

  it.each([
    'Returns <code>true</code> unless the status is <code>Ready</code>.',
    'Returns <code>true</code> only if the status is <code>Ready</code>.',
    'Returns <code>true</code> if the status is <code>Ready</code>, otherwise it stops.',
    'Returns <code>true</code> if the status is <code>Ready</code> or if it is queued.',
    'Returns <code>true</code> if the status is <code>Ready</code>, false when queued.',
    'Returns <code>true</code> if the status is <code>Ready</code>, false for queued work.',
    'Returns <code>true</code> if the status is <code>Ready</code><br>and returns false for queued work.',
    'Returns <code>true</code> if the status is <code>Ready</code>. It preserves the value.',
    '<em>Returns </em><code>true</code> if the status is <code>Ready</code>.',
    'Returns <code>true</code><em> if the status is </em><code>Ready</code>.',
  ])("uses the original request outside its scope for %j", async html => {
    expect(await capture(html, true)).toEqual(await capture(html, false));
  });

  it("uses the original prompt when there is room only for the original bytes", () => {
    const request = {html: source, ...route};
    const encoded = encodeFixedMtText(source);
    const originalBytes = new TextEncoder().encode(fixedMtPrompt(encoded, request)).length;
    expect(clarifyReturnCondition(encoded, request, originalBytes)).toBeUndefined();
    expect(clarifyReturnCondition(encoded, request, originalBytes + 100)).toContain("The return value is");
  });
});
