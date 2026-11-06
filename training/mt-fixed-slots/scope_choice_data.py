"""Audited synthetic scope choices and plain translation rehearsal; no web eval imports."""
import argparse,hashlib,json,random
from pathlib import Path

INSTRUCTION = "你是网页翻译的范围选择器。中文译文已经冻结，禁止翻译或改写。请选择与 english_focus 在本句中完整对应的中文范围。必须包含否定、前缀和全部概念，不能选择同一词的另一次出现，不能吞入未选中的英文动作。候选缺失完整连续对应范围时选择 X。只输出一个候选字母或 X。\n"
TERMS = {
 'train': [('dismantling','拆卸','assembly','组装'),('decoding','解码','encoding','编码'),('unpacking','解包','packing','打包'),
  ('deactivation','停用','activation','激活'),('disconnection','断开连接','connection','建立连接'),('demotion','降级','promotion','升级'),
  ('deserialization','反序列化','serialization','序列化'),('deallocation','释放内存','allocation','分配内存'),
  ('revocation','撤销授权','authorization','授权'),('decompression','解压缩','compression','压缩'),
  ('disabling','禁用','enabling','启用'),('rollback','回滚','commit','提交'),
  ('read-only','只读','writable','可写'),('immutable','不可变','mutable','可变')],
 'validation': [('unmounting','卸载挂载点','mounting','挂载'),('unsubscription','取消订阅','subscription','订阅'),
  ('uninstallation','卸载程序','installation','安装程序'),('invalidation','使缓存失效','validation','验证有效性')],
 'holdout': [('deregistration','注销登记','registration','登记注册'),('unbinding','解除绑定','binding','绑定'),
  ('unfreezing','解除冻结','freezing','冻结'),('draining','排空','filling','填充')]
}
FRAMES = {
 'train': [('T0','These operations are ',' and ','.','这两种操作分别是','和','。'),
  ('T1','The first action is ', '; the other is ','.','第一个动作是','；另一个动作是','。'),
  ('T2','Use ',' rather than ',' for this stage.','在此阶段使用','，而不是','。'),
  ('T3','The manual distinguishes ',' from ','.','手册区分了','与','。')],
 'validation': [('V0','The diagram labels the left branch ', ' and the right branch ','.','图中左分支标为','，右分支标为','。'),
  ('V1','One option performs ', '; its alternative performs ','.','一种选项执行','；另一种选项执行','。')],
 'holdout': [('H0','The operator selected ',' instead of ','.','操作员选择了','而非','。'),
  ('H1','The procedure describes ', ', followed by ','.','该流程先描述','，随后描述','。')]
}
NUMBERS=[('three','三'),('four','四'),('five','五'),('six','六'),('seven','七'),('eight','八')]
REPEAT_FRAMES={
 'T0':('The first section mentions ',' before the example; the second mentions ',' after it.','第一节在示例前提到','；第二节在示例后提到','。'),
 'T1':('One note describes ',' during setup; another describes ',' during cleanup.','一条说明在设置阶段描述','；另一条在清理阶段描述','。'),
 'T2':('The read path discusses ', ', and the write path discusses ','.','读取路径讨论','，写入路径也讨论','。'),
 'T3':('A primary document covers ', '; a backup document also covers ','.','主文档涵盖','；备用文档也涵盖','。'),
 'V0':('The diagram names ',' above the arrow and ',' below it.','图中箭头上方标注','，下方也标注','。'),
 'V1':('Compare the early discussion of ',' with the later discussion of ','.','比较前面关于','的讨论与后面关于','的讨论。'),
 'H0':('The request log describes ', '; the response log describes ','.','请求日志描述','；响应日志描述','。'),
 'H1':('Read the remark about ', ', then read the second remark about ','.','先阅读关于','的说明，再阅读第二条关于','的说明。')}

def u16(text,i):return len(text[:i].encode('utf-16-le'))//2
def natural_prompt(source):
 return 'Translate the following English text into Simplified Chinese. Preserve every action, participant, condition, negation and temporal relationship. Keep the protected code strings unchanged. Output only the translation, without labels, HTML, explanations or markers.\nProtected code (JSON):\n[]\nEnglish:\n'+source
