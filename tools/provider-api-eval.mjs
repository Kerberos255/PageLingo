#!/usr/bin/env node
// Runs the production adapters on frozen public-page cases. Never stores keys.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';

const args=process.argv.slice(2), value=k=>args[args.indexOf(k)+1];
if(!args.includes('--engine')||!args.includes('--cases')||!args.includes('--out')) {
  throw new Error('Usage: node tools/provider-api-eval.mjs --engine ai|microsoft|google --cases capture.json --out result.json [--limit 8]');
}
const kind=value('--engine'), env=process.env;
const names=kind==='ai'?{key:'PAGELINGO_AI_API_KEY',base:'PAGELINGO_AI_BASE_URL',model:'PAGELINGO_AI_MODEL'}
  :kind==='microsoft'?{key:'PAGELINGO_MS_API_KEY',base:'PAGELINGO_MS_BASE_URL',region:'PAGELINGO_MS_REGION'}
    :kind==='google'?{key:'PAGELINGO_GOOGLE_API_KEY',base:'PAGELINGO_GOOGLE_BASE_URL'}:null;
if(!names)throw new Error('Unknown API engine');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const input=await readFile(resolve(value('--cases')),'utf8'), capture=JSON.parse(input);
const selected=Array.isArray(capture)?capture:capture.cases;
if(!Array.isArray(selected)||!selected.length)throw new Error('Expected frozen public-page cases');
const missing=Object.entries(names).filter(([key,name])=>!['region','base'].includes(key)&&!env[name]).map(([,name])=>name);
if(kind==='ai'&&!env[names.base])missing.push(names.base);
const result={protocol:'public-page-provider-api-v17',engine:kind,started_utc:new Date().toISOString(),
  cases_sha256:createHash('sha256').update(input).digest('hex'),production_adapter:true,
  successful_service_responses:0,rows:[],status:missing.length?'blocked_missing_configuration':'running',missing_configuration:missing};
const output=resolve(value('--out'));await mkdir(dirname(output),{recursive:true});
const save=()=>writeFile(output,JSON.stringify(result,null,2)+'\n');
if(missing.length){await save();process.exitCode=2;}
else {
 const {window}=new JSDOM();globalThis.DOMParser=window.DOMParser;globalThis.Node=window.Node;
 const config={id:'api-evaluation',name:kind,type:kind==='ai'?'openai-compatible':kind,enabled:true,
   apiKey:env[names.key],baseUrl:env[names.base]||'',model:names.model?env[names.model]||'':'',
   region:names.region?env[names.region]||'':'',prompt:'',headersJson:'',bodyJson:'',responsePath:''};
 const bundle=await build({stdin:{contents:'export {translateWithExternalEngine} from "./src/providers/external-translation.ts";export {restoreFixedHtmlTransport} from "./src/core/fixed-html-transport.ts";',resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
 const {translateWithExternalEngine,restoreFixedHtmlTransport}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
 const redact=s=>String(s).replaceAll(config.apiKey,'[REDACTED]');
 const limit=args.includes('--limit')?Number(value('--limit')):8;
 if(!Number.isInteger(limit)||limit<1||limit>32)throw new Error('Limit must be 1..32');
 for(const c of selected.slice(0,limit)){
  if(typeof c.fixed_html!=='string'||!c.fixed_html.includes('data-flt-text-id'))throw new Error('Case lacks original-node wire HTML');
  const request={html:c.fixed_html,sourceLanguage:c.source_language||'en',targetLanguage:'zh-Hans'};
  const started=performance.now(),row={id:c.id,source_url:c.context_url,request,
    request_sha256:createHash('sha256').update(JSON.stringify(request)).digest('hex')};
  try {
   const html=await translateWithExternalEngine(config,request);row.html=html;result.successful_service_responses++;
   row.restored_html=restoreFixedHtmlTransport(request.html,html);row.status='template_valid_pending_live_browser_replay';
  }catch(error){row.status='failed_or_refused';row.error=redact(error instanceof Error?error.message:error);}
  row.wall_s=(performance.now()-started)/1000;result.rows.push(row);await save();
 }
 result.finished_utc=new Date().toISOString();result.status='complete';await save();window.close();
}
console.log(JSON.stringify({engine:kind,status:result.status,requests:result.rows.length,output}));
