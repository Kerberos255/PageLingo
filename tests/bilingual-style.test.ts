import { afterEach, describe, expect, it } from "vitest";
import { buildBilingualRulesCss } from "../src/core/bilingual-style";
import { PageTranslator } from "../src/core/page-translator";
import type { TranslationRequest } from "../src/core/provider";
import { DEFAULT_BILINGUAL_STYLE, normalizeBilingualStyle } from "../src/shared/settings";

afterEach(() => {
  document.body.replaceChildren();
});

describe("webpage bilingual style settings and CSS generation", () => {
  it("normalizes bilingual style settings and clamps fontScale to 85–115", () => {
    expect(normalizeBilingualStyle(null)).toEqual(DEFAULT_BILINGUAL_STYLE);
    expect(normalizeBilingualStyle({
      order: "translation-top",
      learningMode: true,
      theme: "border-left",
      fontScale: 200,
      translationColor: "#2563EB",
    })).toEqual({
      order: "translation-top",
      learningMode: true,
      theme: "border-left",
      fontScale: 115,
      translationColor: "#2563eb",
    });
    expect(normalizeBilingualStyle({
      order: "invalid",
      theme: "neon",
      fontScale: 40,
      translationColor: "#ff00ff",
    })).toEqual({
      order: "source-top",
      learningMode: false,
      theme: "inherit",
      fontScale: 85,
      translationColor: "inherit",
    });
  });

  it("generates CSS variables, theme rules, learning mode blur, and translation-only resets", () => {
    const css = buildBilingualRulesCss({
      order: "translation-top",
      learningMode: true,
      theme: "border-left",
      fontScale: 95,
      translationColor: "#2563eb",
    }, ":host");

    expect(css).toContain(":host {");
    expect(css).toContain("--pagelingo-bilingual-scale: 0.95;");
    expect(css).toContain("--pagelingo-bilingual-color: #2563eb;");
    expect(css).toContain("border-inline-start:");
    expect(css).toContain("--pagelingo-bilingual-pad-start: 0.65em;");
    expect(css).toContain("filter: blur(5.5px) !important;");
    expect(css).toContain('[data-pagelingo-revealed="true"]');
    expect(css).toContain('.flt-translation[data-flt-display-mode="translation"]');
  });

  it("supports translation-top ordering, live style updates, learning-mode click reveal, and clean restore", async () => {
    document.body.innerHTML = `
      <main>
        <p id="prose">Read the <a id="doc-link" href="#docs">guide</a> carefully.</p>
      </main>
    `;
    const provider = {
      prefersWholeSentenceHtml: async () => true,
      translateHtml: async (req: TranslationRequest) =>
        req.html
          .replace("Read the ", "仔细阅读 ")
          .replace("guide", "指南")
          .replace(" carefully.", "。"),
    };

    const translator = new PageTranslator(document, provider, {
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
      displayMode: "bilingual",
      bilingualStyle: {
        order: "translation-top",
        learningMode: true,
        theme: "highlight",
        fontScale: 95,
        translationColor: "#0f766e",
      },
    });

    await translator.translateAll(document.body);
    const prose = document.getElementById("prose")!;
    const translation = prose.querySelector<HTMLElement>('[data-flt-generated="translation"]')!;
    expect(translation).not.toBeNull();
    // translation-top mounts before the source text inside the paragraph.
    expect(prose.firstElementChild).toBe(translation);
    expect(translation.dataset.fltOrder).toBe("translation-top");

    // Clicking inside the translation box toggles learning-mode reveal,
    // while clicking an inline link inside the translation box does NOT toggle reveal.
    const translatedLink = translation.querySelector("a")!;
    translatedLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(translation.getAttribute("data-pagelingo-revealed")).toBeNull();

    translation.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(translation.getAttribute("data-pagelingo-revealed")).toBe("true");
    translation.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(translation.getAttribute("data-pagelingo-revealed")).toBeNull();

    // Live style update switches back to source-top and disables learning mode cleanly.
    translation.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(translation.getAttribute("data-pagelingo-revealed")).toBe("true");
    translator.setBilingualStyle({
      order: "source-top",
      learningMode: false,
      theme: "underline",
      fontScale: 105,
      translationColor: "inherit",
    });
    expect(prose.lastElementChild).toBe(translation);
    expect(translation.dataset.fltOrder).toBeUndefined();
    expect(translation.getAttribute("data-pagelingo-revealed")).toBeNull();

    // Switching translation-only -> bilingual preserves clean state and respects updated order.
    translator.setDisplayMode("translation");
    translator.setBilingualStyle({ order: "translation-top" });
    translator.setDisplayMode("bilingual");
    const remounted = prose.querySelector<HTMLElement>('[data-flt-generated="translation"]')!;
    expect(prose.firstElementChild).toBe(remounted);
    expect(remounted.dataset.fltOrder).toBe("translation-top");
    expect(remounted.dataset.fltDisplayMode).toBeUndefined();

    // Full restore removes all generated translation nodes and leaves source untouched.
    translator.restore();
    expect(document.querySelector('[data-flt-generated="translation"]')).toBeNull();
    expect(prose.textContent).toBe("Read the guide carefully.");
  });

  it("skips duplicate unchanged brand labels and keeps control SVG icons ahead of translated labels", async () => {
    document.body.innerHTML = `
      <header>
        <strong id="brand">PageLingo</strong>
        <button id="install-btn"><svg id="btn-icon"></svg>Install language pack</button>
      </header>
    `;
    const provider = {
      prefersWholeSentenceHtml: async () => true,
      translateHtml: async (req: TranslationRequest) =>
        req.html.replace("Install language pack", "安装语言包"),
    };

    const translator = new PageTranslator(document, provider, {
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
      displayMode: "bilingual",
      bilingualStyle: { order: "translation-top", theme: "border-left" },
    });

    await translator.translateAll(document.body);

    // Unchanged brand text ("PageLingo" === "PageLingo") must NOT mount a duplicate flex sibling.
    const header = document.querySelector("header")!;
    expect(header.querySelectorAll('[data-flt-generated="translation"]')).toHaveLength(1);
    expect(document.getElementById("brand")!.nextElementSibling?.id).toBe("install-btn");

    // Control with leading SVG keeps <svg> as first child even in translation-top mode.
    const button = document.getElementById("install-btn")!;
    const controlTranslation = button.querySelector<HTMLElement>('[data-flt-generated="translation"]')!;
    expect(controlTranslation).not.toBeNull();
    expect(controlTranslation.dataset.fltControl).toBe("true");
    expect(button.firstElementChild?.id).toBe("btn-icon");
    expect(button.children[1]).toBe(controlTranslation);

    // Live switch back to source-top keeps <svg> first and places translation after source text.
    translator.setBilingualStyle({ order: "source-top" });
    const remountedControl = button.querySelector<HTMLElement>('[data-flt-generated="translation"]')!;
    expect(button.firstElementChild?.id).toBe("btn-icon");
    expect(button.lastElementChild).toBe(remountedControl);
    expect(remountedControl.dataset.fltOrder).toBeUndefined();
  });
});
