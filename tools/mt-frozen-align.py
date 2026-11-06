"""CPU research: frozen text + contextual mBERT alignment, no translator/trainer."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import re
import time


def sha(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def u16(text, i):
    return len(text[:i].encode('utf-16-le')) // 2


def readonly_spans(annotations, target):
    atoms = [a for a in annotations if a['immutable']]
    candidates = []
    for a in atoms:
        pattern = r'(?<![A-Za-z0-9_$])' + re.escape(a['text']) + r'(?![A-Za-z0-9_$])'
        candidates.append([(u16(target, m.start()), u16(target, m.end())) for m in re.finditer(pattern, target)])
    solutions = []
    def visit(i, end, current):
        if len(solutions) > 1: return
        if i == len(atoms): solutions.append(dict(current)); return
        for start, stop in candidates[i]:
            if start >= end: visit(i + 1, stop, current + [(atoms[i]['id'], (start, stop))])
    visit(0, 0, [])
    if len(solutions) != 1: raise ValueError('immutable anchors missing, reordered or ambiguous')
    return solutions[0]


def project(case, links, min_cosine, *, readonly_resolver=readonly_spans, inherit_full_parent_flows=False, close_label_colons=False, close_sentence_punctuation=False):
    words_s, words_t, annotations = case['source_words'], case['target_words'], case['annotations']
    chosen = readonly_resolver(annotations, case['frozen_target'])
    diagnostics = []
    for a in annotations:
        if a['id'] in chosen: continue
        if inherit_full_parent_flows and a.get('kind') == 'flow' and a.get('full_parent'):
            parent = next((p for p in annotations if p['id'] == a['parent']), None)
            expected = (parent['start'], parent['end']) if parent else (0, u16(case['source_text'], len(case['source_text'])))
            if (a['start'], a['end']) != expected or a['parent'] is not None and a['parent'] not in chosen:
                raise ValueError('invalid full-parent flow witness')
            chosen[a['id']] = chosen[a['parent']] if parent else (0, u16(case['frozen_target'], len(case['frozen_target'])))
            continue
        # Code-only links/format wrappers share their immutable descendant's range.
        same = [b for b in annotations if b['immutable'] and b['start'] == a['start'] and b['end'] == a['end']]
        if len(same) == 1:
            chosen[a['id']] = chosen[same[0]['id']]; continue
        # A unique unchanged whole word is a supported deterministic tag anchor.
        matches = list(re.finditer(r'(?<![A-Za-z0-9_$])' + re.escape(a['text']) + r'(?![A-Za-z0-9_$])', case['frozen_target']))
        if len(matches) == 1:
            m = matches[0]; chosen[a['id']] = (u16(case['frozen_target'], m.start()), u16(case['frozen_target'], m.end())); continue
        if a['parent'] is not None and a['parent'] not in chosen: raise ValueError('parent annotation unresolved')
        lo, hi = chosen.get(a['parent'], (0, u16(case['frozen_target'], len(case['frozen_target']))))
        if any(w['lexical'] and w['start'] < a['end'] and w['end'] > a['start']
               and not (w['start'] >= a['start'] and w['end'] <= a['end']) for w in words_s):
            raise ValueError('source annotation cuts a lexical word')
        src = {i for i, w in enumerate(words_s) if w['lexical'] and w['start'] >= a['start'] and w['end'] <= a['end']
               and w['text'].lower() not in ['a', 'an', 'the']}
        if not src: raise ValueError('no complete content word in source annotation')
        allowed = [j for j, w in enumerate(words_t) if w['lexical'] and lo <= w['start'] and w['end'] <= hi]
        if not allowed: raise ValueError('no target words inside parent range')
        anchored_children = [chosen[b['id']] for b in annotations if b['immutable'] and a['start'] <= b['start'] and b['end'] <= a['end']]
        ranked = []
        for left in range(len(allowed)):
            for right in range(left, len(allowed)):
                start, end = words_t[allowed[left]]['start'], words_t[allowed[right]]['end']
                if any(start > x or end < y for x, y in anchored_children): continue
                covered = {i for i, j, sim in links if i in src and start <= words_t[j]['start'] and words_t[j]['end'] <= end}
                if covered != src: continue
                # Maximizing inside+outside links is equivalent to this difference,
                # up to the constant total number of outside-source links.
                score = sum((1 if i in src else -1) for i, j, sim in links if start <= words_t[j]['start'] and words_t[j]['end'] <= end)
                ranked.append((score, -(end - start), start, end))
        if not ranked: raise ValueError('full source content-word coverage unavailable')
        best = max((x[0], x[1]) for x in ranked)
        options = [(x[2], x[3]) for x in ranked if (x[0], x[1]) == best]
        if len(options) != 1 or best[0] <= 0: raise ValueError('ambiguous or nonpositive tag projection')
        chosen[a['id']] = options[0]
        diagnostics.append({'id': a['id'], 'source_words': sorted(src), 'score': best[0], 'candidate_ties': len(options)})
    if close_label_colons:
        target16 = case['frozen_target'].encode('utf-16-le')
        for a in annotations:
            if a.get('kind') != 'format' or a['immutable'] or not a['text'].rstrip().endswith(':'): continue
            start, end = chosen[a['id']]
            if target16[2 * start:2 * end].decode('utf-16-le').endswith((':', '：')): continue
            if target16[2 * end:2 * (end + 1)] not in [':'.encode('utf-16-le'), '：'.encode('utf-16-le')]:
                raise ValueError('format label colon missing from scope')
            chosen[a['id']] = (start, end + 1)
            diagnostics.append({'id': a['id'], 'rule': 'include_immediately_adjacent_source_label_colon',
                                'original_span': [start, end], 'new_span': [start, end + 1]})
    if close_sentence_punctuation:
        target16 = case['frozen_target'].encode('utf-16-le')
        marks = {'.': ['.', '。'], '!': ['!', '！'], '?': ['?', '？']}
        for a in annotations:
            text = a['text'].rstrip(); symbol = text[-1:] if text else ''
            if a.get('kind') != 'format' or a['immutable'] or symbol not in marks: continue
            if len(re.findall(r"[A-Za-z]+(?:[-'][A-Za-z]+)*", text)) < 2 or re.search(r'(?:[A-Za-z]\.){2,}$', text): continue
            start, end = chosen[a['id']]; allowed = [s.encode('utf-16-le') for s in marks[symbol]]
            if target16[2 * (end - 1):2 * end] in allowed: continue
            if target16[2 * end:2 * (end + 1)] not in allowed: raise ValueError('format sentence punctuation missing from scope')
            chosen[a['id']] = (start, end + 1)
            diagnostics.append({'id': a['id'], 'rule': 'include_immediately_adjacent_source_sentence_punctuation',
                                'original_span': [start, end], 'new_span': [start, end + 1]})
    return [{'id': a['id'], 'start': chosen[a['id']][0], 'end': chosen[a['id']][1]} for a in annotations], diagnostics


def main():
    parser = argparse.ArgumentParser()
    for name in ['plan', 'model', 'output']: parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    args = parser.parse_args()
    if args.output.exists(): raise ValueError('Use a new result file')
    plan = json.loads(args.plan.read_text())
    if plan.get('protocol') not in ['frozen-target-span-projection-v9', 'production-owned-projection-v11', 'typed-punctuation-projection-v12', 'collapsible-whitespace-projection-v13', 'frozen-prose-gaps-v14'] or plan.get('evaluation_only') is not True or plan.get('optimizer_inputs_approved') is not False: raise ValueError('Expected frozen evaluation plan')
    owned_policy = plan['protocol'] in ['production-owned-projection-v11', 'typed-punctuation-projection-v12', 'collapsible-whitespace-projection-v13', 'frozen-prose-gaps-v14']
    if owned_policy:
        from mt_owned_projection import readonly_owned
    root = Path(__file__).resolve().parents[1]
    for name, expected in plan['source_hashes'].items():
        p = (root / name).resolve()
        if not p.is_relative_to(root) or sha(p) != expected: raise ValueError('Frozen projection source changed')
    if sha(args.model / 'model.onnx') != args.sha256: raise ValueError('Alignment model changed')
    import numpy as np
    import onnxruntime as ort
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(args.model, local_files_only=True, trust_remote_code=False)
    if not tokenizer.is_fast: raise ValueError('Offset-aware tokenizer required')
    options = ort.SessionOptions(); options.intra_op_num_threads = 2; options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    started = time.perf_counter(); session = ort.InferenceSession(str(args.model / 'model.onnx'), sess_options=options, providers=['CPUExecutionProvider'])
    result = {'protocol': plan['protocol'], 'plan_sha256': sha(args.plan), 'model_sha256': args.sha256,
        'model_bytes': (args.model / 'model.onnx').stat().st_size, 'model_directory': str(args.model.resolve()),
        'model_identity_notice': 'Public cstr export card identifies truncated pretrained multilingual BERT layer 8; not asserted to be the fine-tuned official AWESOME checkpoint.',
        'tokenizer_files_sha256': {p.name: sha(p) for p in args.model.glob('*.json')},
        'runtime': ort.__version__, 'device': 'CPUExecutionProvider', 'threads': 2, 'rules': plan['rules'],
        'load_window_s_warm_cache': time.perf_counter() - started, 'new_translator_generations': 0, 'training_executed': False, 'rows': []}
    for case in plan['cases']:
        began = time.perf_counter(); texts = [case['source_text'], case['frozen_target']]
        encoded = tokenizer(texts, padding=True, truncation=False, return_offsets_mapping=True, return_tensors='np')
        if encoded['input_ids'].shape[1] > 512: raise ValueError('Refusing to truncate alignment input')
        feed = {key: np.asarray(encoded[key], dtype=np.int64) for key in ['input_ids', 'attention_mask']}
        t = time.perf_counter(); hidden = session.run(None, feed)[0]; inference_s = time.perf_counter() - t
        groups = []
        for b, (text, words) in enumerate(zip(texts, [case['source_words'], case['target_words']])):
            offsets = [(u16(text, int(a)), u16(text, int(z))) for a, z in encoded['offset_mapping'][b]]
            vec = []
            for w in words:
                indices = [i for i, (a, z) in enumerate(offsets) if a < z and a < w['end'] and z > w['start']]
                vec.append(hidden[b, indices].mean(axis=0) if indices else np.zeros(hidden.shape[-1], dtype=np.float32))
            values = np.stack(vec); values /= np.maximum(np.linalg.norm(values, axis=1, keepdims=True), 1e-12); groups.append(values)
        sim = groups[0] @ groups[1].T
        for i, w in enumerate(case['source_words']):
            if not w['lexical']: sim[i, :] = -2
        for j, w in enumerate(case['target_words']):
            if not w['lexical']: sim[:, j] = -2
        forward, backward = np.argmax(sim, axis=1), np.argmax(sim, axis=0)
        links = [(i, int(j), float(sim[i, j])) for i, j in enumerate(forward) if backward[j] == i and sim[i, j] >= plan['rules']['min_cosine']]
        row = {'id': case['id'], 'target_sha256': hashlib.sha256(case['frozen_target'].encode()).hexdigest(), 'links': links,
               'inference_s': inference_s, 'input_ids_sha256': hashlib.sha256(feed['input_ids'].tobytes()).hexdigest()}
        try:
            kwargs = {'readonly_resolver': readonly_owned, 'inherit_full_parent_flows': True} if owned_policy else {}
            if plan['protocol'] == 'typed-punctuation-projection-v12': kwargs['close_label_colons'] = True
            if plan['protocol'] in ['collapsible-whitespace-projection-v13', 'frozen-prose-gaps-v14']: kwargs['close_label_colons'] = plan['rules']['source_label_colon_closure']
            if plan['protocol'] == 'frozen-prose-gaps-v14': kwargs['close_sentence_punctuation'] = True
            row['spans'], row['projection_diagnostics'] = project(case, links, plan['rules']['min_cosine'], **kwargs); row['status'] = 'projected'
        except ValueError as error:
            row.update(status='rejected', reason=str(error), spans=[])
        row['wall_s'] = time.perf_counter() - began; result['rows'].append(row)
        result['process_memory'] = [s for s in Path('/proc/self/status').read_text().splitlines() if s.startswith(('VmHWM:', 'VmRSS:'))]
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'id': case['id'], 'status': row['status'], 'reason': row.get('reason')}), flush=True)
    result['finished_utc'] = datetime.datetime.now(datetime.timezone.utc).isoformat(); args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__': main()
