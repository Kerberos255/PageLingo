"""Owned-region policy; literal punctuation is distinct from code-word anchors."""
from functools import lru_cache
import re


def u16(text, i):
    return len(text[:i].encode('utf-16-le')) // 2


def readonly_owned(annotations, target):
    atoms = [a for a in annotations if a['immutable']]
    candidates = []
    for a in atoms:
        if not a['text']:
            raise ValueError('empty owned immutable annotation')
        literal = re.escape(a['text'])
        pattern = r'(?<![A-Za-z0-9_$])' + literal + r'(?![A-Za-z0-9_$])' if a['anchor_kind'] == 'opaque' else literal
        candidates.append([(u16(target, m.start()), u16(target, m.end())) for m in re.finditer(pattern, target)])

    @lru_cache(None)
    def count(i, end):
        if i == len(atoms):
            return 1
        total = 0
        for start, stop in candidates[i]:
            if start >= end:
                total = min(2, total + count(i + 1, stop))
                if total == 2:
                    break
        return total

    if count(0, 0) != 1:
        raise ValueError('owned immutable anchors missing, reordered or ambiguous')
    chosen, end = {}, 0
    for i, a in enumerate(atoms):
        start, stop = next((x, z) for x, z in candidates[i] if x >= end and count(i + 1, z))
        chosen[a['id']] = (start, stop)
        end = stop
    return chosen
