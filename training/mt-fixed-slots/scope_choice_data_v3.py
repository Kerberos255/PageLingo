"""Candidate count is crossed with availability; no evaluation output is imported."""
import hashlib,json,random
from scope_choice_data import choice_prompt,natural_prompt,u16
from scope_choice_data_v2 import build as build_templates,TERMS as OLD_TERMS,NUMBERS,AGENTS as OLD_AGENTS
from scope_choice_contract import validate_scope_rows,validate_count_balance

TERMS={'train':OLD_TERMS['train'],
 'validation':[('not retained','未保留','retained','已保留'),('not mounted','未挂载','mounted','已挂载')],
 'holdout':[('not verified','未验证','verified','已验证'),('not subscribed','未订阅','subscribed','已订阅')]}
FRAMES={
 'train':[('T30','The first badge displays ', '; the second badge displays ','.','第一个标记显示','；第二个标记显示','。'),
  ('T31','The top entry is labelled ', ' and the bottom entry is labelled ','.','顶部条目标为','，底部条目标为','。')],
 'validation':[('V30','The input label is ', '; the output label is ','.','输入标签为','；输出标签为','。'),
  ('V31','An opening notice says ', ', whereas the closing notice says ','.','开头的通知显示','，而结尾的通知显示','。')],
 'holdout':[('H30','The status card on the left reads ', '; the status card on the right reads ','.','左侧状态卡显示','；右侧状态卡显示','。'),
  ('H31','The primary indicator shows ', ' and the fallback indicator shows ','.','主指示器显示','，备用指示器显示','。')]}
AGENTS={'train':OLD_AGENTS['train'],
 'validation':([('sentinel task','哨兵任务'),('mediator task','中介任务')],[('transformer task','转换任务')]),
 'holdout':([('observer task','观察任务'),('supervisor task','监督任务')],[('serializer task','序列化任务')])}
QUANTITY={'train':('Schedule','attempts','安排','尝试'),'validation':('Authorize','transfers','授权','传输'),'holdout':('Permit','polls','允许','轮询')}

def training_causal(a,ca,b,cb):
 return [
  (f'The {a} continues when the {b} stops by raising a protocol error.',f'{cb}因抛出协议错误而停止时，{ca}继续运行。'),
  (f'After the {b} terminates by throwing a protocol error, the {a} becomes ready.',f'{cb}因抛出协议错误而终止后，{ca}就绪。'),
  (f'The {b} ends by raising a protocol error, so the {a} resumes; the error comes from the {b}.',f'{cb}因抛出协议错误而结束，因此{ca}恢复运行；该错误由{cb}抛出。'),
  (f'The {a} stops waiting if the {b} finishes because the {b} raises an error.',f'如果{cb}因抛出错误而结束，{ca}就停止等待。'),
  (f'The {a} raises an exception when the {b} finishes normally; the {b} does not raise it.',f'{cb}正常结束时，{ca}会抛出异常；{cb}不会抛出该异常。'),
  (f'The {a} does not itself throw an exception when the {b} fails; it returns after the {b} has failed.',f'{cb}失败时，{ca}本身不会抛出异常；它会在{cb}失败后返回。'),
  (f'The {a} resumes only after the {b} has terminated; a timeout alone does not prove termination.',f'只有在{cb}终止之后，{ca}才恢复运行；仅仅超时并不能证明已终止。'),
  (f'The {a} reports that the {b} failed; retries must not turn that failure into a success report.',f'{ca}报告{cb}失败；重试不能把这一失败变成成功报告。'),
  (f'The {a} returns when any {b} finishes by raising an exception.',f'任一{cb}因抛出异常而结束时，{ca}返回。'),
  (f'The {a} returns when any {b} finishes by raising a protocol error. If no {b} raises an error, it waits for all {b} instances.',f'任一{cb}因抛出协议错误而结束时，{ca}返回。如果没有{cb}抛出错误，它会等待所有{cb}实例。'),
  (f'The {a} raises an exception when any {b} returns normally. An error in the {b} does not itself mean that the {a} throws an exception.',f'任一{cb}正常返回时，{ca}会抛出异常。{cb}中出现错误本身并不意味着{ca}会抛出异常。'),
  (f'An exception is raised by the {b} as it finishes; this completion makes the {a} return without raising its own exception.',f'{cb}结束时会抛出异常；这一结束事件使{ca}返回，{ca}自身不抛出异常。')]
def validation_causal(a,ca,b,cb):
 return [
  (f'The {a} is notified of completion when the {b} raises an exception and exits.',f'{cb}抛出异常并退出时，{ca}收到完成通知。'),
  (f'Returning from the {a} follows an exception raised in the {b}; the {a} did not raise it.',f'{ca}在{cb}中抛出异常之后返回；该异常不是{ca}抛出的。'),
  (f'Without an error in the {b}, the {a} itself raises an exception under this test rule.',f'按照这条测试规则，{cb}未出错时，{ca}自身会抛出异常。'),
  (f'The {a} keeps the buffer alive while the {b} is unfinished, even if its deadline has passed.',f'即使截止时间已过，只要{cb}尚未完成，{ca}就会保留缓冲区。')]
