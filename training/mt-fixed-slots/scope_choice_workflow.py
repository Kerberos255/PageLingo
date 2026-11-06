"""Reuse the stable x.cmd launcher; GPU train + BF16 evidence, all paths on project drive."""
import argparse,datetime,hashlib,json,os,subprocess,sys,time,zipfile
from pathlib import Path
from run_local import validate_package,CACHE_KEYS
from handoff_archive import verify_handoff

HERE=Path(__file__).resolve().parent
def sha(path):
 with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
def write(path,value):path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')

def main(config_name='config-scope-choice-v1.json'):
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--mode',choices=['check','run'],default='check');p.add_argument('--plan',action='store_true');args=p.parse_args()
 package=validate_package(HERE);config=json.loads((HERE/config_name).read_text());manifest=json.loads((HERE/'data/manifest.json').read_text())
 from scope_choice_contract import validate_scope_config
 from evaluate_scope_choice import validate_eval_plan
 validate_scope_config(config,manifest);evaluation=json.loads((HERE/'scope-evaluation-plan.json').read_text());validate_eval_plan(evaluation)
 root=args.root.resolve();prefix=manifest['corpus']
 if args.plan:
  print(json.dumps({'mode':args.mode,'source_commit':package['source_commit'],'base':'models/hy-mt2-1.8b','base_revision':config['base_revision'],
   'initialization':'fresh original base, no old adapter resumed','max_optimizer_steps':config['candidate_max_steps'],'data':manifest['task_counts'],
   'bf16_jobs_each':len(evaluation['jobs']),'gpu_scope':['training','BF16 comparison'],'cloud_scope':['LoRA conversion/quantization','CPU evaluation','Firefox'],
   'main_pc_browser_required':False,'dependencies_installed':False,'upload':False},indent=2));return 0
 if os.name=='nt' and (root.drive.lower()=='c:' or str(root).startswith('\\\\')):raise ValueError('Launch from the original local non-C project drive')
 for key in CACHE_KEYS:
  value=os.environ.get(key)
  if not value or not Path(value).resolve().is_relative_to(root):raise ValueError('Use the existing x.cmd environment; cache path must remain inside project: '+key)
 stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+os.urandom(3).hex()
 out=root/'outputs'/(prefix+('-check-' if args.mode=='check' else '-run-')+stamp);out.mkdir(parents=True,exist_ok=False)
 state={'source_commit':package['source_commit'],'check_only':args.mode=='check','training_completed':False,'gpu_comparison_completed':False,'workflow_completed':False,'stages':[]}
 save=lambda:write(out/'workflow-result.json',state)
 def run(name,command):
  started=time.perf_counter();log=out/(name+'.log');print('STAGE '+name,flush=True)
  with log.open('w',encoding='utf-8') as stream:result=subprocess.run([str(x) for x in command],cwd=root,stdout=stream,stderr=subprocess.STDOUT)
  state['stages'].append({'name':name,'exit_code':result.returncode,'wall_s':time.perf_counter()-started,'log':log.name});save()
  if result.returncode:raise RuntimeError(name+' failed; inspect '+str(log))
 try:
  save();base=root/'models/hy-mt2-1.8b'
  if not (base/config['base_weight_file']).is_file() or sha(base/config['base_weight_file'])!=config['base_weight_sha256']:raise ValueError('Pinned original BF16 base is missing or changed')
  import torch
  if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():raise ValueError('BF16 CUDA GPU required; no training started')
  run('preflight',[sys.executable,'-u',HERE/'train.py','--data',HERE/'data','--base',base,'--output',out/'preflight','--config',HERE/config_name,'--synthetic-candidate'])
  if args.mode=='check':state.update(workflow_completed=True,check_passed=True);save();print('GPU_PREFLIGHT_COMPLETE: no optimization or model conversion executed.');return 0
  common=[sys.executable,'-u',HERE/'evaluate_scope_choice.py','--base',base,'--plan',HERE/'scope-evaluation-plan.json']
  run('bf16-base',common+['--output',out/'bf16-base.json'])
  run('train-candidate',[sys.executable,'-u',HERE/'train.py','--data',HERE/'data','--base',base,'--project-root',root,'--output',out/'candidate',
   '--config',HERE/config_name,'--synthetic-candidate','--train'])
  trained=json.loads((out/'candidate/training-result.json').read_text())
  if not trained['training_executed'] or trained['optimizer_steps']!=config['candidate_max_steps'] or trained.get('base_weights_frozen') is not True:raise ValueError('Candidate training did not complete the bounded frozen-base run')
  state['training_completed']=True;save();adapter=out/'candidate/adapter'
  run('bf16-candidate',common+['--adapter',adapter,'--output',out/'bf16-candidate.json'])
  for name in ['bf16-base.json','bf16-candidate.json']:
   receipt=json.loads((out/name).read_text())
   if not receipt.get('finished_utc') or len(receipt['generations'])!=len(evaluation['jobs']):raise ValueError('GPU comparison incomplete')
  state['gpu_comparison_completed']=True;save()
  files={f.relative_to(out).as_posix():f for f in out.rglob('*') if f.is_file() and 'checkpoints' not in f.parts and f.name!='workflow-result.json'}
  files.update({'scope-evaluation-plan.json':HERE/'scope-evaluation-plan.json','data-manifest.json':HERE/'data/manifest.json','config.json':HERE/config_name,'package-manifest.json':HERE/'package-manifest.json'})
  inventory={name:{'bytes':f.stat().st_size,'sha256':sha(f)} for name,f in files.items()}
  bundle=out/'gpu-handoff.zip'
  with zipfile.ZipFile(bundle,'x',zipfile.ZIP_DEFLATED) as z:
   for name,f in files.items():z.write(f,name)
   z.writestr('MANIFEST.json',json.dumps({'files':inventory,'weights_kind':'LoRA adapter only','release_approved':False},indent=2)+'\n')
  state['handoff_validation']=verify_handoff(bundle)
  state.update(handoff=str(bundle),handoff_sha256=sha(bundle),workflow_completed=True,release_approved=False);save()
  print('GPU_COMPLETE: adapter and BF16 evidence ready. Cloud handles CPU and Firefox; no model was uploaded.',flush=True);return 0
 except Exception as error:state['error']=str(error);save();raise

if __name__=='__main__':raise SystemExit(main())
