"""Score verified replay results against frozen public references, with display coverage."""
import argparse
import hashlib
import json
from pathlib import Path

import sacrebleu
from sacrebleu.metrics import CHRF


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--comparison', type=Path, required=True)
    parser.add_argument('--references', type=Path, default=Path(__file__).resolve().parents[1] / 'eval/mt-quality/external/flores200-32.json')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if sacrebleu.__version__ != '2.5.1':
        raise ValueError('Use sacrebleu==2.5.1 for the frozen scoring settings')
    if args.output.exists():
        raise ValueError('Use a new output file to preserve preceding measurements')
    comparison = json.loads(args.comparison.read_text(encoding='utf-8'))
    if comparison.get('test_fixture'):
        raise ValueError('Synthetic replay fixtures are not measured model outputs')
    references = json.loads(args.references.read_text(encoding='utf-8'))
    rows = {row['id']: row for row in comparison['cases']}
    if len(rows) != len(comparison['cases']):
        raise ValueError('Duplicate replay case IDs')
    samples = references['cases']
    if len(samples) != 32 or len({s['id'] for s in samples}) != 32:
        raise ValueError('The frozen external subset must contain 32 distinct pairs')
    labels = sorted(rows[samples[0]['id']]['models'])
    if not labels:
        raise ValueError('No model results')
    for sample in samples:
        row = rows[sample['id']]
        if sample['review_status'] != 'external_published_reference' or len(sample['reference_slots']) != 1:
            raise ValueError('Unexpected reference provenance or structure')
        if row['reference_status'] != sample['review_status'] or sorted(row['models']) != labels:
            raise ValueError('Reference/model coverage mismatch')
        for label in labels:
            value = row['models'][label]
            if not all(value[k] for k in ['original_structure_unchanged', 'code_unchanged', 'restored_exact']):
                raise ValueError('A structural replay failed; inspect it before scoring')
            if not isinstance(value['translated_text'], str) or not isinstance(value['displayed'], bool):
                raise ValueError('Missing actual displayed output')
    common = [s for s in samples if all(rows[s['id']]['models'][label]['displayed'] for label in labels)]
    scorer = CHRF(char_order=6, word_order=0, beta=2, lowercase=False, whitespace=False, eps_smoothing=False)
    def score(subset, label):
        if not subset:
            return None
        return scorer.corpus_score([rows[s['id']]['models'][label]['translated_text'] for s in subset],
                                   [[s['reference_slots'][0] for s in subset]]).score
    metrics = {label: {'displayed': sum(rows[s['id']]['models'][label]['displayed'] for s in samples),
                       'cases': len(samples), 'chrf2_displayed_or_retained_source': score(samples, label),
                       'chrf2_common_displayed': score(common, label)} for label in labels}
    result = {'interpretation': 'chrF2 is reference character overlap, not semantic accuracy or release approval. The all-case score includes original source text where production rejected a translation; the common score uses the same accepted subset for every arm.',
              'reference_provenance': references['source'], 'common_displayed_cases': len(common),
              'sacrebleu_version': sacrebleu.__version__, 'signature': str(scorer.get_signature()),
              'input_sha256': {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in [('comparison', args.comparison), ('references', args.references)]},
              'models': metrics, 'release_approved': False,
              'per_case': [{'id': s['id'], 'reference': s['reference_slots'][0],
                            'models': {label: {'displayed': rows[s['id']]['models'][label]['displayed'],
                                               'text': rows[s['id']]['models'][label]['translated_text'],
                                               'sentence_chrf2': scorer.sentence_score(rows[s['id']]['models'][label]['translated_text'], [s['reference_slots'][0]]).score}
                                       for label in labels}} for s in samples]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'models': metrics, 'common_displayed_cases': len(common), 'signature': result['signature']}))


if __name__ == '__main__':
    main()
