"""Frozen v29 baseline/candidate BF16 generations. No grammar, targets or optimizer."""
import argparse
import datetime
import json
from pathlib import Path

from evaluate_gpu import generate_one, request_hash, sha256, write_json
from evaluate_matrix import pinned
from evaluate_semantic import encoded_request
from paraphrase_recovery import checked_baseline


def validate_plan(plan):
    if plan.get('protocol')!='BF16-fixed-paraphrase-v29' or plan.get('grammar_applied') is not False or plan.get('optimizer_inputs_approved') is not False:
        raise ValueError('Expected the frozen unconstrained v29 evaluation plan')
    cases={c['id']:c for c in plan['cases']};seen=set()
    if len(cases)!=len(plan['cases']) or any(c['split'] not in ['holdout','diagnostic'] for c in cases.values()):
        raise ValueError('Only separate holdout/diagnostic sources may be generated')
    for job in plan['jobs']:
        if job['key'] in seen or job['case_id'] not in cases or job['split']!=cases[job['case_id']]['split']:
            raise ValueError('Duplicate job or evaluation split mismatch')
        seen.add(job['key']);request=job['request']
        if job['mode'] not in ['legacy','compact','natural'] or request_hash(request)!=job['request_sha256']:
            raise ValueError('Evaluation request identity changed')
        if [m['role'] for m in request['messages']]!=['user'] or not 1<=request['max_tokens']<=768 or set(request)!={'messages','max_tokens'}:
            raise ValueError('Only the frozen source user message and output budget are inference inputs')
        if job['mode']!='natural' and not job.get('production_grammar'):
            raise ValueError('Missing downstream frame grammar')
        if job['mode']=='natural' and job['cohort']!='synthetic-v29-holdout':
            raise ValueError('Unexpected natural diagnostic expansion')
    if len(seen)!=plan['jobs_per_model'] or plan['maximum_generation_calls']!=3*len(seen):
        raise ValueError('Frozen generation count changed')


def main():
    p=argparse.ArgumentParser()
    for n in ['root','output','models','plan']:p.add_argument('--'+n,type=Path,required=True)
    p.add_argument('--phase',choices=['baseline','candidates'],required=True);p.add_argument('--check-only',action='store_true')
    p.add_argument('--baseline-recovery',type=Path);a=p.parse_args()
    root=a.root.resolve();out=a.output.resolve()
    if not out.is_relative_to(root) or out.exists():raise ValueError('Use a new output directory inside the project')
    plan=json.loads(a.plan.read_text(encoding='utf-8'));validate_plan(plan);identities=json.loads(a.models.read_text(encoding='utf-8'))
    labels=['v022'] if a.phase=='baseline' else ['legacy_v29','compact_v29']
    if set(identities['adapters'])!=set(['v022']+([] if a.phase=='baseline' else labels)):raise ValueError('Unexpected model identities')
    base=pinned(root,identities['base'],'model.safetensors');folders={label:pinned(root,identity,'adapter_model.safetensors') for label,identity in identities['adapters'].items()}
    import torch,transformers,peft
    from transformers import AutoModelForCausalLM,AutoTokenizer,GenerationConfig
    from peft import PeftModel
    tokenizer=AutoTokenizer.from_pretrained(base,local_files_only=True,trust_remote_code=False)
    if not tokenizer.is_fast or tokenizer.eos_token_id!=120020:raise ValueError('Original fast tokenizer/EOS required')
    encoded={j['key']:encoded_request(tokenizer,j['request']) for j in plan['jobs']}
    recovered=[];recovery=None
    if a.baseline_recovery:
        if a.phase!='baseline':raise ValueError('Recovery only applies to the formal baseline')
        recovered,recovery=checked_baseline(root,a.baseline_recovery,a.plan,plan,identities,encoded)
        print(json.dumps({'event':'verified_baseline_recovery',**recovery}),flush=True)
    print(json.dumps({'event':'paraphrase_evaluation_preflight','jobs_per_model':len(encoded),'models':labels,'model_weights_loaded':False}),flush=True)
    if a.check_only:return 0
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():raise RuntimeError('BF16 CUDA required; no model loaded')
    out.mkdir(parents=True,exist_ok=False);torch.manual_seed(42);torch.cuda.manual_seed_all(42)
    record={'protocol':plan['protocol'],'grammar_applied':False,'phase':a.phase,'plan_sha256':sha256(a.plan),'identities':identities,
        'created_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'planned_generations':len(encoded)*len(labels),'files':{},'automatic_selection':False,
        'versions':{'torch':torch.__version__,'transformers':transformers.__version__,'peft':peft.__version__},
        'gpu':{'name':torch.cuda.get_device_name(0),'total_memory_bytes':torch.cuda.get_device_properties(0).total_memory}}
    if recovery:
        if record['versions']!=recovery['previous_versions'] or record['gpu']!=recovery['previous_gpu']:
            raise ValueError('Baseline recovery GPU and library versions must match')
        record['recovery']=recovery
    record['new_generation_calls']=len(encoded)*len(labels)-len(recovered)
    write_json(out/'runs.json',record)
    model=AutoModelForCausalLM.from_pretrained(base,local_files_only=True,trust_remote_code=False,dtype=torch.bfloat16,attn_implementation='sdpa').to('cuda').eval()
    generation=GenerationConfig(do_sample=False,num_beams=1,use_cache=True,repetition_penalty=1.0,bos_token_id=tokenizer.bos_token_id,eos_token_id=tokenizer.eos_token_id,pad_token_id=tokenizer.pad_token_id)
    try:
        for i,label in enumerate(labels):
            if i==0:model=PeftModel.from_pretrained(model,folders[label],adapter_name=label,is_trainable=False).eval()
            else:model.load_adapter(folders[label],adapter_name=label,is_trainable=False)
            model.set_adapter(label);model.eval();model.requires_grad_(False)
            if list(model.active_adapters)!=[label] or any(t.requires_grad for t in model.parameters()):raise RuntimeError('Evaluation adapter activation/freezing failed')
            torch.cuda.reset_peak_memory_stats();result={'model':label,'identity':identities['adapters'][label],'grammar_applied':False,'training_executed':False,'generations':list(recovered)}
            for job in plan['jobs'][len(recovered):]:
                tokens,hashes=encoded[job['key']];result['generations'].append({'key':job['key'],'case_id':job['case_id'],'mode':job['mode'],'request_sha256':job['request_sha256'],
                    'max_tokens':job['request']['max_tokens'],**hashes,**generate_one(model,tokenizer,tokens,job['request']['max_tokens'],generation,'cuda')})
                write_json(out/(label+'.json'),result);print(json.dumps({'event':'paraphrase_generation','model':label,'key':job['key']}),flush=True)
            result.update(finished_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),cuda_peak_allocated_bytes=torch.cuda.max_memory_allocated(),cuda_peak_reserved_bytes=torch.cuda.max_memory_reserved())
            write_json(out/(label+'.json'),result);record['files'][label]={'file':label+'.json','sha256':sha256(out/(label+'.json'))};write_json(out/'runs.json',record)
        record['finished_utc']=datetime.datetime.now(datetime.timezone.utc).isoformat();write_json(out/'runs.json',record)
    finally:del model;torch.cuda.empty_cache()
    return 0


if __name__=='__main__':raise SystemExit(main())
