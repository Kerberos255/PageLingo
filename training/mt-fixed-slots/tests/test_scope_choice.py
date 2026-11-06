import importlib.util,json,sys,tempfile,unittest
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path
HERE=Path(__file__).resolve().parents[1];sys.path.insert(0,str(HERE))
from scope_choice_data import build,export
from scope_choice_contract import validate_scope_rows,validate_scope_config,scope_trainer_class

class ScopeChoiceContract(unittest.TestCase):
 def test_disjoint_families_and_new_source_terms_with_exact_candidate_ranges(self):
  data=build();self.assertTrue(validate_scope_rows(data));families={s:{r['family'] for r in rows} for s,rows in data.items()}
  self.assertFalse(families['train']&families['validation']);self.assertFalse(families['train']&families['holdout'])
  text='\n'.join(r['messages'][0]['content'] for r in data['train'])
  for reserved in ['dereferencing','Decryption','non-blocking','Unlock the mutex','at most once','is not required','may, but need not','The function will return when any future']:
   self.assertNotIn(reserved,text)
 def test_permutations_are_distinct_but_bound_to_the_same_gold_span(self):
  data=build();pairs={}
  for r in data['train']:
   if r['task']=='scope_choice':pairs.setdefault(r['pair_id'],[]).append(r)
  for rows in pairs.values():
   self.assertEqual(len(rows),2);self.assertNotEqual(rows[0]['messages'][0]['content'],rows[1]['messages'][0]['content']);self.assertEqual(rows[0]['gold_candidate'],rows[1]['gold_candidate'])
 def test_corruption_and_evaluation_split_reuse_are_refused(self):
  data=build();data['train'][0]['messages'][1]['content']='X';self.assertRaises(ValueError,validate_scope_rows,data)
  data=build();data['validation'][0]['family']=data['train'][0]['family'];self.assertRaises(ValueError,validate_scope_rows,data)
 def test_scope_pilot_cannot_resume_old_adapters_or_exceed_128_steps(self):
  c=json.loads((HERE/'config-scope-choice-v1.json').read_text());m={'protocol':'frozen-scope-choice-v1','corpus':'scope-choice-v1','holdout_in_optimizer_inputs':False};validate_scope_config(c,m)
  for change in [{'candidate_max_steps':129},{'initialization':'resume_verified_adapter'},{'checkpoint_selection':'lowest_validation_loss'},{'batch_size':2}]:
   self.assertRaises(ValueError,validate_scope_config,{**c,**change},m)
 def test_sequence_mean_loss_never_forwards_accumulated_token_count(self):
  class Parent:
   def __init__(self):self.model_accepts_loss_kwargs=True
   def compute_loss(self,model,inputs,return_outputs=False,num_items_in_batch=None):return num_items_in_batch
  trainer=scope_trainer_class(Parent)();self.assertFalse(trainer.model_accepts_loss_kwargs);self.assertIsNone(trainer.compute_loss(None,{},num_items_in_batch=200))
 def test_holdout_is_exported_separately_and_never_an_optimizer_file(self):
  with tempfile.TemporaryDirectory() as temp:
   m=export(Path(temp)/'data');self.assertFalse(m['holdout_in_optimizer_inputs']);self.assertEqual(set(m['files']),{'train','validation','holdout'})
   self.assertGreater(m['task_counts']['train']['scope_choice'],m['task_counts']['train']['natural_replay'])

