import {afterEach, describe, expect, it, vi} from "vitest";
import {validateFixedTextHtml,restoreFixedHtmlTransport} from "../src/core/fixed-html-transport";
import {PageTranslator} from "../src/core/page-translator";
import {translateWithExternalEngine} from "../src/providers/external-translation";
import type {TranslationEngineConfig} from "../src/shared/translation-engine-settings";
import type {TranslationRequest} from "../src/core/provider";

afterEach(() => {document.body.replaceChildren(); vi.unstubAllGlobals();});
const wire = '<span data-flt-text-id="0">Use </span><a data-flt-link-id="0" href="https://pagelingo.invalid/__link/0"><strong><span data-flt-text-id="1">the guide</span></strong></a><span data-flt-text-id="2"> with </span><code>__FLT_OPAQUE_0__</code>';
const translated = wire.replace('Use ', '使用 ').replace('the guide', '指南').replace(' with ', ' 并使用 ');

describe("engine-independent original-node transport", () => {
  it("accepts translated text and harmless transport formatting without adding DOM authority", () => {
    expect(() => validateFixedTextHtml(wire, translated.replace(/></gu, '>\n<'))).not.toThrow();
    expect(() => validateFixedTextHtml(wire, translated.replace('data-flt-text-id="0"', "data-flt-text-id='0'"))).not.toThrow();
  });
  it.each([
    translated.replace('data-flt-text-id="1"', 'data-flt-text-id="0"'),
    translated.replace('data-flt-text-id="1"', 'data-flt-text-id="7"'),
    translated.replace('<strong>', '<em>').replace('</strong>', '</em>'),
    translated.replace('__FLT_OPAQUE_0__', '__FLT_OPAQUE_1__'),
    translated.replace('<a ', '<a onclick="alert(1)" '),
    translated.replace('https://pagelingo.invalid/__link/0', 'https://wrong.invalid/'),
    translated.replace('指南', '<i>指南</i>'),
    translated.replace('指南', ''),
    translated+'额外译文',
    translated+'<!--unexpected-->',
    '<meta name="unexpected">'+translated,
  ])("rejects a damaged template before the first source write: %s", result => {
    expect(() => validateFixedTextHtml(wire, result)).toThrow();
  });
  it("allows an optional article to be empty but keeps fixed labels and nonbreaking whitespace exact", () => {
    const source='<span data-flt-text-id="0">A </span><span data-flt-fixed="true">v2</span>\u00a0';
    expect(() => validateFixedTextHtml(source, source.replace('A ', ''))).not.toThrow();
    expect(() => validateFixedTextHtml(source, source.replace('v2', 'v3'))).toThrow();
    expect(() => validateFixedTextHtml(source, source.replace('\u00a0', ' '))).toThrow();
  });
  it("restores omitted known readonly atoms, source punctuation and edge whitespace without accepting wrong atoms",()=>{
    const source=wire+'<span data-flt-fixed="true">.</span>';
    const raw=translated.replace('__FLT_OPAQUE_0__','').replace('使用 ','使用').replace(' 并使用 ','并使用')+'<span data-flt-fixed="true">。</span>';
    const restored=restoreFixedHtmlTransport(source,raw);
    expect(restored).toBe(translated+'<span data-flt-fixed="true">.</span>');
    expect(()=>restoreFixedHtmlTransport(source,raw.replace('<code></code>','<code>__FLT_OPAQUE_1__</code>'))).toThrow();
    expect(()=>restoreFixedHtmlTransport(source,raw.replace('<code></code>','<code>额外文字</code>'))).toThrow();
    expect(()=>restoreFixedHtmlTransport(source,raw.replace('。</span>','没有。</span>'))).toThrow();
  });
  it("rejects introduced or lost parentheses and CJK title/corner brackets before any source write",()=>{
    expect(()=>restoreFixedHtmlTransport(wire,translated.replace('使用 ','）、使用 '))).toThrow(/brackets/);
    expect(()=>restoreFixedHtmlTransport(wire,translated.replace('使用 ','详见《'))).toThrow(/brackets/);
    expect(()=>restoreFixedHtmlTransport(wire,translated.replace('使用 ','详见「'))).toThrow(/brackets/);
    const source=wire.replace('Use ','Use (').replace(' with ',') with ');
    expect(()=>restoreFixedHtmlTransport(source,translated.replace('使用 ','使用（'))).toThrow(/brackets/);
  });
  it("checks complete paragraph brackets including 《》 across original link/text slots",()=>{
    const source=wire.replace('Use ','Use (').replace(' with ',') with '),target=translated.replace('使用 ','使用（').replace(' 并使用 ','）并使用 ');
    expect(()=>restoreFixedHtmlTransport(source,target)).not.toThrow();
    const titleTarget=translated.replace('使用 ','详见《').replace(' 并使用 ','》并使用 ');
    expect(()=>restoreFixedHtmlTransport(wire,titleTarget)).not.toThrow();
  });
  it("preserves an incomplete source excerpt without manufacturing a closing bracket",()=>{
    expect(()=>restoreFixedHtmlTransport(wire.replace('Use ','Use ('),translated.replace('使用 ','使用（'))).not.toThrow();
  });
  it.each(['microsoft', 'google', 'openai-compatible'] as const)("writes only original Text nodes through the actual %s adapter", async type => {
    document.body.innerHTML='<p>Use <a href="/guide" class="source-link"><strong>the guide</strong></a> with <code>commit()</code>.</p>';
    const root=document.querySelector('p')!, link=root.querySelector('a')!, code=root.querySelector('code')!;
    const before=root.outerHTML, nodes=[root,...root.querySelectorAll('*')], childLists=nodes.map(n=>[...n.childNodes]);
    const sentinel=vi.fn();link.addEventListener('pagelingo-probe',sentinel);
    const engine:TranslationEngineConfig={id:'contract-test',name:'Contract',type,enabled:true,baseUrl:'https://api.example.invalid',apiKey:'fixture-key',model:'fixture-model',region:'',prompt:'',headersJson:'',bodyJson:'',responsePath:''};
    const calls: string[]=[];
    vi.stubGlobal('fetch', vi.fn(async (_url:RequestInfo|URL, init:RequestInit) => {
      const body=JSON.parse(String(init.body));
      const source=type==='microsoft'?body[0].Text:type==='google'?body.q:body.messages[1].content;
      calls.push(source);
      expect(source).toContain('data-flt-text-id=');expect(source).toContain('__FLT_OPAQUE_0__');
      if(type==='microsoft')expect(String(_url)).toContain('textType=html');
      if(type==='google')expect(body.format).toBe('html');
      // Real HTML translation engines can omit non-linguistic marker text. The adapter must
      // restore only known source-owned atoms before its opaque-token check.
      const result=source.replace('Use ', '使用 ').replace('the guide', '指南').replace(' with ', ' 并使用 ').replace(/__FLT_(?:OPAQUE|LINK_START|LINK_END)_\d+__/gu,'');
      return new Response(JSON.stringify(type==='microsoft'?[{translations:[{text:result}]}]:type==='google'?{data:{translations:[{translatedText:result}]}}:{choices:[{message:{content:result}}]}));
    }));
    const translator=new PageTranslator(document,{prefersWholeSentenceHtml:async()=>true,translateHtml:(r:TranslationRequest)=>translateWithExternalEngine(engine,r)},{displayMode:'translation',sourceLanguage:'en',targetLanguage:'zh-Hans'});
    await translator.translateAll(root);
    expect(translator.translatedCount).toBe(1);expect(calls).toHaveLength(1);expect(root.textContent).toContain('指南');
    nodes.forEach((n,i)=>expect([...n.childNodes]).toEqual(childLists[i]));
    expect(root.querySelector('a')).toBe(link);expect(link.getAttribute('href')).toBe('/guide');expect(code.textContent).toBe('commit()');
    link.dispatchEvent(new Event('pagelingo-probe'));expect(sentinel).toHaveBeenCalledOnce();
    translator.restore();expect(root.outerHTML).toBe(before);
  });
  it("retains the complete paragraph when an external engine changes a slot identity", async () => {
    document.body.innerHTML='<p>Read <a href="/guide">the guide</a>.</p>';const p=document.querySelector('p')!,before=p.outerHTML;
    const t=new PageTranslator(document,{prefersWholeSentenceHtml:async()=>true,translateHtml:async (r:TranslationRequest)=>r.html.replace('data-flt-text-id="1"','data-flt-text-id="0"')},{displayMode:'translation'});
    await t.translateAll(p);expect(t.translatedCount).toBe(0);expect(p.outerHTML).toBe(before);
  });
  it.each(['google','microsoft'] as const)("omits auto source language for the official %s API",async type=>{
    const engine:TranslationEngineConfig={id:'auto',name:'Auto',type,enabled:true,baseUrl:'',apiKey:'fixture-key',model:'',region:'',prompt:'',headersJson:'',bodyJson:'',responsePath:''};
    const fetchMock=vi.fn(async (url:RequestInfo|URL,init:RequestInit)=>{
      const body=JSON.parse(String(init.body));
      if(type==='google'){expect(body.source).toBeUndefined();expect(body.target).toBe('zh-CN');expect(body.format).toBe('html');}
      else{expect(new URL(String(url)).searchParams.has('from')).toBe(false);expect(new URL(String(url)).searchParams.get('to')).toBe('zh-Hans');}
      return new Response(JSON.stringify(type==='google'?{data:{translations:[{translatedText:'你好'}]}}:[{translations:[{text:'你好'}]}]));
    });
    vi.stubGlobal('fetch',fetchMock);await expect(translateWithExternalEngine(engine,{html:'Hello',sourceLanguage:'auto',targetLanguage:'zh-Hans'})).resolves.toBe('你好');expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("rejects an unsafe Google endpoint before sending its credential",async()=>{
    const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
    const engine:TranslationEngineConfig={id:'unsafe',name:'Unsafe',type:'google',enabled:true,baseUrl:'http://remote.invalid/translate',apiKey:'fixture-key',model:'',region:'',prompt:'',headersJson:'',bodyJson:'',responsePath:''};
    await expect(translateWithExternalEngine(engine,{html:'Hello',sourceLanguage:'en',targetLanguage:'zh-Hans'})).rejects.toThrow(/HTTPS/);expect(fetchMock).not.toHaveBeenCalled();
  });
});
