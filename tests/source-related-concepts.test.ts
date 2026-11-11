import {afterEach, describe, expect, it} from "vitest";
import {captureOwnedSource, compileOwnedProjection, ownedProposalKey, applyReviewedOwnedProjection} from "../eval/mt-quality/owned-projection";
import {assertSourceScopeConstraints, deriveSourceScopeConstraints} from "../eval/mt-quality/scope-constraints";

afterEach(() => document.body.replaceChildren());
const common = {punctuationPolicy:"prose-v1",whitespacePolicy:"collapse-v1",allocationPolicy:"prose-gaps-v1"} as const;
const candidate=(text:string)=>({text,finish_reason:"stop"});
function sourceRoot(source:string,focus:string) {
  const match = new RegExp("(?<![A-Za-z])"+focus+"(?![A-Za-z])","u").exec(source)!;
  document.body.innerHTML='<p>'+source.slice(0,match.index)+'<a href="/concept">'+focus+'</a>'+source.slice(match.index+focus.length)+'</p>';
  return document.body.firstElementChild as HTMLElement;
}
describe("source concept ambiguity",()=>{
  it.each([
    ['The operator selected deregistration instead of registration.','deregistration','操作员选择了注销登记而非登记注册。','注销登记而非登记注册'],
    ['The operator selected unbinding instead of binding.','binding','操作员选择了解除绑定而非绑定。','解除绑定'],
    ['The operator selected unfreezing instead of freezing.','unfreezing','操作员选择了解除冻结而非冻结。','解除冻结而非冻结'],
    ['The procedure describes unfreezing, followed by freezing.','freezing','该流程先描述解除冻结，随后描述冻结。','解除冻结，随后描述冻结'],
  ])("refuses an actual known scope error without changing the v15 policy: %s",(source,focus,text,selected)=>{
    const p=sourceRoot(source,focus),before=p.outerHTML;
    const legacy=captureOwnedSource(p,{...common,scopePolicy:"source-constraints-v1"});
    const strict=captureOwnedSource(p,{...common,scopePolicy:"source-constraints-v2"});
    const at=text.indexOf(selected),spans=[{id:strict.annotations[0]!.id,start:at,end:at+selected.length}];
    expect(()=>compileOwnedProjection(legacy,candidate(text),spans)).not.toThrow();
    const c=candidate(text),review={decision:"confirmed",reviewer:"assistant",proposal_key:ownedProposalKey(strict,c,spans)} as const;
    expect(()=>applyReviewedOwnedProjection(strict,c,spans,review)).toThrow(/Related source concepts/);
    expect(p.outerHTML).toBe(before);
  });
  it.each([['encode','decode','code'],['enable','disable','able'],['decompress','compress','compress'],['inactive','active','active']])("detects a related source family without assigning Chinese meaning: %s / %s",(focus,other,stem)=>{
    const source=`Choose ${focus} rather than ${other}.`,start=source.indexOf(focus);
    const annotations=[{id:'f',kind:'format' as const,immutable:false,parent:null,start,end:start+focus.length}];
    const c=deriveSourceScopeConstraints(source,annotations,'仅供范围约束测试。',[])[0]!;
    expect(c.related_source_terms).toEqual([{text:other,start:source.lastIndexOf(other),end:source.lastIndexOf(other)+other.length,shared_stem:stem}]);
  });
  it("records the refusal cost for a correct but unproven translated term",()=>{
    const p=sourceRoot('The operator selected unbinding instead of binding.','unbinding');
    const s=captureOwnedSource(p,{...common,scopePolicy:'source-constraints-v2'}),text='操作员选择了解除绑定而非绑定。';
    const at=text.indexOf('解除绑定');
    expect(()=>compileOwnedProjection(s,candidate(text),[{id:s.annotations[0]!.id,start:at,end:at+4}])).toThrow(/Related source concepts/);
  });
  it("keeps a program-derived unchanged literal witness usable",()=>{
    const source='Use encode rather than decode.',start=source.indexOf('encode'),target='使用encode而非decode。';
    const a={id:'f',kind:'format' as const,immutable:false,parent:null,start,end:start+6},at=target.indexOf('encode');
    expect(()=>assertSourceScopeConstraints(source,[a],target,[],[{id:'f',start:at,end:at+6}],{rejectRelatedSourceConcepts:true})).not.toThrow();
  });
  it("does not reject an entire wrapper that owns both concepts",()=>{
    document.body.innerHTML='<p><strong>Use encode rather than decode.</strong></p>';const p=document.body.firstElementChild as HTMLElement;
    const s=captureOwnedSource(p,{...common,scopePolicy:'source-constraints-v2'}),text='使用编码而非解码。',before=p.outerHTML;
    const c=compileOwnedProjection(s,candidate(text),[{id:s.annotations[0]!.id,start:0,end:text.length}]);c.apply();expect(p.textContent).toBe(text);c.restore();expect(p.outerHTML).toBe(before);
  });
  it("limits the relationship check to the original independent flow",()=>{
    document.body.innerHTML='<p>Read <a href="/binding">binding</a> guidance.<br>Later consider unbinding.</p>';
    const s=captureOwnedSource(document.body.firstElementChild as HTMLElement,{...common,scopePolicy:'source-constraints-v2'}),a=s.annotations.find(a=>a.tag==='A')!;
    const constraints=deriveSourceScopeConstraints(s.sourceText,s.annotations,'阅读绑定说明。之后考虑解除绑定。',[]);
    expect(constraints.find(c=>c.id===a.id)!.related_source_terms).toEqual([]);
  });
  it("binds the stronger policy to a distinct proposal identity",()=>{
    const p=sourceRoot('Use encode rather than decode.','encode'),text='使用编码而非解码。';
    const a=captureOwnedSource(p,{...common,scopePolicy:'source-constraints-v1'}),b=captureOwnedSource(p,{...common,scopePolicy:'source-constraints-v2'});
    const spans=[{id:a.annotations[0]!.id,start:2,end:4}];expect(ownedProposalKey(a,candidate(text),spans)).not.toBe(ownedProposalKey(b,candidate(text),spans));
  });
});
