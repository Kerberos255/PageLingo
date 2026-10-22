import {afterEach,describe,expect,it} from 'vitest';
import {collectTranslationRoots} from '../src/core/dom-policy';
import {PageTranslator} from '../src/core/page-translator';
import {planMtSentences} from '../src/providers/pagelingo-mt/sentence-plan';
import {inferMtHtml} from '../src/providers/pagelingo-mt/inference';
import {encodeMtHtml,mtPrompt} from '../src/providers/pagelingo-mt/protocol';
import {translationContextForUrl} from '../src/core/translation-context';
import {richHtmlStructureCompatible} from '../src/core/rich-segment-splitter';
import type {TranslationRequest} from '../src/core/provider';

afterEach(()=>document.body.replaceChildren());
describe('MT sentence context and atomic rendering',()=>{
 it('keeps a numeric linked HTTP code within its full sentence without modifying the source',()=>{
  document.body.innerHTML='<p>The response must include the headers of an equivalent <a href="/200"><code>200</code></a> response, such as:</p>';
  const before=document.body.innerHTML;const p=document.querySelector('p')!;
  expect(collectTranslationRoots(document.body,{preserveInlineContext:true})).toEqual([p]);
  expect(document.body.innerHTML).toBe(before);
 });
 it('deduplicates inline labels while retaining standalone navigation labels',()=>{
  document.body.innerHTML='<nav><a href="/home">Home</a></nav><p>Read the <a href="/guide">guide</a>.</p>';
  const roots=collectTranslationRoots(document.body,{preserveInlineContext:true});
  expect(roots).toHaveLength(2);expect(roots.filter((r:any)=>r.tagName==='P')).toHaveLength(1);
 });
 it('collects toolbar context without wrapping or restyling the source',()=>{
  document.body.innerHTML='<p style="display:flex"><a href="/x">Open</a><svg></svg><span>Settings</span></p>';
  const before=document.body.innerHTML;
  expect(collectTranslationRoots(document.body,{preserveInlineContext:true})).toEqual([document.querySelector('p')]);
  expect(document.body.innerHTML).toBe(before);
 });
 it('splits only at complete sentences and preserves rich element identities',()=>{
  const sentence=(i:number)=>`Read <a data-flt-link-id="${i}" href="https://pagelingo.invalid/__link/${i}"><code>__FLT_LINK_START_${i}__</code>the guide ${i}<code>__FLT_LINK_END_${i}__</code></a> before continuing. `;
  const html=Array.from({length:16},(_,i)=>sentence(i)).join('');
  const units=planMtSentences({html,sourceLanguage:'en',targetLanguage:'zh-Hans'});
  expect(units.length).toBeGreaterThan(1);expect(units.every(u=>u.trim().endsWith('continuing.'))).toBe(true);
  expect(richHtmlStructureCompatible(html,units.join(''))).toBe(true);
 });
 it('does not treat source-code line wrapping as an English sentence boundary',()=>{
  const html="If the body of the <code>__FLT_OPAQUE_0__</code> statement exits with an exception\n(so <a data-flt-link-id=\"0\" href=\"https://pagelingo.invalid/__link/0\"><code>__FLT_LINK_START_0__</code><code>__FLT_OPAQUE_1__</code><code>__FLT_LINK_END_0__</code></a> is called with an exception set),\nthis is treated the same as if one of the tasks failed:\nthe remaining tasks are cancelled and then waited for,\nand non-cancellation exceptions are grouped into an\nexception group and raised.\nThe exception passed into <code>__FLT_OPAQUE_2__</code>,\nunless it is <a data-flt-link-id=\"1\" href=\"https://pagelingo.invalid/__link/1\"><code>__FLT_LINK_START_1__</code><code>__FLT_OPAQUE_3__</code><code>__FLT_LINK_END_1__</code></a>,\nis also included in the exception group.\nThe same special case is made for\n<a data-flt-link-id=\"2\" href=\"https://pagelingo.invalid/__link/2\"><code>__FLT_LINK_START_2__</code><code>__FLT_OPAQUE_4__</code><code>__FLT_LINK_END_2__</code></a> and <a data-flt-link-id=\"3\" href=\"https://pagelingo.invalid/__link/3\"><code>__FLT_LINK_START_3__</code><code>__FLT_OPAQUE_5__</code><code>__FLT_LINK_END_3__</code></a> as in the previous paragraph.\nThere is an additional special case made only for the body of the\n<code>__FLT_OPAQUE_6__</code>: if it raises <a data-flt-link-id=\"4\" href=\"https://pagelingo.invalid/__link/4\"><code>__FLT_LINK_START_4__</code><code>__FLT_OPAQUE_7__</code><code>__FLT_LINK_END_4__</code></a> and none of the\nother tasks raise exceptions that would be reported, then the\n<code>__FLT_OPAQUE_8__</code> is reraised.";
  const repeated=Array(3).fill(html).join(' ');
  const units=planMtSentences({html:repeated,sourceLanguage:'en',targetLanguage:'zh-Hans'});
  expect(units.length).toBeGreaterThan(1);
  expect(units.every(unit=>(new DOMParser().parseFromString(unit,'text/html').body.textContent??'').trim().endsWith('.'))).toBe(true);
  expect(richHtmlStructureCompatible(repeated,units.join(''))).toBe(true);
 });
 it('rejects an oversized indivisible sentence rather than cutting a link or code',()=>{
  const html='<a href="/x">'+('verylongword '.repeat(500))+'</a>';
  expect(()=>planMtSentences({html,sourceLanguage:'en',targetLanguage:'zh-Hans'})).toThrow(/complete sentence/);
 });
 it('never accepts a length-limited translation even if its markers are valid',async()=>{
  const request={html:'Isolation Level',sourceLanguage:'en',targetLanguage:'zh-Hans'};
  const result=await inferMtHtml(request,async()=>({choices:[{finish_reason:'length',message:{content:'隔离级别'}}]}));
  expect(result.accepted).toBe(false);expect(result.html).toBe(request.html);
 });
 it('retains the entire paragraph when a later sentence fails',async()=>{
  const html=Array.from({length:18},(_,i)=>`A <strong>transaction ${i}</strong> must not expose changes before commit. `).join('');
  let calls=0;
  const result=await inferMtHtml({html,sourceLanguage:'en',targetLanguage:'zh-Hans'},async options=>{
   calls++;if(calls===2)throw new Error('Injected runtime failure');
   const source=options.messages[0].content.split('English:\n')[1].split('\nChinese:')[0];
   const translated=source.replace(/⟦(\d+)⟧[^⟦]*⟦\/\1⟧/g,(_match:string,id:string)=>`⟦${id}⟧事务提交前不能暴露变更⟦/${id}⟧`);
   return{choices:[{finish_reason:'stop',message:{content:translated}}]};
  }).catch(()=>({accepted:false,html}));
  expect(calls).toBe(2);expect(result.accepted).toBe(false);expect(result.html).toBe(html);
 });
 it('mounts no child translations when a whole paragraph provider rejects',async()=>{
  document.body.innerHTML='<p>Read the <a href="/x">conditional</a> request and <a href="/y">HTTP caching</a> rules.</p>';
  const before=document.body.innerHTML;let requests=0;
  const provider={prefersWholeSentenceHtml:async()=>true,translateHtml:async()=>{requests++;throw new Error('Injected rejection');}};
  const translator=new PageTranslator(document,provider);await translator.translateAll();
  expect(requests).toBe(1);expect(document.querySelectorAll('.flt-translation')).toHaveLength(0);expect(document.body.innerHTML).toBe(before);
  translator.restore();expect(document.body.innerHTML).toBe(before);
 });
 it('keeps adjacent paragraph selectors intact and restores the original source container',async()=>{
  document.body.innerHTML='<section><p id="source">Translate this documentation paragraph.</p><p id="neighbor">Another paragraph.</p></section>';
  const before=document.body.innerHTML;const source=document.querySelector<HTMLElement>('#source')!;const neighbor=document.querySelector<HTMLElement>('#neighbor')!;
  const text=source.firstChild;
  const translator=new PageTranslator(document,{prefersWholeSentenceHtml:async()=>true,translateHtml:async (request:TranslationRequest)=>{
   const body=new DOMParser().parseFromString(request.html,'text/html').body;
   body.querySelector('[data-flt-text-id]')!.textContent='翻译这个文档段落。';return body.innerHTML;
  }},{displayMode:'translation'});
  await translator.translateAll(source);
  expect(source.textContent).toBe('翻译这个文档段落。');expect(source.firstChild).toBe(text);
  expect(source.querySelector('.flt-translation')).toBeNull();
  expect(neighbor.matches('p + p')).toBe(true);
  translator.setDisplayMode('bilingual');expect(source.querySelector('[data-flt-list-source-wrapper]')).toBeNull();
  translator.restore();expect(document.body.innerHTML).toBe(before);
 });
 it('passes domain-specific terminology only for the matching URL family',()=>{
  expect(translationContextForUrl('https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/304')).toBe('http');
  expect(translationContextForUrl('https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/Heading_Elements')).toBeUndefined();
  expect(mtPrompt('header',[{source:'header',target:'标头',mode:'replace'}],'http')).toContain('header translates to 标头');
  expect(encodeMtHtml('<code>Content-Length</code>').slots.size).toBe(1);
 });
});
