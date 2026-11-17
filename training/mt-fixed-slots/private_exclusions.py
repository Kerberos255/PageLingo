"""Verify the frozen original-source inventory locally before loading any model."""
import hashlib
import json
from pathlib import Path
import re
import unicodedata

from evaluate_gpu import sha256,write_json


def fingerprint(row):
    canonical=lambda s:re.sub(r'\s+',' ',unicodedata.normalize('NFKC',s).lower()).strip()
    digest=lambda s:hashlib.sha256(s.encode()).hexdigest()
    html=row['html'];delex=re.sub(r'<(code|kbd|samp|var)\b[^>]*>[\s\S]*?</\1>',' PROTECTED_CODE ',html,flags=re.I)
    delex=re.sub(r'__FLT_OPAQUE_\d+__',' PROTECTED_CODE ',delex)
    return {'id':row['id'],'normal':[digest(canonical(row['source_text'])),digest(canonical(html))],'delex':digest(canonical(delex))}


def validate_exclusion_plan(here,plan):
    if plan.get('mode')!='verify_on_gpu_host_before_model_load' or plan.get('cases_checked')!=192 or plan.get('new_web_cases_checked')!=6:
        raise ValueError('A mandatory pre-model original-source check is required')
    if plan.get('data_manifest_sha256')!=sha256(here/'data/manifest.json'):
        raise ValueError('Exclusion plan belongs to different data')
    file=here/'candidate-source-fingerprints.json'
    if sha256(file)!=plan.get('candidate_fingerprints_sha256'):raise ValueError('Candidate source fingerprint file changed')
    rows=json.loads((here/'data/evaluation-cases.json').read_text(encoding='utf-8'))['cases']+json.loads((here/'web-sources.json').read_text(encoding='utf-8'))['cases']
    expected=[fingerprint(row) for row in rows];actual=json.loads(file.read_text(encoding='utf-8'))
    if len(expected)!=198 or len({r['id'] for r in expected})!=198 or actual!=expected:
        raise ValueError('Source fingerprints must exactly cover authored and new web sources')
    if not re.fullmatch('[a-f0-9]{64}',plan.get('inventory_sha256','')) or plan.get('expected_canonical_sources',0)<1 or plan.get('expected_delexicalized_sources',0)<1:
        raise ValueError('Missing frozen original-source inventory identity')
    return actual


def check_private_exclusions(root,here,out,plan):
    candidates=validate_exclusion_plan(here,plan);path=(root/plan['inventory_file']).resolve()
    if not path.is_relative_to(root) or sha256(path)!=plan['inventory_sha256']:raise ValueError('Original-source inventory changed or escaped the project')
    inventory=json.loads(path.read_text(encoding='utf-8'))
    for record in inventory['files']:
        file=(root/record['path']).resolve()
        if not file.is_relative_to(root) or sha256(file)!=record['sha256']:raise ValueError('Original data changed since source audit: '+record['path'])
    normal=set(inventory['canonical_source_sha256']);delex=set(inventory['delexicalized_source_sha256'])
    if len(normal)!=plan['expected_canonical_sources'] or len(delex)!=plan['expected_delexicalized_sources']:
        raise ValueError('Original-source inventory coverage changed')
    collisions=[]
    for row in candidates:
        if any(s in normal for s in row['normal']):collisions.append({'id':row['id'],'kind':'canonical-source'})
        if row['delex'] in delex:collisions.append({'id':row['id'],'kind':'delexicalized-source'})
    result={'all_checked':True,'cases_checked':192,'new_web_cases_checked':6,'inventory_sha256':plan['inventory_sha256'],
        'original_files_verified':len(inventory['files']),'canonical_sources':len(normal),'delexicalized_sources':len(delex),
        'collisions':collisions,'model_weights_loaded':False,'training_executed':False}
    write_json(out/'private-exclusion-result.json',result)
    if collisions:raise ValueError('Original/private training or evaluation source overlap; no model loaded')
    print(json.dumps({'event':'private_source_exclusion','cases':198,'collisions':0,'model_weights_loaded':False}),flush=True)
    return result
