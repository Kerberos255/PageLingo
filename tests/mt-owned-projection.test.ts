import {afterEach, describe, expect, it} from "vitest";
import {serializeRichSegment} from "../src/core/rich-segment";
import {captureOwnedSource, compileOwnedProjection, assessOwnedCandidate, immutableOwnedSpans, ownedProposalKey, applyReviewedOwnedProjection, type OwnedSource} from "../eval/mt-quality/owned-projection";
import type {TargetSpan} from "../eval/mt-quality/frozen-span-projection";

afterEach(() => {document.body.replaceChildren(); document.head.querySelectorAll("[data-owned-test]").forEach(n => n.remove());});
const root = (html: string) => {document.body.innerHTML = html; return document.body.firstElementChild as HTMLElement;};
const candidate = (text: string) => ({text, finish_reason: "stop"});
function flows(source: OwnedSource, text: string, explicit: TargetSpan[] = []) {
  const spans = [...immutableOwnedSpans(source, text), ...explicit], byId = new Map(spans.map(s => [s.id, s]));
  for (const a of source.annotations) if (a.kind === "flow" && a.full_parent) {
    const parent = a.parent ? byId.get(a.parent) : {start: 0, end: text.length};
    if (!parent) throw new Error("Fixture parent span not specified");
    const s = {id: a.id, start: parent.start, end: parent.end}; byId.set(a.id, s); spans.push(s);
  }
  return spans;
}
describe("production-owned frozen projection", () => {
  it("traces the same serialization without changing the request or original DOM", () => {
    const p = root('<p>Read <a href="/guide"><em>the guide</em></a><br>then call <code>x()</code>.<span hidden>not input</span></p>');
    const before = p.outerHTML, a = serializeRichSegment(p, {fixedTextSlots: true});
    const b = serializeRichSegment(p, {fixedTextSlots: true, captureOwnership: true});
    expect(a.html).toBe(b.html); expect(a.opaque).toEqual(b.opaque); expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.textSlots!.map(s => s.node)).toEqual(b.textSlots!.map(s => s.node));
    expect(a.sourceTrace).toBeUndefined(); expect(b.sourceTrace?.parts.length).toBeGreaterThan(0); expect(p.outerHTML).toBe(before);
  });
  it("preserves a nested child list while translating only its parent's owned prefix", () => {
    const p = root('<ul><li>Choose one:<ul><li><a href="/first">First independent choice.</a></li></ul></li></ul>').querySelector("li")!;
    const s = captureOwnedSource(p), child = p.querySelector("ul")!, a = p.querySelector("a"), childHtml = child.outerHTML, before = p.outerHTML;
    expect(s.sourceText).toBe("Choose one:"); expect(s.sourceText).not.toContain("independent");
    const text = "请选择其一：", c = compileOwnedProjection(s, candidate(text), flows(s, text)); c.apply();
    expect(c.readOwnedText()).toBe(text); expect(p.firstChild!.textContent).toBe(text);
    expect(p.querySelector("ul")).toBe(child); expect(p.querySelector("a")).toBe(a); expect(child.outerHTML).toBe(childHtml);
    c.restore(); expect(p.outerHTML).toBe(before);
  });
  it("leaves hidden anchors and metadata untouched without including their text in the input", () => {
    const p = root('<p>Read this paragraph.<a href="#p" hidden>¶</a><link rel="help" href="/meta"></p>');
    const before = p.outerHTML, anchor = p.querySelector("a"), metadata = p.querySelector("link"), s = captureOwnedSource(p);
    expect(s.sourceText).toBe("Read this paragraph.");
    const text = "阅读此段。", c = compileOwnedProjection(s, candidate(text), flows(s, text)); c.apply();
    expect(c.readOwnedText()).toBe(text); expect(p.textContent).toBe(text + "¶");
    expect(p.querySelector("a")).toBe(anchor); expect(p.querySelector("link")).toBe(metadata);
    c.restore(); expect(p.outerHTML).toBe(before);
  });
  it("maps explicit source regions around the same br and rejects crossing that boundary", () => {
    const p = root('<p>Read the guide.<br>Then save.</p>'), br = p.querySelector("br"), before = p.outerHTML, s = captureOwnedSource(p);
    const text = "阅读指南。然后保存。", a = s.annotations.filter(a => a.kind === "flow");
    expect(a).toHaveLength(2);
    const c = compileOwnedProjection(s, candidate(text), [{id: a[0]!.id, start: 0, end: 5}, {id: a[1]!.id, start: 5, end: text.length}]);
    c.apply(); expect(p.childNodes[0]!.textContent).toBe("阅读指南。"); expect(p.childNodes[2]!.textContent).toBe("然后保存。");
    expect(p.querySelector("br")).toBe(br); expect(p.childNodes).toHaveLength(3); c.restore(); expect(p.outerHTML).toBe(before);
    expect(() => compileOwnedProjection(s, candidate(text), [{id: a[0]!.id, start: 5, end: text.length}, {id: a[1]!.id, start: 0, end: 5}])).toThrow(/carrier|crossing/);
    expect(p.outerHTML).toBe(before);
  });
  it("preserves block containers and assigns each explicit target region to its original text node", () => {
    const p = root('<div>First part.<div class="inner">Inside part.</div>Last part.</div>'), inner = p.querySelector("div")!, s = captureOwnedSource(p), before = p.outerHTML;
    const text = "前段。内段。尾段。", byText = new Map(s.annotations.map(a => [a.text, a.id]));
    const c = compileOwnedProjection(s, candidate(text), [{id: byText.get("First part.")!, start: 0, end: 3},
      {id: byText.get("Inside part.")!, start: 3, end: 6}, {id: byText.get("Last part.")!, start: 6, end: 9}]);
    c.apply(); expect(inner.textContent).toBe("内段。"); expect(p.querySelector("div")).toBe(inner); expect(c.readOwnedText()).toBe(text);
    c.restore(); expect(p.outerHTML).toBe(before);
  });
  it("keeps unowned website text edits and independently translated child roots", () => {
    const p = root('<ul><li>Choose one:<ul><li>Child source.</li></ul><span hidden>old hidden text</span></li></ul>').querySelector("li")!;
    const s = captureOwnedSource(p); p.querySelector("li")!.firstChild!.textContent = "Website changed child";
    p.querySelector("span")!.firstChild!.textContent = "Website changed hidden label";
    const text = "请选择其一：", c = compileOwnedProjection(s, candidate(text), flows(s, text)); c.apply(); c.restore();
    expect(p.querySelector("li")!.textContent).toBe("Website changed child"); expect(p.querySelector("span")!.textContent).toBe("Website changed hidden label");
  });
  it("rejects inserted children and preserves a newly added accessibility label", () => {
    const p = root('<p>Read this paragraph.<a href="#p" hidden>¶</a></p>'), s = captureOwnedSource(p);
    const added = document.createElement("span"); added.className = "cite-accessibility-label"; added.textContent = "Jump up to: "; p.querySelector("a")!.prepend(added);
    const current = p.outerHTML;
    expect(() => compileOwnedProjection(s, candidate("阅读此段。"), flows(s, "阅读此段。"))).toThrow(/source changed/);
    expect(p.outerHTML).toBe(current); expect(p.querySelector("span")).toBe(added);
  });
  it("preserves trimmed transport whitespace as original DOM text", () => {
    const p = root('<p>\n  Read this paragraph.\n <span hidden>hidden</span>\n</p>'), s = captureOwnedSource(p), before = p.outerHTML;
    expect(s.sourceText).toBe("\n  Read this paragraph.\n ");
    const text = "阅读此段。", c = compileOwnedProjection(s, candidate(text), flows(s, text)); c.apply();
    expect(c.readOwnedText()).toBe(text); expect(p.lastChild!.textContent).toBe("\n"); c.restore(); expect(p.outerHTML).toBe(before);
  });
  it("handles the production link fallback without inventing an editable hidden text slot", () => {
    const p = root('<p>Read <a href="/guide"><span hidden>guide</span></a> now.</p>'), s = captureOwnedSource(p);
    expect(s.sourceText).toBe("Read guide now."); expect(s.slots).toHaveLength(2);
    expect(s.annotations.find(a => a.tag === "A")?.immutable).toBe(true);
  });
  it("uses only production-owned slots and refuses changing readonly punctuation", () => {
    const p = root('<p>Call <code>x()</code>.</p>'), s = captureOwnedSource(p), before = p.outerHTML;
    expect(s.slots).toHaveLength(1);
    expect(() => assessOwnedCandidate(s, candidate("调用x()。"))).toThrow(/immutable/);
    const text = "调用x().", c = compileOwnedProjection(s, candidate(text), flows(s, text)); c.apply();
    expect(p.textContent).toBe(text); expect(p.querySelector("code")!.textContent).toBe("x()"); c.restore(); expect(p.outerHTML).toBe(before);
  });
  it.each(["text", "href", "ancestor", "css"])("refuses stale owned source before any write: %s", change => {
    const p = root('<p>Read <a href="/guide">the guide</a>.<span class="later" hidden>New text</span></p>'), s = captureOwnedSource(p);
    const text = "阅读指南.", a = s.annotations.find(a => a.tag === "A")!;
    if (change === "text") p.firstChild!.textContent = "Website replaced owned text";
    if (change === "href") p.querySelector("a")!.setAttribute("href", "/changed");
    if (change === "ancestor") document.body.className = "new-page-state";
    if (change === "css") p.querySelector("span")!.removeAttribute("hidden");
    const before = p.outerHTML;
    expect(() => compileOwnedProjection(s, candidate(text), flows(s, text, [{id: a.id, start: 2, end: 4}]))).toThrow(/source changed/);
    expect(p.outerHTML).toBe(before); document.body.removeAttribute("class");
  });
  it("rechecks CSS ownership changed by an external stylesheet", () => {
    const style = document.createElement("style"); style.dataset.ownedTest = "true"; style.textContent = ".later{display:none}"; document.head.append(style);
    const p = root('<p>Read this paragraph.<span class="later">New website text</span></p>'), s = captureOwnedSource(p);
    const text = "阅读此段。", c = compileOwnedProjection(s, candidate(text), flows(s, text));
    style.textContent = ".later{display:inline}";
    expect(() => c.apply()).toThrow(/source changed/); expect(p.firstChild!.textContent).toBe("Read this paragraph.");
  });
  it.each(["code", "punctuation"])("rejects an in-place website edit to readonly %s before writing", change => {
    const p = root('<p>Call <code>x()</code>.</p>'), s = captureOwnedSource(p), text = "调用x().";
    const c = compileOwnedProjection(s, candidate(text), flows(s, text));
    const node = (change === "code" ? p.querySelector("code")!.firstChild : p.lastChild) as Text;
    node.data = change === "code" ? "y()" : "!";
    const current = p.outerHTML;
    expect(() => c.apply()).toThrow(/source changed/);
    expect(p.outerHTML).toBe(current); expect(p.firstChild!.textContent).toBe("Call ");
  });
  it("refuses a compiled result after the website reparents its root", () => {
    const p = root('<p>Read this paragraph.</p>'), s = captureOwnedSource(p), c = compileOwnedProjection(s, candidate("阅读此段。"), []);
    const other = document.createElement("section"); document.body.append(other); other.append(p);
    expect(() => c.apply()).toThrow(/source changed/); expect(p.textContent).toBe("Read this paragraph.");
  });
  it("never overwrites a later website edit when restoring", () => {
    const p = root('<p>Read this paragraph.</p>'), s = captureOwnedSource(p), c = compileOwnedProjection(s, candidate("阅读此段。"), []);
    c.apply(); p.firstChild!.textContent = "New website text"; c.restore(); expect(p.textContent).toBe("New website text");
  });
  it("rejects an incomplete candidate and obvious short JSON echoes before projection", () => {
    const p = root('<p>Each line contains the <code>pick</code> command and the commit identifier, then the message. The <code>git rebase</code> process applies all three columns to the repository.</p>');
    const s = captureOwnedSource(p), before = p.outerHTML;
    expect(() => assessOwnedCandidate(s, {text: "选择提交。", finish_reason: "length"})).toThrow(/EOS/);
    expect(() => assessOwnedCandidate(s, candidate('["pick","git rebase"]'))).toThrow(/suspiciously_short/);
    expect(p.outerHTML).toBe(before);
  });
  it("rejects ambiguous repeated anchors and a changed protected code string", () => {
    const p = root('<p>Call <code>x()</code> now.</p>'), s = captureOwnedSource(p);
    expect(() => assessOwnedCandidate(s, candidate("调用y()。"))).toThrow(/immutable/);
    expect(() => assessOwnedCandidate(s, candidate("调用x()，再调用x()。"))).toThrow(/ambiguous/);
  });
  it("does not execute literal target HTML or split a Unicode surrogate pair", () => {
    const p = root('<p>Read this ordinary paragraph before saving the document.</p>'), s = captureOwnedSource(p);
    const text = '说明 <img src=x onerror="alert(1)"> 文本';
    const c = compileOwnedProjection(s, candidate(text), []); c.apply(); expect(p.querySelector("img")).toBeNull(); expect(p.textContent).toBe(text); c.restore();
    const q = root('<p>Read <em>this</em>.</p>'), t = captureOwnedSource(q), em = t.annotations.find(a => a.tag === "EM")!;
    expect(() => compileOwnedProjection(t, candidate("看😀."), [{id: em.id, start: 2, end: 3}])).toThrow(/UTF-16/);
  });
  it("keeps explicit no-translate content and API declarations out of this research path", () => {
    expect(() => captureOwnedSource(root('<dt class="sig">task(name=None)</dt>'))).toThrow(/protected/);
    expect(() => captureOwnedSource(root('<p>Read <span translate="no">Brand text</span> now.</p>'))).toThrow(/no-translate/);
  });
  it("refuses an unreviewed or failed scope before any live write", () => {
    const p = root('<p>Read this paragraph.</p>'), s = captureOwnedSource(p), value = candidate("阅读此段。"), before = p.outerHTML;
    for (const decision of ["unreviewed", "wrong", "uncertain"] as const) {
      expect(() => applyReviewedOwnedProjection(s, value, [], {decision, reviewer: "assistant", proposal_key: ownedProposalKey(s, value, [])})).toThrow(/scope unreviewed/);
      expect(p.outerHTML).toBe(before);
    }
  });
  it("binds review to exact source, target and ranges rather than a reused sample ID", () => {
    const p = root('<p>Read <a href="/guide">the guide</a> now.</p>'), s = captureOwnedSource(p), value = candidate("请读指南。"), a = s.annotations.find(a => a.tag === "A")!;
    const ranges = [{id: a.id, start: 2, end: 4}];
    const review = {decision: "confirmed" as const, reviewer: "assistant" as const, proposal_key: ownedProposalKey(s, value, ranges)};
    expect(() => applyReviewedOwnedProjection(s, candidate("请读说明。"), ranges, review)).toThrow(/changed/);
    expect(() => applyReviewedOwnedProjection(s, value, [{id: a.id, start: 0, end: 4}], review)).toThrow(/changed/);
    const c = applyReviewedOwnedProjection(s, value, ranges, review); expect(p.querySelector("a")!.textContent).toBe("指南"); c.restore();
  });
});
