import { describe, expect, it } from "vitest";
import {
  richHtmlStructureCompatible,
  richMarkerCandidateCount,
  splitRichHtmlByStructureBudget,
  translateRichHtmlTextNodesSafely,
} from "../src/core/rich-segment-splitter";

describe("rich segment structure budget", () => {
  it("keeps ordinary rich HTML in one chunk", () => {
    const html = "Read <strong>the docs</strong> and <em>continue</em>.";
    expect(richMarkerCandidateCount(html)).toBe(2);
    expect(splitRichHtmlByStructureBudget(html, 6)).toEqual([html]);
  });

  it("splits a ten-marker rich segment into complete <=6-marker chunks", () => {
    const html = Array.from({ length: 10 }, (_, index) => "<strong>part " + index + "</strong>").join(" ");
    const chunks = splitRichHtmlByStructureBudget(html, 6);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => richMarkerCandidateCount(chunk) <= 6)).toBe(true);
    expect(chunks.join("").replace(/\s+/g, " ").trim()).toBe(html.replace(/\s+/g, " ").trim());
  });

  it("duplicates only formatting wrappers when a nested subtree exceeds budget", () => {
    const html = "<strong>" + Array.from({ length: 8 }, (_, index) => "<em>nested " + index + "</em>").join(" ") + "</strong>";
    const chunks = splitRichHtmlByStructureBudget(html, 6);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => richMarkerCandidateCount(chunk) <= 6)).toBe(true);
    expect(chunks.every((chunk) => chunk.startsWith("<strong>"))).toBe(true);
  });

  it("accepts sibling reorder but rejects dropped tags and changed nesting", () => {
    expect(richHtmlStructureCompatible(
      "<strong>A</strong><em>B</em>",
      "<em>乙</em><strong>甲</strong>",
    )).toBe(true);
    expect(richHtmlStructureCompatible(
      "<strong>A</strong><em>B</em>",
      "<strong>甲</strong>乙",
    )).toBe(false);
    expect(richHtmlStructureCompatible(
      "<strong><em>A</em></strong>",
      "<em><strong>甲</strong></em>",
    )).toBe(false);
  });

  it("preserves exact markup in leaf-safe fallback", async () => {
    const html = "Before <strong>alpha <em>beta</em></strong> <code>__FLT_OPAQUE_0__</code>.";
    const translated = await translateRichHtmlTextNodesSafely(html, async (text) => "译:" + text);
    expect(richHtmlStructureCompatible(html, translated)).toBe(true);
    expect(translated).toContain("<strong>");
    expect(translated).toContain("<em>");
    expect(translated).toContain("__FLT_OPAQUE_0__");
    expect(translated).toContain("译:Before");
  });
  it("rejects an oversized atomic anchor instead of violating the marker budget", () => {
    const html =
      '<a data-flt-link-id="0" href="https://pagelingo.invalid/__link/0">' +
      Array.from({ length: 8 }, (_, index) => "<strong>part " + index + "</strong>").join(" ") +
      "</a>";
    expect(() => splitRichHtmlByStructureBudget(html, 6)).toThrow(/oversized atomic/i);
  });

  it("escapes decoded text nodes while rebuilding split HTML", () => {
    const html =
      "Literal &lt;config&gt; &amp;copy; " +
      Array.from({ length: 8 }, (_, index) => "<strong>part " + index + "</strong>").join(" ");
    const chunks = splitRichHtmlByStructureBudget(html, 6);
    const rebuilt = chunks.join("");
    const parsed = new DOMParser().parseFromString(rebuilt, "text/html");

    expect(parsed.body.querySelector("config")).toBeNull();
    expect(parsed.body.textContent).toContain("Literal <config> &copy;");
    expect(rebuilt).toContain("&lt;config&gt;");
    expect(rebuilt).toContain("&amp;copy;");
  });

});
