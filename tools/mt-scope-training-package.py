"""Build the single-x.cmd GPU kit. No weights, dependencies, uploads or remote writes."""
import argparse,hashlib,importlib.util,json,pathlib,shutil,subprocess,sys,zipfile
ROOT=pathlib.Path(__file__).resolve().parents[1];TRAIN=ROOT/'training/mt-fixed-slots'
sys.path.insert(0,str(TRAIN))
from scope_choice_data import export
from evaluate_scope_choice import validate_eval_plan

def sha(path):
 with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def build(out,cold):
 if out.exists():raise ValueError('Preserve existing kits; use a new output path')
 commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip();dirty=bool(subprocess.check_output(['git','status','--porcelain'],cwd=ROOT,text=True).strip())
 relative='.pagelingo-kits/scope-choice-v1-'+commit[:12];folder=out/relative;folder.mkdir(parents=True)
 for file in ['train.py','training_options.py','scope_choice_contract.py','scope_choice_data.py','scope_choice_workflow.py','evaluate_scope_choice.py','config-scope-choice-v1.json']:
  shutil.copyfile(TRAIN/file,folder/file)
 shutil.copyfile(TRAIN/'windows/run_local.py',folder/'run_local.py')
 (folder/'research_v2.py').write_text('from scope_choice_workflow import main\nif __name__ == "__main__":\n    raise SystemExit(main())\n')
 manifest=export(folder/'data');evaluation={'protocol':'scope-choice-evaluation-v1','evaluation_only':True,'optimizer_inputs_approved':False,'jobs':[]}
 for line in (folder/'data/holdout.jsonl').read_text().splitlines():
  row=json.loads(line);request={'messages':row['messages'][:1],'grammar':None,'max_tokens':8 if row['task']=='scope_choice' else 192}
  allowed=[c['id'] for c in row.get('candidates',[])]+['X']
  if row['task']=='scope_choice':request['grammar']='root ::= '+' | '.join(json.dumps(x) for x in allowed)
  evaluation['jobs'].append({'case_id':row['id'],'variant':'synthetic-holdout','kind':'scope_choice' if row['task']=='scope_choice' else 'natural_replay',
    'request':request,'request_sha256':hashlib.sha256(json.dumps(request,ensure_ascii=False,separators=(',',':')).encode()).hexdigest(),
    'allowed_ids':allowed if row['task']=='scope_choice' else [],'expected_id':row['messages'][1]['content'] if row['task']=='scope_choice' else None,
    'reference':row['messages'][1]['content'],'pair_id':row.get('pair_id'),'gold_candidate':row.get('gold_candidate')})
 if cold:
  original=json.loads(cold.read_text())
  if original.get('optimizer_inputs_approved') is not False:raise ValueError('Cold controls must remain evaluation-only')
  for job in original['jobs']:
   request=job['request'];scope=job['variant'].startswith('selector-')
   evaluation['jobs'].append({**job,'case_id':'cold-'+job['case_id'],'kind':'scope_choice' if scope else 'natural_replay',
    'allowed_ids':list('ABCD')[:len(job.get('choice_order',[]))]+['X'] if scope else [],'expected_id':job.get('gold_id')})
 validate_eval_plan(evaluation)
 (folder/'scope-evaluation-plan.json').write_text(json.dumps(evaluation,ensure_ascii=False,indent=2)+'\n')
 files={str(f.relative_to(folder)):{'bytes':f.stat().st_size,'sha256':sha(f)} for f in folder.rglob('*') if f.is_file()}
 package={'schema_version':1,'source_commit':commit,'source_dirty':dirty,'purpose':'bounded fresh-base scope-choice and natural translation pilot',
  'gpu_only':True,'max_optimizer_steps':128,'model_upload':False,'release_approved':False,'files':files}
 (folder/'package-manifest.json').write_text(json.dumps(package,indent=2)+'\n')
 control=out/'tools/mt-control';control.mkdir(parents=True);shutil.copyfile(TRAIN/'windows/launcher.py',control/'launcher.py');shutil.copyfile(TRAIN/'windows/x.cmd',out/'x.cmd')
 (control/'current-task.json').write_text(json.dumps({'schema_version':1,'run_prefix':'scope-choice-v1','description':'GPU-only scope-choice pilot, 128 steps; BF16 base/candidate comparison',
  'source_commit':commit,'package':relative,'manifest_sha256':sha(folder/'package-manifest.json')},indent=2)+'\n')
 (out/'README-TRAINING.txt').write_text('Keep the original PageLingo-MT.cmd unchanged. Extract this kit into the existing E:\\PageLingo-MT project. Open PageLingo-MT.cmd, then run x.cmd.\nOnly x.cmd is supplied; no Firefox or CPU model conversion runs on the GPU PC. Existing caches/models/adapters/logs are preserved. No dependencies are installed and no weights are uploaded.\nThe required original base is models/hy-mt2-1.8b/model.safetensors, pinned by SHA. Fresh LoRA candidate: no old adapter resumed, at most128 optimizer steps.\nOutputs: outputs/scope-choice-v1-run-*/gpu-handoff.zip. Completion means evidence is ready, not model release approval.\nx.cmd status only reads status. x.cmd check preflights without optimization and does not consume the training run.\n')
 inventory={str(f.relative_to(out)):{'bytes':f.stat().st_size,'sha256':sha(f)} for f in out.rglob('*') if f.is_file()}
 (out/'INSTALL-MANIFEST.json').write_text(json.dumps({'files':inventory,'original_environment_entry_included':False,'source_commit':commit,'source_dirty':dirty},indent=2)+'\n')
 archive=out.with_suffix('.zip')
 with zipfile.ZipFile(archive,'x',zipfile.ZIP_DEFLATED) as z:
  for f in out.rglob('*'):
   if f.is_file():z.write(f,str(f.relative_to(out)))
 with zipfile.ZipFile(archive) as z:
  if z.testzip() is not None:raise ValueError('Kit CRC failed')
 receipt={'archive':str(archive),'bytes':archive.stat().st_size,'sha256':sha(archive),'files':len(inventory)+1,'source_commit':commit,'source_dirty':dirty,
  'package':str(folder),'task_counts':manifest['task_counts'],'gpu_jobs_each':len(evaluation['jobs']),'max_optimizer_steps':128,'root_cmds':['x.cmd']}
 return receipt

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--out',type=pathlib.Path,required=True);p.add_argument('--cold-controls',type=pathlib.Path);a=p.parse_args();print(json.dumps(build(a.out.resolve(),a.cold_controls),ensure_ascii=False,indent=2))
