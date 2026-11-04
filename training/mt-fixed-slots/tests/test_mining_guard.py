import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'tools'))
from mt_mining_guard import validate_mining_plan


class TrainingMiningGuard(unittest.TestCase):
    def plan(self):
        request = {'messages':[{'role':'user','content':'固定源句'}], 'max_tokens':64, 'grammar':'root ::= "frame"'}
        return {'protocol':'fixed-training-error-mining-v1','grammar_applied':True,'heldout_sources_in_jobs':False,
            'cases':[{'id':'source','split':'train','family':'training-family'}],
            'jobs':[{'case_id':'source','split':'train','family':'training-family','request':request,
                'request_sha256':hashlib.sha256(json.dumps(request,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()}]}

    def test_reserved_sources_never_enter_mining_even_when_the_request_is_valid(self):
        plan=self.plan();validate_mining_plan(plan)
        for split in ['validation','holdout','diagnostic']:
            bad=copy.deepcopy(plan);bad['cases'][0]['split']=split
            with self.subTest(split=split),self.assertRaises(ValueError):validate_mining_plan(bad)

    def test_missing_grammar_changed_input_and_duplicate_jobs_are_rejected(self):
        for mutation in ['grammar','input','duplicate','missing','family']:
            bad=self.plan()
            if mutation=='grammar':bad['jobs'][0]['request']['grammar']=None
            if mutation=='input':bad['jobs'][0]['request']['messages'][0]['content']='different'
            if mutation=='duplicate':bad['jobs'].append(copy.deepcopy(bad['jobs'][0]))
            if mutation=='missing':bad['jobs']=[]
            if mutation=='family':bad['jobs'][0]['family']='other'
            with self.subTest(mutation=mutation),self.assertRaises(ValueError):validate_mining_plan(bad)


if __name__=='__main__':unittest.main()
