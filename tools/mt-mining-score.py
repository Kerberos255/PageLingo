"""Cloud CPU BF16 likelihood audit of manually reviewed, training-only errors.

Does not optimize, convert, upload, or replace any model. Q5 mining and BF16
teacher-forced canonical text likelihood are different measurements.
"""
import argparse
import datetime
import hashlib
import json
import math
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'training/mt-fixed-slots'))
from evaluate_gpu import sha256, write_json
from validation_metrics import target_kinds, target_losses, loss_summary


def audited_errors(plan, replay, audit, *, plan_sha256, replay_sha256):
    if plan.get('protocol') != 'fixed-training-error-mining-v1' or replay.get('partial') is not False:
        raise ValueError('Completed training-source mining required')
    if replay.get('plan_sha256') != plan_sha256 or audit.get('plan_sha256') != plan_sha256 or audit.get('replay_sha256') != replay_sha256:
        raise ValueError('Audit input identity changed')
    if audit.get('schema_version') != 1 or audit.get('run_sha256') != replay['run_sha256']:
        raise ValueError('Actual generation identity changed')
    samples = {row['id']: row for row in plan['cases']}
    rendered = {row['id']: row for row in replay['rows']}
    records = {row['id']: row for row in audit['rows']}
    if len(records) != len(audit['rows']) or set(samples) != set(rendered) or set(records) != set(samples):
        raise ValueError('Every mined source needs one explicit audit decision')
    selected = []
    for identity, record in records.items():
        source, row = samples[identity], rendered[identity]
        if source.get('split') != 'train' or row.get('split') != 'train' or record.get('actual_output_sha256') != row['actual_output_sha256']:
            raise ValueError('Reserved source or changed generated text')
        if hashlib.sha256(row['actual_output'].encode()).hexdigest() != row['actual_output_sha256']:
            raise ValueError('Generated text digest mismatch')
        verdict = record.get('verdict')
        if verdict not in ['semantic_error','scope_error','acceptable_alternative','uncertain','structural_rejection']:
            raise ValueError('Unreviewed or unknown semantic verdict')
        if verdict in ['semantic_error','scope_error']:
            if not row['replay']['displayed'] or row['generation']['finish_reason'] != 'stop':
                raise ValueError('A preferred error must first be a complete accepted frame')
            if not record.get('reason') or not record.get('source_fact') or record.get('chosen_reference_confirmed') is not True:
                raise ValueError('A differing string alone is not an audited semantic negative')
            if row['actual_output'] == source['reference_wire']:
                raise ValueError('Positive and actual negative are identical')
            selected.append((source, row, record))
    if not selected: raise ValueError('No reviewed factual or scope errors to score')
    return selected


def likelihood_metrics(loss):
    total = sum(loss[k]['sum_nll'] for k in ['content','marker','eos'])
    count = sum(loss[k]['tokens'] for k in ['content','marker','eos'])
    if not loss['content']['tokens'] or not count or not math.isfinite(total): raise ValueError('Missing finite content likelihood')
    return {'sequence_logp':-total,'target_tokens':count,
        'content_mean_logp':-loss['content']['sum_nll']/loss['content']['tokens'], 'components':loss}


def is_hard_pair(chosen, actual, minimum_sequence_margin=1.0, minimum_content_mean_margin=.01):
    seq = actual['sequence_logp']-chosen['sequence_logp']
    content = actual['content_mean_logp']-chosen['content_mean_logp']
    if not math.isfinite(seq) or not math.isfinite(content): raise ValueError('Nonfinite preference margin')
    # Both conditions matter: a shorter rejected sequence alone is insufficient.
    return {'hard_negative_candidate':seq >= minimum_sequence_margin and content >= minimum_content_mean_margin,
        'actual_minus_chosen_sequence_logp':seq,'actual_minus_chosen_content_mean_logp':content}


