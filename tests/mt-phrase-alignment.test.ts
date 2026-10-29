import {describe, expect, it} from "vitest";
import {encodeSentenceAlignment} from "../eval/mt-quality/sentence-alignment";
import {alignTranslatedPhrases} from "../eval/mt-quality/phrase-alignment";

describe("independent phrase exact alignment research", () => {
  it("keeps the complete linked action rather than trusting a draft's partial marker span", () => {
    const encoded = encodeSentenceAlignment('Prefer one <code>h1</code> per page and <a>nest headings</a> without skipping levels.');
    const {html, aligned} = alignTranslatedPhrases(encoded, "每页只使用一个⟪P0⟫，且不能跳过层级地嵌套标题。", new Map([[0, "嵌套标题"]]));
    expect(aligned).toContain("地⟦0⟧嵌套标题⟦/0⟧。");
    expect(html).toContain("<a>嵌套标题</a>");
  });
  it.each(["阅读指南，然后关闭指南。", "阅读说明，然后关闭。"])("rejects an ambiguous or absent phrase: %s", draft => {
    const encoded = encodeSentenceAlignment("Read <a>the guide</a> and close it.");
    const before = encoded.fixed.body.innerHTML;
    expect(() => alignTranslatedPhrases(encoded, draft, new Map([[0, "指南"]]))).toThrow(/absent or ambiguous/);
    expect(encoded.fixed.body.innerHTML).toBe(before);
  });
  it("rejects a unique but reversed ordering of two labels", () => {
    const encoded = encodeSentenceAlignment("Read <a>one</a> and <a>two</a> now.");
    expect(() => alignTranslatedPhrases(encoded, "先阅读二以及一。", new Map([[0, "一"], [1, "二"]])))
      .toThrow(/non-monotone/);
  });
  it("rejects otherwise complete words after the final original protected node", () => {
    const encoded = encodeSentenceAlignment("An example using <a><code>Thread</code></a>:");
    expect(() => alignTranslatedPhrases(encoded, "使用⟪P0⟫创建线程的示例⟪P1⟫", new Map([[0, "⟪P0⟫"]])))
      .toThrow(/unassigned text/);
  });
  it("preserves nested formatting when two source labels have the same translated extent", () => {
    const encoded = encodeSentenceAlignment("Read <a><em>the guide</em></a> now.");
    const {html} = alignTranslatedPhrases(encoded, "现在阅读指南。", new Map([[0, "指南"], [1, "指南"]]));
    expect(html).toContain("<a><em>指南</em></a>");
  });
  it("rejects cross-nesting from overlapping exact phrase matches", () => {
    const encoded = encodeSentenceAlignment("Read <a>one two</a> then <em>two three</em> now.");
    expect(() => alignTranslatedPhrases(encoded, "现在阅读一二三。", new Map([[0, "一二"], [1, "二三"]])))
      .toThrow(/non-monotone/);
  });
});
