import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {fixtureDom,projectRoot as W} from './mt-quality-runtime.mjs';
const {values}=parseArgs({options:{data:{type:'string',default:'artifacts/mt-quality/paraphrase-v29-data'},web:{type:'string'},out:{type:'string',default:'artifacts/mt-quality/paraphrase-v29-plan.json'}}});
if(!values.web)throw Error('A frozen source-only web capture is required');
const data=path.resolve(values.data),sha=b=>createHash('sha256').update(b).digest('hex'),read=async f=>JSON.parse(await readFile(f,'utf8'));
const api=await import(pathToFileURL(path.join(W,'artifacts/mt-quality/paraphrase-v29-runtime.mjs')).href);
const authored=await read(path.join(data,'evaluation-cases.json')),web=await read(path.resolve(values.web));
assert.equal(web.protocol,'fixed-paraphrase-v29');assert.equal(web.evaluation_only,true);assert.equal(web.optimizer_inputs_approved,false);assert.equal(web.cases.length,6);assert.ok(web.sites.every(s=>!s.error));
const known=await read(path.join(W,'eval/mt-quality/external/compact-context-v28.json')),flores=await read(path.join(W,'eval/mt-quality/external/flores200-32.json'));
const inputs=[...authored.cases.filter(c=>c.split==='holdout').map(c=>({...c,cohort:'synthetic-v29-holdout'})),
 ...web.cases.map(c=>({...c,split:'holdout',cohort:'new-web-v29'})),
 ...known.cases.map(c=>({...c,split:'diagnostic',cohort:'known-v28-regression'})),
 ...flores.cases.map(c=>({...c,id:'v29-flores-'+c.id,split:'diagnostic',cohort:'frozen-natural-regression'}))];
const cases=[],jobs=[],forbidden=new Set(),forbiddenWire=new Set();
for(const c of authored.cases.filter(c=>c.split!=='holdout')){forbidden.add(c.source_sha256);forbiddenWire.add(c.fixed_source_sha256);}
const canonical=s=>s.normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();
for(const c of inputs){const dom=fixtureDom(c.context_url);try{const p=api.prepareSourceDiagnostic(c),f=api.prepareCompactContext(p.request,p.segment.opaque);assert.equal(p.calls.length,1,c.id);const digest=sha(canonical(p.semantic.sourceText));assert.ok(!forbidden.has(digest),'Optimizer source entered evaluation');assert.ok(!forbiddenWire.has(sha(f.semantic.fixed.source)),'Optimizer wire entered evaluation');
 if(c.cohort==='new-web-v29'){assert.equal(digest,c.source_sha256);assert.equal(p.segment.html,c.fixed_html);}
 const sample={...c,source_text:p.semantic.sourceText,source_sha256:digest,fixed_source:f.semantic.fixed.source,eligible_compact:f.eligible};delete sample.requests;delete sample.target;cases.push(sample);
 const add=(mode,prompt,budget,grammar)=>{const request={messages:[{role:'user',content:prompt}],max_tokens:budget};jobs.push({key:c.id+'/'+mode,case_id:c.id,split:c.split,cohort:c.cohort,mode,request,request_sha256:sha(JSON.stringify(request)),...(grammar?{production_grammar:grammar,production_grammar_sha256:sha(grammar)}:{})});};
 add('legacy',f.prompts.baseline,f.semantic.maxTokens,f.semantic.grammar);
 if(c.cohort!=='frozen-natural-regression'){assert.ok(f.eligible,c.id+':'+f.reason);add('compact',f.prompts['scope-map'],f.semantic.maxTokens,f.semantic.grammar);}
 if(c.cohort==='synthetic-v29-holdout')add('natural',api.naturalTranslationPrompt(f.semantic),Math.min(768,f.semantic.maxTokens),null);
 p.scope.remove();
 }finally{dom.window.close();}}
assert.equal(cases.length,84);assert.equal(jobs.length,168);assert.equal(new Set(cases.map(c=>c.id)).size,cases.length);
const plan={schema_version:1,protocol:'BF16-fixed-paraphrase-v29',grammar_applied:false,evaluation_only:true,optimizer_inputs_approved:false,
 model_labels:['v022','legacy_v29','compact_v29'],jobs_per_model:jobs.length,maximum_generation_calls:jobs.length*3,
 data_manifest_sha256:sha(await readFile(path.join(data,'manifest.json'))),capture_sha256:sha(await readFile(path.resolve(values.web))),
 source_scope:'No training/validation sources in generation evaluation. New web sources have no target reference and remain evaluation-only. Synthetic holdout references are never model inputs. v28/FLORES are already-consumed regression controls.',cases,jobs};
await mkdir(path.dirname(path.resolve(values.out)),{recursive:true});await writeFile(path.resolve(values.out),JSON.stringify(plan,null,2)+'\n');console.log(JSON.stringify({cases:cases.length,jobs_per_model:jobs.length,maximum_generation_calls:jobs.length*3,new_web:6,synthetic_holdout:32}));
