"""Limit correlated mined candidates. Selection is curation, not an accuracy score."""
from collections import defaultdict
import itertools
import re


def select_family_capped(rows, cap=2):
    if cap != 2: raise ValueError('This pilot has a fixed maximum of two sources per family')
    groups=defaultdict(list);seen=set()
    for row in rows:
        if row['id'] in seen or row.get('split')!='train': raise ValueError('Duplicate or reserved scored source')
        seen.add(row['id'])
        if row.get('hard_negative_candidate') is True: groups[row['family']].append(row)
    selected=[]
    def direction(identity):
        result=re.search(r'(?:^|-)(before|after)(?:-|$)',identity)
        return result.group(1) if result else 'other'
    for group in groups.values():
        def priority(pair):
            return (len({direction(x['id'])for x in pair}),len({x['audit']['verdict']for x in pair}),
                sum(x['actual_minus_chosen_sequence_logp']for x in pair),tuple(x['id']for x in pair))
        selected.extend(max(itertools.combinations(group,min(cap,len(group))),key=priority))
    return sorted(selected,key=lambda row:row['id'])
