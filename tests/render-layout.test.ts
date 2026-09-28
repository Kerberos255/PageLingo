import { afterEach, describe, expect, it } from "vitest";
import { mountTranslation } from "../src/core/render";

function fragment(text: string): DocumentFragment {
  const value = document.createDocumentFragment();
  value.append(document.createTextNode(text));
  return value;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("translation display preservation", () => {
  it("keeps semantic inline roots inline when their computed display is inline", () => {
    document.body.innerHTML = '<span id="source">Source</span>';
    const source = document.querySelector<HTMLElement>("#source")!;
    const translated = mountTranslation(source, fragment("译文"), "zh-Hans");

    expect(translated.style.getPropertyValue("display")).toBe("inline");
  });

  it("does not force a block-styled span back to inline", () => {
    document.body.innerHTML = '<span id="source" style="display:block">Source</span>';
    const source = document.querySelector<HTMLElement>("#source")!;
    const translated = mountTranslation(source, fragment("译文"), "zh-Hans");

    expect(translated.style.getPropertyValue("display")).toBe("block");
  });

  it("preserves flex display on a CSS-styled label", () => {
    document.body.innerHTML = '<label id="source" style="display:flex">Source</label>';
    const source = document.querySelector<HTMLElement>("#source")!;
    const translated = mountTranslation(source, fragment("译文"), "zh-Hans");

    expect(translated.style.getPropertyValue("display")).toBe("flex");
  });
});
