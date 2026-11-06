import {afterEach, describe, expect, it} from "vitest";
import {classifyProsePunctuation, closeLabelColon} from "../src/core/prose-punctuation";
import {captureOwnedSource, immutableOwnedSpans, compileOwnedProjection, type OwnedSource} from "../eval/mt-quality/owned-projection";
import {serializeRichSegment} from "../src/core/rich-segment";
import type {TargetSpan} from "../eval/mt-quality/frozen-span-projection";

afterEach(() => {document.body.replaceChildren(); document.head.querySelectorAll("[data-punctuation-test]").forEach(n => n.remove());});
const root = (html: string) => {document.body.innerHTML = html; return document.body.firstElementChild as HTMLElement;};
const candidate = (text: string) => ({text, finish_reason: "stop"});
const capture = (p: HTMLElement) => captureOwnedSource(p, {punctuationPolicy: "prose-v1"});
function spans(s: OwnedSource, text: string, extra: TargetSpan[] = []) {
  return [...immutableOwnedSpans(s, text), ...extra];
}
describe("bounded prose punctuation ownership", () => {
  it("leaves standalone symbols, NBSP and whitespace-preserving prose outside the new contract", () => {
    expect(classifyProsePunctuation(" ", "Read ", "later")).toBeNull();
    expect(classifyProsePunctuation(".", "Version 1", "2")).toBeNull();
    const s = capture(root('<p style="white-space:pre-wrap">Call <code>x()</code>.</p>'));
    expect(s.annotations.some(a => a.anchor_kind === "prose-punctuation")).toBe(false);
  });
  it("localizes a terminal punctuation node without changing production input, code or node identity", () => {
    const p = root('<p>Call <code>x()</code>.</p>'), wire = serializeRichSegment(p, {fixedTextSlots: true}).html, before = p.outerHTML;
    const code = p.querySelector("code"), period = p.lastChild, s = capture(p), text = "调用x()。";
    expect(s.slots).toHaveLength(2); expect(s.segment.textSlots).toHaveLength(1); expect(s.segment.html).toBe(wire);
    const c = compileOwnedProjection(s, candidate(text), spans(s, text)); c.apply();
    expect(p.lastChild).toBe(period); expect(period!.textContent).toBe("。"); expect(p.querySelector("code")).toBe(code);
    expect(code!.textContent).toBe("x()"); expect(c.readOwnedText()).toBe(text); c.restore(); expect(p.outerHTML).toBe(before);
  });
  it("uses the terminal role rather than an earlier sentence or a dot inside code", () => {
    const s = capture(root('<p>Read the guide, then call <code>x.y()</code>.</p>')), text = "先阅读指南。然后调用x.y()。";
    const a = s.annotations.find(a => a.anchor_kind === "prose-punctuation")!;
    expect(immutableOwnedSpans(s, text).find(x => x.id === a.id)).toEqual({id: a.id, start: text.length - 1, end: text.length});
    expect(() => immutableOwnedSpans(s, "调用x.y()。")).not.toThrow();
    expect(() => immutableOwnedSpans(s, "调用x.y()。\n")).toThrow(/immutable/);
  });
  it("allows a unique prose comma beside readonly code but refuses ambiguous assignments", () => {
    const s = capture(root('<p>Read <code>a</code>, <code>b</code> now.</p>')), text = "阅读a、b，然后继续。";
    const c = compileOwnedProjection(s, candidate(text), spans(s, text)); c.apply(); expect(c.readOwnedText()).toBe(text); c.restore();
    const t = capture(root('<p>Read this <span>, </span>and continue.</p>'));
    expect(() => immutableOwnedSpans(t, "阅读、此处、然后继续。")).toThrow(/ambiguous/);
  });
  it.each([".", ":", ",", ";"])("does not authorize a compact syntax separator %s", symbol => {
    const s = capture(root(`<p>Read <code>left</code>${symbol}<code>right</code> now.</p>`));
    expect(s.annotations.some(a => a.anchor_kind === "prose-punctuation")).toBe(false);
  });
  it.each(['<p>Read <code>x.y()</code> now.</p>', '<p>Read <a href="/id">.</a> now.</p>',
    '<p>Read <span translate="no">.</span> now.</p>', '<p>Read <span contenteditable="true">.</span> now.</p>',
    '<p>Read <span hidden>.</span> now.</p>', '<p>Read <span> </span> now.</p>', '<p>Read <span>3</span> now.</p>'])("keeps protected or non-prose text outside punctuation ownership: %s", html => {
    const s = capture(root(html)); expect(s.annotations.some(a => a.anchor_kind === "prose-punctuation")).toBe(false);
  });
  it("preserves website edits to a punctuation node during restore and rejects stale compiled writes", () => {
    const p = root('<p>Call <code>x()</code>.</p>'), s = capture(p), text = "调用x()。", c = compileOwnedProjection(s, candidate(text), spans(s, text));
    (p.lastChild as Text).data = "!"; const current = p.outerHTML;
    expect(() => c.apply()).toThrow(/source changed/); expect(p.outerHTML).toBe(current);
    const fresh = capture(p), next = "调用x()！", applied = compileOwnedProjection(fresh, candidate(next), spans(fresh, next));
    applied.apply(); (p.lastChild as Text).data = "Website punctuation edit"; applied.restore();
    expect(p.lastChild!.textContent).toBe("Website punctuation edit");
  });
  it("invalidates pending punctuation writes when an external stylesheet starts preserving whitespace", () => {
    const style = document.createElement("style"); style.dataset.punctuationTest = "true"; document.head.append(style);
    const p = root('<p class="prose">Call <code>x()</code>.</p>'), s = capture(p), text = "调用x()。";
    const c = compileOwnedProjection(s, candidate(text), spans(s, text)), before = p.outerHTML;
    style.textContent = ".prose{white-space:pre-wrap}";
    expect(() => c.apply()).toThrow(/source changed/); expect(p.outerHTML).toBe(before);
  });
  it("rejects arbitrary symbol replacements and removing the protected punctuation node's content", () => {
    const p = root('<p>Call <code>x()</code>.</p>'), s = capture(p), before = p.outerHTML;
    for (const text of ["调用x()！", "调用x()", "调用y()。", "调用x()<script>"]) {
      expect(() => compileOwnedProjection(s, candidate(text), spans(s, text))).toThrow(); expect(p.outerHTML).toBe(before);
    }
  });
  it("keeps the strict default and refuses a language-appropriate punctuation change without the explicit policy", () => {
    const s = captureOwnedSource(root('<p>Call <code>x()</code>.</p>'));
    expect(() => immutableOwnedSpans(s, "调用x()。")).toThrow(/immutable/);
  });
});
describe("format label colon extent", () => {
  it("includes only an adjacent equivalent colon without consuming following words", () => {
    expect(closeLabelColon("Caution:", "小心：继续。", 0, 2)).toEqual({start: 0, end: 3});
    expect(closeLabelColon("Label:", "标签:继续。", 0, 3)).toEqual({start: 0, end: 3});
    expect(() => closeLabelColon("Caution:", "小心操作：继续。", 0, 2)).toThrow(/missing/);
  });
  it("rejects a colon outside the original emphasis and accepts complete emphasis", () => {
    const p = root('<p><strong>Caution:</strong> Read this paragraph.</p>'), s = capture(p), a = s.annotations.find(a => a.kind === "format")!, text = "小心：阅读此段。", before = p.outerHTML;
    expect(() => compileOwnedProjection(s, candidate(text), [{id: a.id, start: 0, end: 2}])).toThrow(/colon/);
    expect(p.outerHTML).toBe(before);
    const c = compileOwnedProjection(s, candidate(text), [{id: a.id, start: 0, end: 3}]); c.apply();
    expect(p.querySelector("strong")!.textContent).toBe("小心："); c.restore(); expect(p.outerHTML).toBe(before);
  });
});
