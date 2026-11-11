import {PageTranslator} from "../../src/core/page-translator";
import {serializeRichSegment} from "../../src/core/rich-segment";
import {isProtectedApiSignature} from "../../src/core/dom-policy";
import type {TranslationRequest} from "../../src/core/provider";
import {sourceLocator, liveRequest} from "./complex-web";

interface Case {id:string; site_id:string; locator:string; context_url:string; html:string}
interface Job {id:number; request:TranslationRequest}
let queue:Job[]=[], next=0, result:unknown=null;
const pending=new Map<number,{resolve:(html:string)=>void;reject:(e:Error)=>void}>();
export const status=()=>({pending:queue.splice(0),result});
export function respond(id:number, html:string, error?:string) {
  const item=pending.get(id);if(!item)throw new Error('Unknown provider request');pending.delete(id);
  if(error)item.reject(new Error(error));else item.resolve(html);
}
const nodes=(root:Node):Node[]=>[root,...[...root.childNodes].flatMap(nodes)];
const attrs=(node:Node)=>node.nodeType===Node.ELEMENT_NODE?[...(node as Element).attributes].map(a=>[a.name,a.value]):[];
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);

export function capture(siteId:string, selector:string, count=2) {
  const chosen=[];
  for(const root of document.querySelectorAll<HTMLElement>(selector)) {
    const text=(root.textContent??'').trim();
    if(text.length<60||text.length>320||!root.querySelector('a,code,strong,em')||!root.getClientRects().length||isProtectedApiSignature(root))continue;
    try {
      const segment=serializeRichSegment(root,{fixedTextSlots:true});
      if(!segment.textSlots?.length||segment.textSlots.length>8)continue;
      const mt=liveRequest(root,location.href);
      chosen.push({id:siteId+'-'+(chosen.length+1),site_id:siteId,locator:sourceLocator(root),context_url:location.href,
        html:root.outerHTML,source_text:text,slots:segment.textSlots.length,legacy_html:serializeRichSegment(root).html,
        fixed_html:segment.html,mt_fixed_calls:mt.calls,natural:mt.natural,fixed_source:mt.semantic.fixed.source,
        selection:'First visible source paragraphs of 60..320 characters with inline markup and at most 8 text slots; selected before translation.'});
      if(chosen.length===count)break;
    }catch{}
  }
  return chosen;
}

export function begin(c:Case, contract:'legacy'|'original-nodes') {
  if(pending.size)throw new Error('Previous provider job is still pending');
  result=null;queue=[];
  const root=document.querySelector<HTMLElement>(c.locator);
  if(!root||location.href!==c.context_url||root.outerHTML!==c.html){result={id:c.id,contract,status:'source_changed',displayed:false};return;}
  const before=root.outerHTML, original=nodes(root), children=original.map(n=>[...n.childNodes]), attributes=original.map(attrs);
  const text=original.map(n=>n.nodeType===Node.TEXT_NODE?n.textContent:null), handlers=original.map(n=>(n as HTMLElement).onclick);
  const ancestors:Element[]=[];for(let p=root.parentElement;p;p=p.parentElement)ancestors.push(p);
  const ancestorLists=ancestors.map(n=>[...n.childNodes]), ancestorAttributes=ancestors.map(attrs);
  const code=[...root.querySelectorAll('code,kbd,samp,var,svg,math')], codeHtml=code.map(n=>n.outerHTML);
  const links=[...root.querySelectorAll('a')], hrefs=links.map(a=>a.getAttribute('href'));
  let events=0;const probes=links.map(link=>{const f=()=>events++;link.addEventListener('pagelingo-nonnavigation-probe',f);return f;});
  const dimensions=()=>({width:root.getBoundingClientRect().width,height:root.getBoundingClientRect().height,
    horizontal_overflow:root.clientWidth>0&&root.scrollWidth>root.clientWidth+2,viewport_width:innerWidth});
  const dimensionsBefore=dimensions(),calls:Array<Job&{html?:string;error?:string}>=[];
  const t=new PageTranslator(document,{
    prefersWholeSentenceHtml:async()=>contract==='original-nodes',supportsStructuralSplitting:async()=>true,
    translateHtml:(request:TranslationRequest)=>new Promise<string>((resolve,reject)=>{
      const job={id:++next,request};calls.push(job);pending.set(job.id,{resolve:html=>{calls.find(c=>c.id===job.id)!.html=html;resolve(html);},
        reject:e=>{calls.find(c=>c.id===job.id)!.error=String(e);reject(e);}});queue.push(job);
    })},{sourceLanguage:'en',targetLanguage:'zh-Hans',displayMode:'translation',concurrency:1});
  void t.translateAll(root).then(()=>{
    const displayed=t.translatedCount>0,translatedText=contract==='legacy'?(root.querySelector('[data-flt-generated]')?.textContent??root.textContent):root.textContent;
    const structure=original.length===nodes(root).length&&original.every((n,i)=>nodes(root)[i]===n&&same([...n.childNodes].map(x=>original.indexOf(x)),children[i]!.map(x=>original.indexOf(x)))&&same(attrs(n),attributes[i]));
    const ancestorCheck=ancestors.every((n,i)=>same(attrs(n),ancestorAttributes[i])&&n.childNodes.length===ancestorLists[i]!.length&&[...n.childNodes].every((v,j)=>v===ancestorLists[i]![j]));
    const codeCheck=code.every((n,i)=>n.isConnected&&n.outerHTML===codeHtml[i]);
    const linkCheck=links.every((n,i)=>n.isConnected&&n.getAttribute('href')===hrefs[i])&&original.every((n,i)=>(n as HTMLElement).onclick===handlers[i]);
    links.forEach(n=>n.dispatchEvent(new Event('pagelingo-nonnavigation-probe')));
    const dimensionsAfter=dimensions(),translatedHtml=root.outerHTML;
    t.restore();links.forEach((link,i)=>link.removeEventListener('pagelingo-nonnavigation-probe',probes[i]!));
    result={id:c.id,contract,status:displayed?'displayed':'refused',displayed,translated_text:translatedText,translated_html:translatedHtml,calls,
      original_structure_unchanged:structure,ancestor_structure_unchanged:ancestorCheck,code_unchanged:codeCheck,
      link_targets_and_handler_properties_unchanged:linkCheck,nonnavigation_listeners_preserved:events===links.length,
      restored_exact:root.outerHTML===before,restored_source_text_nodes:original.every((n,i)=>text[i]===null||n.textContent===text[i]),
      refused_source_untouched:displayed?null:translatedHtml===before,dimensions_before:dimensionsBefore,dimensions_after:dimensionsAfter};
  },e=>{t.restore();result={id:c.id,status:'internal_error',error:String(e)};});
}
