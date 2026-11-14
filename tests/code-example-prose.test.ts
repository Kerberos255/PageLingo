import {afterEach,describe,expect,it,vi} from "vitest";
import {collectTranslationRoots} from "../src/core/dom-policy";
import {PageTranslator} from "../src/core/page-translator";
import type {TranslationRequest} from "../src/core/provider";

afterEach(()=>document.body.replaceChildren());
describe("prose beside code examples",()=>{
  it.each(['li','blockquote'])("selects a paragraph inside %s beside a direct pre in both collection modes",tag=>{
    document.body.innerHTML=`<${tag}><p>After success, run <code>kubectl get deployments</code>.</p><pre>NAME READY\nnginx 3/3</pre></${tag}>`;
    const p=document.querySelector('p')!;
    for(const preserveInlineContext of [true,false])expect(collectTranslationRoots(document.body,{preserveInlineContext})).toEqual([p]);
  });
  it("translates the real Kubernetes paragraph through original Text nodes and restores the entire list item",async()=>{
    document.body.innerHTML='<ul><li><p>After the rollout succeeds, you can view the Deployment by running <code>kubectl get deployments</code>.\nThe output is similar to this:</p><pre>NAME READY\nnginx-deployment 3/3</pre></li></ul>';
    const li=document.querySelector('li')!,p=li.querySelector('p')!,code=p.querySelector('code')!,pre=li.querySelector('pre')!,before=li.outerHTML,nodes=[...p.childNodes];
    const provider={prefersWholeSentenceHtml:async()=>true,translateHtml:vi.fn(async(r:TranslationRequest)=>r.html.replace('After the rollout succeeds, you can view the Deployment by running ','发布成功后，可以运行 ').replace('.\nThe output is similar to this:', ' 查看部署。\n输出如下：'))};
    const t=new PageTranslator(document,provider,{displayMode:'translation',sourceLanguage:'en',targetLanguage:'zh-Hans'});
    await t.translateAll(li);
    expect(provider.translateHtml).toHaveBeenCalledOnce();expect(provider.translateHtml.mock.calls[0]![0].html).not.toContain('nginx-deployment');
    expect(t.translatedCount).toBe(1);expect(t.failedCount).toBe(0);expect(p.textContent).toContain('发布成功后');
    expect([...p.childNodes]).toEqual(nodes);expect(p.querySelector('code')).toBe(code);expect(code.textContent).toBe('kubectl get deployments');expect(li.querySelector('pre')).toBe(pre);expect(pre.textContent).toBe('NAME READY\nnginx-deployment 3/3');
    t.restore();expect(li.outerHTML).toBe(before);
  });
  it.each([true,false])("keeps unmarked code-widget fallback lines and pre text excluded: inline=%s",preserveInlineContext=>{
    document.body.innerHTML='<div class="highlight"><div class="code-line"><span>const value = 1;</span></div><pre><code>const value = 1;</code></pre></div>';
    expect(collectTranslationRoots(document.body,{preserveInlineContext})).toEqual([]);
  });
});
