import importlib.util
from pathlib import Path
import unittest

SPEC=importlib.util.spec_from_file_location("validation_metrics",Path(__file__).resolve().parents[1]/"validation_metrics.py")
metrics=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(metrics)


class ValidationLossComponents(unittest.TestCase):
    def test_marker_bytes_remain_separate_from_prose_and_eos(self):
        text="⟦0⟧先交给⟦/0⟧⟪P0⟫"
        kinds=metrics.target_kinds(text,[(0,3),(3,4),(4,5),(5,6),(6,10),(10,14)])
        self.assertEqual(kinds,["marker","content","content","content","marker","marker","eos"])
        # Byte fallback may map several token IDs to the same Unicode glyph.
        self.assertEqual(metrics.target_kinds("⟦0⟧甲",[(0,1),(0,1),(1,3),(3,4)]),["marker","marker","marker","content","eos"])

    def test_boundary_spanning_token_cannot_hide_content_loss(self):
        self.assertEqual(metrics.target_kinds("⟦0⟧甲",[(0,4)]),["content","eos"])
        for offsets in [[(0,0)],[(0,5)],[(-1,1)]]:
            with self.assertRaises(ValueError):metrics.target_kinds("⟦0⟧甲",offsets)

    def test_token_weighted_and_sample_weighted_losses_are_distinct(self):
        one=metrics.loss_summary([1.,2.,3.],["marker","content","eos"])
        two=metrics.loss_summary([1.,1.,1.,1.,1.,1.],["marker","content","content","content","content","eos"])
        v=metrics.aggregate([one,two])
        self.assertEqual(v["content"],{"tokens":5,"mean_nll":1.2})
        self.assertAlmostEqual(v["token_weighted_nll"],12/9)
        self.assertAlmostEqual(v["mean_sample_nll"],1.5)
        self.assertEqual(v["all_target_tokens"],9)

    def test_incomplete_or_nonfinite_results_never_become_a_score(self):
        for losses,kinds in [([1.],["marker"]),([1.],["eos"]),([1.,float('nan')],["content","eos"]),([1.,-1.],["content","eos"]),([1.],["content","eos"])]:
            with self.assertRaises(ValueError):metrics.loss_summary(losses,kinds)
        with self.assertRaises(ValueError):metrics.aggregate([])

    def test_teacher_forcing_uses_the_previous_position_and_excludes_the_prompt(self):
        import torch
        logits=torch.full((1,5,3),-10.)
        logits[0,1,2]=10.;logits[0,2,1]=10.;logits[0,3,0]=10.
        correct=metrics.target_losses(logits,2,[2,1,0])
        self.assertTrue(torch.all(correct<.0001))
        wrong=metrics.target_losses(logits,2,[1,0,2])
        self.assertTrue(torch.all(wrong>10.))
        with self.assertRaises(ValueError):metrics.target_losses(logits[:,:4],2,[2,1,0])


if __name__=="__main__":unittest.main()
