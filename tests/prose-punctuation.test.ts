import { afterEach, describe, expect, it } from "vitest";
import { classifyProsePunctuation, closeLabelColon } from "../src/core/prose-punctuation";
import { serializeRichSegment } from "../src/core/rich-segment";
import { PageTranslator } from "../src/core/page-translator";
import type { TranslationRequest } from "../src/core/provider";

afterEach(() => document.body.replaceChildren());

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

describe("standalone terminal punctuation after inline links/tags", () => {
  it("promotes trailing sentence punctuation after </a> to a prose-punctuation slot while protecting dotted versions and ordinals", () => {
    document.body.innerHTML = `<p>Read <a href="/why">Why OpenClaw</a>.</p>`;
    const p = document.querySelector("p")!;
    const seg = serializeRichSegment(p, { fixedTextSlots: true, prosePunctuationSlots: true });
    expect(seg.textSlots).toHaveLength(3);
    expect(seg.textSlots![2]?.writePolicy).toBe("prose-punctuation");
    expect(seg.textSlots![2]?.source).toBe(".");
    expect(seg.html).toContain(`<span data-flt-text-id="2">.</span>`);
    expect(seg.html).not.toContain(`data-flt-fixed`);

    // Dotted version numbers, code expressions, and numeric list prefixes stay fixed.
    for (const protectedHtml of [
      `<p>Version <span>1</span>.<span>2</span> released</p>`,
      `<p>Call <code>foo</code>.<code>bar()</code> now</p>`,
      `<li><span>1</span>. <a href="/a">Service</a></li>`,
      `<p><code>only()</code>.</p>`,
    ]) {
      document.body.innerHTML = protectedHtml;
      const el = document.body.firstElementChild as HTMLElement;
      const result = serializeRichSegment(el, { fixedTextSlots: true, prosePunctuationSlots: true });
      expect(result.textSlots?.some((s) => s.writePolicy === "prose-punctuation")).toBe(false);
    }
  });

  it("converts a residual ASCII period after </a> to fullwidth 。 in Chinese translations and restores cleanly", async () => {
    document.body.innerHTML = `<p>The full architecture case is in <a href="/start/why-openclaw">Why OpenClaw</a>.</p>`;
    const p = document.querySelector("p")!;
    const link = p.querySelector("a")!;
    const before = p.outerHTML;
    const provider = {
      prefersWholeSentenceHtml: async () => true,
      translateHtml: async (req: TranslationRequest) =>
        // Simulate an engine/plain-text fallback that leaves the standalone '.' slot unconverted.
        req.html
          .replace("The full architecture case is in ", "完整的架构案例详见 ")
          .replace("Why OpenClaw", "为什么选择 OpenClaw"),
    };

    const translator = new PageTranslator(document, provider, {
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
      displayMode: "translation",
    });
    await translator.translateAll(p);
    expect(translator.translatedCount).toBe(1);
    expect(p.querySelector("a")).toBe(link);
    expect(p.textContent).toBe("完整的架构案例详见为什么选择 OpenClaw。");

    // Bilingual mode keeps the original '.' in source and fullwidth '。' in translation.
    translator.setDisplayMode("bilingual");
    expect(p.firstChild?.textContent).toBe("The full architecture case is in ");
    expect(link.nextSibling?.textContent).toBe(".");
    expect(document.querySelector('[data-flt-generated="translation"]')?.textContent).toBe("完整的架构案例详见为什么选择 OpenClaw。");

    translator.restore();
    expect(p.outerHTML).toBe(before);

    // Non-Chinese target languages keep ASCII period untouched.
    const frTranslator = new PageTranslator(document, {
      prefersWholeSentenceHtml: async () => true,
      translateHtml: async (req: TranslationRequest) =>
        req.html
          .replace("The full architecture case is in ", "Le cas complet se trouve dans ")
          .replace("Why OpenClaw", "Pourquoi OpenClaw"),
    }, {
      sourceLanguage: "en",
      targetLanguage: "fr",
      displayMode: "translation",
    });
    await frTranslator.translateAll(p);
    expect(p.textContent).toBe("Le cas complet se trouve dans Pourquoi OpenClaw.");
    frTranslator.restore();
  });
});

