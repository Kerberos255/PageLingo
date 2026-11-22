import { describe, expect, it } from "vitest";
import { classifyProsePunctuation, closeLabelColon } from "../src/core/prose-punctuation";

describe("bounded prose punctuation ownership", () => {
  it("leaves standalone symbols and NBSP outside prose punctuation classification", () => {
    expect(classifyProsePunctuation("\u00a0", "Read ", "later")).toBeNull();
    expect(classifyProsePunctuation(".", "Version 1", "2")).toBeNull();
  });

  it("classifies terminal sentence punctuation after prose", () => {
    expect(classifyProsePunctuation(".", "Call x()", "")).toBeTruthy();
  });
});

describe("format label colon extent", () => {
  it("includes only an adjacent equivalent colon without consuming following words", () => {
    expect(closeLabelColon("Caution:", "小心：继续。", 0, 2)).toEqual({ start: 0, end: 3 });
    expect(closeLabelColon("Label:", "标签:继续。", 0, 3)).toEqual({ start: 0, end: 3 });
    expect(() => closeLabelColon("Caution:", "小心操作：继续。", 0, 2)).toThrow(/missing/);
  });
});
