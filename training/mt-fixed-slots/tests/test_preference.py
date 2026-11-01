import copy
import json
import math
from pathlib import Path
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parents[1]; sys.path.insert(0, str(HERE))
from preference_contract import validate_config, validate_cache, read_corpus
try:
    import torch
    from preference_loss import causal_logps, preference_objective, preference_trainer_class
    from train_preference import collator, policy_scores, tensor_digest, validation_summary
except ImportError:
    torch = None


class PreferenceContractTests(unittest.TestCase):
    def test_rejects_moving_reference_model_dropout_or_step_budget(self):
        config = json.loads((HERE / "config-preference-v6.json").read_text()); config["preference_weight"] = .25
        manifest = {"corpus": "semantic-preference-v6", "protocol": "production-fixed-text-v1", "prompt_variant": "legacy"}
        validate_config(config, manifest)
        for key, value in [("candidate_max_steps", 32), ("initialization", "fresh_base"), ("lora_dropout", .05),
                ("disable_all_dropout", False), ("preference_beta", 2), ("semantic_marker_weight", .25), ("preference_weight", True)]:
            with self.subTest(key=key), self.assertRaises(ValueError): validate_config({**config, key: value}, manifest)

    def test_reference_cache_pins_model_data_tokens_and_initial_tensors(self):
        config = {key: "a" * 64 for key in ["base_weight_sha256", "initial_adapter_sha256", "initial_adapter_config_sha256"]}
        encoded = {"sample": {"tokens_sha256": "b" * 64, "sequences": [{"labels": [-100, 1, 2]}, {"labels": [-100, 2, 1]}]}}
        cache = {"schema_version": 1, "input_manifest_sha256": "c" * 64, "disable_all_dropout": True,
            "initial_trainable_sha256": "d" * 64, "precision": "cuda_bf16_autocast", **config, "records": {"sample": {"tokens_sha256": "b" * 64, "logps": [-3., -5.], "target_counts": [2, 2]}}}
        self.assertEqual(validate_cache(cache, "c" * 64, config, encoded), "d" * 64)
        for key in ["input_manifest_sha256", "base_weight_sha256", "initial_adapter_sha256", "initial_adapter_config_sha256"]:
            with self.subTest(key=key), self.assertRaises(ValueError): validate_cache({**cache, key: "e" * 64}, "c" * 64, config, encoded)
        with self.assertRaisesRegex(ValueError, "initial"): validate_cache(cache, "c" * 64, config, encoded, "e" * 64)
        bad = copy.deepcopy(cache); bad["records"]["sample"]["tokens_sha256"] = "e" * 64
        with self.assertRaisesRegex(ValueError, "token"): validate_cache(bad, "c" * 64, config, encoded)
        bad = copy.deepcopy(cache); bad["records"]["sample"]["logps"][0] = float("nan")
        with self.assertRaisesRegex(ValueError, "probabilities"): validate_cache(bad, "c" * 64, config, encoded)


