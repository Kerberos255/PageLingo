// Inspect existing weights on the held-out validation families; never retrain them.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {parseArgs} from "node:util";
import {fixtureDom, projectRoot, qualityRuntime} from "./mt-quality-runtime.mjs";

const {values} = parseArgs({options:{out:{type:"string",default:"artifacts/mt-validation-v1"}}});
const git = args => execFileSync("git",args,{cwd:projectRoot,encoding:"utf8"}).trim();
const sourceCommit=git(["rev-parse","HEAD"]), output=path.resolve(values.out);
const relativePackage=`training-packages/validation-v1-${sourceCommit.slice(0,12)}`, folder=path.join(output,relativePackage);
const hash=raw=>createHash("sha256").update(raw).digest("hex");
const dataRoot=path.join(projectRoot,"artifacts/mt-quality/targeted-v2");
const raw=await readFile(path.join(dataRoot,"validation.jsonl"));
assert.equal(hash(raw),"149401c637f721a54caaf6a5609cdaac1c237ba66e466ed2a997d9440549fc6d");
const rows=raw.toString().trim().split("\n").map(line=>JSON.parse(line));
const trainRaw=await readFile(path.join(dataRoot,"train.jsonl"));
assert.equal(hash(trainRaw),"883f8496501c31d74ae7336defdc16ab53416321c7aa5ab740d3d2d11cb9f725");
const train=trainRaw.toString().trim().split("\n").map(line=>JSON.parse(line));
assert.equal(rows.length,64);assert.equal(new Set(rows.map(r=>r.id)).size,64);
const families=new Set(train.map(r=>r.family)), prompts=new Set(train.map(r=>r.messages[0].content));
const api=await qualityRuntime(), samples=[];
for(const row of rows){
  assert.equal(row.split,"validation");assert.ok(!families.has(row.family)&&!prompts.has(row.messages[0].content));
  const dom=fixtureDom("https://validation.example/");
  try{
    const reference=[...row.messages[1].content.matchAll(/⟦(\d+)⟧([\s\S]*?)⟦\/\1⟧/gu)].map(m=>m[2]);
    const sample={id:row.id,html:row.source_html,context_url:"https://validation.example/",reference_slots:reference,probes:[]};
    const prepared=api.prepareQualityCase(sample), calls=api.qualityCallPlan(prepared.request);
    assert.equal(calls.length,1);assert.deepEqual(calls[0].messages,row.messages.slice(0,1));
    assert.equal(prepared.target,row.messages[1].content);prepared.scope.remove();
    samples.push({...row,max_tokens:calls[0].max_tokens,production_grammar:calls[0].grammar});
  }finally{dom.window.close();}
}
await mkdir(path.dirname(folder),{recursive:true});await mkdir(folder);
const manifest={schema_version:1,source_commit:sourceCommit,source_dirty:Boolean(git(["status","--porcelain"])),
  purpose:"Validation diagnostics of existing base and v2b adapters only. No optimizer, model conversion, Firefox, upload or release approval.",files:{}};
async function put(name,contents){
  const bytes=Buffer.isBuffer(contents)?contents:Buffer.from(contents);await writeFile(path.join(folder,name),bytes);
  manifest.files[name]={bytes:bytes.length,sha256:hash(bytes)};
}
for(const file of ["validation_probe.py","validation_metrics.py","evaluate_gpu.py"])
  await put(file,await readFile(path.join(projectRoot,"training/mt-fixed-slots",file)));
await put("README.md",await readFile(path.join(projectRoot,"training/mt-fixed-slots/VALIDATION_V1.md")));
await put("research_v2.py",'from validation_probe import main\nif __name__ == "__main__": raise SystemExit(main())\n');
await put("validation-plan.json",JSON.stringify({scope:"validation-only-no-training",validation_jsonl_sha256:hash(raw),
  review_status:"assistant_audited_synthetic",independent_human_review:false,rows:samples},null,2)+"\n");
const run="outputs/pagelingo-quality-v2b-run-20261026-163645-a532c4/";
await put("validation-models.json",JSON.stringify({base:{directory:"models/hy-mt2-1.8b",sha256:"29e9117a44c79f81857613601968ff482d8a23c2d6736a1710bba9e5ca4762e5"},adapters:{
  fresh_r16:{directory:run+"fresh-r16-lr3e5/adapter",sha256:"85546101dce5baae57f472b92e8b722f68c4c26550b396187e0b0e5d3e844b02",config_sha256:"5af5e26dc0354cff9ebdd9b2d3534fa66542aa751db866dd99db0d23bedc2663"},
  resume_r32:{directory:run+"resume-v2a-r32-lr1e5/adapter",sha256:"dfc3874e46f810c9d9951add371cce13cc2987bcb2fd673ade2af62ee22670cb",config_sha256:"23a20853d2ae7500c571c08fb74640e2474ae560e32733bf60a7a44bd97a3e7e"}}},null,2)+"\n");
const serialized=JSON.stringify(manifest,null,2)+"\n";await writeFile(path.join(folder,"package-manifest.json"),serialized);
const control=path.join(output,"tools/mt-control");await mkdir(control,{recursive:true});
await writeFile(path.join(control,"launcher.py"),await readFile(path.join(projectRoot,"training/mt-fixed-slots/windows/launcher.py")));
await writeFile(path.join(control,"current-task.json"),JSON.stringify({schema_version:1,description:"Existing-weight validation only: base, fresh r16, resumed r32; no training",package:relativePackage,
  run_prefix:"pagelingo-validation-v1",source_commit:sourceCommit,manifest_sha256:hash(serialized)},null,2)+"\n");
await writeFile(path.join(output,"x.cmd"),(await readFile(path.join(projectRoot,"training/mt-fixed-slots/windows/x.cmd"),"utf8")).replace(/\r?\n/gu,"\r\n"));
console.log(JSON.stringify({output,package:relativePackage,files:Object.keys(manifest.files).length,rows:rows.length,source_commit:sourceCommit,
  source_dirty:manifest.source_dirty,training_executed:false,environment_entry_preserved:true}));
