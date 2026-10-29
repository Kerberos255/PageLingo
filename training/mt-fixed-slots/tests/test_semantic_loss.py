import importlib.util
import math
from pathlib import Path
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import semantic_loss as loss


class SemanticLossContract(unittest.TestCase):
    def test_only_fully_marker_tokens_are_downweighted(self):
        text = "⟦0⟧甲⟦/0⟧⟪P0⟫"
        weights, kinds = loss.token_weights(text, [(i, i + 1) for i in range(len(text))], .25)
        self.assertEqual(weights[-1], 1.)
        self.assertEqual(kinds[-1], "eos")
        self.assertEqual(weights[text.index("甲")], 1.)
        self.assertEqual(sum(w == .25 for w in weights), len(text) - 1)
        self.assertEqual(loss.token_weights("⟦0⟧甲", [(0, 4)], .25), ([1., 1.], ["content", "eos"]))

    def test_invalid_marker_weights_are_rejected(self):
        for weight in [0, -1, 1.1, True, None, float("nan"), float("inf")]:
            with self.assertRaises(ValueError):
                loss.token_weights("word", [(0, 4)], weight)

    @unittest.skipUnless(importlib.util.find_spec("torch"), "Optional PyTorch")
    def test_weighted_shift_mask_and_unweighted_equivalence(self):
        import torch
        import torch.nn.functional as functional
        logits = torch.tensor([[[0., 0., 0.], [1., 0., 3.], [0., 2., 1.], [4., 1., 0.], [0., 0., 0.]]], requires_grad=True)
        labels = torch.tensor([[-100, -100, 2, 1, 0]])
        weights = torch.tensor([[0., 0., .25, 1., 1.]])
        result = loss.weighted_causal_loss(logits, labels, weights)
        individual = functional.cross_entropy(logits[0, 1:4], torch.tensor([2, 1, 0]), reduction="none")
        self.assertTrue(torch.allclose(result, (individual * torch.tensor([.25, 1., 1.])).sum() / 2.25))
        unweighted = loss.weighted_causal_loss(logits, labels, torch.tensor([[0., 0., 1., 1., 1.]]))
        expected = functional.cross_entropy(logits[:, :-1].reshape(-1, 3), labels[:, 1:].reshape(-1), ignore_index=-100)
        self.assertTrue(torch.allclose(unweighted, expected))
        result.backward()
        self.assertTrue(torch.all(logits.grad[:, 0] == 0))
        self.assertTrue(torch.all(logits.grad[:, -1] == 0))
        self.assertTrue(torch.any(logits.grad[:, 1] != 0))
        for invalid in [torch.tensor([[0., 1., .25, 1., 1.]]), torch.tensor([[0., 0., 0., 1., 1.]])]:
            with self.assertRaises(ValueError):
                loss.weighted_causal_loss(logits, labels, invalid)

    @unittest.skipUnless(importlib.util.find_spec("torch") and importlib.util.find_spec("transformers"), "Optional ML libraries")
    def test_real_trainer_preserves_weights_and_accumulates_cpu_gradients(self):
        import torch
        from transformers import GPT2Config, GPT2LMHeadModel, Trainer, TrainingArguments
        torch.set_num_threads(2)
        model = GPT2LMHeadModel(GPT2Config(vocab_size=16, n_layer=1, n_head=1, n_embd=8, n_positions=16, use_cache=False))
        rows = [{"input_ids": [1, 2, 3, 4], "attention_mask": [1] * 4, "labels": [-100, -100, 3, 4], "loss_weights": [0., 0., .25, 1.]}] * 4

        def collate(batch):
            return {key: torch.tensor([row[key] for row in batch], dtype=torch.float32 if key == "loss_weights" else torch.long) for key in batch[0]}

        initial = model.transformer.wte.weight.detach().clone()
        with tempfile.TemporaryDirectory() as folder:
            options = TrainingArguments(output_dir=folder, max_steps=2, per_device_train_batch_size=1, gradient_accumulation_steps=2,
                use_cpu=True, remove_unused_columns=False, report_to=[], save_strategy="no", disable_tqdm=True, dataloader_pin_memory=False)
            trainer = loss.semantic_trainer_class(Trainer)(model=model, args=options, train_dataset=rows, eval_dataset=rows, data_collator=collate)
            self.assertFalse(trainer.model_accepts_loss_kwargs)
            result = trainer.train()
            self.assertEqual(trainer.state.global_step, 2)
            self.assertTrue(math.isfinite(result.training_loss))
            self.assertFalse(torch.equal(initial, model.transformer.wte.weight.detach()))
            self.assertTrue(math.isfinite(trainer.evaluate()["eval_loss"]))


if __name__ == "__main__":
    unittest.main()
