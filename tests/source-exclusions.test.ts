import {afterEach, describe, expect, it, vi} from "vitest";
import {PageTranslator} from "../src/core/page-translator";
import {serializeRichSegment} from "../src/core/rich-segment";
import {collectTranslationRoots, isEligibleTextContext} from "../src/core/dom-policy";
import {restoreFixedHtmlTransport, validateFixedTextHtml} from "../src/core/fixed-html-transport";
import type {TranslationRequest} from "../src/core/provider";

afterEach(() => document.body.replaceChildren());
const translate = (request: TranslationRequest) => request.html.replace(/Read/g, "阅读").replace(/guide/g, "指南").replace(/Theme/g, "主题").replace(/now/g, "现在");

describe("fixed source padding", () => {
  it.each([" |", " »\n ", " (", " + ", " ® "])("restores only collapsed ASCII edges of a fixed payload: %s", text => {
    const source=`<span data-flt-text-id="0">Guide</span><span data-flt-fixed="true">${text}</span>`;
    const received=source.replace("Guide", "指南").replace(text, text.trim());
    const result=restoreFixedHtmlTransport(source, received);
    expect(result).toBe(source.replace("Guide", "指南"));
    expect(()=>validateFixedTextHtml(source,result)).not.toThrow();
  });
  it.each([[" | ", ""], [" | ", "+"], [" | | ", "||"], ["\u00a0|", "|"], ["v2 ", "v3"]])("rejects changed, missing or NBSP-normalized fixed content", (original, received) => {
    const source=`<span data-flt-text-id="0">Guide</span><span data-flt-fixed="true">${original}</span>`;
    expect(()=>restoreFixedHtmlTransport(source,source.replace(original!,received!))).toThrow();
  });
  it.each(['<span data-flt-fixed="true"> | </span>', '<code>__FLT_OPAQUE_0__</code>'])("does not erase an injected comment while restoring a fixed leaf", atom => {
    const source='<span data-flt-text-id="0">Guide</span>'+atom;
    const target=source.replace(/( \| |__FLT_OPAQUE_0__)/u,'<!--unexpected-->');
    expect(()=>restoreFixedHtmlTransport(source,target)).toThrow();
  });
});

