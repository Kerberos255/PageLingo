"""Export measured pairs for independent review. Does not build an executable task."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'training/mt-fixed-slots'))
from mining_selection import select_family_capped
from evaluate_gpu import sha256,write_json


def main():
    parser=argparse.ArgumentParser()
    for name in ['plan','replay','audit','scores','output']:parser.add_argument('--'+name,type=Path,required=True)
    args=parser.parse_args()
    if args.output.exists():raise ValueError('Use a new curation output')
    plan=json.loads(args.plan.read_text());replay=json.loads(args.replay.read_text());audit=json.loads(args.audit.read_text());scores=json.loads(args.scores.read_text())
    if not scores.get('finished_utc') or scores.get('training_executed') is not False or scores.get('grammar_applied_to_likelihood') is not False:
        raise ValueError('Completed nontraining BF16 likelihood audit required')
    if scores['versions']['transformers']!='5.17.0' or scores['versions']['peft']!='0.21.0':raise ValueError('Use the same Transformers/PEFT versions as the GPU run')
    for name in ['plan','replay','audit']:
        if scores['inputs_sha256'][name]!=sha256(getattr(args,name)):raise ValueError('Curation inputs changed')
    by_id={s['id']:s for s in plan['cases']};outputs={s['id']:s for s in replay['rows']};jobs={s['case_id']:s for s in plan['jobs']}
    selected=select_family_capped(scores['rows']);pairs=[]
    for score in selected:
        identity=score['id'];source=by_id[identity];actual=outputs[identity];decision=score['audit']
        if source['split']!='train' or not actual['replay']['displayed'] or decision['actual_output_sha256']!=actual['actual_output_sha256']:
            raise ValueError('Unusable source or generated negative')
        pairs.append({'id':'mined-v7/'+identity,'source_id':identity,'split':'train','family':source['family'],
            'source_html':source['html'],'source_reference_provenance':source['review_status'],
            'review_status':'assistant_audited_mined_needs_independent_review','independent_review':'pending',
            'prompt':jobs[identity]['request']['messages'],'chosen':source['reference_wire'],'rejected':actual['actual_output'],
            'reference_text':actual['reference_text'],'actual_text':actual['replay']['translated_text'],
            'audit':decision,'mining_model':replay['model'],'measured_bf16_preference':score,
            'actual_output_sha256':actual['actual_output_sha256']})
    args.output.mkdir(parents=True)
    raw=''.join(json.dumps(row,ensure_ascii=False)+'\n'for row in pairs)
    (args.output/'candidate-pairs.jsonl').write_text(raw)
    manifest={'schema_version':1,'corpus':'mined-hard-negative-candidates-v7','protocol':'production-fixed-text-v1',
        'scope':'Measured training-source candidate pairs for independent review; incompatible with current training manifests until explicitly integrated.',
        'optimizer_inputs_approved':False,'training_executed':False,'new_gpu_task_installed':False,'independently_human_reviewed':False,
        'mining_generations':replay['actual_generations'],'model_outputs_displayed':replay['displayed'],
        'audit_verdicts':dict(Counter(row['verdict']for row in audit['rows'])),'bf16_scored_errors':len(scores['rows']),
        'bf16_preferred_errors_before_family_cap':sum(row['hard_negative_candidate']for row in scores['rows']),
        'selected_pairs':len(pairs),'selected_families':len({row['family']for row in pairs}),
        'selected_error_types':dict(Counter(row['audit']['verdict']for row in pairs)),
        'selection_policy':'Post-measurement curation: at most two per family, prioritize before/after coverage, then error/scope diversity, then measured sequence margin. Not a pre-registered benchmark.',
        'inputs_sha256':{name:sha256(getattr(args,name))for name in ['plan','replay','audit','scores']},
        'file':{'name':'candidate-pairs.jsonl','bytes':len(raw.encode()),'sha256':hashlib.sha256(raw.encode()).hexdigest()},
        'thresholds':scores['thresholds'],'reference_notice':'Assistant references are not independently human reviewed. Ambiguous transfer-as-money references were excluded.'}
    write_json(args.output/'manifest.json',manifest)
    review_ids=[
        'v6-train-temporal-snapshot-after-code','v6-train-temporal-receipt-after-code',
        'v6-train-temporal-partition-after-code','v6-train-temporal-catalog-after-code',
        'v6-train-temporal-certificate-after-code','v6-train-temporal-sample-after-text',
        'v5-train-certificate-attestations-0-after','v5-train-nonce-lifetimes-0',
        'v6-train-temporal-snapshot-before-text','v6-train-temporal-receipt-before-code',
        'v6-train-temporal-partition-after-text','v6-train-temporal-certificate-before-code']
    found={p['source_id']:p for p in pairs};assert all(identity in found for identity in review_ids)
    table=['# 12 条独立抽查短表','',
        '请看英文和两段中文，判断建议参考是否忠实、模型输出是否确实错义或改变强调范围。参考由助手整理，仍待你的独立抽查。',
        '可以回复“1–12 均同意”，或列出有异议的编号和修改。抽查不等于全部 17 条或模型质量已经通过。此文件不会自动启动训练。','',
        '| 编号 | 英文原句 | 建议正确参考（待审核） | 模型实际输出 | 助手判定 |',
        '| --- | --- | --- | --- | --- |']
    import re
    def clean(value):return re.sub(r'\s+',' ',value).strip().replace('|','\\|').replace('<','&lt;').replace('>','&gt;')
    for number,identity in enumerate(review_ids,1):
        p=found[identity];html=p['source_html']
        marked=re.sub(r'<(?:em|strong)>(.*?)</(?:em|strong)>',r'**\1**',html)
        english=re.sub('<[^>]+>','',marked)
        verdict=p['audit']['reason']
        if p['audit']['verdict']=='scope_error':
            observed=outputs[identity]['translated_labels'];label=' / '.join(x['text']or''for x in observed)
            verdict+=' 模型强调：'+label
        table.append('| '+str(number)+' | '+clean(english)+' | '+clean(p['reference_text'])+' | '+clean(p['actual_text'])+' | '+clean(verdict)+' |')
    table+=['','编号到训练源句 ID（仅用于记录，不必逐字检查标记）：','']+[f'{i}. `{identity}`'for i,identity in enumerate(review_ids,1)]
    (args.output/'review-12.md').write_text('\n'.join(table)+'\n')
    write_json(args.output/'review-12-ids.json',{'source_ids':review_ids,'independent_review':'pending'})
    print(json.dumps({k:manifest[k]for k in ['selected_pairs','selected_families','selected_error_types','optimizer_inputs_approved']}))
    return 0


if __name__=='__main__':raise SystemExit(main())
