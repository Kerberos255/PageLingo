"""Frozen v29 paired paraphrase experiment; public-page targets are not optimizer inputs."""
import collections
import json
import re

from curriculum_workflow import completed_candidate
from evaluate_gpu import sha256
from scope_choice_contract import scope_trainer_class

FORMAL_ADAPTER_SHA256 = '28a0bd981feab75390ec045a9b97b02401e8a5ab973118d7e54da7b9e77cf859'
FORMAL_CONFIG_SHA256 = '1e55f31f99fc13ea21a25bc4f4b8c60f1b5a6b3d52ff6497ab778b1f4a4efa10'


def validate_config(config, manifest):
    if manifest.get('corpus') != 'fixed-paraphrase-v29' or manifest.get('protocol') != 'production-fixed-text-v1':
        raise ValueError('Expected v29 authored paraphrase data')
    if manifest.get('prompt_variant') not in ['legacy', 'compact'] or config.get('paraphrase_prompt_variant') != manifest['prompt_variant']:
        raise ValueError('Paraphrase prompt variant changed')
    expected = {'candidate_max_steps':32, 'checkpoint_selection':'final', 'initialization':'resume_verified_v022',
        'base_weight_sha256':'29e9117a44c79f81857613601968ff482d8a23c2d6736a1710bba9e5ca4762e5',
        'initial_adapter_sha256':FORMAL_ADAPTER_SHA256, 'initial_adapter_config_sha256':FORMAL_CONFIG_SHA256,
        'lora_r':32, 'lora_alpha':64, 'lora_dropout':0.0, 'learning_rate':5e-6, 'batch_size':1, 'gradient_accumulation_steps':8}
    if any(config.get(k) != v for k,v in expected.items()) or config.get('semantic_marker_weight') is not None:
        raise ValueError('v29 requires the exact formal adapter, paired 32-step final runs and ordinary target CE')


def validate_row(row, manifest):
    if row.get('task') not in ['fixed', 'natural'] or row.get('prompt_variant') != manifest['prompt_variant']:
        raise ValueError('Unexpected paraphrase optimizer task/variant')
    if not str(row.get('pair_id','')).startswith('v29-'+row['split']+'-') or row.get('review_status') != 'assistant_audited_synthetic':
        raise ValueError('Only separately authored v29 sources may enter optimization')
    if not row.get('source_html') or not row.get('semantic_facts'):
        raise ValueError('Missing reviewed source and semantic facts')
    if any(not re.fullmatch('[a-f0-9]{64}',row.get(k,'')) for k in ['source_sha256','source_wire_sha256']):
        raise ValueError('Missing source/wire identity')


def validate_splits(splits, manifest):
    if set(splits) != {'train','validation'}:
        raise ValueError('Holdout/diagnostic sources cannot enter the optimizer loader')
    ids=set();prompts=set();families={};sources={};wires={}
    for split, rows in splits.items():
        count = 128 if split == 'train' else 32
        if collections.Counter(r.get('task') for r in rows) != {'fixed':count,'natural':count}:
            raise ValueError('Expected balanced fixed/natural paraphrase tasks')
        pairs = collections.defaultdict(list)
        for row in rows:
            validate_row(row,manifest);pairs[row['pair_id']].append(row)
            if row['id'] in ids or row['messages'][0]['content'] in prompts:raise ValueError('Duplicate optimizer ID/prompt')
            ids.add(row['id']);prompts.add(row['messages'][0]['content'])
            if families.setdefault(row['family'],split)!=split:raise ValueError('Template family crosses optimizer split')
            for table,key in [(sources,'source_sha256'),(wires,'source_wire_sha256')]:
                if table.setdefault(row[key],row['pair_id'])!=row['pair_id']:raise ValueError('Source/wire repeats across distinct pairs')
        if len(pairs) != count or any(len(v)!=2 or v[0]['source_html']!=v[1]['source_html'] or v[0]['semantic_facts']!=v[1]['semantic_facts'] for v in pairs.values()):
            raise ValueError('Paraphrase fixed/natural pair changed')


def completed_paraphrase_candidate(folder, config_file, data, expected_initial=None):
    config=json.loads(config_file.read_text(encoding='utf-8'));manifest=json.loads((data/'manifest.json').read_text(encoding='utf-8'))
    validate_config(config,manifest);identity=completed_candidate(folder,config)
    result=json.loads((folder/'training-result.json').read_text(encoding='utf-8'))
    if result['config_sha256']!=sha256(config_file) or result['input_manifest_sha256']!=sha256(data/'manifest.json'):
        raise ValueError('Paraphrase configuration/corpus changed')
    if result.get('local_weight_sha256')!=config['base_weight_sha256'] or result.get('initial_adapter',{}).get('config_sha256')!=FORMAL_CONFIG_SHA256:
        raise ValueError('Paraphrase base or initial adapter configuration changed')
    digest=result.get('initial_trainable_sha256','')
    if not re.fullmatch('[a-f0-9]{64}',digest) or expected_initial is not None and digest!=expected_initial:
        raise ValueError('Paired paraphrase initialization differs')
    if result.get('base_weights_frozen') is not True or result.get('dropout_disabled') is not True:
        raise ValueError('Paraphrase base/dropout contract changed')
    initialization=json.loads((folder/'initialization.json').read_text(encoding='utf-8'))
    if initialization!={'initial_trainable_sha256':digest,'expected_initial_sha256':expected_initial,'base_weights_frozen':True,'optimization_started':False}:
        raise ValueError('Paraphrase initialization record changed')
    if result.get('loss_definition',{}).get('kind')!='batch1_sequence_mean_target_ce':
        raise ValueError('Unexpected paraphrase loss')
    saved=json.loads((folder/'adapter/adapter_config.json').read_text(encoding='utf-8'))
    if saved.get('r')!=32 or saved.get('lora_alpha')!=64 or saved.get('lora_dropout')!=0 or saved.get('peft_type')!='LORA' or set(saved.get('target_modules',[]))!=set(config['target_modules']):
        raise ValueError('Saved paraphrase adapter configuration changed')
    for split in ['train','validation']:
        actual=result['splits'][split];record=manifest['files'][split]
        if actual['sha256']!=record['sha256'] or sha256(data/record['file'])!=record['sha256'] or actual['rows']!=record['rows'] or actual['task_counts']!=manifest['task_counts'][split]:
            raise ValueError('Paraphrase split identity changed')
    return identity
