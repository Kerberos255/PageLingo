"""GPU BF16 evidence only; no merge, quantization, Firefox or upload."""
import argparse,datetime,hashlib,json,time
from pathlib import Path

def validate_eval_plan(plan):
 if plan.get('protocol')!='scope-choice-evaluation-v1' or plan.get('evaluation_only') is not True or plan.get('optimizer_inputs_approved') is not False:raise ValueError('Expected evaluation-only scope plan')
 keys=set()
 for job in plan['jobs']:
  key=(job['case_id'],job['variant'])
  if key in keys:raise ValueError('Repeated evaluation job')
  keys.add(key);request=job['request']
  if [m['role'] for m in request['messages']]!=['user'] or not 1<=request['max_tokens']<=192:raise ValueError('Unexpected evaluation request')
  if hashlib.sha256(json.dumps(request,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()!=job['request_sha256']:raise ValueError('Evaluation request changed')
  if job['kind'] not in ['scope_choice','natural_replay']:raise ValueError('Unexpected evaluation task')
  if job['kind']=='scope_choice' and (set(job['allowed_ids'])-set('ABCDX') or 'X' not in job['allowed_ids'] or len(job['allowed_ids'])!=len(set(job['allowed_ids'])) or job.get('expected_id') not in job['allowed_ids']):raise ValueError('Invalid closed choices')
 return True

def main():
 p=argparse.ArgumentParser();p.add_argument('--base',type=Path,required=True);p.add_argument('--adapter',type=Path);p.add_argument('--plan',type=Path,required=True);p.add_argument('--output',type=Path,required=True);args=p.parse_args()
 plan=json.loads(args.plan.read_text());validate_eval_plan(plan)
 if args.output.exists():raise ValueError('Preserve previous evaluation output')
 import torch
 from transformers import AutoModelForCausalLM,AutoTokenizer
 if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():raise ValueError('This comparison requires a BF16 CUDA GPU')
 torch.manual_seed(42);tokenizer=AutoTokenizer.from_pretrained(args.base,local_files_only=True,trust_remote_code=False)
 model=AutoModelForCausalLM.from_pretrained(args.base,local_files_only=True,trust_remote_code=False,dtype=torch.bfloat16,attn_implementation='sdpa').to('cuda:0')
 if args.adapter:
  from peft import PeftModel
  model=PeftModel.from_pretrained(model,args.adapter,local_files_only=True,is_trainable=False)
 model.eval();model.config.use_cache=True;torch.cuda.reset_peak_memory_stats()
 result={'protocol':plan['protocol'],'plan_sha256':hashlib.sha256(args.plan.read_bytes()).hexdigest(),'started_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
  'base':str(args.base),'adapter':str(args.adapter) if args.adapter else None,'precision':'BF16','device':torch.cuda.get_device_name(0),'generations':[],
  'closed_choice_schema_compliance_is_forced_not_accuracy':True,'optimizer_inputs_approved':False}
 for job in plan['jobs']:
  prompt=tokenizer.apply_chat_template(job['request']['messages'],tokenize=False,add_generation_prompt=True)
  encoded=tokenizer(prompt,add_special_tokens=False,return_tensors='pt').to('cuda:0');length=encoded['input_ids'].shape[1]
  if length+job['request']['max_tokens']>3072:raise ValueError('Refusing evaluation truncation')
  options={'do_sample':False,'eos_token_id':tokenizer.eos_token_id,'pad_token_id':tokenizer.pad_token_id,'max_new_tokens':job['request']['max_tokens']}
  if job['kind']=='scope_choice':
   allowed=[tokenizer.encode(label,add_special_tokens=False) for label in job['allowed_ids']]
   if any(len(ids)!=1 for ids in allowed):raise ValueError('Choice IDs must each be one base token')
   ids=[x[0] for x in allowed]
   options.update(max_new_tokens=2,prefix_allowed_tokens_fn=lambda batch_id,sentence:ids if len(sentence)==length else [tokenizer.eos_token_id])
  torch.cuda.synchronize();began=time.perf_counter()
  with torch.inference_mode():output=model.generate(**encoded,**options)[0,length:]
  torch.cuda.synchronize();generated=output.detach().cpu().tolist();text=tokenizer.decode(generated,skip_special_tokens=True)
  result['generations'].append({'case_id':job['case_id'],'variant':job['variant'],'kind':job['kind'],'request_sha256':job['request_sha256'],
   'text':text,'token_ids':generated,'finish_reason':'stop' if generated and generated[-1]==tokenizer.eos_token_id else 'length','wall_s':time.perf_counter()-began,
   'correct_id':text.strip()==job.get('expected_id') if job['kind']=='scope_choice' else None})
  args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'case':job['case_id'],'variant':job['variant'],'finished':len(result['generations'])}),flush=True)
 result.update(finished_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),cuda_peak_allocated_bytes=torch.cuda.max_memory_allocated(),cuda_peak_reserved_bytes=torch.cuda.max_memory_reserved())
 result['scope_accuracy']={'correct':sum(x['correct_id'] is True for x in result['generations']),'total':sum(x['kind']=='scope_choice' for x in result['generations'])}
 args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')

if __name__=='__main__':main()
