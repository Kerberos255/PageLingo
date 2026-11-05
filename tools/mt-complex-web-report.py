"""Join immutable live-page evidence with an explicitly separate assistant audit."""
import argparse
from collections import Counter
import hashlib
import html
import json
from pathlib import Path
import statistics


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    for name in ['root', 'browser', 'audit', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError('Preserve earlier reports')
    args.output.mkdir(parents=True)
    plan_file = args.root / 'plan-final.json'
    plan = json.loads(plan_file.read_text())
    capture = json.loads((args.root / 'capture-final/result.json').read_text())
    browser = json.loads(args.browser.read_text())
    audit = json.loads(args.audit.read_text())
    assert audit['plan_sha256'] == sha(plan_file)
    assert audit['browser_sha256'] == sha(args.browser)
    assert audit['independent_human_review'] is False and audit['optimizer_inputs_approved'] is False
    rows = [r for s in browser['sites'] for r in s.get('replays', [])]
    assert browser.get('finished_utc') and browser['accept_insecure_certs'] is False
    key = lambda r: (r['model'], r['id'], r['mode'])
    assert len({key(r) for r in rows}) == len(rows)
    checks = ['original_structure_unchanged', 'ancestor_structure_unchanged', 'code_unchanged',
              'link_targets_and_handler_properties_unchanged', 'nonnavigation_listener_sentinel_preserved',
              'restored_exact', 'restored_source_text_nodes']
    models = json.loads((args.root / 'models.json').read_text())
    output = {'protocol': 'complex-live-web-v10-report', 'plan_sha256': sha(plan_file),
              'capture_sha256': sha(args.root / 'capture-final/result.json'), 'browser_sha256': sha(args.browser),
              'production_enabled': False, 'model_published': False, 'training_executed': False,
              'independent_human_review': False, 'optimizer_inputs_approved': False,
              'live_site_count': len(capture['sites']), 'selected_samples': plan['selected_count'],
              'preparation_refusals': plan['excluded_before_inference'], 'inferred_samples_per_model': len(plan['cases']),
              'browser_version': browser['browser_version'], 'new_browser_model_inference': False,
              'limitations': ['Source-selected stress sample, not a random website accuracy estimate.',
                              'Native CPU model outputs replayed into live Firefox DOM; no installed extension/WASM model inference.',
                              'No external link navigation or original addEventListener enumeration; node/attribute/onclick identity and custom nonnavigation sentinel tested.',
                              'Ancestor root relationships do not by themselves establish overlapping text ownership.',
                              'Source-mismatched live reloads are refused and untested, not structural passes.',
                              'Semantic and markup-range judgments are assistant reviews, not independent human certification.'],
              'source_capture': capture, 'plan': plan, 'browser': browser, 'audit': audit, 'models': []}
    reviewed = {(r['model'], r['id']): r for r in audit['rows']}
    assert len(reviewed) == len(models) * len(plan['cases'])
    for m in models:
        native = json.loads(Path(m['run']).read_text())
        frozen = json.loads(Path(m['frozen_plan']).read_text())
        align = json.loads(Path(m['alignment']).read_text())
        assert native['finished_utc'] and native['plan_sha256'] == sha(plan_file)
        assert frozen['natural_run_sha256'] == sha(Path(m['run']))
        assert align['plan_sha256'] == sha(Path(m['frozen_plan']))
        stats = {'name': m['name'], 'native_run': native, 'frozen_plan': frozen, 'alignment': align,
                 'eos': sum(g['finish_reason'] == 'stop' for g in native['generations']),
                 'generations': len(native['generations']), 'ready_wall_s': native['ready_wall_s'], 'proc_status': native['proc_status'],
                 'align_source_unsupported': len(frozen['excluded']), 'align_attempted': len(align['rows']),
                 'align_statuses': dict(Counter(r['status'] for r in align['rows'])),
                 'align_reasons': dict(Counter(r.get('reason', 'projected') for r in align['rows'])),
                 'align_median_inference_s': statistics.median(r['inference_s'] for r in align['rows']),
                 'align_process_memory': align['process_memory'], 'modes': {}}
        for mode in ['production', 'projection']:
            subset = [r for r in rows if r['model'] == m['name'] and r['mode'] == mode]
            matched = [r for r in subset if r['source_matches']]
            stats['modes'][mode] = {'records': len(subset), 'source_matches': len(matched),
                                   'displayed': sum(r['displayed'] for r in matched),
                                   'refused_retained': sum(not r['displayed'] and r['rejected_source_untouched'] for r in matched),
                                   'checks': {k: sum(r[k] for r in matched) for k in checks},
                                   'refusal_reasons': dict(Counter(r['reason'] for r in matched if not r['displayed'])),
                                   'new_horizontal_overflow': [r['id'] for r in matched if r['displayed']
                                       and not r['dimensions_before']['horizontal_overflow'] and r['dimensions_after']['horizontal_overflow']]}
        for field in ['natural_meaning', 'production_meaning', 'production_ranges', 'projection_ranges']:
            stats[field] = dict(Counter(reviewed[(m['name'], c['id'])][field] for c in plan['cases']))
        output['models'].append(stats)
    (args.output / 'summary.json').write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n')
    e = lambda s: html.escape(str(s))
    blocks = ['<!doctype html><meta charset="utf-8"><title>PageLingo complex live web v10</title><style>body{max-width:1400px;margin:auto;padding:24px;font:16px system-ui}section{border-top:2px solid #aaa;margin:24px 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f4f4;padding:12px}h3{margin-bottom:0}</style><h1>复杂真实网页：源文、真实输出与独立范围审核记录</h1><p>仅助手审查。结构保留与格式语义分开；拒绝保留原文不算成功翻译。浏览器运行原节点回放，未在浏览器中运行模型。</p>']
    for c in plan['cases']:
        blocks.append('<section><h2>' + e(c['id']) + '</h2><p><a href="' + e(c['context_url']) + '">原网站</a> · ' + e(c['bucket']) + '</p><h3>实际 owned source</h3><pre>' + e(c['source_text']) + '</pre>')
        for m in models:
            s = next(s for s in output['models'] if s['name'] == m['name'])
            native = next(g for g in s['native_run']['generations'] if g['case_id'] == c['id'] and g['variant'] == 'natural-visible')
            blocks.append('<h3>' + e(m['name']) + '</h3><pre>' + e(native['text']) + '</pre><div class="grid">')
            for mode in ['production', 'projection']:
                r = next(r for r in rows if key(r) == (m['name'], c['id'], mode))
                blocks.append('<div><h4>' + e(mode) + '</h4><pre>' + e(json.dumps(r, ensure_ascii=False, indent=2)) + '</pre></div>')
            blocks.append('</div><h4>助手审核</h4><pre>' + e(json.dumps(reviewed[(m['name'], c['id'])], ensure_ascii=False, indent=2)) + '</pre>')
        blocks.append('</section>')
    (args.output / 'comparison.html').write_text('\n'.join(blocks))
    print(json.dumps({'sites': output['live_site_count'], 'selected': output['selected_samples'], 'browser_records': len(rows),
                      'models': [{k: m[k] for k in ['name', 'eos', 'generations', 'modes', 'natural_meaning', 'production_meaning', 'production_ranges', 'projection_ranges']} for m in output['models']]}, ensure_ascii=False))


if __name__ == '__main__':
    main()
