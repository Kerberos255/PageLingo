"""Single-entry v29 GPU handoff: baseline, two paired final32 pilots, BF16 evidence."""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import traceback
import uuid
import zipfile

from curriculum_workflow import validate_package
from evaluate_gpu import sha256,write_json
from evaluate_matrix import pinned
from evaluate_paraphrase import validate_plan
from handoff_archive import verify_handoff
from paraphrase_contract import validate_config,validate_splits,completed_paraphrase_candidate
from private_exclusions import validate_exclusion_plan,check_private_exclusions

HERE=Path(__file__).resolve().parent


def verify_pair(here):
    records={};configs={}
    for variant in ['legacy','compact']:
        folder=here/'data'/variant;manifest=json.loads((folder/'manifest.json').read_text(encoding='utf-8'))
        config=json.loads((here/('config-paraphrase-'+variant+'-v29.json')).read_text(encoding='utf-8'));validate_config(config,manifest)
        splits={}
        for split in ['train','validation']:
            record=manifest['files'][split];file=folder/record['file']
            if file.parent!=folder or sha256(file)!=record['sha256']:raise ValueError('Paraphrase split path/hash changed')
            splits[split]=[json.loads(s) for s in file.read_text(encoding='utf-8').splitlines() if s.strip()]
        validate_splits(splits,manifest);records[variant]=splits;configs[variant]=config
    left={k:v for k,v in configs['legacy'].items() if k!='paraphrase_prompt_variant'}
    if left!={k:v for k,v in configs['compact'].items() if k!='paraphrase_prompt_variant'}:raise ValueError('Paired optimizer/initialization configuration changed')
    for split in ['train','validation']:
        project=lambda row:(row['pair_id'],row['family'],row['task'],row['source_html'],row['semantic_facts'],row['messages'][1])
        a=records['legacy'][split];b=records['compact'][split]
        if list(map(project,a))!=list(map(project,b)):raise ValueError('Paired source order or targets changed')
        for x,y in zip(a,b):
            same=x['messages'][0]==y['messages'][0]
            if same!=(x['task']=='natural'):raise ValueError('Only fixed prompts may differ; natural replay must match')
    audit=json.loads((here/'private-exclusion-plan.json').read_text(encoding='utf-8'))
    validate_exclusion_plan(here,audit)
    return configs,audit


def evidence(out,here,package,plan):
    files={}
    for rel in ['baseline/runs.json','baseline/v022.json','comparison/runs.json','comparison/legacy_v29.json','comparison/compact_v29.json',
                'baseline-models.json','model-identities.json','workflow-evidence.json','private-exclusion-result.json']:
        files[rel]=out/rel
    for variant in ['legacy','compact']:
        for name in ['training-result.json','initialization.json']:
            files['training/'+variant+'/'+name]=out/(variant+'_v29')/name
    for file in out.glob('*.log'):files['logs/'+file.name]=file
    for name in ['package-manifest.json','evaluation-plan.json','preregister.json','private-exclusion-plan.json','candidate-source-fingerprints.json','config-paraphrase-legacy-v29.json','config-paraphrase-compact-v29.json']:
        files['kit/'+name]=here/name
    for name in ['manifest.json','template-review.md','evaluation-cases.json']:
        files['data/'+name]=here/'data'/name
    for stage,labels in [('baseline',['v022']),('comparison',['legacy_v29','compact_v29'])]:
        runs=json.loads((out/stage/'runs.json').read_text(encoding='utf-8'))
        if not runs.get('finished_utc') or runs['plan_sha256']!=sha256(here/'evaluation-plan.json') or set(runs['files'])!=set(labels):raise ValueError('Incomplete BF16 evidence stage')
        for label in labels:
            row=json.loads((out/stage/(label+'.json')).read_text(encoding='utf-8'))
            if not row.get('finished_utc') or len(row['generations'])!=len(plan['jobs']) or sha256(out/stage/(label+'.json'))!=runs['files'][label]['sha256']:
                raise ValueError('Incomplete BF16 generation evidence')
            if row.get('model')!=label or any(g.get('key')!=j['key'] or g.get('request_sha256')!=j['request_sha256'] for g,j in zip(row['generations'],plan['jobs'])):
                raise ValueError('BF16 generation source/request binding changed')
    manifest={'schema_version':1,'source_commit':package['source_commit'],'release_approved':False,'model_weights_included':False,
        'files':{name:{'bytes':f.stat().st_size,'sha256':sha256(f)} for name,f in files.items()}}
    target=out/'gpu-handoff.zip'
    with zipfile.ZipFile(target,'x',zipfile.ZIP_DEFLATED) as z:
        for name,file in files.items():z.write(file,name)
        z.writestr('MANIFEST.json',json.dumps(manifest,indent=2)+'\n')
    return {'file':str(target),'sha256':sha256(target),'validation':verify_handoff(target)}


