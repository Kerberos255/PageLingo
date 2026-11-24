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
  it("bypasses blanket page/form translate=no wrappers like itch.io project editors while preserving nested editors, inline exclusions, and package filenames", async () => {
    document.body.innerHTML = `
      <div class="header_widget"><a href="/browse">Read</a></div>
      <div class="main">
        <div class="edit_game_page form" translate="no">
          <form class="game_edit_form">
            <div class="input_row"><label><div class="label">Theme</div></label></div>
            <h2>Read guide</h2>
            <p class="sub">Read <span translate="no">Brand</span> now.</p>
            <button type="button">Read</button>
            <strong class="upload_display_name">drywell-html5.zip</strong>
            <div class="redactor-layer" contenteditable="true" translate="no"><p>Read guide now.</p></div>
          </form>
        </div>
      </div>
      <footer><a href="/about">Theme</a></footer>
    `;
    const t = new PageTranslator(document, { prefersWholeSentenceHtml: async () => true, translateHtml: async (r: TranslationRequest) => translate(r) }, { displayMode: "translation" });
    await t.translateAll();
    expect(document.querySelector(".edit_game_page .label")!.textContent).toBe("主题");
    expect(document.querySelector(".edit_game_page h2")!.textContent).toBe("阅读 指南");
    expect(document.querySelector(".edit_game_page p.sub")!.textContent).toBe("阅读 Brand 现在.");
    expect(document.querySelector(".edit_game_page button")!.textContent).toBe("阅读");
    expect(document.querySelector(".upload_display_name")!.textContent).toBe("drywell-html5.zip");
    expect(document.querySelector(".redactor-layer")!.textContent).toBe("Read guide now.");
  });
  it("keeps translate=no honored on flat log viewers and small embedded demo widgets inside a larger article", async () => {
    document.body.innerHTML = `
      <div class="logs" translate="no">
        <div>Read guide now</div><div>Read guide now</div><div>Read guide now</div>
        <div>Read guide now</div><div>Read guide now</div><div>Read guide now</div>
      </div>
    `;
    const logProvider = { prefersWholeSentenceHtml: async () => true, translateHtml: vi.fn(async (r: TranslationRequest) => translate(r)) };
    const logTranslator = new PageTranslator(document, logProvider, { displayMode: "translation" });
    await logTranslator.translateAll();
    expect(logProvider.translateHtml).not.toHaveBeenCalled();

    document.body.innerHTML = `
      <article>
        <h1>Read the complete deployment guide now</h1>
        <p>Read this detailed introduction to configuring the theme and reading every guide carefully before production rollout.</p>
        <p>Read the second section of the guide now so that your theme configuration remains stable across environments.</p>
        <div class="live-demo" translate="no">
          <form><h3>Theme</h3><p>Read</p><p>guide</p><button type="button">now</button></form>
        </div>
      </article>
    `;
    const demoTranslator = new PageTranslator(document, { prefersWholeSentenceHtml: async () => true, translateHtml: async (r: TranslationRequest) => translate(r) }, { displayMode: "translation" });
    await demoTranslator.translateAll();
    expect(document.querySelector("article > h1")!.textContent).toContain("阅读");
    expect(document.querySelector(".live-demo button")!.textContent).toBe("now");
    expect(document.querySelector(".live-demo h3")!.textContent).toBe("Theme");
  });
});
