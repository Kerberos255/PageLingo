import copy
import hashlib
import importlib.util
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('mining_score',ROOT/'tools/mt-mining-score.py')
score=importlib.util.module_from_spec(spec);spec.loader.exec_module(score)


class MiningLikelihoodGuard(unittest.TestCase):
    def inputs(self):
        text='⟦0⟧先删除，再保存。⟦/0⟧';digest=hashlib.sha256(text.encode()).hexdigest()
        plan={'protocol':'fixed-training-error-mining-v1','cases':[{'id':'train-only','split':'train','family':'a','reference_wire':'⟦0⟧先保存，再删除。⟦/0⟧'}]}
        row={'id':'train-only','split':'train','actual_output':text,'actual_output_sha256':digest,
             'generation':{'finish_reason':'stop'},'replay':{'displayed':True}}
        replay={'partial':False,'plan_sha256':'p','run_sha256':'r','rows':[row]}
        audit={'schema_version':1,'plan_sha256':'p','run_sha256':'r','replay_sha256':'q','rows':[{'id':'train-only',
            'actual_output_sha256':digest,'verdict':'semantic_error','reason':'Reversed save/delete order',
            'source_fact':'Save precedes delete','chosen_reference_confirmed':True}]}
        return plan,replay,audit

    def test_only_explicitly_reviewed_accepted_actual_errors_are_eligible(self):
        plan,replay,audit=self.inputs()
        self.assertEqual(len(score.audited_errors(plan,replay,audit,plan_sha256='p',replay_sha256='q')),1)
        for mutation in ['unreviewed','synonym','source-split','changed-output','missing-review','no-fact','rejected-frame','partial']:
            p,r,a=copy.deepcopy((plan,replay,audit))
            if mutation=='unreviewed':a['rows'][0]['verdict']='unreviewed'
            if mutation=='synonym':a['rows'][0]['verdict']='acceptable_alternative'
            if mutation=='source-split':p['cases'][0]['split']='holdout'
            if mutation=='changed-output':r['rows'][0]['actual_output']='modified'
            if mutation=='missing-review':a['rows']=[]
            if mutation=='no-fact':a['rows'][0]['source_fact']=''
            if mutation=='rejected-frame':r['rows'][0]['replay']['displayed']=False
            if mutation=='partial':r['partial']=True
            with self.subTest(mutation=mutation),self.assertRaises(ValueError):score.audited_errors(p,r,a,plan_sha256='p',replay_sha256='q')

    def test_shorter_sequence_preference_without_content_preference_is_not_hard(self):
        gold={'sequence_logp':-12.,'content_mean_logp':-.2}
        shorter={'sequence_logp':-8.,'content_mean_logp':-.3}
        self.assertFalse(score.is_hard_pair(gold,shorter)['hard_negative_candidate'])
        harder={'sequence_logp':-8.,'content_mean_logp':-.1}
        self.assertTrue(score.is_hard_pair(gold,harder)['hard_negative_candidate'])
        small_margin={'sequence_logp':-11.5,'content_mean_logp':-.1}
        self.assertFalse(score.is_hard_pair(gold,small_margin)['hard_negative_candidate'])

    def test_content_metric_excludes_marker_and_eos_tokens(self):
        value=score.likelihood_metrics({'content':{'tokens':2,'sum_nll':4.},'marker':{'tokens':20,'sum_nll':.1},'eos':{'tokens':1,'sum_nll':.01}})
        self.assertAlmostEqual(value['sequence_logp'],-4.11)
        self.assertEqual(value['content_mean_logp'],-2.)
        self.assertEqual(value['target_tokens'],23)


if __name__=='__main__':unittest.main()