class ScopeChoiceKit(unittest.TestCase):
 def build_kit(self,root,version='v1',previous=None):
  spec=importlib.util.spec_from_file_location('scope_package_builder',HERE.parents[1]/'tools/mt-scope-training-package.py')
  module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  return module.build(root,None,version,previous)
 def test_v2_uses_new_holdout_and_preserves_every_old_evaluation_request(self):
  import subprocess
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);old=self.build_kit(root/'v1');previous=Path(old['package'])/'scope-evaluation-plan.json'
   new=self.build_kit(root/'v2','v2',previous);package=Path(new['package']);plan=json.loads((package/'scope-evaluation-plan.json').read_text())
   old_jobs=json.loads(previous.read_text())['jobs'];regression=[j for j in plan['jobs'] if j['evaluation_cohort']=='frozen-v1-regression']
   self.assertEqual([j['request'] for j in regression],[j['request'] for j in old_jobs]);self.assertEqual(new['gpu_jobs_each'],200)
   self.assertEqual(len([j for j in plan['jobs'] if j['evaluation_cohort']=='scope-choice-v2-new-holdout']),100)
   result=subprocess.run([sys.executable,'-S',str(package/'research_v2.py'),'--root',str(root/'v2'),'--mode','run','--plan'],capture_output=True,text=True)
   self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(json.loads(result.stdout)['bf16_jobs_each'],200)
   self.assertEqual(json.loads((root/'v2/tools/mt-control/current-task.json').read_text())['run_prefix'],'scope-choice-v2')
 def test_portable_plan_validates_all_files_without_gpu_or_dependencies(self):
  import subprocess,hashlib,zipfile
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp)/'kit';receipt=self.build_kit(root);package=Path(receipt['package'])
   result=subprocess.run([sys.executable,'-S',str(package/'research_v2.py'),'--root',str(root),'--mode','run','--plan'],capture_output=True,text=True)
   self.assertEqual(result.returncode,0,result.stderr);plan=json.loads(result.stdout)
   self.assertEqual(plan['max_optimizer_steps'],128);self.assertFalse(plan['main_pc_browser_required']);self.assertEqual(plan['bf16_jobs_each'],100)
   self.assertEqual([p.name for p in root.glob('*.cmd')],['x.cmd']);self.assertFalse((root/'outputs').exists())
   inventory=json.loads((root/'INSTALL-MANIFEST.json').read_text())['files']
   for name,record in inventory.items():self.assertEqual(hashlib.sha256((root/name).read_bytes()).hexdigest(),record['sha256'])
   with zipfile.ZipFile(receipt['archive']) as bundle:self.assertIsNone(bundle.testzip())
   (package/'config-scope-choice-v1.json').write_text('{}')
   refused=subprocess.run([sys.executable,'-S',str(package/'research_v2.py'),'--root',str(root),'--plan'],capture_output=True,text=True)
   self.assertNotEqual(refused.returncode,0);self.assertIn('Staged package changed',refused.stderr)
 def test_workflow_separates_check_from_run_and_really_requests_optimization(self):
  import hashlib
  sys.path.insert(0,str(HERE/'windows'))
  try:
   spec=importlib.util.spec_from_file_location('scope_workflow_under_test',HERE/'scope_choice_workflow.py')
   module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  finally:sys.path.pop(0)
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp)/'kit';receipt=self.build_kit(root);module.HERE=Path(receipt['package'])
   base=root/'models/hy-mt2-1.8b';base.mkdir(parents=True);(base/'model.safetensors').write_bytes(b'fixture')
   expected=json.loads((module.HERE/'config-scope-choice-v1.json').read_text())['base_weight_sha256'];original_sha=module.sha
   def digest(path):return expected if path==base/'model.safetensors' else original_sha(path)
   calls=[]
   def child(command,**kwargs):
    command=[str(x) for x in command];calls.append(command);output=Path(command[command.index('--output')+1])
    if command[2].endswith('train.py'):
     output.mkdir(parents=True)
     if output.name=='candidate':
      self.assertIn('--train',command);(output/'adapter').mkdir();(output/'adapter/fixture.json').write_text('{}')
      (output/'training-result.json').write_text(json.dumps({'training_executed':True,'optimizer_steps':128,'base_weights_frozen':True}))
     else:self.assertNotIn('--train',command)
    else:output.write_text(json.dumps({'finished_utc':'fixture','generations':[{}]*100}))
    return SimpleNamespace(returncode=0)
   fake_torch=SimpleNamespace(cuda=SimpleNamespace(is_available=lambda:True,is_bf16_supported=lambda:True))
   with patch.dict('os.environ',{key:str(root/'.cache') for key in module.CACHE_KEYS}),patch.dict(sys.modules,{'torch':fake_torch}),patch.object(module,'sha',digest),patch.object(module.subprocess,'run',child):
    with patch.object(sys,'argv',['workflow','--root',str(root),'--mode','check']):self.assertEqual(module.main(),0)
    self.assertEqual(len(calls),1);self.assertFalse(list((root/'outputs').glob('scope-choice-v1-run-*')))
    calls.clear()
    with patch.object(sys,'argv',['workflow','--root',str(root),'--mode','run']):self.assertEqual(module.main(),0)
   self.assertEqual(len(calls),4);run=next((root/'outputs').glob('scope-choice-v1-run-*'));state=json.loads((run/'workflow-result.json').read_text())
   self.assertTrue(state['training_completed']);self.assertTrue(state['gpu_comparison_completed']);self.assertTrue((run/'gpu-handoff.zip').is_file())
   self.assertTrue(state['handoff_validation']['all_member_sha256_passed'])