@unittest.skipUnless(torch is not None, "Optional ML dependencies not installed")
class PreferenceLossTests(unittest.TestCase):
    def test_causal_shift_excludes_prompt_and_padding_in_values_and_gradients(self):
        logits = torch.zeros((1, 5, 3), requires_grad=True)
        labels = torch.tensor([[-100, -100, 2, 1, -100]])
        logps, counts = causal_logps(logits, labels)
        self.assertEqual(counts.tolist(), [2]); self.assertAlmostEqual(logps.item(), -2 * math.log(3), places=6)
        (-logps.sum()).backward()
        self.assertEqual(logits.grad[0, [0, 3, 4]].abs().sum().item(), 0)
        self.assertGreater(logits.grad[0, 1:3].abs().sum().item(), 0)

    def test_reference_relative_dpo_gradient_rewards_chosen_and_penalizes_rejected(self):
        policy = torch.tensor([[-3., -5.]], requires_grad=True); reference = policy.detach().clone()
        loss, terms = preference_objective(policy, torch.tensor([[2, 2]]), reference, torch.tensor([True]), beta=.1, weight=.25)
        self.assertAlmostEqual(loss.item(), 1.5 + .25 * math.log(2), places=6)
        self.assertEqual(terms["reference_relative_margin"].item(), 0)
        loss.backward(); self.assertLess(policy.grad[0, 0].item(), 0); self.assertGreater(policy.grad[0, 1].item(), 0)
        improved = policy.detach() + torch.tensor([[1., -1.]])
        _, better = preference_objective(improved, torch.tensor([[2, 2]]), reference, torch.tensor([True]), beta=.1, weight=.25)
        self.assertLess(better["preference"].item(), math.log(2))

    def test_sft_control_and_replay_never_optimize_negative_or_preference(self):
        for weight, paired in [(0., True), (.25, False)]:
            policy = torch.tensor([[-3., -50.]], requires_grad=True)
            loss, _ = preference_objective(policy, torch.tensor([[2, 4]]), torch.tensor([[-3., -5.]]), torch.tensor([paired]), beta=.1, weight=weight)
            self.assertEqual(loss.item(), 1.5); loss.backward(); self.assertEqual(policy.grad[0, 1].item(), 0)

    def test_actual_trainer_updates_only_lora_with_reference_cache_and_gradient_accumulation(self):
        from transformers import LlamaConfig, LlamaForCausalLM, TrainingArguments, Trainer
        from peft import LoraConfig, get_peft_model
        torch.manual_seed(42); torch.set_num_threads(2)
        model = get_peft_model(LlamaForCausalLM(LlamaConfig(vocab_size=32, hidden_size=8, intermediate_size=16,
            num_hidden_layers=1, num_attention_heads=2, num_key_value_heads=2, max_position_embeddings=32, use_cache=False)),
            LoraConfig(task_type="CAUSAL_LM", r=2, lora_alpha=4, lora_dropout=0, target_modules=["q_proj", "v_proj"]))
        model.enable_input_require_grads()
        initial = tensor_digest(model); frozen = {n: p.detach().clone() for n, p in model.named_parameters() if not p.requires_grad}
        items = {str(i): {"tokens_sha256": str(i), "paired": bool(i % 2), "sequences": [
            {"input_ids": [1, 2, 3, 4], "labels": [-100, -100, 3, 4]},
            {"input_ids": [1, 2, 5], "labels": [-100, -100, 5]}]} for i in range(4)}
        collate = collator(0); reference = policy_scores(model, items, collate)
        for identity, item in items.items(): item["reference_logps"] = reference[identity]["logps"]
        before = validation_summary(reference, [{"id": k, "kind": "contrast"} for k in items], reference, .1)
        self.assertAlmostEqual(before["mean_dpo_loss"], math.log(2))
        with tempfile.TemporaryDirectory() as name:
            args = TrainingArguments(output_dir=name, use_cpu=True, per_device_train_batch_size=1, gradient_accumulation_steps=2,
                gradient_checkpointing=True, gradient_checkpointing_kwargs={"use_reentrant": False}, learning_rate=.01,
                max_steps=2, remove_unused_columns=False, report_to=[], save_strategy="no", logging_steps=1, disable_tqdm=True)
            actual = preference_trainer_class(Trainer)(model=model, args=args, train_dataset=list(items.values()), data_collator=collate, beta=.1, preference_weight=.25)
            self.assertFalse(actual.model_accepts_loss_kwargs); actual.train(); self.assertEqual(actual.state.global_step, 2)
        self.assertNotEqual(tensor_digest(model), initial)
        for n, p in model.named_parameters():
            if n in frozen: self.assertTrue(torch.equal(p, frozen[n]))
        self.assertTrue(all(math.isfinite(v) for row in policy_scores(model, items, collate).values() for v in row["logps"]))


if __name__ == "__main__": unittest.main()
