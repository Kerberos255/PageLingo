"""Stdlib-only guards and simulated stages; these tests never load or train a model."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from evaluate_gpu import request_hash,sha256,write_json
from evaluate_paraphrase import validate_plan
from paraphrase_contract import validate_config,validate_splits
import paraphrase_workflow as workflow
from private_exclusions import fingerprint,check_private_exclusions

TRAIN=Path(__file__).resolve().parents[1];DIGEST='a'*64


def config(variant):
    return json.loads((TRAIN/('config-paraphrase-'+variant+'-v29.json')).read_text())


def splits(variant):
    result={}
    for split,count in [('train',128),('validation',32)]:
        rows=[]
        for i in range(count):
            identity='v29-'+split+'-fixture-'+str(i)
            for task in ['fixed','natural']:
                rows.append({'id':identity+'/'+task,'pair_id':identity,'family':'fixture-'+split,'split':split,'task':task,'prompt_variant':variant,
                    'review_status':'assistant_audited_synthetic','source_html':'<p>'+identity+'</p>','semantic_facts':{'verb':'run','subject':'A'},
                    'source_sha256':hashlib.sha256(identity.encode()).hexdigest(),'source_wire_sha256':hashlib.sha256((identity+' wire').encode()).hexdigest(),
                    'messages':[{'role':'user','content':(variant if task=='fixed' else '')+task+' '+identity},{'role':'assistant','content':'示例译文'}]})
        result[split]=rows
    return result


def plan():
    request={'messages':[{'role':'user','content':'Source only'}],'max_tokens':48}
    return {'protocol':'BF16-fixed-paraphrase-v29','grammar_applied':False,'optimizer_inputs_approved':False,'jobs_per_model':1,'maximum_generation_calls':3,
        'cases':[{'id':'held','split':'holdout','meaning_reference':'NEVER FEED THIS TO THE MODEL'}],
        'jobs':[{'key':'held/legacy','case_id':'held','split':'holdout','cohort':'synthetic-v29-holdout','mode':'legacy','request':request,'request_sha256':request_hash(request),'production_grammar':'root ::= "x"'}]}


class ParaphraseGuards(unittest.TestCase):
    def test_configuration_pins_formal_lineage_and_bounded_steps(self):
        manifest={'corpus':'fixed-paraphrase-v29','protocol':'production-fixed-text-v1','prompt_variant':'legacy'}
        validate_config(config('legacy'),manifest)
        for key,value in [('candidate_max_steps',64),('initial_adapter_sha256','0'*64),('initialization','fresh_base'),('learning_rate',1e-4),('lora_dropout',.05),('base_weight_sha256','1'*64)]:
            altered=config('legacy');altered[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):validate_config(altered,manifest)

    def test_optimizer_rejects_holdout_duplicate_wire_and_missing_task(self):
        manifest={'prompt_variant':'legacy'};original=splits('legacy');validate_splits(original,manifest)
        altered=copy.deepcopy(original);altered['holdout']=[]
        with self.assertRaisesRegex(ValueError,'Holdout'):validate_splits(altered,manifest)
        altered=copy.deepcopy(original);altered['train'][2]['source_wire_sha256']=altered['train'][0]['source_wire_sha256']
        with self.assertRaisesRegex(ValueError,'Source/wire'):validate_splits(altered,manifest)
        altered=copy.deepcopy(original);altered['validation'].pop()
        with self.assertRaisesRegex(ValueError,'balanced'):validate_splits(altered,manifest)

    def test_evaluation_refuses_targets_training_cases_and_changed_request(self):
        original=plan();validate_plan(original)
        altered=copy.deepcopy(original);altered['cases'][0]['split']='train'
        with self.assertRaises(ValueError):validate_plan(altered)
        altered=copy.deepcopy(original);request=altered['jobs'][0]['request'];request['reference']='BAD';altered['jobs'][0]['request_sha256']=request_hash(request)
        with self.assertRaisesRegex(ValueError,'Only the frozen source'):validate_plan(altered)
        altered=copy.deepcopy(original);altered['jobs'][0]['request']['messages'].append({'role':'assistant','content':'BAD'});altered['jobs'][0]['request_sha256']=request_hash(altered['jobs'][0]['request'])
        with self.assertRaises(ValueError):validate_plan(altered)
        altered=copy.deepcopy(original);altered['jobs'][0]['request']['max_tokens']=50
        with self.assertRaisesRegex(ValueError,'identity'):validate_plan(altered)

    def kit(self,root):
        here=root/'kit';here.mkdir();write_json(here/'evaluation-plan.json',plan());write_json(here/'preregister.json',{'fixture_only':True})
        for name in ['train.py','evaluate_paraphrase.py']:(here/name).write_text('# fixture only\n')
        (here/'data').mkdir()
        write_json(here/'data/manifest.json',{'fixture_only':True})
        (here/'data/template-review.md').write_text('fixture')
        authored=[{'id':'authored-'+str(i),'html':'<p>Authored '+str(i)+'</p>','source_text':'Authored '+str(i)} for i in range(192)]
        web=[{'id':'web-'+str(i),'html':'<p>Web '+str(i)+'</p>','source_text':'Web '+str(i)} for i in range(6)]
        write_json(here/'data/evaluation-cases.json',{'cases':authored});write_json(here/'web-sources.json',{'cases':web})
        write_json(here/'candidate-source-fingerprints.json',[fingerprint(c) for c in authored+web])
        for variant in ['legacy','compact']:
            folder=here/'data'/variant;folder.mkdir();records={}
            for split,rows in splits(variant).items():
                file=folder/(split+'.jsonl');file.write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows),encoding='utf-8');records[split]={'file':file.name,'rows':len(rows),'sha256':sha256(file)}
            manifest={'corpus':'fixed-paraphrase-v29','protocol':'production-fixed-text-v1','prompt_variant':variant,'files':records,
                'task_counts':{'train':{'fixed':128,'natural':128},'validation':{'fixed':32,'natural':32}}}
            write_json(folder/'manifest.json',manifest);write_json(here/('config-paraphrase-'+variant+'-v29.json'),config(variant))
        (root/'reports').mkdir();inventory=root/'reports/private.json';old=root/'reports/old.jsonl';old.write_text('{}')
        write_json(inventory,{'files':[{'path':'reports/old.jsonl','sha256':sha256(old)}],'canonical_source_sha256':['0'*64],'delexicalized_source_sha256':['1'*64]})
        write_json(here/'private-exclusion-plan.json',{'mode':'verify_on_gpu_host_before_model_load','cases_checked':192,'new_web_cases_checked':6,
            'inventory_file':'reports/private.json','inventory_sha256':sha256(inventory),'expected_canonical_sources':1,'expected_delexicalized_sources':1,
            'data_manifest_sha256':sha256(here/'data/manifest.json'),'candidate_fingerprints_sha256':sha256(here/'candidate-source-fingerprints.json')})
        files={p.relative_to(here).as_posix():{'bytes':p.stat().st_size,'sha256':sha256(p)} for p in here.rglob('*') if p.is_file()}
        write_json(here/'package-manifest.json',{'schema_version':1,'source_commit':'c'*40,'source_dirty':False,'files':files})
        return here

    def candidate(self,folder,config_file,data,expected,wrong=False):
        folder.mkdir();adapter=folder/'adapter';adapter.mkdir();(adapter/'adapter_model.safetensors').write_bytes(b'fixture weights')
        c=json.loads(config_file.read_text());write_json(adapter/'adapter_config.json',{'peft_type':'LORA','r':32,'lora_alpha':64,'lora_dropout':0,'target_modules':c['target_modules']})
        digest='b'*64 if wrong else DIGEST;manifest=json.loads((data/'manifest.json').read_text())
        write_json(folder/'initialization.json',{'initial_trainable_sha256':digest,'expected_initial_sha256':expected,'base_weights_frozen':True,'optimization_started':False})
        write_json(folder/'training-result.json',{'fixture_only':True,'training_executed':True,'run_kind':'synthetic_research_candidate','optimizer_steps':32,'config':c,
            'initial_adapter':{'sha256':c['initial_adapter_sha256'],'config_sha256':c['initial_adapter_config_sha256']},'local_weight_sha256':c['base_weight_sha256'],
            'selection':{'best_checkpoint':None},'validation_after':{'eval_loss':1.0},'config_sha256':sha256(config_file),'input_manifest_sha256':sha256(data/'manifest.json'),
            'initial_trainable_sha256':digest,'base_weights_frozen':True,'dropout_disabled':True,'loss_definition':{'kind':'batch1_sequence_mean_target_ce'},
            'splits':{s:{'sha256':r['sha256'],'rows':r['rows'],'task_counts':manifest['task_counts'][s]} for s,r in manifest['files'].items()}})

    def test_pair_target_drift_is_rejected_even_with_updated_file_hash(self):
        with tempfile.TemporaryDirectory() as name:
            here=self.kit(Path(name));file=here/'data/compact/train.jsonl';rows=[json.loads(s) for s in file.read_text().splitlines()];rows[0]['messages'][1]['content']='changed';file.write_text(''.join(json.dumps(r)+'\n' for r in rows))
            manifest=json.loads((file.parent/'manifest.json').read_text());manifest['files']['train']['sha256']=sha256(file);write_json(file.parent/'manifest.json',manifest)
            with self.assertRaisesRegex(ValueError,'source order or targets'):workflow.verify_pair(here)

    def test_original_source_collision_stops_before_models_and_records_actual_failure(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);here=self.kit(root);out=root/'check';out.mkdir();p=here/'private-exclusion-plan.json';spec=json.loads(p.read_text())
            inventory=root/spec['inventory_file'];data=json.loads(inventory.read_text());data['canonical_source_sha256']=[json.loads((here/'candidate-source-fingerprints.json').read_text())[0]['normal'][0]];write_json(inventory,data)
            spec['inventory_sha256']=sha256(inventory)
            with self.assertRaisesRegex(ValueError,'no model loaded'):check_private_exclusions(root,here,out,spec)
            result=json.loads((out/'private-exclusion-result.json').read_text());self.assertFalse(result['model_weights_loaded']);self.assertFalse(result['training_executed']);self.assertTrue(result['collisions'])

    def test_simulated_check_run_and_second_candidate_failure_preserve_evidence(self):
        for mode,wrong in [('check',False),('run',False),('run',True)]:
            with self.subTest(mode=mode,wrong=wrong),tempfile.TemporaryDirectory() as name:
                root=Path(name);here=self.kit(root);commands=[];owner=self
                class Process:
                    def __init__(self,command,**kwargs):
                        commands.append(command);self.stdout=iter(['fixture stage\n'])
                        if '--train' in command:
                            folder=Path(command[command.index('--output')+1]);expected=command[command.index('--expected-initial-sha256')+1] if '--expected-initial-sha256' in command else None
                            owner.candidate(folder,Path(command[command.index('--config')+1]),Path(command[command.index('--data')+1]),expected,wrong and folder.name=='compact_v29')
                        if command[2].endswith('evaluate_paraphrase.py') and '--check-only' not in command:
                            out=Path(command[command.index('--output')+1]);out.mkdir();phase=command[command.index('--phase')+1];labels=['v022'] if phase=='baseline' else ['legacy_v29','compact_v29'];runs={'finished_utc':'fixture','plan_sha256':sha256(here/'evaluation-plan.json'),'files':{}}
                            for label in labels:
                                file=out/(label+'.json');job=plan()['jobs'][0];write_json(file,{'model':label,'finished_utc':'fixture','generations':[{'key':job['key'],'request_sha256':job['request_sha256']}]});runs['files'][label]={'file':file.name,'sha256':sha256(file)}
                            write_json(out/'runs.json',runs)
                    def __enter__(self):return self
                    def __exit__(self,*a):return False
                    def wait(self):return 0
                with patch.object(workflow,'HERE',here),patch.object(workflow.subprocess,'Popen',Process),patch.object(workflow,'pinned',lambda root,identity,weight:root/identity['directory']),patch.object(sys,'argv',['workflow','--root',str(root),'--mode',mode]):
                    if wrong:
                        with self.assertRaisesRegex(ValueError,'initialization differs'):workflow.main()
                    else:self.assertEqual(workflow.main(),0)
                run=next((root/'outputs').iterdir());status=json.loads((run/'workflow-result.json').read_text())
                self.assertEqual(sum('--train' in c for c in commands),0 if mode=='check' else 2)
                self.assertFalse(status['release_approved']);self.assertFalse(status['upload_executed'])
                if wrong:
                    self.assertFalse(status['workflow_completed']);self.assertTrue((run/'legacy_v29/adapter/adapter_model.safetensors').exists());self.assertFalse((run/'gpu-handoff.zip').exists())
                elif mode=='run':self.assertTrue(status['workflow_completed']);self.assertTrue((run/'gpu-handoff.zip').exists())
                else:self.assertIn('paraphrase-v29-check-',run.name)


if __name__=='__main__':unittest.main()