class HardScopeData(unittest.TestCase):
 def test_new_data_is_disjoint_from_old_prompts_and_keeps_real_template_families_separate(self):
  from scope_choice_data_v2 import build as build_v2,AGENTS
  data=build_v2();self.assertTrue(validate_scope_rows(data));old={r['messages'][0]['content'] for rows in build().values() for r in rows}
  self.assertFalse(old&{r['messages'][0]['content'] for split in ['train','validation'] for r in data[split]})
  normalized={}
  for split,rows in data.items():
   values=set()
   for row in rows:
    if row.get('reference_kind')!='assistant_audited_causal_contrast':continue
    source=row['source_text']
    for term,zh in sum((list(group) for group in AGENTS[split]),[]):source=source.replace(term,'ENTITY')
    values.add(source)
   normalized[split]=values
  self.assertFalse(normalized['train']&normalized['validation']);self.assertFalse(normalized['train']&normalized['holdout']);self.assertFalse(normalized['validation']&normalized['holdout'])
 def test_missing_and_present_pairs_bind_the_same_occurrence_without_changing_translation(self):
  from scope_choice_data_v2 import build as build_v2
  data=build_v2();positive={};missing={}
  for row in data['train']:
   if row['task']!='scope_choice' or row['category'].startswith('quantity'):continue
   key=row['pair_id'].rsplit('-',1)[0];(missing if row['category'].endswith('_missing') else positive).setdefault(key,row)
  self.assertEqual(positive.keys(),missing.keys())
  for key,row in positive.items():
   other=missing[key]
   for field in ['source_text','source_focus','frozen_target']:self.assertEqual(row[field],other[field])
   self.assertIsNone(other['gold_candidate']);self.assertNotIn(row['gold_candidate'],[[c['start'],c['end']] for c in other['candidates']])
  choices=[r for r in data['train'] if r['task']=='scope_choice'];self.assertEqual(sum(r['gold_candidate'] is None for r in choices),len(choices)//2)
 def test_v2_config_cannot_be_applied_to_v1_or_resume_the_previous_adapter(self):
  c=json.loads((HERE/'config-scope-choice-v2.json').read_text());m={'protocol':'frozen-scope-choice-v1','corpus':'scope-choice-v2','holdout_in_optimizer_inputs':False}
  validate_scope_config(c,m);self.assertRaises(ValueError,validate_scope_config,c,{**m,'corpus':'scope-choice-v1'})
  self.assertRaises(ValueError,validate_scope_config,{**c,'initialization':'resume_verified_adapter'},m)

class HandoffIdentity(unittest.TestCase):
 def make_zip(self,path,records,payload):
  import zipfile
  with zipfile.ZipFile(path,'w') as bundle:
   for name,data in payload.items():bundle.writestr(name,data)
   bundle.writestr('MANIFEST.json',json.dumps({'files':records}))
 def test_legacy_windows_paths_are_explicit_and_never_change_payload_identity(self):
  import hashlib
  from handoff_archive import verify_handoff
  with tempfile.TemporaryDirectory() as temp:
   p=Path(temp)/'legacy.zip';record={'bytes':3,'sha256':hashlib.sha256(b'abc').hexdigest()}
   self.make_zip(p,{'candidate\\adapter\\part.json':record},{'candidate/adapter/part.json':b'abc'})
   self.assertRaises(ValueError,verify_handoff,p);self.assertEqual(verify_handoff(p,legacy_windows_paths=True)['legacy_windows_paths_normalized'],1)
   self.make_zip(p,{'candidate/adapter/part.json':record},{'candidate/adapter/part.json':b'bad'})
   self.assertRaises(ValueError,verify_handoff,p)
 def test_colliding_paths_and_unlisted_members_are_rejected(self):
  import hashlib
  from handoff_archive import verify_handoff
  with tempfile.TemporaryDirectory() as temp:
   p=Path(temp)/'legacy.zip';record={'bytes':3,'sha256':hashlib.sha256(b'abc').hexdigest()}
   self.make_zip(p,{'a\\b':record,'a/b':record},{'a/b':b'abc'})
   self.assertRaises(ValueError,verify_handoff,p,legacy_windows_paths=True)
   self.make_zip(p,{'a':record},{'a':b'abc','extra':b'abc'});self.assertRaises(ValueError,verify_handoff,p)

if __name__=='__main__':unittest.main()
