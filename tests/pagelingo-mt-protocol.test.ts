import { describe, expect, it } from "vitest";
import {
  decodeMtHtml,
  encodeMtHtml,
  mtRouteSupported,
  validateMtOutput,
} from "../src/providers/pagelingo-mt/protocol";

describe("PageLingo MT protocol", () => {
  it("round-trips nested markers while preserving protected code", () => {
    const encoded = encodeMtHtml('<strong>Hello <em>world</em></strong> with <code>npm run build</code>.');
    expect(encoded.source).toContain("⟦0⟧");
    expect(encoded.source).toContain("⟪P0⟫");

    const translated = encoded.source
      .replace("Hello ", "你好")
      .replace("world", "世界")
      .replace(" with ", "，使用")
      .replace(/\.$/, "。");

    const validation = validateMtOutput(encoded, translated);
    expect(validation.ok).toBe(true);
    const decoded = decodeMtHtml(encoded, translated);
    const holder = document.createElement("div");
    holder.innerHTML = decoded;
    expect(holder.querySelector("strong em")?.textContent).toBe("世界");
    expect(holder.querySelector("code")?.textContent).toBe("npm run build");
  });

  it("rejects marker damage and non-Chinese output", () => {
    const encoded = encodeMtHtml("<strong>Hello world</strong>");
    expect(validateMtOutput(encoded, "Hello world").ok).toBe(false);
    expect(validateMtOutput(encoded, "⟦0⟧Hello world⟦/0⟧").cjkOk).toBe(false);
  });

  it("only advertises the currently trained route", () => {
    expect(mtRouteSupported({ html: "Hello", sourceLanguage: "en", targetLanguage: "zh-Hans" })).toBe(true);
    expect(mtRouteSupported({ html: "Hello", sourceLanguage: "en", targetLanguage: "ja" })).toBe(false);
    expect(mtRouteSupported({ html: "你好", sourceLanguage: "zh", targetLanguage: "en" })).toBe(false);
  });
});
