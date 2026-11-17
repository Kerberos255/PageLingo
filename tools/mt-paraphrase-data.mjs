import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {build} from 'esbuild';
import {fixtureDom,projectRoot as W} from './mt-quality-runtime.mjs';
import {paraphraseCases} from '../training/mt-fixed-slots/paraphrase-v29.mjs';
const {values}=parseArgs({options:{out:{type:'string',default:'artifacts/mt-quality/paraphrase-v29-data'}}});
const out=path.resolve(values.out),sha=b=>createHash('sha256').update(b).digest('hex');
const runtime=path.join(W,'artifacts/mt-quality/paraphrase-v29-runtime.mjs');await mkdir(path.dirname(runtime),{recursive:true});
await build({stdin:{contents:["export * from './eval/mt-quality/protocol.ts';","export * from './eval/mt-quality/source-diagnostic.ts';","export * from './eval/mt-quality/compact-context.ts';","export * from './eval/mt-quality/semantic-rewrite.ts';","export * from './src/providers/pagelingo-mt/fixed-text.ts';","export {serializeRichSegment} from './src/core/rich-segment.ts';"].join('\n'),resolveDir:W},bundle:true,platform:'node',format:'esm',outfile:runtime,logLevel:'silent'});
const api=await import(pathToFileURL(runtime).href),canon=s=>s.normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();
const forbidden=new Set(),forbiddenWire=new Set(),inventoryFiles=[],inventoryFailures=[];
function collect(v,rows){if(Array.isArray(v)){for(const x of v)collect(x,rows);return;}if(!v||typeof v!=='object')return;if(typeof v.html==='string'&&typeof v.id==='string')rows.push(v);for(const x of Object.values(v))if(x&&typeof x==='object')collect(x,rows);}
const old=[];
async function scan(dir){for(const e of await readdir(path.join(W,dir),{withFileTypes:true})){const name=dir+'/'+e.name;if(e.isDirectory())await scan(name);else if(e.name.endsWith('.json')){const v=JSON.parse(await readFile(path.join(W,name),'utf8')),before=old.length;collect(v,old);if(old.length>before)inventoryFiles.push(name);}}}
await scan('eval/mt-quality');await scan('training/mt-fixed-slots');
for(const [file,fn] of [['training/mt-fixed-slots/targeted-v2.mjs','targetedCases'],['training/mt-fixed-slots/targeted-v3.mjs','targetedCases'],['training/mt-fixed-slots/semantic-v4.mjs','semanticCases'],['training/mt-fixed-slots/corrective-v5.mjs','correctiveCases'],['training/mt-fixed-slots/preference-v6.mjs','preferenceCases'],['eval/mt-quality/release-v2.mjs','releaseCases']]){const mod=await import(pathToFileURL(path.join(W,file)).href);old.push(...mod[fn]());inventoryFiles.push(file);}
const dom=fixtureDom('https://example.org/pagelingo/v29-authored');
try{
 for(const sample of old){const scope=document.createElement('article');scope.innerHTML=sample.html;document.body.append(scope);forbidden.add(sha(canon(scope.textContent??'')));
  try{const root=scope.firstElementChild??scope,segment=api.serializeRichSegment(root,{fixedTextSlots:true});forbiddenWire.add(sha(api.encodeFixedMtText(segment.html).source));}catch(e){inventoryFailures.push({id:sample.id,error:String(e)});}finally{scope.remove();}}
 const sources=new Set(),wires=new Set(),ids=new Set(),families=new Map(),rows={legacy:{train:[],validation:[]},compact:{train:[],validation:[]}},cases=paraphraseCases();
 const counts={train:0,validation:0,holdout:0},max={},review=['# v29 template review','','Assistant-authored fictional examples, not independently human reviewed. One representative for every syntactic family. All source/target pairs and semantic facts are retained in evaluation-cases.json. No model output is used as a target.',''];
 const seenReview=new Set(),validation=[];
 for(const sample of cases){assert.ok(!ids.has(sample.id));ids.add(sample.id);const prior=families.get(sample.family);assert.ok(!prior||prior===sample.split,'Template family crosses split');families.set(sample.family,sample.split);
  const p=api.prepareQualityCase(sample),f=api.prepareCompactContext(p.request,p.segment.opaque);assert.ok(f.eligible,sample.id+':'+f.reason);assert.equal(p.prompt,f.prompts.baseline);
  const source=sha(canon(p.root.textContent??'')),wire=sha(f.semantic.fixed.source);assert.ok(!forbidden.has(source)&&!sources.has(source),'Reused source '+sample.id);assert.ok(!forbiddenWire.has(wire)&&!wires.has(wire),'Reused delexicalized wire '+sample.id);sources.add(source);wires.add(wire);counts[sample.split]++;
  assert.ok(!/[⟦⟧⟪⟫⟨⟩]/u.test(sample.natural_reference));
  const codeStrings=[...p.root.querySelectorAll('code,kbd,samp,var')].map(x=>x.textContent);for(const value of new Set(codeStrings))assert.equal(sample.natural_reference.split(value).length-1,codeStrings.filter(x=>x===value).length,sample.id+':natural protected code identity');
  const natural=api.naturalTranslationPrompt(f.semantic);
  sample.source_text=p.root.textContent;sample.source_sha256=source;sample.fixed_source_sha256=wire;
  sample.requests={legacy:{messages:[{role:'user',content:f.prompts.baseline}],max_tokens:f.semantic.maxTokens,grammar:f.semantic.grammar},compact:{messages:[{role:'user',content:f.prompts['scope-map']}],max_tokens:f.semantic.maxTokens,grammar:f.semantic.grammar},natural:{messages:[{role:'user',content:natural}],max_tokens:Math.min(768,f.semantic.maxTokens),grammar:null}};
  sample.target=p.target;delete sample.template_parts;
  if(sample.split!=='holdout')for(const variant of ['legacy','compact'])for(const task of ['fixed','natural']){
   const prompt=task==='fixed'?sample.requests[variant].messages[0].content:natural,target=task==='fixed'?p.target:sample.natural_reference;
   const row={id:sample.id+'/'+task,pair_id:sample.id,family:sample.family,split:sample.split,task,prompt_variant:variant,category:sample.category,review_status:sample.review_status,
    source_html:sample.html,source_sha256:source,source_wire_sha256:wire,semantic_facts:sample.semantic_facts,messages:[{role:'user',content:prompt},{role:'assistant',content:target}]};rows[variant][sample.split].push(row);if(sample.split==='validation')validation.push({...row,id:row.id+'/'+variant});
  }
  for(const [variant,request] of Object.entries(sample.requests))max[variant]=Math.max(max[variant]??0,new TextEncoder().encode(request.messages[0].content).length+request.max_tokens+8);
  if(!seenReview.has(sample.family)){seenReview.add(sample.family);review.push('## '+sample.family+' ('+sample.split+')','',sample.source_text,'','Natural: '+sample.natural_reference,'','Fixed text slots: '+JSON.stringify(sample.reference_slots),'','Facts: '+JSON.stringify(sample.semantic_facts),'');}
  p.scope.remove();
 }
 assert.deepEqual(counts,{train:128,validation:32,holdout:32});
 for(const split of ['train','validation']){assert.deepEqual(rows.legacy[split].map(r=>[r.pair_id,r.task,r.messages[1]]),rows.compact[split].map(r=>[r.pair_id,r.task,r.messages[1]]));for(const variant of ['legacy','compact'])assert.equal(new Set(rows[variant][split].map(r=>r.messages[0].content)).size,rows[variant][split].length);}
 const sourceFiles=['training/mt-fixed-slots/paraphrase-v29.mjs','tools/mt-paraphrase-data.mjs','eval/mt-quality/compact-context.ts','eval/mt-quality/semantic-rewrite.ts','eval/mt-quality/source-diagnostic.ts','eval/mt-quality/protocol.ts','src/providers/pagelingo-mt/fixed-text.ts','src/providers/pagelingo-mt/protocol.ts','src/providers/pagelingo-mt/sentence-plan.ts','src/core/rich-segment.ts','src/core/dom-policy.ts'];
 const sourceHashes=Object.fromEntries(await Promise.all(sourceFiles.map(async n=>[n,sha(await readFile(path.join(W,n)))])));
 await mkdir(out,{recursive:true});const variants={};
 for(const variant of ['legacy','compact']){const folder=path.join(out,variant);await mkdir(folder,{recursive:true});const manifest={schema_version:1,corpus:'fixed-paraphrase-v29',protocol:'production-fixed-text-v1',prompt_variant:variant,review_status:'assistant_audited_synthetic',independently_human_reviewed:false,source_hashes:sourceHashes,files:{},task_counts:{train:{fixed:128,natural:128},validation:{fixed:32,natural:32}}};
  for(const split of ['train','validation']){const raw=rows[variant][split].map(r=>JSON.stringify(r)).join('\n')+'\n';await writeFile(path.join(folder,split+'.jsonl'),raw);manifest.files[split]={file:split+'.jsonl',rows:rows[variant][split].length,sha256:sha(raw)};}
  const raw=JSON.stringify(manifest,null,2)+'\n';await writeFile(path.join(folder,'manifest.json'),raw);variants[variant]={file:variant+'/manifest.json',sha256:sha(raw)};
 }
 const evalRaw=JSON.stringify({schema_version:1,evaluation_only:true,optimizer_inputs_approved:false,cases},null,2)+'\n';await writeFile(path.join(out,'evaluation-cases.json'),evalRaw);
 const validationRaw=validation.map(r=>JSON.stringify(r)).join('\n')+'\n';await writeFile(path.join(out,'evaluation-validation.jsonl'),validationRaw);await writeFile(path.join(out,'template-review.md'),review.join('\n'));
 const manifest={schema_version:1,corpus:'fixed-paraphrase-v29',case_counts:counts,variants,source_hashes:sourceHashes,review_status:'assistant_audited_synthetic',independently_human_reviewed:false,
  checks:{real_web_sources_in_optimizer:false,previous_sources_excluded:true,unique_delexicalized_wire:true,template_families_disjoint:true,all_targets_production_decoded:true,paired_source_target_order_equal:true,targets_are_not_model_outputs:true,semantic_equivalence_automatically_proven:false},
  prior_inventory:{files:inventoryFiles,unique_source_hashes:forbidden.size,unique_wire_hashes:forbiddenWire.size,encoder_budget_failures:inventoryFailures},maximum_conservative_context_bound:max,
  evaluation_cases:{file:'evaluation-cases.json',rows:cases.length,sha256:sha(evalRaw),optimizer_input:false},evaluation_validation:{file:'evaluation-validation.jsonl',rows:validation.length,sha256:sha(validationRaw),optimizer_input:false}};
 await writeFile(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify({output:out,cases:counts,train_rows_each:256,validation_rows_each:64,template_families:families.size,prior_sources:forbidden.size,prior_wires:forbiddenWire.size,maximum_context_bounds:max}));
}finally{dom.window.close();}
