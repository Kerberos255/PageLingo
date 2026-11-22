import { afterEach, describe, expect, it } from "vitest";
import { canCollapseProseWhitespace } from "../src/core/collapsible-whitespace";
import { prepareFixedTextRecord, applyFixedTextRecord } from "../src/core/fixed-text-render";

afterEach(() => {
  document.body.replaceChildren();
  document.head.querySelectorAll("[data-space-test]").forEach(n => n.remove());
});
const root = (html: string) => {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
};

describe("CSS-bound collapsible whitespace", () => {
  it("refuses explicit no-translate and protected code whitespace", () => {
    const p = root('<p>Read <span translate="no"> </span><code> </code> now.</p>');
    expect(canCollapseProseWhitespace(p.querySelector("span")!.firstChild as Text)).toBe(false);
    expect(canCollapseProseWhitespace(p.querySelector("code")!.firstChild as Text)).toBe(false);
  });

  it.each(["normal", "nowrap", "pre", "pre-wrap", "pre-line", "break-spaces"])("uses the live CSS whitespace contract: %s", whiteSpace => {
    const p = root(`<p style="white-space:${whiteSpace}"> </p>`);
    expect(canCollapseProseWhitespace(p.firstChild as Text)).toBe(["normal", "nowrap"].includes(whiteSpace));
  });
});

describe("renderer whitespace authority", () => {
  it("permits an empty whitespace target only with a verified explicit role", () => {
    const p = root("<p> </p>"), node = p.firstChild as Text, slot = { id: 0, node, parent: p, source: node.data };
    expect(() => prepareFixedTextRecord(p, [slot], '<span data-flt-text-id="0"></span>')).toThrow(/empty/);
    const record = prepareFixedTextRecord(p, [{ ...slot, writePolicy: "collapsible-whitespace" }], '<span data-flt-text-id="0"></span>');
    expect(applyFixedTextRecord(p, record, "translation", "zh-Hans")).toBe(true);
    expect(node.data).toBe("");
  });

  it("refuses forged whitespace roles on prose and refuses word injection through a whitespace slot", () => {
    for (const [source, target] of [["Read text", ""], [" ", "new word"]]) {
      const p = root("<p></p>");
      p.textContent = source!;
      const node = p.firstChild as Text;
      expect(() => prepareFixedTextRecord(p, [{ id: 0, node, parent: p, source: source!, writePolicy: "collapsible-whitespace" }], `<span data-flt-text-id="0">${target}</span>`)).toThrow(/whitespace ownership/);
    }
  });

  it("rechecks CSS at application time before the first whitespace edit", () => {
    const p = root("<p>\n </p>"), node = p.firstChild as Text;
    const record = prepareFixedTextRecord(p, [{ id: 0, node, parent: p, source: node.data, writePolicy: "collapsible-whitespace" }], '<span data-flt-text-id="0"></span>');
    p.style.whiteSpace = "pre";
    expect(applyFixedTextRecord(p, record, "translation", "zh-Hans")).toBe(false);
    expect(node.data).toBe("\n ");
  });
});
