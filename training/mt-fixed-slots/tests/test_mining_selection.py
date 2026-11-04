from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from mining_selection import select_family_capped


class FamilyDiversitySelection(unittest.TestCase):
    def row(self,identity,margin,verdict='semantic_error',family='topic',hard=True):
        return {'id':identity,'split':'train','family':family,'hard_negative_candidate':hard,
                'actual_minus_chosen_sequence_logp':margin,'audit':{'verdict':verdict}}

    def test_selection_retains_opposite_directions_and_scope_diversity_before_margin(self):
        rows=[self.row('topic-after-code',10),self.row('topic-after-text',20),self.row('topic-before-code',3,'scope_error')]
        self.assertEqual([r['id']for r in select_family_capped(rows)],['topic-after-text','topic-before-code'])

    def test_family_cap_excludes_easy_errors_and_reserved_or_duplicate_inputs(self):
        rows=[self.row('topic-before',10),self.row('topic-after',12),self.row('topic-extra',30),self.row('easy',40,hard=False)]
        self.assertEqual(len(select_family_capped(rows)),2)
        with self.assertRaises(ValueError):select_family_capped(rows+[rows[0]])
        with self.assertRaises(ValueError):select_family_capped([{**rows[0],'split':'validation'}])


if __name__=='__main__':unittest.main()
