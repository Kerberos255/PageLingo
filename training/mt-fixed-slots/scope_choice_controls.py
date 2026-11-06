"""Matched 3/4-option GPU diagnostics. Never supplies optimizer examples."""
import copy,hashlib,json,random
from scope_choice_data import INSTRUCTION
from scope_choice_data_v3 import cp_index,count_choices

def build_count_plan(previous):
 selected=[];seen=set()
 for job in previous['jobs']:
  if job['kind']=='scope_choice' and job['variant']=='selector-permutation:0':selected.append(job)
 for job in previous['jobs']:
  if job.get('evaluation_cohort')!='scope-choice-v2-new-holdout' or job.get('expected_id')!='X':continue
  fields=json.loads(job['request']['messages'][0]['content'].split('\n',1)[1]);key=json.dumps({k:fields[k] for k in ['english_before','english_focus','english_after','frozen_chinese']},sort_keys=True)
  if key in seen:continue
  seen.add(key);selected.append(job)
  if len(seen)==3:break
 if len(selected)!=12:raise ValueError('Expected nine frozen scope controls and three new missing-candidate cases')
 plan={'protocol':'scope-choice-evaluation-v1','evaluation_only':True,'optimizer_inputs_approved':False,
  'purpose':'Within-question response to adding/removing an incorrect candidate; labels, frozen target, focus and correct answer are held fixed within each pair. Diagnostic, not a new blind accuracy set.', 'jobs':[]}
 for index,job in enumerate(selected):
  original=json.loads(job['request']['messages'][0]['content'].split('\n',1)[1]);target=original['frozen_chinese'];gold=next((c for c in original['candidates'] if c['id']==job['expected_id']),None)
  choices=[tuple(cp_index(target,c[k]) for k in ['start','end']) for c in original['candidates']]
  gold_cp=None if gold is None else tuple(cp_index(target,gold[k]) for k in ['start','end'])
  values=count_choices(choices,gold_cp,target,20261109+index)[4]
  for permutation in [0,1]:
   order=list(range(4));random.Random(20261109+index*31).shuffle(order)
   if permutation:order=order[1:]+order[:1]
   candidates=[]
   for label,i in zip('ABCD',order):
    start,end=values[i];candidates.append({'id':label,'start':len(target[:start].encode('utf-16-le'))//2,'end':len(target[:end].encode('utf-16-le'))//2,
     'text':target[start:end],'left_context':target[max(0,start-16):start],'right_context':target[end:end+16]})
   expected='X' if gold is None else next(c['id'] for c in candidates if [c['start'],c['end']]==[gold['start'],gold['end']])
   # Always remove an incorrect candidate. Kept IDs and their order remain
   # identical in the matched 3/4-option pair, including the correct ID.
   removable=[c for c in reversed(candidates) if c['id']!=expected];drop=removable[permutation%len(removable)]['id']
   for count in [3,4]:
    fields=copy.deepcopy(original);fields['candidates']=[c for c in candidates if count==4 or c['id']!=drop]
    allowed=[c['id'] for c in fields['candidates']]+['X']
    request={'messages':[{'role':'user','content':INSTRUCTION+json.dumps(fields,ensure_ascii=False,separators=(',',':'))}],
     'grammar':'root ::= '+' | '.join(json.dumps(x) for x in allowed),'max_tokens':8}
    plan['jobs'].append({'case_id':'count-control-'+str(index),'variant':f'count-{count}-permutation-{permutation}',
     'kind':'scope_choice','request':request,'request_sha256':hashlib.sha256(json.dumps(request,ensure_ascii=False,separators=(',',':')).encode()).hexdigest(),
     'allowed_ids':allowed,'expected_id':expected,'evaluation_cohort':'candidate-count-control','candidate_count':count,
     'matched_group':f'{index}-{permutation}','source_job_sha256':job['request_sha256'],'source_case_id':job['case_id']})
 return plan
