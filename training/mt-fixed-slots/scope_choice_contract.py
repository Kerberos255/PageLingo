"""Guards for a fresh-base, bounded selector/translation pilot; not a model release."""
import json,re

def validate_scope_rows(splits):
 seen_ids=set();seen_prompts=set();families={};terms={}
 for split,rows in splits.items():
  for row in rows:
   if row['split']!=split or row['id'] in seen_ids:raise ValueError('Scope data split/ID collision')
   seen_ids.add(row['id']);previous=families.setdefault(row['family'],split)
   if previous!=split:raise ValueError('Scope template family crosses splits')
   if row['review_status']!='assistant_audited_synthetic':raise ValueError('Unexpected scope data review status')
   messages=row['messages']
   if [m['role'] for m in messages]!=['user','assistant'] or messages[0]['content'] in seen_prompts:raise ValueError('Scope messages duplicate or malformed')
   seen_prompts.add(messages[0]['content'])
   if row['task']=='scope_choice':
    candidates=row['candidates'];answer=messages[1]['content'];allowed={x['id'] for x in candidates}|{'X'}
    if answer not in allowed or len(allowed)!=len(candidates)+1:raise ValueError('Invalid scope answer')
    focus=row['source_focus'];source=row['source_text']
    if not 0<=focus[0]<focus[1]<=len(source):raise ValueError('Source focus is out of bounds')
    target=row['frozen_target'];raw=target.encode('utf-16-le')
    for c in candidates:
     if not 0<=c['start']<c['end']<=len(raw)//2 or raw[2*c['start']:2*c['end']].decode('utf-16-le')!=c['text']:raise ValueError('Candidate must be an exact frozen target substring')
    selected=next((c for c in candidates if c['id']==answer),None);gold=row['gold_candidate']
    if (selected is None)!=(gold is None) or selected and [selected['start'],selected['end']]!=gold:raise ValueError('Gold scope label differs from its range')
    fields=json.loads(messages[0]['content'].split('\n',1)[1])
    if fields['english_before']+fields['english_focus']+fields['english_after']!=source or fields['frozen_chinese']!=target or fields['candidates']!=candidates:raise ValueError('Scope prompt differs from bound source/target/choices')
   elif row['task']!='natural_replay':raise ValueError('Unexpected optimizer task')
 return True

def validate_scope_config(config,manifest):
 if manifest.get('protocol')!='frozen-scope-choice-v1' or manifest.get('corpus') not in ['scope-choice-v1','scope-choice-v2'] or manifest.get('holdout_in_optimizer_inputs') is not False:raise ValueError('Invalid scope manifest')
 if config.get('corpus','scope-choice-v1')!=manifest['corpus']:raise ValueError('Scope config and corpus differ')
 if config.get('initialization')!='fresh_base' or config.get('checkpoint_selection')!='final' or config.get('batch_size')!=1:raise ValueError('Scope pilot requires fresh base, batch1 and a fixed final checkpoint')
 if not 1<=config.get('candidate_max_steps',0)<=128:raise ValueError('Scope pilot exceeds the step bound')

def scope_trainer_class(base):
 class ScopeTrainer(base):
  def __init__(self,*args,**kwargs):
   super().__init__(*args,**kwargs);self.model_accepts_loss_kwargs=False
  def compute_loss(self,model,inputs,return_outputs=False,num_items_in_batch=None):
   # Batch1 sequence-mean CE: long translation targets must not erase the
   # contribution of a two-token choice/EOS example across accumulation steps.
   return super().compute_loss(model,inputs,return_outputs=return_outputs,num_items_in_batch=None)
 return ScopeTrainer
