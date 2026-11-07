import {afterEach, describe, expect, it} from "vitest";
import {captureOwnedSource, compileOwnedProjection, immutableOwnedSpans, ownedProposalKey, applyReviewedOwnedProjection} from "../eval/mt-quality/owned-projection";
import {deriveSourceScopeConstraints} from "../eval/mt-quality/scope-constraints";

afterEach(() => document.body.replaceChildren());
const options = {punctuationPolicy: "prose-v1", whitespacePolicy: "collapse-v1", allocationPolicy: "prose-gaps-v1", scopePolicy: "source-constraints-v1"} as const;
function setup(html: string) {document.body.innerHTML = html; return document.body.firstElementChild as HTMLElement;}
const candidate = (text: string) => ({text, finish_reason: "stop"});

describe("source-owned scope constraints", () => {
  it("inherits nested whole-parent scopes and preserves link objects, listeners and restoration", () => {
    const p = setup('<p><a href="/guide"><strong>Read the guide.</strong></a></p>');
    const before = p.outerHTML, link = p.querySelector("a")!, strong = p.querySelector("strong")!, source = captureOwnedSource(p, options);
    let clicks = 0; link.addEventListener("probe", () => clicks++);
    const text = "阅读指南。", spans = source.annotations.map(a => ({id: a.id, start: 0, end: text.length}));
    const constraints = deriveSourceScopeConstraints(source.sourceText, source.annotations, text, []);
    expect(constraints.every(c => c.full_parent)).toBe(true);
    const compiled = compileOwnedProjection(source, candidate(text), spans); compiled.apply();
    expect(p.querySelector("a")).toBe(link); expect(p.querySelector("strong")).toBe(strong); expect(link.href).toContain("/guide");
    expect(p.textContent).toBe(text); link.dispatchEvent(new Event("probe")); expect(clicks).toBe(1);
    compiled.restore(); expect(p.outerHTML).toBe(before);
  });
  it("rejects a partial translation range for a whole-parent source wrapper before any write", () => {
    const p = setup('<p><strong>Read the guide.</strong></p>'), before = p.outerHTML, source = captureOwnedSource(p, options);
    expect(() => compileOwnedProjection(source, candidate("阅读指南。"), [{id: source.annotations[0]!.id, start: 2, end: 4}])).toThrow(/Whole-parent/);
    expect(p.outerHTML).toBe(before);
  });
  it("does not infer whole-parent ownership when another source clause remains outside", () => {
    for (const html of ['<p><strong>Read the guide.</strong> Then save.</p>', '<p>Read <a href="/guide">the guide</a> now.</p>']) {
      const source = captureOwnedSource(setup(html), options);
      expect(deriveSourceScopeConstraints(source.sourceText, source.annotations, "阅读指南。", []).some(c => c.full_parent)).toBe(false);
    }
  });
  it.each([0, 1])("refuses either occurrence of an unfenced repeated target even with a confirmed review: %s", occurrence => {
    const p = setup('<p>The left log says <a href="/state">not subscribed</a>; the right log says not subscribed.</p>');
    const source = captureOwnedSource(p, options), before = p.outerHTML, text = "左侧日志显示未订阅；右侧日志显示未订阅。";
    const at = occurrence ? text.lastIndexOf("未订阅") : text.indexOf("未订阅"), spans = [{id: source.annotations[0]!.id, start: at, end: at + 3}];
    const c = candidate(text), review = {decision: "confirmed", reviewer: "assistant", proposal_key: ownedProposalKey(source, c, spans)} as const;
    expect(() => applyReviewedOwnedProjection(source, c, spans, review)).toThrow(/Repeated target scope/);
    expect(p.outerHTML).toBe(before);
  });
  it("allows repeated translations separated by original immutable anchors, and refuses the other occurrence", () => {
    const p = setup('<p><code>left()</code> reports <a href="/state">not subscribed</a>; <code>right()</code> reports not subscribed.</p>');
    const source = captureOwnedSource(p, options), before = p.outerHTML, text = "left()未订阅；right()未订阅。";
    const immutable = immutableOwnedSpans(source, text), a = source.annotations.find(a => a.tag === "A")!;
    const at = text.indexOf("未订阅"), spans = [...immutable, {id: a.id, start: at, end: at + 3}];
    const compiled = compileOwnedProjection(source, candidate(text), spans); compiled.apply(); expect(p.querySelector("a")!.textContent).toBe("未订阅");
    expect(p.querySelectorAll("code")[1]!.textContent).toBe("right()"); compiled.restore(); expect(p.outerHTML).toBe(before);
    const wrong = text.lastIndexOf("未订阅");
    expect(() => compileOwnedProjection(source, candidate(text), [...immutable, {id:a.id,start:wrong,end:wrong+3}])).toThrow(/anchor fence/);
    expect(p.outerHTML).toBe(before);
  });
  it("keeps the occurrence witness of code-only links with repeated identical code", () => {
    const p = setup('<p>Call <a href="/first"><code>x()</code></a> then <code>x()</code>.</p>'), source = captureOwnedSource(p, options);
    const text = "调用x()然后x()。", immutable = immutableOwnedSpans(source, text), a = source.annotations.find(a => a.tag === "A")!;
    expect(a.immutable).toBe(true); expect(immutable.find(s => s.id === a.id)!.start).toBe(text.indexOf("x()"));
    const compiled = compileOwnedProjection(source, candidate(text), immutable);
    compiled.apply(); expect(p.querySelector("a")!.textContent).toBe("x()"); compiled.restore();
  });
  it("uses a unique unchanged formatted sibling to identify a repeated literal before it", () => {
    const p = setup('<p>Use <a href="/jquery">jQuery</a>, copy <a href="/html">HTML</a>, then save jQuery.</p>'), source = captureOwnedSource(p, options), before = p.outerHTML;
    const text = "使用jQuery，复制HTML，然后保存jQuery。", jq = source.annotations[0]!, html = source.annotations[1]!;
    const h = text.indexOf("HTML"), first = text.indexOf("jQuery"), second = text.lastIndexOf("jQuery");
    const span = (id: string, start: number, length: number) => ({id,start,end:start+length});
    const compiled = compileOwnedProjection(source,candidate(text),[span(jq.id,first,6),span(html.id,h,4)]);
    compiled.apply(); expect(p.querySelector("a")!.textContent).toBe("jQuery"); compiled.restore(); expect(p.outerHTML).toBe(before);
    expect(() => compileOwnedProjection(source,candidate(text),[span(jq.id,second,6),span(html.id,h,4)])).toThrow(/anchor fence/);
  });
  it("does not treat unformatted or repeated source literals as occurrence witnesses", () => {
    const p = setup('<p>HTML: use <a href="/jquery">jQuery</a>, copy HTML, then save jQuery.</p>'), source = captureOwnedSource(p, options);
    const text = "HTML：使用jQuery，复制HTML，然后保存jQuery。", start = text.indexOf("jQuery");
    expect(() => compileOwnedProjection(source,candidate(text),[{id:source.annotations[0]!.id,start,end:start+6}])).toThrow(/Repeated target scope/);
  });
  it("permits a full Chinese expansion around an unchanged formatted literal", () => {
    const p = setup('<p><strong>HTML</strong></p>'), source = captureOwnedSource(p, options), text = "超文本标记语言（HTML）。";
    const compiled = compileOwnedProjection(source,candidate(text),[{id:source.annotations[0]!.id,start:0,end:text.length}]);
    compiled.apply(); expect(p.querySelector("strong")!.textContent).toBe(text); compiled.restore();
  });
  it("refuses a source tag that cuts an English word", () => {
    const p = setup('<p><strong>un</strong>stable policy.</p>'), source = captureOwnedSource(p, options), before = p.outerHTML;
    expect(() => compileOwnedProjection(source, candidate("不稳定的规则。"), [{id:source.annotations[0]!.id,start:0,end:1}])).toThrow(/lexical word/);
    expect(p.outerHTML).toBe(before);
  });
  it("refuses slicing inside a target lexical word", () => {
    const p = setup('<p>Use <a href="/browser">the browser</a> now.</p>'), source = captureOwnedSource(p, options), before = p.outerHTML;
    const text = "请在浏览器中查看。", at = text.indexOf("浏览器") + 1;
    expect(() => compileOwnedProjection(source, candidate(text), [{id:source.annotations[0]!.id,start:at,end:at+2}])).toThrow(/lexical word/);
    expect(p.outerHTML).toBe(before);
  });
  it("binds the opt-in policy to review identity while leaving the default contract unchanged", () => {
    const p = setup('<p>Read <a href="/guide">the guide</a>.</p>'), legacy = captureOwnedSource(p), strict = captureOwnedSource(p, options);
    const text = "阅读指南。", spans = [{id:strict.annotations[0]!.id,start:2,end:4}];
    expect(ownedProposalKey(legacy,candidate(text),spans)).not.toBe(ownedProposalKey(strict,candidate(text),spans));
    expect(legacy.scopePolicy).toBe("alignment-v1");
  });
});
