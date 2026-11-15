import {describe,expect,it,vi} from 'vitest';
import {MtTranslationQueue} from '../src/providers/pagelingo-mt/translation-queue';
import type {CheckedTranslationResult,TranslationRequest} from '../src/core/provider';
const source=():TranslationRequest=>({html:'Read this paragraph.',sourceLanguage:'en',targetLanguage:'zh-Hans'});
const translated=():CheckedTranslationResult=>({html:'阅读这个段落。',accepted:true});
describe('MT serial result cache',()=>{
 it('generates once for simultaneous identical requests and returns independent result objects',async()=>{
  const generate=vi.fn(async()=>translated()),q=new MtTranslationQueue('model-a',generate);
  const results=await Promise.all([q.translate(source()),q.translate(source()),q.translate(source())]);
  expect(generate).toHaveBeenCalledOnce();expect(results).toEqual([translated(),translated(),translated()]);
  results[1]!.html='caller changed its result';expect(await q.translate(source())).toEqual(translated());
 });
 it('separates source HTML, languages, domain and every terminology field',async()=>{
  const generate=vi.fn(async()=>translated()),q=new MtTranslationQueue('model-a',generate);
  const inputs=[source(),{...source(),html:'Another paragraph.'},{...source(),sourceLanguage:'auto'},{...source(),targetLanguage:'zh-Hant'},{...source(),context:'javascript' as const},...[
   {source:'promise',target:'Promise',mode:'replace' as const}, {source:'promise',target:'承诺',mode:'replace' as const}, {source:'promise',target:'Promise',mode:'protect' as const}, {source:'promises',target:'Promise',mode:'replace' as const}
  ].map(entry=>({...source(),terminology:[entry]}))];
  for(const r of inputs){await q.translate(r);await q.translate(r);}
  expect(generate).toHaveBeenCalledTimes(inputs.length);
 });
 it('returns a warm result while an unrelated CPU generation is still busy',async()=>{
  let release!:(value:CheckedTranslationResult)=>void;
  const generate=vi.fn().mockResolvedValueOnce(translated()).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
  const q=new MtTranslationQueue('model-a',generate);await q.translate(source());
  const busy=q.translate({...source(),html:'A different slow paragraph.'});await Promise.resolve();
  let returned=false;const warm=q.translate(source()).then(r=>{returned=true;return r;});
  try{await new Promise(resolve=>setTimeout(resolve,0));expect(returned).toBe(true);expect(generate).toHaveBeenCalledTimes(2);}
  finally{release(translated());await busy;await warm;}
 });
 it('does not cache a rejected paragraph or a runtime exception and keeps later work usable',async()=>{
  const generate=vi.fn().mockResolvedValueOnce({html:source().html,accepted:false,reason:'truncated'}).mockRejectedValueOnce(new Error('runtime failed')).mockResolvedValue(translated());
  const q=new MtTranslationQueue('model-a',generate);
  expect((await q.translate(source())).accepted).toBe(false);await expect(q.translate(source())).rejects.toThrow('runtime failed');
  expect(await q.translate(source())).toEqual(translated());expect(await q.translate(source())).toEqual(translated());expect(generate).toHaveBeenCalledTimes(3);
 });
 it('takes a stable copy of HTML and nested terminology before queued work starts',async()=>{
  const generate=vi.fn(async(_request:TranslationRequest)=>translated()),q=new MtTranslationQueue('model-a',generate),r={...source(),terminology:[{source:'promise',target:'Promise',mode:'replace' as const}]};
  const pending=q.translate(r);r.html='mutated';r.terminology[0]!.target='mutated';await pending;
  expect(generate.mock.calls[0]![0]).toMatchObject({html:'Read this paragraph.',terminology:[{source:'promise',target:'Promise'}]});
  await q.translate({...source(),terminology:[{source:'promise',target:'Promise',mode:'replace'}]});expect(generate).toHaveBeenCalledOnce();
 });
 it('clears a warm result and cannot repopulate it from an older in-flight generation',async()=>{
  let release!:(value:CheckedTranslationResult)=>void;
  const generate=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;})).mockResolvedValue(translated());
  const q=new MtTranslationQueue('model-a',generate),old=q.translate(source());await Promise.resolve();q.clear();release(translated());await old;
  await q.translate(source());await q.translate(source());expect(generate).toHaveBeenCalledTimes(2);
  q.clear();await q.translate(source());expect(generate).toHaveBeenCalledTimes(3);
 });
 it('skips an aborted queued request without running the CPU callback',async()=>{
  const generate=vi.fn(async()=>translated()),q=new MtTranslationQueue('model-a',generate),controller=new AbortController();
  const pending=q.translate({...source(),signal:controller.signal});controller.abort();await expect(pending).rejects.toThrow('aborted');expect(generate).not.toHaveBeenCalled();
  await q.translate(source());expect(generate).toHaveBeenCalledOnce();
  const warmController=new AbortController(),warm=q.translate({...source(),signal:warmController.signal});warmController.abort();
  await expect(warm).rejects.toThrow('aborted');expect(generate).toHaveBeenCalledOnce();
 });
 it('evicts the least recently used result at the entry limit and skips oversized HTML',async()=>{
  const generate=vi.fn(async()=>translated()),q=new MtTranslationQueue('model-a',generate);
  for(let i=0;i<257;i++)await q.translate({...source(),html:'paragraph '+i});
  await q.translate({...source(),html:'paragraph 256'});expect(generate).toHaveBeenCalledTimes(257);
  await q.translate({...source(),html:'paragraph 0'});expect(generate).toHaveBeenCalledTimes(258);
  await q.translate({...source(),html:'x'.repeat(8193)});await q.translate({...source(),html:'x'.repeat(8193)});expect(generate).toHaveBeenCalledTimes(260);
 });
});