def holdout_causal(a,ca,b,cb):
 return [
  (f'Only after the {b} has failed with an exception does the {a} complete its wait; the exception originates in the {b}.',f'只有在{cb}因异常失败之后，{ca}才结束等待；该异常来自{cb}。'),
  (f'The end of the {b} due to an exception is what allows the {a} to return, rather than requiring the {a} to raise an exception.',f'{cb}因异常结束，使{ca}得以返回，而不要求{ca}抛出异常。'),
  (f'This test requires the {a} to raise an exception on a successful return by the {b}, even though the {b} has not failed.',f'尽管{cb}没有失败，这项测试仍要求在{cb}成功返回时由{ca}抛出异常。'),
  (f'The {a} cannot discard storage merely because time elapsed: it still needs confirmation that the {b} completed.',f'{ca}不能仅因时间已过就丢弃存储空间：它仍需确认{cb}已经完成。')]

def count_choices(choices,gold,target,seed):
 """Both classes always contain the same whole-sentence distractor style."""
 whole=(0,len(target));gold=tuple(gold) if gold is not None else None
 if gold==whole:raise ValueError('A focused concept must not be the whole paragraph')
 bank=list(dict.fromkeys(tuple(c) for c in choices if tuple(c)!=gold and tuple(c)!=whole))
 random.Random(seed).shuffle(bank)
 required=3 if gold is None else 2
 if len(bank)<required:raise ValueError('Insufficient distinct incorrect candidates')
 return {n:([gold] if gold is not None else [])+[whole]+bank[:n-(2 if gold is not None else 1)] for n in [3,4]}
def cp_index(text,index):return len(text.encode('utf-16-le')[:2*index].decode('utf-16-le'))

def build():
 original=build_templates(terms=TERMS,frames=FRAMES,numbers=NUMBERS,agents=AGENTS,quantity_forms=QUANTITY,
  causal_overrides={'train':training_causal,'validation':validation_causal,'holdout':holdout_causal})
 result={s:[] for s in original};serial=0
 for split,rows in original.items():
  seen=set()
  for row in rows:
   if row['task']=='natural_replay':
    serial+=1;result[split].append({**row,'id':f'scope-v3-{serial:05d}','family':row['family'].replace('-v2','-v3')});continue
   pair=row['pair_id']
   if pair in seen:continue
   seen.add(pair);target=row['frozen_target'];gold=row['gold_candidate']
   choices=[(cp_index(target,c['start']),cp_index(target,c['end'])) for c in row['candidates']]
   gold_cp=None if gold is None else tuple(cp_index(target,i) for i in gold)
   options=count_choices(choices,gold_cp,target,20261108+serial)
   for count,values in options.items():
    permutation_seed=20261108+serial*19
    for permutation in [0,1]:
     prompt,order,displayed=choice_prompt(row['source_text'],row['source_focus'],target,values,permutation_seed,permutation)
     label='X' if gold_cp is None else 'ABCD'[order.index(values.index(gold_cp))]
     serial+=1;result[split].append({**row,'id':f'scope-v3-{serial:05d}','family':row['family'].replace('-v2','-v3'),
      'pair_id':pair+'-count-'+str(count),'counterfactual_group':pair,'candidate_count':count,
      'messages':[{'role':'user','content':prompt},{'role':'assistant','content':label}],
      'candidates':displayed,'gold_candidate':gold})
 validate_scope_rows(result);validate_count_balance(result);return result

def export(out):
 data=build();out.mkdir(parents=True,exist_ok=False)
 manifest={'protocol':'frozen-scope-choice-v1','corpus':'scope-choice-v3','review_status':'assistant_audited_synthetic','human_reviewed':False,
  'production_enabled':False,'checkpoint_selection':'final','base_initialization':'fresh_base','holdout_in_optimizer_inputs':False,
  'previous_holdout_in_optimizer_inputs':False,'original_web_evaluations_imported':False,'semantic_equivalence_automatically_proven':False,
  'candidate_count_balance_required':True,'whole_sentence_distractor_in_all_classes':True,'files':{},'task_counts':{}}
 for split,rows in data.items():
  raw=''.join(json.dumps(x,ensure_ascii=False,separators=(',',':'))+'\n' for x in rows).encode();(out/(split+'.jsonl')).write_bytes(raw)
  manifest['files'][split]={'file':split+'.jsonl','rows':len(rows),'sha256':hashlib.sha256(raw).hexdigest()}
  manifest['task_counts'][split]={task:sum(r['task']==task for r in rows) for task in ['scope_choice','natural_replay']}
 (out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n');return manifest
