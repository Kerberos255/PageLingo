"""Fresh hard scope contrasts and causal roles. Never imports evaluation outputs."""
import hashlib,json
from pathlib import Path
from scope_choice_data import choice_prompt,natural_prompt
from scope_choice_contract import validate_scope_rows

TERMS={
 'train':[('unpairing','取消配对','pairing','配对'),('unsealing','解除密封','sealing','密封'),
  ('not mandatory','并非强制','mandatory','强制'),('not permitted','不被允许','permitted','被允许'),
  ('not available','不可用','available','可用'),('not enabled','未启用','enabled','已启用'),
  ('no longer valid','不再有效','still valid','仍然有效'),('unmuting','取消静音','muting','静音')],
 'validation':[('not writable','不可写','writable','可写'),('not connected','未连接','connected','已连接')],
 'holdout':[('not synchronized','未同步','synchronized','已同步'),('not initialized','未初始化','initialized','已初始化')]}
FRAMES={
 'train':[('T20','The left label says ', ', while the right label says ','.','左侧标签为','，而右侧标签为','。'),
  ('T21','The header displays ', '; the footer displays ','.','页眉显示','；页脚显示','。'),
  ('T22','In the list, ', ' is the first entry and ', ' is the last entry.','列表中的第一项为','，最后一项为','。'),
  ('T23','For the source field use ', '; for the destination field use ','.','源字段使用','；目标字段使用','。')],
 'validation':[('V20','One pane shows ', '; the next pane shows ','.','一个窗格显示','；下一个窗格显示','。'),
  ('V21','The caption begins with ', ' and concludes with ','.','说明文字以','开头，以','结束。')],
 'holdout':[('H20','The upper log row is marked ', '; the lower log row is marked ','.','上方日志行标为','；下方日志行标为','。'),
  ('H21','The inspector reads ', ' on the primary badge and ', ' on the secondary badge.','检查器在主标记上读到','，在次标记上读到','。')]}
NUMBERS={'train':[('three','三'),('four','四'),('five','五'),('six','六'),('seven','七'),('eight','八')],
 'validation':[('nine','九'),('ten','十')],'holdout':[('eleven','十一'),('twelve','十二')]}
AGENTS={'train':([('arbiter','仲裁器'),('controller','控制器'),('supervisor','监督器'),('manager','管理器')],
                 [('decoder','解码器'),('receiver','接收器'),('reader','读取器'),('poller','轮询器')]),
 'validation':([('router','路由器'),('notifier','通知器')],[('encoder','编码器')]),
 'holdout':([('auditor','审计器'),('dispatcher','分派器')],[('scanner','扫描器')])}

