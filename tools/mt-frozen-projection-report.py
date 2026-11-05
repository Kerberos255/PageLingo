"""Summarize completed frozen-text projection and a separate scope review."""
import argparse
import hashlib
import html
import json
from pathlib import Path
import statistics


def read(p): return json.loads(p.read_text())
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--root', type=Path, required=True); args = parser.parse_args()
    r = args.root; plan_file = r / 'final-plan.json'; plan = read(plan_file); audit = read(r / 'scope-audit.json')
    assert audit['plan_sha256'] == sha(plan_file) and audit['production_enabled'] is False and audit['independent_human_review'] is False
    assert len({c['id'] for c in plan['cases']}) == len(plan['cases']) == len(audit['rows'])
    audits = {a['id']: a for a in audit['rows']}; summary = {'protocol': plan['protocol'], 'plan_sha256': sha(plan_file),
        'plan': plan, 'audit': audit, 'production_enabled': False, 'new_translator_generations': 0, 'training_executed': False,
        'principle': 'Original nodes, hierarchy, attributes, code, listeners and semantic markup ranges before translation quality and coverage.', 'models': {}}
    for name in ['fp32', 'int8']:
        run_file, replay_file = r / (name + '-final-run.json'), r / (name + '-final-replay.json')
        run, replay = read(run_file), read(replay_file)
        assert run.get('finished_utc') and run['plan_sha256'] == replay['plan_sha256'] == sha(plan_file)
        assert replay['alignment_run_sha256'] == sha(run_file)
        assert len(run['rows']) == len(replay['results']) == len(plan['cases'])
        counts = {}; cases = []
        for sample, row, output in zip(plan['cases'], run['rows'], replay['results']):
            assert sample['id'] == row['id'] == output['id']
            assert row['target_sha256'] == hashlib.sha256(sample['frozen_target'].encode()).hexdigest()
            a = audits[sample['id']]
            assert output['original_structure_unchanged'] and output['code_unchanged'] and output['original_link_listeners_preserved'] and output['restored_exact'] and output['surrounding_text_unchanged']
            if output['displayed']: assert output['frozen_target_exact']
            else: assert output['rejected_source_untouched'] and a['decision'] == 'not_projected'
            counts[a['decision']] = counts.get(a['decision'], 0) + 1
            cases.append({'id': sample['id'], 'alignment': row, 'replay': output, 'scope_audit': a})
        summary['models'][name] = {'model_sha256': run['model_sha256'], 'model_bytes': run['model_bytes'],
            'model_identity_notice': run['model_identity_notice'], 'run_sha256': sha(run_file), 'replay_sha256': sha(replay_file),
            'load_window_s_warm_cache': run['load_window_s_warm_cache'], 'process_memory': run['process_memory'],
            'encoder_pair_inference_median_s': statistics.median(x['inference_s'] for x in run['rows']),
            'alignment_wall_sum_s': sum(x['wall_s'] for x in run['rows']),
            'formally_replayed_cases': len(cases), 'structurally_displayed': sum(x['replay']['displayed'] for x in cases),
            'posthoc_assistant_scope_decisions': counts, 'neural_projection_roles': sum(len(x.get('projection_diagnostics', [])) for x in run['rows']),
            'cases': cases}
    a, b = summary['models']['fp32']['cases'], summary['models']['int8']['cases']
    summary['fp32_int8_identical_spans_status'] = all(x['alignment']['status'] == y['alignment']['status'] and x['alignment']['spans'] == y['alignment']['spans'] for x, y in zip(a, b))
    browser_file = r / 'firefox-dom/result.json'; browser = read(browser_file)
    assert browser['plan_sha256'] == sha(plan_file)
    actual, manual = browser['actual'], browser['manual_structure_fixtures']
    assert len(actual) == len(plan['cases']) * 2
    fields = ['original_structure_unchanged', 'code_unchanged', 'original_link_listeners_preserved', 'surrounding_text_unchanged', 'restored_exact']
    assert all(row[k] for row in actual + manual for k in fields)
    assert all(row['node_text_matches'] and row['node_display_matches'] for row in actual)
    assert all(row['expected_display_matches'] for row in manual)
    summary['firefox'] = {'version': browser['browser_version'], 'result_sha256': sha(browser_file), 'actual_encoder_assignments': len(actual),
        'manual_structure_fixtures': len(manual), 'checks': {k: sum(row[k] for row in actual + manual) for k in fields},
        'new_browser_translator_or_aligner_inference': False}
    summary['environment'] = read(r / 'environment.json')
    summary['model_downloads'] = read(r / 'model-downloads.json')
    (r / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    esc = lambda s: html.escape(str(s)); pieces = ['<!doctype html><meta charset="utf-8"><title>Frozen text projection v9</title>',
        '<style>body{font:16px/1.6 system-ui;max-width:1200px;margin:auto;padding:24px}table{border-collapse:collapse;width:100%;table-layout:fixed}td,th{border:1px solid #bbb;padding:12px;vertical-align:top;overflow-wrap:anywhere}pre{white-space:pre-wrap}details{margin:20px 0}</style>',
        '<h1>结构优先的冻结译文投影：实际对齐与范围审核</h1><p>译文来自已有 v8 自然输出，本轮没有新翻译生成。显示只说明可在原节点回填；范围审核独立记录。before→后 暂列争议，默认流程未切换。</p>']
    for i, sample in enumerate(plan['cases']):
        pieces += [f'<details open><summary>{esc(sample["id"])} · {esc(audits[sample["id"]]["decision"])}</summary>',
            f'<p>{esc(audits[sample["id"]]["reason"])}</p><pre>{esc(sample["source_text"])}</pre><p>冻结中文：</p><pre>{esc(sample["frozen_target"])}</pre>',
            '<table><tr><th>模型</th><th>实际回填结果</th><th>链接与格式的源 / 目标范围</th></tr>']
        for name in ['fp32', 'int8']:
            row = summary['models'][name]['cases'][i]; out = row['replay']
            labels = '\n'.join(x['tag'] + ': ' + x['source'] + ' → ' + (x['target'] or '') for x in out['labels'])
            pieces += [f'<tr><th>{name}</th><td><b>{"候选已显示" if out["displayed"] else "保留原文"}</b><p>{esc(row["alignment"].get("reason", ""))}</p><pre>{esc(out["translated_text"])}</pre></td><td><pre>{esc(labels)}</pre></td></tr>']
        pieces += ['</table></details>']
    (r / 'comparison.html').write_text('\n'.join(pieces))
    print(json.dumps({name: {k: m[k] for k in ['structurally_displayed', 'posthoc_assistant_scope_decisions', 'encoder_pair_inference_median_s', 'process_memory']} for name, m in summary['models'].items()}, ensure_ascii=False))


if __name__ == '__main__': main()
