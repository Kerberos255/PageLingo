import {afterEach, describe, expect, it} from "vitest";
import {captureOwnedSource, compileOwnedProjection, immutableOwnedSpans} from "../eval/mt-quality/owned-projection";
import {prepareFixedTextRecord, prepareFrozenProseRecord, applyFixedTextRecord, clearFixedTextRecord, type SourceTextSlot} from "../src/core/fixed-text-render";
import {serializeRichSegment} from "../src/core/rich-segment";

afterEach(() => document.body.replaceChildren());
const root = (html: string) => {document.body.innerHTML=html;return document.body.firstElementChild as HTMLElement;};
const capture = (p: HTMLElement) => captureOwnedSource(p,{punctuationPolicy:"prose-v1",whitespacePolicy:"collapse-v1",allocationPolicy:"prose-gaps-v1"});
const candidate = (text: string) => ({text,finish_reason:"stop"});
describe("same-parent frozen prose gap allocation", () => {
  it("allows Chinese grammar after a code label through the original colon node, without changing the model input", () => {
    const p=root('<p>See the description of <code>Logger</code>: <code>debug()</code>.</p>'),before=p.outerHTML;
    const nodes=[...p.childNodes],codes=[...p.querySelectorAll("code")],wire=serializeRichSegment(p,{fixedTextSlots:true}).html;
    const s=capture(p),text="请参阅Logger的说明：debug()。",c=compileOwnedProjection(s,candidate(text),immutableOwnedSpans(s,text));
    expect(s.segment.html).toBe(wire);c.apply();expect(c.readOwnedText()).toBe(text);expect(p.childNodes[2]!.textContent).toBe("的说明：");
    expect([...p.childNodes]).toEqual(nodes);expect([...p.querySelectorAll("code")]).toEqual(codes);
    expect(codes.map(n=>n.textContent)).toEqual(["Logger","debug()"]);c.restore();expect(p.outerHTML).toBe(before);
  });
  it("keeps an emptied original prose node when Chinese places the link first", () => {
    const p=root('<p>Read <a href="/guide">the guide</a> carefully.</p>'),before=p.outerHTML,s=capture(p),node=p.firstChild;
    const a=s.annotations.find(a=>a.tag==="A")!,text="指南请仔细阅读。";
    const c=compileOwnedProjection(s,candidate(text),[{id:a.id,start:0,end:2}]);c.apply();
    expect(p.firstChild).toBe(node);expect(node!.textContent).toBe("");expect(p.querySelector("a")!.textContent).toBe("指南");
    expect(c.readOwnedText()).toBe(text);c.restore();expect(p.outerHTML).toBe(before);
  });
  it("coalesces only same-parent plain fragments and retains their original Text and comment objects", () => {
    const p=root('<p>Read <!--keep-->this <a href="/guide">guide</a> carefully.</p>'),before=p.outerHTML,nodes=[...p.childNodes],s=capture(p);
    const text="请仔细阅读此指南。",a=s.annotations.find(a=>a.tag==="A")!,i=text.indexOf("指南");
    const c=compileOwnedProjection(s,candidate(text),[{id:a.id,start:i,end:i+2}]);c.apply();expect(p.textContent).toBe(text);
    expect([...p.childNodes]).toEqual(nodes);expect(nodes[2]!.textContent).toBe("");c.restore();expect(p.outerHTML).toBe(before);
  });
  it("does not grant empty prose permissions to the strict or whitespace-only arms", () => {
    const p=root('<p>Read <a href="/guide">the guide</a> carefully.</p>'),s=captureOwnedSource(p,{punctuationPolicy:"prose-v1",whitespacePolicy:"collapse-v1"});
    const a=s.annotations.find(a=>a.tag==="A")!;expect(()=>compileOwnedProjection(s,candidate("指南请仔细阅读。"),[{id:a.id,start:0,end:2}])).toThrow(/empty/);
  });
  it("retains code and numeric literals and refuses changed link attributes", () => {
    const p=root('<p>Read <code>x()</code> at <span>12</span> now.</p>'),s=capture(p),before=p.outerHTML;
    expect(()=>immutableOwnedSpans(s,"现在阅读y()，数值24。")).toThrow(/immutable/);expect(p.outerHTML).toBe(before);
    const q=root('<p>Read <a href="/guide">the guide</a> carefully.</p>'),t=capture(q),a=t.annotations.find(a=>a.tag==="A")!;
    const c=compileOwnedProjection(t,candidate("指南请仔细阅读。"),[{id:a.id,start:0,end:2}]);q.querySelector("a")!.href="/changed";
    expect(()=>c.apply()).toThrow(/source changed/);expect(q.firstChild!.textContent).toBe("Read ");
  });
  it("requires a full sentence's punctuation inside its original format wrapper", () => {
    const p=root('<p><strong>Read this paragraph.</strong> Then save.</p>'),s=capture(p),a=s.annotations.find(a=>a.tag==="STRONG")!,text="阅读此段。然后保存。",before=p.outerHTML;
    expect(()=>compileOwnedProjection(s,candidate(text),[{id:a.id,start:0,end:4}])).toThrow(/sentence punctuation/);
    const c=compileOwnedProjection(s,candidate(text),[{id:a.id,start:0,end:5}]);c.apply();expect(p.querySelector("strong")!.textContent).toBe("阅读此段。");c.restore();expect(p.outerHTML).toBe(before);
  });
  it("refuses moving words through a layout-only gap across BR/omitted boundaries", () => {
    const p=root('<p>Before.<br>\n<span hidden>meta</span>After.</p>'),s=capture(p),before=p.outerHTML;
    const flow=s.annotations.filter(a=>a.kind==="flow");expect(flow).toHaveLength(2);
    expect(()=>compileOwnedProjection(s,candidate("前段。请后段。"),[{id:flow[0]!.id,start:0,end:3},{id:flow[1]!.id,start:4,end:7}])).toThrow(/layout gap/);
    expect(p.outerHTML).toBe(before);
    const c=compileOwnedProjection(s,candidate("前段。后段。"),[{id:flow[0]!.id,start:0,end:3},{id:flow[1]!.id,start:3,end:6}]);c.apply();
    expect(p.querySelector("br")).not.toBeNull();expect(p.querySelector("span")!.textContent).toBe("meta");c.restore();expect(p.outerHTML).toBe(before);
  });
  it("does not join protected atoms or write into NBSP and whitespace-preserving text", () => {
    const p=root('<p>Read <code>甲</code>\n <code>乙</code> now.</p>'),s=capture(p),text="现在阅读甲乙。";
    expect(()=>compileOwnedProjection(s,candidate(text),immutableOwnedSpans(s,text))).toThrow(/join protected/);
    const q=root('<p>Read <em>this</em> <strong>guide</strong> now.</p>'),t=capture(q);
    expect(()=>immutableOwnedSpans(t,"现在阅读此指南。")).toThrow(/immutable/);
    const r=root('<p style="white-space:pre-line">Read <a href="/guide">the guide</a> carefully.</p>'),u=capture(r),a=u.annotations.find(a=>a.tag==="A")!;
    expect(()=>compileOwnedProjection(u,candidate("指南请仔细阅读。"),[{id:a.id,start:0,end:2}])).toThrow(/empty/);
  });
});
describe("explicit complete-target renderer witness", () => {
  function fixture() {
    const p=root('<p>Read this text.</p>'),node=p.firstChild as Text;
    const slot:SourceTextSlot={id:0,node,parent:p,source:node.data,writePolicy:"frozen-prose-gap"};
    return {p,node,slot};
  }
  it("rejects a model/JSON-style policy flag without private application authority", () => {
    const {p,slot}=fixture();expect(()=>prepareFixedTextRecord(p,[slot],'<span data-flt-text-id="0"></span>')).toThrow(/verified application authority/);
  });
  it("checks the renderer's complete parsed text before original writes and on application", () => {
    const {p,node,slot}=fixture(),before=p.outerHTML;
    expect(()=>prepareFrozenProseRecord(p,[slot],'<span data-flt-text-id="0">错误</span>',{target:"阅读文字。",readProjected:m=>m.get(node)??node.data})).toThrow(/witness/);
    expect(p.outerHTML).toBe(before);
    const record=prepareFrozenProseRecord(p,[slot],'<span data-flt-text-id="0">阅读文字。</span>',{target:"阅读文字。",readProjected:m=>m.get(node)??node.data});
    record.edits[0]!.translated="被篡改的文字";expect(applyFixedTextRecord(p,record,"translation","zh-Hans")).toBe(false);expect(p.outerHTML).toBe(before);
  });
  it("retains website text edits and rejects CSS changes before application", () => {
    const {p,node,slot}=fixture();const record=prepareFrozenProseRecord(p,[slot],'<span data-flt-text-id="0">阅读文字。</span>',{target:"阅读文字。",readProjected:m=>m.get(node)??node.data});
    p.style.whiteSpace="pre-line";expect(applyFixedTextRecord(p,record,"translation","zh-Hans")).toBe(false);
    p.style.whiteSpace="normal";expect(applyFixedTextRecord(p,record,"translation","zh-Hans")).toBe(true);
    node.data="Website edit";clearFixedTextRecord(record);expect(node.data).toBe("Website edit");
  });
  it("rejects code, numbers and an empty complete target even through the special API", () => {
    for(const html of ['<p><code>x()</code></p>','<p>12</p>']) {
      const p=root(html),node=(p.querySelector("code")??p).firstChild as Text;
      expect(()=>prepareFrozenProseRecord(p,[{id:0,node,parent:node.parentNode!,source:node.data,writePolicy:"frozen-prose-gap"}],'<span data-flt-text-id="0">词</span>',{target:"词",readProjected:m=>m.get(node)??node.data})).toThrow(/authority/);
    }
    const {p,node,slot}=fixture();expect(()=>prepareFrozenProseRecord(p,[slot],'<span data-flt-text-id="0"></span>',{target:"",readProjected:m=>m.get(node)??node.data})).toThrow(/empty/);
  });
});
