import { describe, expect, it } from "vitest";
import {
  damagedTerms,
  directBergamotResult,
  onlyProtectedTerms,
  planTermGuard,
  protectOnly,
} from "../src/providers/bergamot/term-guard";
import { restoreTerminologyHtml } from "../src/core/rich-segment";

describe("Bergamot term guard and standalone labels", () => {
  it("translates known-broken standalone en->zh labels while leaving sentences and polysemous words to the model", () => {
    expect(directBergamotResult(`<span data-flt-text-id="0">Neither</span>`, "en", "zh-Hans"))
      .toBe(`<span data-flt-text-id="0">两者都不</span>`);
    expect(directBergamotResult(`<b><span data-flt-text-id="0"> Neither </span></b>`, "en", "zh-Hant"))
      .toBe(`<b><span data-flt-text-id="0"> 兩者都不 </span></b>`);
    expect(directBergamotResult(`<span data-flt-text-id="0">Nevermind</span>`, "en", "zh-Hans"))
      .toBe(`<span data-flt-text-id="0">算了</span>`);
    expect(directBergamotResult(`<span data-flt-text-id="0">Neither option works.</span>`, "en", "zh-Hans"))
      .toBeUndefined();
    expect(directBergamotResult(`<span data-flt-text-id="0">Load</span>`, "en", "zh-Hans"))
      .toBeUndefined();
    expect(directBergamotResult(`<span data-flt-text-id="0">Neither</span>`, "fr", "zh-Hans"))
      .toBeUndefined();
  });

  it("preserves lone CamelCase names and segments containing only protected terms", () => {
    expect(directBergamotResult(`<span data-flt-text-id="0">PageLingo</span>`, "en", "zh-Hans"))
      .toBe(`<span data-flt-text-id="0">PageLingo</span>`);
    expect(directBergamotResult(`<span data-flt-text-id="0">OpenRouter</span>`, "en", "zh-Hans"))
      .toBe(`<span data-flt-text-id="0">OpenRouter</span>`);
    expect(directBergamotResult(`<span data-flt-text-id="0"><span data-flt-term-id="0">PageLingo</span></span>`, "en", "zh-Hans"))
      .toBe(`<span data-flt-text-id="0"><span data-flt-term-id="0">PageLingo</span></span>`);
    expect(onlyProtectedTerms(
      `<a data-flt-link-id="0" href="https://pagelingo.invalid/__link/0"><code>__FLT_LINK_START_0__</code><span data-flt-text-id="0"><span data-flt-term-id="0">PageLingo</span></span><code>__FLT_LINK_END_0__</code></a>`,
    )).toBe(true);
    expect(onlyProtectedTerms(
      `<span data-flt-text-id="0"><span data-flt-term-id="0">PageLingo</span> translates webpages</span>`,
    )).toBe(false);
  });

  it("unwraps protection spans for verify-first translation and re-protects only damaged terms", () => {
    const source = `<span data-flt-text-id="0">Runs in <span data-flt-term-id="0">Firefox</span> with <span data-flt-term-id="1">Bergamot</span> WASM and <span data-flt-term-id="2">PageLingo</span>.</span>`;
    const plan = planTermGuard(source)!;
    expect(plan.unprotected).toBe(`<span data-flt-text-id="0">Runs in Firefox with Bergamot WASM and PageLingo.</span>`);
    expect(plan.expected.get("Firefox")).toBe(1);
    expect(plan.expected.get("Bergamot")).toBe(1);
    expect(plan.expected.get("PageLingo")).toBe(1);

    const undamaged = damagedTerms(plan, `<span data-flt-text-id="0">在 Firefox 中使用 Bergamot WASM 和 PageLingo 运行。</span>`);
    expect(undamaged.size).toBe(0);

    const broken = damagedTerms(plan, `<span data-flt-text-id="0">在 Firefox 中使用 Bergatot WASM 和 佩吉林戈 运行。</span>`);
    expect([...broken].sort()).toEqual(["Bergamot", "PageLingo"]);

    expect(protectOnly(source, broken)).toBe(
      `<span data-flt-text-id="0">Runs in Firefox with <span data-flt-term-id="1">Bergamot</span> WASM and <span data-flt-term-id="2">PageLingo</span>.</span>`,
    );
  });

  it("restores Latin spacing and preserves soft-aligned neighbours without breaking duplicate collapse", () => {
    const glued = restoreTerminologyHtml(
      document,
      `采用<span data-flt-term-id="0">Bergamot</span>WASM 和 Mozilla<span data-flt-term-id="1">Marian</span>模型`,
      ["Bergamot", "Marian"],
    );
    expect(glued).toBe("采用Bergamot WASM 和 Mozilla Marian模型");

    const pulled = restoreTerminologyHtml(
      document,
      `Microsoft <span data-flt-term-id="0">Translator、Google Cloud</span> Translation`,
      ["Google Cloud"],
    );
    expect(pulled).toBe("Microsoft Translator、Google Cloud Translation");

    const duplicated = restoreTerminologyHtml(
      document,
      `<span data-flt-term-id="0">ClaudeGPT克劳德</span>和<span data-flt-term-id="1">GPT</span>模型`,
      ["Claude", "GPT"],
    );
    expect(duplicated).toBe("Claude和GPT模型");
  });
});
