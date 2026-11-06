import {afterEach, describe, expect, it} from "vitest";
import {captureOwnedSource, compileOwnedProjection, immutableOwnedSpans, type OwnedSource} from "../eval/mt-quality/owned-projection";
import {canCollapseProseWhitespace} from "../src/core/collapsible-whitespace";
import {prepareFixedTextRecord, applyFixedTextRecord} from "../src/core/fixed-text-render";
import {serializeRichSegment} from "../src/core/rich-segment";
import type {TargetSpan} from "../eval/mt-quality/frozen-span-projection";

afterEach(() => {document.body.replaceChildren(); document.head.querySelectorAll("[data-space-test]").forEach(n => n.remove());});
const root = (html: string) => {document.body.innerHTML = html; return document.body.firstElementChild as HTMLElement;};
const capture = (p: HTMLElement) => captureOwnedSource(p, {punctuationPolicy: "prose-v1", whitespacePolicy: "collapse-v1"});
const candidate = (text: string) => ({text, finish_reason: "stop"});
function ranges(s: OwnedSource, text: string): TargetSpan[] {
  return [...immutableOwnedSpans(s, text), ...s.annotations.filter(a => !a.immutable).map(a => {
    const value = a.text === "this" ? "此" : a.text === "guide" ? "指南" : "";
    if (!value) throw new Error("Specify fixture range");
    return {id: a.id, start: text.indexOf(value), end: text.indexOf(value) + value.length};
  })];
}
describe("CSS-bound collapsible whitespace", () => {
  it("keeps an original empty Text node between two complete format ranges, with unchanged model requests", () => {
    const p = root('<p>Read <em>this</em>\n  <strong>guide</strong> now.</p>'), before = p.outerHTML;
    const wire = serializeRichSegment(p, {fixedTextSlots: true}).html, s = capture(p), ws = p.childNodes[2] as Text;
    const text = "现在阅读此指南。", c = compileOwnedProjection(s, candidate(text), ranges(s, text));
    expect(s.segment.html).toBe(wire); expect(s.segment.textSlots).toHaveLength(4);
    expect(s.slots.filter(s => s.writePolicy === "collapsible-whitespace")).toHaveLength(1);
    c.apply(); expect(ws.isConnected).toBe(true); expect(ws.data).toBe(""); expect(p.childNodes[2]).toBe(ws);
    expect(p.querySelector("em")!.textContent).toBe("此"); expect(p.querySelector("strong")!.textContent).toBe("指南");
    expect(c.readOwnedText()).toBe(text); c.restore(); expect(p.outerHTML).toBe(before);
  });
  it.each(["normal", "nowrap", "pre", "pre-wrap", "pre-line", "break-spaces"])("uses the live CSS whitespace contract: %s", whiteSpace => {
    const p = root(`<p style="white-space:${whiteSpace}">Read <em>this</em>\n <strong>guide</strong> now.</p>`), s = capture(p);
    const expected = ["normal", "nowrap"].includes(whiteSpace);
    expect(s.slots.some(s => s.writePolicy === "collapsible-whitespace")).toBe(expected);
    if (!expected) expect(() => immutableOwnedSpans(s, "现在阅读此指南。")).toThrow(/immutable/);
  });
  it("refuses NBSP normalization, explicit no-translate and protected code whitespace", () => {
    const s = capture(root('<p>Read <em>this</em> <strong>guide</strong> now.</p>'));
    expect(() => immutableOwnedSpans(s, "现在阅读此指南。")).toThrow(/immutable/);
    const p = root('<p>Read <span translate="no"> </span><code> </code> now.</p>');
    expect(canCollapseProseWhitespace(p.querySelector("span")!.firstChild as Text)).toBe(false);
    expect(canCollapseProseWhitespace(p.querySelector("code")!.firstChild as Text)).toBe(false);
  });
  it("accepts terminal line whitespace only in the explicit normal-CSS arm", () => {
    const p = root('<p>Call <code>x()</code>.\n</p>'), s = capture(p), text = "调用x()。\n";
    const c = compileOwnedProjection(s, candidate(text), immutableOwnedSpans(s, text));c.apply();
    expect(c.readOwnedText()).toBe(text); expect(p.lastChild!.textContent).toBe("。\n"); c.restore();
    const strict = captureOwnedSource(p, {punctuationPolicy: "prose-v1"});
    expect(() => immutableOwnedSpans(strict, text)).toThrow(/immutable/);
  });
  it("does not give words to an ASCII whitespace-only carrier", () => {
    const p = root('<p>Read <em>this</em>\n <strong>guide</strong> now.</p>'), s = capture(p), text = "现在阅读此和指南。", before = p.outerHTML;
    expect(() => compileOwnedProjection(s, candidate(text), ranges(s, text))).toThrow(/whitespace/); expect(p.outerHTML).toBe(before);
  });
  it("never joins two protected atoms through a deleted separator", () => {
    const p = root('<p>Read <code>甲</code>\n <code>乙</code> now.</p>'), s = capture(p), text = "现在阅读甲乙。";
    expect(() => compileOwnedProjection(s, candidate(text), immutableOwnedSpans(s, text))).toThrow(/join protected atoms/);
  });
  it("allows an owned prose node beside whitespace without inventing a formatting carrier", () => {
    const p = root('<p>Read <em>this</em>\n <!--keep-->guide now.</p>'), s = capture(p), text = "现在阅读此指南。", before = p.outerHTML;
    const c = compileOwnedProjection(s, candidate(text), ranges(s, text));c.apply();
    expect(p.textContent).toBe(text); expect(p.childNodes[3]!.nodeType).toBe(Node.COMMENT_NODE);c.restore();expect(p.outerHTML).toBe(before);
  });
  it("handles whitespace between independently translated links without changing either original link", () => {
    const p = root('<p><a href="/private">private caches</a>\n <a href="/shared">shared caches</a></p>'), s = capture(p), before=p.outerHTML;
    const links=[...p.querySelectorAll("a")], text="私有缓存共享缓存", annotations=s.annotations.filter(a=>!a.immutable);
    expect(s.slots.some(s=>s.writePolicy==="collapsible-whitespace")).toBe(true);
    const c=compileOwnedProjection(s,candidate(text),[{id:annotations[0]!.id,start:0,end:4},{id:annotations[1]!.id,start:4,end:8}]);c.apply();
    expect([...p.querySelectorAll("a")]).toEqual(links);expect(p.textContent).toBe(text);c.restore();expect(p.outerHTML).toBe(before);
  });
  it("invalidates pending writes when CSS changes from collapsing to pre-line", () => {
    const style = document.createElement("style");style.dataset.spaceTest = "true";document.head.append(style);
    const p = root('<p class="prose">Read <em>this</em>\n <strong>guide</strong> now.</p>'), s = capture(p), text = "现在阅读此指南。";
    const c = compileOwnedProjection(s, candidate(text), ranges(s, text)), before = p.outerHTML;
    style.textContent = ".prose{white-space:pre-line}";
    expect(() => c.apply()).toThrow(/source changed/);expect(p.outerHTML).toBe(before);
  });
  it("does not overwrite a later website edit to an emptied whitespace node on restore", () => {
    const p = root('<p>Read <em>this</em>\n <strong>guide</strong> now.</p>'), s = capture(p), text = "现在阅读此指南。", ws = p.childNodes[2] as Text;
    const c = compileOwnedProjection(s, candidate(text), ranges(s, text));c.apply();ws.data="Website edit";c.restore();expect(ws.data).toBe("Website edit");
  });
  it("rejects parser normalization of a frozen carriage return before applying any original text", () => {
    const p = root('<p>Read this ordinary paragraph before saving the document.</p>'), s = capture(p), before = p.outerHTML;
    expect(() => compileOwnedProjection(s, candidate("请阅读\r这份说明文字，然后保存文档。"), [])).toThrow(/transport/);
    expect(p.outerHTML).toBe(before);
  });
});
describe("renderer whitespace authority", () => {
  it("permits an empty whitespace target only with a verified explicit role", () => {
    const p = root('<p> </p>'), node = p.firstChild as Text, slot = {id:0,node,parent:p,source:node.data};
    expect(() => prepareFixedTextRecord(p,[slot],'<span data-flt-text-id="0"></span>')).toThrow(/empty/);
    const record = prepareFixedTextRecord(p,[{...slot,writePolicy:"collapsible-whitespace"}],'<span data-flt-text-id="0"></span>');
    expect(applyFixedTextRecord(p,record,"translation","zh-Hans")).toBe(true);expect(node.data).toBe("");
  });
  it("refuses forged whitespace roles on prose and refuses word injection through a whitespace slot", () => {
    for (const [source,target] of [["Read text",""],[" ","new word"]]) {
      const p = root('<p></p>');p.textContent=source!;const node=p.firstChild as Text;
      expect(() => prepareFixedTextRecord(p,[{id:0,node,parent:p,source:source!,writePolicy:"collapsible-whitespace"}],`<span data-flt-text-id="0">${target}</span>`)).toThrow(/whitespace ownership/);
    }
  });
  it("rechecks CSS at application time before the first whitespace edit", () => {
    const p=root('<p>\n </p>'),node=p.firstChild as Text,record=prepareFixedTextRecord(p,[{id:0,node,parent:p,source:node.data,writePolicy:"collapsible-whitespace"}],'<span data-flt-text-id="0"></span>');
    p.style.whiteSpace="pre";expect(applyFixedTextRecord(p,record,"translation","zh-Hans")).toBe(false);expect(node.data).toBe("\n ");
  });
});