def choice_prompt(source,focus,target,choices,seed,permutation=0):
 order=list(range(len(choices)));random.Random(seed).shuffle(order);ids=list('ABCD')[:len(order)]
 if permutation:order=order[1:]+order[:1]
 displayed=[]
 for label,index in zip(ids,order):
  start,end=choices[index];displayed.append({'id':label,'start':u16(target,start),'end':u16(target,end),'text':target[start:end],
   'left_context':target[max(0,start-16):start],'right_context':target[end:end+16]})
 a,z=focus;fields={'english_before':source[:a],'english_focus':source[a:z],'english_after':source[z:],'frozen_chinese':target,'candidates':displayed}
 return INSTRUCTION+json.dumps(fields,ensure_ascii=False,separators=(',',':')),order,displayed

def build():
 result={s:[] for s in TERMS};serial=0
 def add(split,family,source,target,task,metadata=None):
  nonlocal serial
  serial+=1;result[split].append({'id':f'scope-v1-{serial:05d}','split':split,'family':family,'task':task,
    'review_status':'assistant_audited_synthetic','messages':[{'role':'user','content':source},{'role':'assistant','content':target}],**(metadata or {})})
 def select(split,family,pair,source,focus,target,choices,gold):
  seed=20261106+serial*17
  for permutation in [0,1]:
   prompt,order,displayed=choice_prompt(source,focus,target,choices,seed,permutation)
   label='X' if gold is None else 'ABCD'[order.index(gold)]
   add(split,family,prompt,label,'scope_choice',{'pair_id':pair,'source_text':source,'source_focus':list(focus),'frozen_target':target,
    'candidates':displayed,'gold_candidate':None if gold is None else list(choices[gold]),'optimizer_inputs_approved':split in ['train','validation']})
 for split,pairs in TERMS.items():
  for t,(en_a,zh_a,en_b,zh_b) in enumerate(pairs):
   for frame in FRAMES[split]:
    family=frame[0]
    for repeated in [False,True]:
     before,middle,after,cbefore,cmiddle,cafter=REPEAT_FRAMES[family] if repeated else frame[1:]
     eb,zb=(en_a,zh_a) if repeated else (en_b,zh_b)
     source=before+en_a+middle+eb+after;target=cbefore+zh_a+cmiddle+zb+cafter
     a=len(cbefore);b=a+len(zh_a)+len(cmiddle);ranges=[(a,a+len(zh_a)),(b,b+len(zb)),(a,b+len(zb))]
     # A short partial syllable, or a different contextual word for one-char labels.
     ranges.append((a+len(zh_a)-1,a+len(zh_a)) if len(zh_a)>1 else (0,min(2,len(cbefore))))
     for which in [0,1]:
      start=len(before) if which==0 else len(before)+len(en_a)+len(middle);focus=(start,start+len(en_a if which==0 else eb))
      select(split,family+('-repeat' if repeated else '-contrast'),f'{split}-{t}-{family}-{repeated}-{which}',source,focus,target,ranges,which)
     # This full translation is a separate rehearsal task; no choice IDs or HTML.
     add(split,family+'-replay',natural_prompt(source),target,'natural_replay',{'source_text':source,'reference_kind':'audited_template_translation'})
  operations=[('write operations','写入操作'),('read operations','读取操作'),('scans','扫描'),('checks','检查'),('copy operations','复制操作'),('polls','轮询'),('queries','查询'),('updates','更新')] if split=='train' else [('scans','扫描')]
  for n,(en,zh,op_en,op_zh) in enumerate([(en,zh,a,b) for en,zh in NUMBERS for a,b in operations]):
   if split=='train':
    before='Perform ';focus='only '+en;after=' '+op_en+'.';target='只进行'+zh+'次'+op_zh+'。'
   elif split=='validation':
    before='The reader should do ';focus='exactly '+en;after=' scans.';target='读取器应恰好执行'+zh+'次扫描。'
   else:
    before='Limit the worker to ';focus='at most '+en;after=' reads.';target='让工作线程最多完成'+zh+'次读取。'
   # Obtain positions by the constructed fragments, avoiding assumptions on digit widths.
   marker='只' if split=='train' else '恰好' if split=='validation' else '最多'
   verb='进行' if split=='train' else '执行' if split=='validation' else '完成'
   left=target.index(marker);right=target.index(zh+'次');bits=[(left,left+len(marker)),(right,right+2),(left,right+2),(left+len(marker),right)]
   source=before+focus+after
   select(split,split+'-noncontiguous',f'{split}-none-{n}',source,(len(before),len(before)+len(focus)),target,bits,None)
   add(split,split+'-quantity-replay',natural_prompt(source),target,'natural_replay',{'source_text':source,'reference_kind':'audited_template_translation'})
 # Fresh causal/temporal contrast templates. Old real-page and selector diagnostics are never read.
 causal={
  'train': [('The scheduler wakes when a writer stops by throwing an I/O error. The writer, not the scheduler, throws the error.','写入器因抛出 I/O 错误而停止时，调度器会被唤醒。抛出错误的是写入器，而不是调度器。'),
   ('The dispatcher resumes once a parser exits with a syntax fault. Resuming does not itself raise that fault.','解析器因语法错误退出后，分派器恢复运行。恢复运行本身并不会抛出该错误。'),
   ('The dispatcher throws a fault when a parser exits normally. That unusual rule is intentional.','解析器正常退出时，分派器会抛出错误。这一非常规规则是有意规定的。'),
   ('The coordinator becomes ready as soon as the sender terminates by throwing a stream error.','发送方因抛出流错误而终止时，协调器立即就绪。'),
   ('The gate opens when the producer leaves the loop by raising an error.','生产者因抛出错误离开循环时，闸门打开。'),
   ('The scanner stops after the parser reaches its end by emitting a failure signal.','解析器发出失败信号而结束后，扫描器停止。'),
   ('The dispatcher itself throws a fault after the sender succeeds; the sender does not throw it.','发送方成功后，分派器本身会抛出错误；发送方不会抛出该错误。'),
   ('Keep the resource until its consumer has stopped. A deadline passing alone does not show that the consumer stopped.','在使用者停止之前保留该资源。仅仅超过截止时间并不能证明使用者已经停止。')],
  'validation':[('The watcher proceeds when a consumer quits by signalling an input error. The consumer is the source of that error.','使用者通过发出输入错误而退出时，观察器继续执行。该错误由使用者发出。'),
   ('A handler may try a rejected request again, but it cannot mark rejection as acceptance.','处理器可以重试被拒绝的请求，但不能把拒绝标为接受。')],
  'holdout':[('The monitor is resumed after a sender finishes by throwing a stream error. The sender throws; the monitor resumes.','发送方因抛出流错误而结束后，监视器恢复运行。发送方抛出错误，监视器恢复运行。'),
   ('Storage must stay allocated until the observer confirms completion; elapsed time alone is insufficient.','在观察器确认完成之前，存储空间必须保持分配状态；仅仅经过一段时间并不足够。')]}
 for split,pairs in causal.items():
  for i,(source,target) in enumerate(pairs):add(split,f'{split}-causal-{i}',natural_prompt(source),target,'natural_replay',{'source_text':source,'reference_kind':'assistant_audited_causal_roles'})
 return result

def export(out):
 from scope_choice_contract import validate_scope_rows
 data=build();validate_scope_rows(data)
 out.mkdir(parents=True,exist_ok=False);manifest={'protocol':'frozen-scope-choice-v1','corpus':'scope-choice-v1','review_status':'assistant_audited_synthetic',
  'human_reviewed':False,'production_enabled':False,'checkpoint_selection':'final','base_initialization':'fresh_base','files':{},
  'task_counts':{},'holdout_in_optimizer_inputs':False,'original_web_evaluations_imported':False,'semantic_equivalence_automatically_proven':False}
 for split,rows in data.items():
  raw=''.join(json.dumps(x,ensure_ascii=False,separators=(',',':'))+'\n' for x in rows).encode();(out/(split+'.jsonl')).write_bytes(raw)
  manifest['files'][split]={'file':split+'.jsonl','rows':len(rows),'sha256':hashlib.sha256(raw).hexdigest()}
  manifest['task_counts'][split]={task:sum(x['task']==task for x in rows) for task in ['scope_choice','natural_replay']}
 (out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n');return manifest

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--out',type=Path,required=True);args=p.parse_args();m=export(args.out);print(json.dumps(m['task_counts']))