def build():
 result={s:[] for s in TERMS};serial=0
 def add(split,family,prompt,target,task,**metadata):
  nonlocal serial
  serial+=1;result[split].append({'id':f'scope-v2-{serial:05d}','split':split,'family':family,'task':task,
   'review_status':'assistant_audited_synthetic','messages':[{'role':'user','content':prompt},{'role':'assistant','content':target}],**metadata})
 def select(split,family,pair,source,focus,target,choices,gold,category):
  seed=20261107+serial*19
  for permutation in [0,1]:
   prompt,order,displayed=choice_prompt(source,focus,target,choices,seed,permutation)
   answer='X' if gold is None else 'ABCD'[order.index(gold)]
   add(split,family,prompt,answer,'scope_choice',pair_id=pair,source_text=source,source_focus=list(focus),frozen_target=target,
    candidates=displayed,gold_candidate=None if gold is None else list(choices[gold]),category=category,
    optimizer_inputs_approved=split in ['train','validation'])
 def replay(split,family,source,target,kind):
  add(split,family,natural_prompt(source),target,'natural_replay',source_text=source,reference_kind=kind)
 for split,pairs in TERMS.items():
  for term,(ea,za,eb,zb) in enumerate(pairs):
   for family,before,middle,after,cbefore,cmiddle,cafter in FRAMES[split]:
    for repeated in [False,True]:
     b,zhb=(ea,za) if repeated else (eb,zb)
     source=before+ea+middle+b+after;target=cbefore+za+cmiddle+zhb+cafter
     left=len(cbefore);right=left+len(za)+len(cmiddle)
     # Partial positive-looking suffixes are intentionally valid words, not
     # only single syllables: e.g. 并非强制 / 强制, 未启用 / 启用.
     choices=[(left,left+len(za)),(right,right+len(zhb)),(left,right+len(zhb)),(left+max(1,len(za)-2),left+len(za))]
     for which in [0,1]:
      start=len(before) if which==0 else len(before)+len(ea)+len(middle)
      focus=(start,start+len(ea if which==0 else b));stem=f'{split}-{term}-{family}-{repeated}-{which}'
      kind='repeated_position' if repeated else 'full_polarity'
      select(split,family+'-choice',stem+'-present',source,focus,target,choices,which,kind)
      # Same source/focus/target, now remove its complete correct occurrence.
      # The other occurrence, positive fragment and over-captured clause remain.
      missing=[c for i,c in enumerate(choices) if i!=which]
      select(split,family+'-choice',stem+'-missing',source,focus,target,missing,None,kind+'_missing')
     replay(split,family+'-replay',source,target,'assistant_audited_label_contrast')
  for ni,(number,zh) in enumerate(NUMBERS[split]):
   for relation,cn in [('no more than','不超过'),('no fewer than','不少于')]:
    focus=relation+' '+number
    for contiguous in [False,True]:
     # All words and number are identical; the target grammar determines whether
     # the English focus has a complete contiguous counterpart without a verb.
     english_verb,english_noun,verb,noun={'train':('Schedule','attempts','安排','尝试'),'validation':('Allow','checks','允许','检查'),'holdout':('Plan','retries','规划','重试')}[split]
     before=english_verb+' ';source=before+focus+' '+english_noun+'.'
     if contiguous:
      target=verb+'的'+noun+'次数'+cn+zh+'次。';a=target.index(cn);z=a+len(cn+zh+'次');gold=0;lead=cn
     else:
      lead='最多' if relation=='no more than' else '至少'
      target=lead+verb+zh+'次'+noun+'。';a=0;z=target.index(zh)+len(zh+'次');gold=None
     number_start=target.index(zh);choices=[(a,z),(a,a+len(lead)),(number_start,number_start+len(zh+'次'))]
     family=split+'-quantity-v2';pair=f'{split}-quantity-{ni}-{relation}-{contiguous}'
     select(split,family,pair,source,(len(before),len(before)+len(focus)),target,choices,gold,'quantity_contiguous' if contiguous else 'quantity_missing')
     # Rehearse one faithful realization per source, avoiding duplicate prompts.
     if contiguous:replay(split,split+'-quantity-replay-v2',source,target,'assistant_audited_quantity')
  first,second=AGENTS[split]
  for ai,(a,ca) in enumerate(first):
   for bi,(b,cb) in enumerate(second):
    cases=[
     (f'The {a} continues when the {b} stops by raising a protocol error.',f'{cb}因抛出协议错误而停止时，{ca}继续运行。'),
     (f'After the {b} terminates by throwing a protocol error, the {a} becomes ready.',f'{cb}因抛出协议错误而终止后，{ca}就绪。'),
     (f'The {b} ends by raising a protocol error, so the {a} resumes; the error comes from the {b}.',f'{cb}因抛出协议错误而结束，因此{ca}恢复运行；该错误由{cb}抛出。'),
     (f'The {a} stops waiting if the {b} finishes because the {b} raises an error.',f'如果{cb}因抛出错误而结束，{ca}就停止等待。'),
     (f'The {a} raises an exception when the {b} finishes normally; the {b} does not raise it.',f'{cb}正常结束时，{ca}会抛出异常；{cb}不会抛出该异常。'),
     (f'The {a} does not itself throw when the {b} fails; it returns after the {b} has failed.',f'{cb}失败时，{ca}本身不会抛出异常；它会在{cb}失败后返回。'),
     (f'The {a} resumes only after the {b} has terminated; a timeout alone does not prove termination.',f'只有在{cb}终止之后，{ca}才恢复运行；仅仅超时并不能证明已终止。'),
     (f'The {a} reports that the {b} failed; retries must not turn that failure into a success report.',f'{ca}报告{cb}失败；重试不能把这一失败变成成功报告。')]
    if split=='validation':
     cases=[
      (f'The {a} waits for the {b}. Once the {b} fails with an exception, the {a} is released.',f'{ca}等待{cb}。{cb}因异常失败后，{ca}解除等待。'),
      (f'Completion of the {b} with an error unblocks the {a}; this does not make the {a} the source of the error.',f'{cb}因错误而结束会解除{ca}的阻塞；这并不意味着该错误来自{ca}。'),
      (f'If the {b} successfully returns, the exception is raised by the {a}, not by the {b}.',f'如果{cb}成功返回，异常由{ca}抛出，而非由{cb}抛出。'),
      (f'The {a} retains state until the {b} finishes. A deadline without completion is insufficient.',f'{ca}会保留状态，直到{cb}结束。仅仅到达截止时间而未完成并不足够。')]
    elif split=='holdout':
     cases=[
      (f'It is the {b}, rather than the {a}, that throws when the {b} ends; only then does the {a} return.',f'{cb}结束时，抛出异常的是{cb}，而非{ca}；只有此后{ca}才返回。'),
      (f'Failure signalled by the {b} causes the {a} to stop waiting; returning and throwing are different events.',f'{cb}发出的失败信号使{ca}停止等待；返回与抛出异常是不同的事件。'),
      (f'A normal completion of the {b} makes the {a} throw, despite the {b} reporting no error.',f'尽管{cb}未报告错误，{cb}正常结束仍会使{ca}抛出异常。'),
      (f'After time has expired, the {a} must still keep storage if the {b} has not confirmed completion.',f'时间到期后，如果{cb}尚未确认完成，{ca}仍必须保留存储空间。')]
    for ci,(source,target) in enumerate(cases):replay(split,f'{split}-causal-v2-{ci}',source,target,'assistant_audited_causal_contrast')
 validate_scope_rows(result);return result

def export(out):
 data=build();out.mkdir(parents=True,exist_ok=False)
 manifest={'protocol':'frozen-scope-choice-v1','corpus':'scope-choice-v2','review_status':'assistant_audited_synthetic','human_reviewed':False,
  'production_enabled':False,'checkpoint_selection':'final','base_initialization':'fresh_base','holdout_in_optimizer_inputs':False,
  'original_web_evaluations_imported':False,'previous_holdout_in_optimizer_inputs':False,'semantic_equivalence_automatically_proven':False,'files':{},'task_counts':{}}
 for split,rows in data.items():
  raw=''.join(json.dumps(x,ensure_ascii=False,separators=(',',':'))+'\n' for x in rows).encode();(out/(split+'.jsonl')).write_bytes(raw)
  manifest['files'][split]={'file':split+'.jsonl','rows':len(rows),'sha256':hashlib.sha256(raw).hexdigest()}
  manifest['task_counts'][split]={task:sum(x['task']==task for x in rows) for task in ['scope_choice','natural_replay']}
 (out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n');return manifest