describe("source translation exclusions", () => {
  it("does not send an inherited translate=no paragraph to the provider", async () => {
    document.body.innerHTML='<section translate="NO"><p>Read the guide.</p></section>';
    const before=document.body.innerHTML,provider={prefersWholeSentenceHtml:async()=>true,translateHtml:vi.fn(async (r:TranslationRequest)=>translate(r))};
    const t=new PageTranslator(document,provider,{displayMode:"translation"});await t.translateAll();
    expect(provider.translateHtml).not.toHaveBeenCalled();expect(t.failedCount).toBe(0);expect(document.body.innerHTML).toBe(before);
  });
  it.each(['yes',''])("honors a nested explicit override: translate=%s", async value => {
    document.body.innerHTML=`<section translate="no"><p translate="${value}">Read the guide.</p></section>`;
    const t=new PageTranslator(document,{prefersWholeSentenceHtml:async()=>true,translateHtml:async (r:TranslationRequest)=>translate(r)},{displayMode:"translation"});
    await t.translateAll();expect(t.translatedCount).toBe(1);expect(document.querySelector('p')!.textContent).toBe('阅读 the 指南.');
  });
  it.each(['<a href="/brand" translate="no">guide</a>', '<a href="/brand"><span translate="no">guide</span></a>', '<a href="/brand"><span hidden>guide</span></a>'])("preserves protected inline text, its nodes and handlers while translating surrounding words", async link => {
    document.body.innerHTML='<p>Read '+link+' now.</p>';
    const p=document.querySelector('p')!,a=p.querySelector('a')!,before=p.outerHTML,nodes=[...p.childNodes],click=vi.fn();a.onclick=click;
    const calls:string[]=[];
    const t=new PageTranslator(document,{prefersWholeSentenceHtml:async()=>true,translateHtml:async (r:TranslationRequest)=>{calls.push(r.html);return translate(r);}},{displayMode:"translation"});
    await t.translateAll();expect(t.translatedCount).toBe(1);expect(calls[0]).not.toContain('guide');expect(a.textContent).toBe('guide');expect(a.onclick).toBe(click);expect([...p.childNodes]).toEqual(nodes);
    t.restore();expect(p.outerHTML).toBe(before);
  });
  it("keeps parent-owned text excluded around a nested override", async () => {
    document.body.innerHTML='<p translate="no">Read <em translate="yes">guide</em> now.</p>';
    const p=document.querySelector('p')!,before=p.outerHTML;
    const t=new PageTranslator(document,{prefersWholeSentenceHtml:async()=>true,translateHtml:async (r:TranslationRequest)=>{expect(r.html).not.toContain('Read');expect(r.html).not.toContain('now');return translate(r);}},{displayMode:"translation"});
    await t.translateAll();expect(t.translatedCount).toBe(1);expect(p.textContent).toBe('Read 指南 now.');t.restore();expect(p.outerHTML).toBe(before);
  });
  it("rechecks translate=no added while an engine request is pending", async () => {
    document.body.innerHTML='<p>Read guide now.</p>';const p=document.querySelector('p')!,before=p.innerHTML;
    const t=new PageTranslator(document,{prefersWholeSentenceHtml:async()=>true,translateHtml:async (r:TranslationRequest)=>{p.setAttribute('translate','no');return translate(r);}},{displayMode:"translation"});
    await t.translateAll();expect(t.translatedCount).toBe(0);expect(p.innerHTML).toBe(before);
  });
  it("keeps explicit no-translate code and protected inline content represented by readonly tokens", () => {
    document.body.innerHTML='<p>Read <code translate="no">run()</code> with <span translate="no">Brand</span>.</p>';
    const p=document.querySelector('p')!,source=serializeRichSegment(p,{fixedTextSlots:true});
    expect(source.html).toContain('__FLT_OPAQUE_0__');expect(source.html).toContain('__FLT_OPAQUE_1__');
    expect(source.html).not.toMatch(/run\(\)|Brand/);expect(source.opaque.map(a=>a.text)).toEqual(['run()','Brand']);
    expect(source.textSlots!.map(s=>s.source)).toEqual(['Read ',' with ']);
  });
  it("ignores an invalid translate value and inherits the nearest valid ancestor", () => {
    document.body.innerHTML='<section translate="no"><p translate="invalid">Read guide.</p></section>';
    expect(isEligibleTextContext(document.querySelector('p')!.firstChild)).toBe(false);expect(collectTranslationRoots(document.body,{preserveInlineContext:true})).toHaveLength(0);
  });
  it("keeps form options and SVG/title out of requests, preserving form value and node identity", async () => {
    document.body.innerHTML='<label>Theme <select><option>Auto</option><option selected>Dark</option></select><svg><title>Icon</title><path d="M0 0"/></svg></label>';
    const root=document.querySelector('label')!,select=root.querySelector('select')!,before=root.outerHTML,nodes=[...root.childNodes];
    const source=serializeRichSegment(root,{fixedTextSlots:true});expect(source.html).not.toMatch(/Auto|Dark|Icon/);expect(source.textSlots).toHaveLength(1);
    const t=new PageTranslator(document,{prefersWholeSentenceHtml:async()=>true,translateHtml:async (r:TranslationRequest)=>translate(r)},{displayMode:"translation"});await t.translateAll();
    expect(t.translatedCount).toBe(1);expect(select.value).toBe('Dark');expect([...root.childNodes]).toEqual(nodes);expect(root.querySelector('svg')!.outerHTML).toContain('<title>Icon</title>');t.restore();expect(root.outerHTML).toBe(before);
  });
});
