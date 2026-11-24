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

  it("forces block display on table header/data cells without double-copying cell padding", () => {
    document.body.innerHTML = '<table><tr><th id="h" style="padding: 7px 10px">Workflow Mode</th><td id="d" style="padding: 7px 10px">Side-by-side</td></tr></table>';
    const th = document.querySelector<HTMLElement>("#h")!;
    const td = document.querySelector<HTMLElement>("#d")!;
    const trTh = mountTranslation(th, fragment("工作流模式"), "zh-Hans");
    const trTd = mountTranslation(td, fragment("双栏对照"), "zh-Hans");

    expect(trTh.parentElement).toBe(th);
    expect(trTh.style.getPropertyValue("display")).toBe("block");
    expect(trTh.style.getPropertyValue("padding-inline-start")).toBe("");
    expect(trTd.parentElement).toBe(td);
    expect(trTd.style.getPropertyValue("display")).toBe("block");
    expect(trTd.style.getPropertyValue("padding-inline-start")).toBe("");
  });
});