def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--mode',choices=['check','run'],default='run');p.add_argument('--plan',action='store_true');a=p.parse_args()
    root=a.root.resolve()
    if not HERE.is_relative_to(root):raise ValueError('Kit must stay inside the project')
    package=validate_package(HERE);configs,audit=verify_pair(HERE);plan=json.loads((HERE/'evaluation-plan.json').read_text(encoding='utf-8'));validate_plan(plan)
    if a.plan:
        print(json.dumps({'protocol':plan['protocol'],'candidates':['legacy_v29','compact_v29'],'steps_each':32,'total_optimizer_steps':64,'max_generation_calls':plan['maximum_generation_calls'],
            'gpu_only':True,'private_source_check':'mandatory on GPU host before model loading','model_weights_loaded':False,'training_executed':False,'release_approved':False}),flush=True);return 0
    if os.name=='nt':
        if root.drive.lower()=='c:' or str(root).startswith('\\\\'):raise ValueError('Start x.cmd on the GPU PC using its local non-C project drive')
        for key in ['TEMP','TMP','HF_HOME','HF_HUB_CACHE','TORCH_HOME','PIP_CACHE_DIR','TRITON_CACHE_DIR','CUDA_CACHE_PATH']:
            if key not in os.environ or not Path(os.environ[key]).resolve().is_relative_to(root):raise ValueError('Task cache escapes project: '+key)
    if shutil.disk_usage(root).free<2*2**30:raise RuntimeError('At least 2 GiB free output space required')
    outputs=root/'outputs';outputs.mkdir(exist_ok=True);stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:6]
    out=outputs/('paraphrase-v29-'+('check-' if a.mode=='check' else 'run-')+stamp);out.mkdir()
    status={'source_commit':package['source_commit'],'check_only':a.mode=='check','training_completed':False,'gpu_comparison_completed':False,'workflow_completed':False,'release_approved':False,'upload_executed':False,'stages':[]}
    write_json(out/'workflow-result.json',status)
    def run(name,command):
        command=list(map(str,command));start=time.perf_counter()
        with (out/(name+'.log')).open('w',encoding='utf-8') as log:
            print('STAGE: '+name,flush=True)
            with subprocess.Popen(command,cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,encoding='utf-8',errors='replace',bufsize=1) as proc:
                for line in proc.stdout:log.write(line);log.flush();print(line,end='',flush=True)
                code=proc.wait()
        status['stages'].append({'name':name,'exit_code':code,'wall_s':time.perf_counter()-start,'log':name+'.log'});write_json(out/'workflow-result.json',status)
        if code:raise RuntimeError('Stage failed: '+name+'; inspect '+str(out/(name+'.log')))
    try:
        check_private_exclusions(root,HERE,out,audit)
        status['source_exclusion_completed']=True;write_json(out/'workflow-result.json',status)
        config=configs['legacy'];base=pinned(root,{'directory':'models/hy-mt2-1.8b','sha256':config['base_weight_sha256']},'model.safetensors')
        formal={'directory':config['initial_adapter_directory'],'sha256':config['initial_adapter_sha256'],'config_sha256':config['initial_adapter_config_sha256']};pinned(root,formal,'adapter_model.safetensors')
        models={'base':{'directory':'models/hy-mt2-1.8b','sha256':config['base_weight_sha256']},'adapters':{'v022':formal}}
        write_json(out/'baseline-models.json',models)
        for variant in ['legacy','compact']:
            run('preflight-'+variant,[sys.executable,'-u',HERE/'train.py','--data',HERE/'data'/variant,'--base',base,'--output',out/('preflight-'+variant),'--config',HERE/('config-paraphrase-'+variant+'-v29.json'),'--project-root',root,'--synthetic-candidate'])
        eval_args=['--root',root,'--plan',HERE/'evaluation-plan.json']
        run('preflight-evaluation',[sys.executable,'-u',HERE/'evaluate_paraphrase.py',*eval_args,'--models',out/'baseline-models.json','--output',out/'evaluation-check','--phase','baseline','--check-only'])
        if a.mode=='check':status['preflight_completed']=True;write_json(out/'workflow-result.json',status);return 0
        run('baseline-bf16',[sys.executable,'-u',HERE/'evaluate_paraphrase.py',*eval_args,'--models',out/'baseline-models.json','--output',out/'baseline','--phase','baseline'])
        initial=None
        for variant in ['legacy','compact']:
            label=variant+'_v29';folder=out/label;data=HERE/'data'/variant;config_file=HERE/('config-paraphrase-'+variant+'-v29.json')
            command=[sys.executable,'-u',HERE/'train.py','--data',data,'--base',base,'--output',folder,'--config',config_file,'--project-root',root,'--synthetic-candidate','--train']
            if initial:command+=['--expected-initial-sha256',initial]
            run('train-'+variant,command);identity=completed_paraphrase_candidate(folder,config_file,data,initial)
            actual=json.loads((folder/'training-result.json').read_text(encoding='utf-8'))['initial_trainable_sha256']
            if initial is None:initial=actual
            elif initial!=actual:raise ValueError('Paired initial trainable tensors differ')
            identity['directory']=str(identity['directory'].relative_to(root));models['adapters'][label]=identity
            write_json(out/'model-identities.json',models)
        status.update(training_completed=True,paired_initial_trainable_sha256=initial);write_json(out/'workflow-result.json',status)
        run('candidate-bf16',[sys.executable,'-u',HERE/'evaluate_paraphrase.py',*eval_args,'--models',out/'model-identities.json','--output',out/'comparison','--phase','candidates'])
        pinned(root,formal,'adapter_model.safetensors');status.update(gpu_comparison_completed=True,finished_utc=datetime.datetime.now(datetime.timezone.utc).isoformat())
        write_json(out/'workflow-evidence.json',status);handoff=evidence(out,HERE,package,plan)
        status.update(workflow_completed=True,handoff=handoff['file'],handoff_sha256=handoff['sha256'],handoff_validation=handoff['validation']);write_json(out/'workflow-result.json',status)
        print('COMPLETE: v29 GPU evidence ready for Cloud review; no model selected or uploaded.',flush=True);return 0
    except Exception as error:
        status.update(error_type=type(error).__name__,error=str(error));write_json(out/'workflow-result.json',status);traceback.print_exc();raise


if __name__=='__main__':raise SystemExit(main())
