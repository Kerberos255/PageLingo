import { afterEach, describe, expect, it } from "vitest";
import { PageTranslator } from "../src/core/page-translator";
import {
  normalizeNumericDotPunctuation,
  protectLeadingListMarkerText,
  protectListMarkersHtml,
  restoreLeadingListMarkerText,
  restoreListMarkersHtml,
} from "../src/core/list-marker-preserve";
import { restoreFixedHtmlTransport } from "../src/core/fixed-html-transport";
import type { TranslationProvider } from "../src/core/provider";

describe("List marker and numeric dot preservation", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps uniform '1. ' / '4. ' / '6. ' ordinals in TOC links even when engines corrupt '.' into '。' or drop spaces", async () => {
    document.body.innerHTML = `
      <div class="navigation">
        <h3>Table of contents</h3>
        <ul>
          <li><a href="#1">1. Service</a></li>
          <li><a href="#2">2. Users and Publishers</a></li>
          <li><a href="#3">3. Acceptable Use</a></li>
          <li><a href="#4">4. Publisher Content</a></li>
          <li><a href="#5">5. User Generated Content</a></li>
          <li><a href="#6">6. Digital Millennium Copyright Act</a></li>
        </ul>
      </div>
    `;

    const seenInputs: string[] = [];
    const dict: Record<string, string> = {
      "Table of contents": "目录",
      "Service": "服务",
      "Users and Publishers": "用户和出版商",
      "Acceptable Use": "可接受使用",
      "Publisher Content": "出版商内容",
      "User Generated Content": "用户生成内容",
      "Digital Millennium Copyright Act": "数字千年版权法",
    };

    const provider: TranslationProvider = {
      prefersWholeSentenceHtml: async () => true,
      translateHtml: async ({ html }) => {
        seenInputs.push(html);
        // Simulate an engine that converts any raw "." into "。" if an ordinal leaked through.
        let out = html;
        for (const [en, zh] of Object.entries(dict)) {
          out = out.replace(en, zh);
        }
        return out.replace(/(\d+)\.\s*/g, "$1。");
      },
    };

    const translator = new PageTranslator(document, provider, {
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
      displayMode: "translation",
    });
    await translator.translateAll();

    // Provider must have received clean headings without the "1. ".."6. " prefix.
    expect(seenInputs.some((h) => h.includes(">Service<"))).toBe(true);
    expect(seenInputs.some((h) => h.includes(">Publisher Content<"))).toBe(true);
    expect(seenInputs.some((h) => h.includes(">1. Service<"))).toBe(false);

    const labels = Array.from(document.querySelectorAll("li a")).map((a) => a.textContent);
    expect(labels).toEqual([
      "1. 服务",
      "2. 用户和出版商",
      "3. 可接受使用",
      "4. 出版商内容",
      "5. 用户生成内容",
      "6. 数字千年版权法",
    ]);

    translator.restore();
    expect(Array.from(document.querySelectorAll("li a")).map((a) => a.textContent)).toEqual([
      "1. Service",
      "2. Users and Publishers",
      "3. Acceptable Use",
      "4. Publisher Content",
      "5. User Generated Content",
      "6. Digital Millennium Copyright Act",
    ]);
  });

  it("supports multi-level section numbers, parenthesized ordinals, and <br>-separated numbered lines", () => {
    const source = `<span data-flt-text-id="0">1.2. Overview</span><br><span data-flt-text-id="1">1.3. Details</span>`;
    const protectedRes = protectListMarkersHtml(source);
    expect(protectedRes.markers).toHaveLength(2);
    expect(protectedRes.html).toContain(">Overview<");
    expect(protectedRes.html).toContain(">Details<");

    const translated = `<span data-flt-text-id="0">概述</span><br><span data-flt-text-id="1">详情</span>`;
    const restored = restoreListMarkersHtml(source, translated, protectedRes.markers);
    expect(restored).toBe(`<span data-flt-text-id="0">1.2. 概述</span><br><span data-flt-text-id="1">1.3. 详情</span>`);

    const paren = protectLeadingListMarkerText("(2) Second clause");
    expect(paren).toEqual({ text: "Second clause", prefix: "(2) " });
    expect(restoreLeadingListMarkerText("(2) Second clause", "第二条款", paren.prefix)).toBe("(2) 第二条款");
  });

  it("does not strip 4-digit years while normalizing decimal/version dots and preserving sentence-ending '。'", () => {
    const yearHtml = `<span data-flt-text-id="0">2026. That was a milestone year.</span>`;
    const protectedYear = protectListMarkersHtml(yearHtml);
    expect(protectedYear.markers).toHaveLength(0);
    expect(protectedYear.html).toBe(yearHtml);

    const normalized = normalizeNumericDotPunctuation(
      "Version 2.0.1 is 3.14x faster.",
      "版本 2。0。1 快了 3。14 倍。",
    );
    expect(normalized).toBe("版本 2.0.1 快了 3.14 倍。");

    const multiLineFixed = normalizeNumericDotPunctuation(
      "1. First item\n4. Fourth item",
      "1。 第一项\n4.第四项",
    );
    expect(multiLineFixed).toBe("1. 第一项\n4. 第四项");
  });

  it("recovers numbered data-flt-fixed atoms when an engine converts '.' to '。'", () => {
    const source = `<span data-flt-fixed="true">1. </span><a data-flt-link-id="0" href="https://pagelingo.invalid/__link/0"><code>__FLT_LINK_START_0__</code><span data-flt-text-id="0">Service</span><code>__FLT_LINK_END_0__</code></a>`;
    const received = `<span data-flt-fixed="true">1。</span><a data-flt-link-id="0" href="https://pagelingo.invalid/__link/0"><code>__FLT_LINK_START_0__</code><span data-flt-text-id="0">服务</span><code>__FLT_LINK_END_0__</code></a>`;
    const restored = restoreFixedHtmlTransport(source, received);
    expect(restored).toContain(`<span data-flt-fixed="true">1. </span>`);
  });
});
