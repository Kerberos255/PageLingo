import {afterEach, describe, expect, it} from "vitest";
import {serializeRichSegment} from "../src/core/rich-segment";
import {checkSemanticFixed, naturalTranslationPrompt, prepareSemanticRewrite, semanticFixedPrompt} from "../eval/mt-quality/semantic-rewrite";
afterEach(() => document.body.replaceChildren());
describe("paired natural translation and fixed-node paraphrase research", () => {
  it("exposes original code meaning and original formatting roles without application sentinels", () => {
    document.body.innerHTML = '<p>Read <a href="/guide"><em>the guide</em></a> using <code>cancel()</code>.</p>';
    const segment = serializeRichSegment(document.querySelector("p")!, {fixedTextSlots: true});
    const encoded = prepareSemanticRewrite({html: segment.html, sourceLanguage: "en", targetLanguage: "zh-Hans"}, segment.opaque);
    expect(encoded.sourceText).toBe("Read the guide using cancel().");
    expect(encoded.textRoles).toEqual([{id: 0, roles: ["plain"]}, {id: 1, roles: ["emphasis:em", "link"]}, {id: 2, roles: ["plain"]}]);
    expect(encoded.protectedContext[0]).toMatchObject({token: "⟪P0⟫", kind: "code", text: "cancel()"});
    expect(naturalTranslationPrompt(encoded)).not.toMatch(/__FLT_|⟦/u);
  });
  it("keeps the source roles and protected payload identical when adding a draft", () => {
    const encoded = prepareSemanticRewrite({html: "Give <code>token</code> to <a>the reader</a> now.", sourceLanguage: "en", targetLanguage: "zh-Hans"});
    const direct = semanticFixedPrompt(encoded), chained = semanticFixedPrompt(encoded, '给阅读器 token。\n"draft"');
    expect(direct.endsWith(`英文：\n${encoded.fixed.source}\n译文：`)).toBe(true);
    expect(chained).toContain(JSON.stringify('给阅读器 token。\n"draft"'));
    expect(chained).toContain(JSON.stringify(encoded.protectedContext));
    expect(chained).toContain(JSON.stringify(encoded.textRoles));
  });
  it("refuses to invent missing original opaque context", () => {
    expect(() => prepareSemanticRewrite({html: '<span data-flt-text-id="0">Use </span><code>__FLT_OPAQUE_0__</code>', sourceLanguage: "en", targetLanguage: "zh-Hans"}))
      .toThrow(/Missing original protected/);
  });
  it("leaves detached source unchanged when the framed output drops or moves an immutable atom", () => {
    const encoded = prepareSemanticRewrite({html: "Use <code>cancel()</code> now.", sourceLanguage: "en", targetLanguage: "zh-Hans"});
    const before = encoded.fixed.body.innerHTML;
    expect(() => checkSemanticFixed(encoded, "⟦0⟧使用⟦/0⟧⟦1⟧现在。⟦/1⟧", "stop")).toThrow();
    expect(encoded.fixed.body.innerHTML).toBe(before);
  });
  it("preserves an original code-only link without allocating a generated text node inside it", () => {
    const encoded = prepareSemanticRewrite({html: 'Here is an example using <a><code>Thread</code></a>:', sourceLanguage: "en", targetLanguage: "zh-Hans"});
    expect(encoded.textRoles).toEqual([{id: 0, roles: ["plain"]}]);
    expect(encoded.protectedContext[0]).toMatchObject({kind: "code", text: "Thread", roles: ["link"]});
    expect(checkSemanticFixed(encoded, '⟦0⟧下面给出一个创建并启动线程的示例，所用工具是⟦/0⟧⟪P0⟫⟪P1⟫', "stop"))
      .toContain('<a><code>Thread</code></a>:');
  });
});
