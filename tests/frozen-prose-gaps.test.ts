import { afterEach, describe, expect, it } from "vitest";
import {
  prepareFixedTextRecord,
  prepareFrozenProseRecord,
  applyFixedTextRecord,
  clearFixedTextRecord,
  type SourceTextSlot,
} from "../src/core/fixed-text-render";

afterEach(() => document.body.replaceChildren());
const root = (html: string) => {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
};

describe("explicit complete-target renderer witness", () => {
  function fixture() {
    const p = root("<p>Read this text.</p>"), node = p.firstChild as Text;
    const slot: SourceTextSlot = { id: 0, node, parent: p, source: node.data, writePolicy: "frozen-prose-gap" };
    return { p, node, slot };
  }

  it("rejects a model/JSON-style policy flag without private application authority", () => {
    const { p, slot } = fixture();
    expect(() => prepareFixedTextRecord(p, [slot], '<span data-flt-text-id="0"></span>')).toThrow(/verified application authority/);
  });

  it("checks the renderer's complete parsed text before original writes and on application", () => {
    const { p, node, slot } = fixture(), before = p.outerHTML;
    expect(() => prepareFrozenProseRecord(p, [slot], '<span data-flt-text-id="0">错误</span>', { target: "阅读文字。", readProjected: m => m.get(node) ?? node.data })).toThrow(/witness/);
    expect(p.outerHTML).toBe(before);
    const record = prepareFrozenProseRecord(p, [slot], '<span data-flt-text-id="0">阅读文字。</span>', { target: "阅读文字。", readProjected: m => m.get(node) ?? node.data });
    record.edits[0]!.translated = "被篡改的文字";
    expect(applyFixedTextRecord(p, record, "translation", "zh-Hans")).toBe(false);
    expect(p.outerHTML).toBe(before);
  });

  it("retains website text edits and rejects CSS changes before application", () => {
    const { p, node, slot } = fixture();
    const record = prepareFrozenProseRecord(p, [slot], '<span data-flt-text-id="0">阅读文字。</span>', { target: "阅读文字。", readProjected: m => m.get(node) ?? node.data });
    p.style.whiteSpace = "pre-line";
    expect(applyFixedTextRecord(p, record, "translation", "zh-Hans")).toBe(false);
    p.style.whiteSpace = "normal";
    expect(applyFixedTextRecord(p, record, "translation", "zh-Hans")).toBe(true);
    node.data = "Website edit";
    clearFixedTextRecord(record);
    expect(node.data).toBe("Website edit");
  });

  it("rejects code, numbers and an empty complete target even through the special API", () => {
    for (const html of ["<p><code>x()</code></p>", "<p>12</p>"]) {
      const p = root(html), node = (p.querySelector("code") ?? p).firstChild as Text;
      expect(() => prepareFrozenProseRecord(p, [{ id: 0, node, parent: node.parentNode!, source: node.data, writePolicy: "frozen-prose-gap" }], '<span data-flt-text-id="0">词</span>', { target: "词", readProjected: m => m.get(node) ?? node.data })).toThrow(/authority/);
    }
    const { p, node, slot } = fixture();
    expect(() => prepareFrozenProseRecord(p, [slot], '<span data-flt-text-id="0"></span>', { target: "", readProjected: m => m.get(node) ?? node.data })).toThrow(/empty/);
  });
});