def main():
    parser=argparse.ArgumentParser()
    for name in ['plan','replay','audit','base','adapter','output']: parser.add_argument('--'+name,type=Path,required=True)
    args=parser.parse_args()
    if args.output.exists(): raise ValueError('Use a new output directory; preserve measurements')
    plan=json.loads(args.plan.read_text());replay=json.loads(args.replay.read_text());audit=json.loads(args.audit.read_text())
    selected=audited_errors(plan,replay,audit,plan_sha256=sha256(args.plan),replay_sha256=sha256(args.replay))
    config=json.loads((ROOT/'training/mt-fixed-slots/config-preference-v6.json').read_text())
    for file,wanted in [(args.base/'model.safetensors',config['base_weight_sha256']),
            (args.adapter/'adapter_model.safetensors',config['initial_adapter_sha256']),
            (args.adapter/'adapter_config.json',config['initial_adapter_config_sha256'])]:
        if sha256(file)!=wanted: raise ValueError('Pinned original BF16/old-r16 identity changed: '+file.name)
    import torch
    import transformers
    import peft
    from transformers import AutoTokenizer,AutoModelForCausalLM
    from peft import PeftModel
    torch.set_num_threads(2);torch.manual_seed(42)
    tokenizer=AutoTokenizer.from_pretrained(args.base,local_files_only=True,trust_remote_code=False)
    if tokenizer.eos_token_id!=120020 or not tokenizer.is_fast: raise ValueError('Original fast tokenizer/EOS required')
    jobs={job['case_id']:job for job in plan['jobs']};encoded=[]
    for source,row,record in selected:
        prompt=tokenizer.apply_chat_template(jobs[source['id']]['request']['messages'],tokenize=False,add_generation_prompt=True)
        ids=tokenizer(prompt,add_special_tokens=False)['input_ids']
        if hashlib.sha256(prompt.encode()).hexdigest()!=row['generation']['actual_prompt_sha256'] or hashlib.sha256(json.dumps(ids,separators=(',',':')).encode()).hexdigest()!=row['generation']['input_token_ids_sha256']:
            raise ValueError('Native/GGUF and original BF16 prompt tokenization differ')
        alternatives=[]
        for text in [source['reference_wire'],row['actual_output']]:
            tokens=tokenizer(text,add_special_tokens=False,return_offsets_mapping=True)
            target=tokens['input_ids']+[tokenizer.eos_token_id]
            if len(ids)+len(target)>3072: raise ValueError('Refusing to truncate a likelihood target')
            alternatives.append((target,target_kinds(text,tokens['offset_mapping'])))
        encoded.append((source,row,record,ids,alternatives))
    args.output.mkdir(parents=True)
    result={'schema_version':1,'started_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'purpose':'CPU original-BF16/old-r16 likelihood of actual Q5-mined errors; not a heldout quality score or training.',
        'device':'cpu','dtype':'bfloat16','autocast':False,'grammar_applied_to_likelihood':False,
        'model_identities':{'base_sha256':config['base_weight_sha256'],'adapter_sha256':config['initial_adapter_sha256'],
                            'adapter_config_sha256':config['initial_adapter_config_sha256']},
        'inputs_sha256':{key:sha256(getattr(args,key)) for key in ['plan','replay','audit']},
        'scoring_source_hashes':{str(file.relative_to(ROOT)):sha256(file) for file in [Path(__file__), ROOT/'training/mt-fixed-slots/validation_metrics.py',
            ROOT/'training/mt-fixed-slots/config-preference-v6.json']},
        'versions':{'torch':torch.__version__,'transformers':transformers.__version__,'peft':peft.__version__},
        'thresholds':{'minimum_sequence_margin_nats':1.0,'minimum_content_mean_margin_nats_per_token':.01},
        'independently_human_reviewed':audit.get('independently_human_reviewed') is True,
        'training_executed':False,'optimizer_inputs_approved':False,'rows':[]}
    write_json(args.output/'result.json',result)
    started=time.perf_counter()
    model=AutoModelForCausalLM.from_pretrained(args.base,local_files_only=True,trust_remote_code=False,dtype=torch.bfloat16,
        attn_implementation='sdpa',low_cpu_mem_usage=True)
    model=PeftModel.from_pretrained(model,args.adapter,local_files_only=True,is_trainable=False).to('cpu').eval()
    model.requires_grad_(False);model.config.use_cache=False
    assert not any(p.requires_grad for p in model.parameters())
    result['model_load_wall_s']=time.perf_counter()-started
    for index,(source,row,record,ids,alternatives) in enumerate(encoded):
        started=time.perf_counter();scores=[]
        with torch.inference_mode():
            for target,kinds in alternatives:
                inputs=torch.tensor([ids+target],dtype=torch.long)
                outputs=model(input_ids=inputs,attention_mask=torch.ones_like(inputs),use_cache=False)
                losses=target_losses(outputs.logits,len(ids),target).cpu().tolist()
                scores.append(likelihood_metrics(loss_summary(losses,kinds)))
                del outputs,inputs
        result['rows'].append({'id':source['id'],'family':source['family'],'split':'train','audit':record,
            'chosen':scores[0],'actual_wrong':scores[1],**is_hard_pair(*scores),'score_wall_s':time.perf_counter()-started})
        result['proc_status']=[line for line in Path('/proc/self/status').read_text().splitlines() if line.startswith(('VmHWM:','VmRSS:'))]
        write_json(args.output/'result.json',result)
        print(json.dumps({'scored':index+1,'of':len(encoded),'id':source['id'],**is_hard_pair(*scores)}),flush=True)
    result['finished_utc']=datetime.datetime.now(datetime.timezone.utc).isoformat();write_json(args.output/'result.json',result)
    return 0


if __name__=='__main__':raise SystemExit(main())
