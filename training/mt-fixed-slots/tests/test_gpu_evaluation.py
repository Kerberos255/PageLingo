import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mt_gpu_evaluator", HERE / "evaluate_gpu.py")
evaluation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluation)


class EvaluationDataContract(unittest.TestCase):
    def setUp(self):
        request = {"messages": [{"role": "user", "content": "Translate this"}], "max_tokens": 8}
        self.plan = {"protocol": "BF16-production-prompt-unconstrained-v1", "grammar_applied": False,
            "cases": [{"id": "x", "split": "holdout"}], "jobs": [{"key": "fixed/x/0", "case_id": "x", "split": "holdout",
            "mode": "fixed", "request": request, "request_sha256": evaluation.request_hash(request)}]}

    def test_rejects_changed_prompt_or_training_split(self):
        evaluation.validate_plan(self.plan)
        altered = copy.deepcopy(self.plan); altered["jobs"][0]["request"]["messages"][0]["content"] = "changed"
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            evaluation.validate_plan(altered)
        self.plan["cases"][0]["split"] = "train"
        with self.assertRaisesRegex(ValueError, "evaluation cases"):
            evaluation.validate_plan(self.plan)

    def test_only_actual_eos_is_normal_termination(self):
        self.assertEqual(evaluation.finish_reason([10, 120020], 120020, 2), "stop")
        self.assertEqual(evaluation.finish_reason([10, 11], 120020, 2), "length")
        self.assertEqual(evaluation.finish_reason([10], 120020, 8), "other")

    def test_preview_escapes_generated_html(self):
        with tempfile.TemporaryDirectory() as temporary:
            evaluation.write_preview(self.plan, {"base": {"generations": [{"key": "fixed/x/0", "finish_reason": "stop",
                "text": "</pre><script>alert(1)</script>"}]}}, Path(temporary))
            output = (Path(temporary) / "raw-preview.html").read_text()
            self.assertNotIn("<script>", output)
            self.assertIn("&lt;script&gt;", output)


@unittest.skipUnless(importlib.util.find_spec("transformers") and importlib.util.find_spec("peft"), "Optional real generation API environment")
class RealGenerationApi(unittest.TestCase):
    def test_greedy_streaming_and_two_different_adapter_ranks_on_cpu(self):
        import torch
        from transformers import GPT2Config, GPT2LMHeadModel, GenerationConfig
        from peft import LoraConfig, PeftModel, get_peft_model

        class Decoder:
            eos_token_id = 2
            @staticmethod
            def decode(ids, **kwargs):
                return " ".join(map(str, ids))

        torch.set_num_threads(2); torch.manual_seed(42)
        config = GPT2Config(n_layer=1, n_head=2, n_embd=8, vocab_size=32, bos_token_id=1, eos_token_id=2, pad_token_id=0)
        encoded = {"input_ids": torch.tensor([[1, 4, 6]]), "attention_mask": torch.ones(1, 3, dtype=torch.long)}
        generation = GenerationConfig(do_sample=False, bos_token_id=1, eos_token_id=2, pad_token_id=0, use_cache=True)
        base = GPT2LMHeadModel(config).eval()
        row = evaluation.generate_one(base, Decoder(), encoded, 3, generation, "cpu")
        self.assertLessEqual(row["new_tokens"], 3)
        self.assertIsNotNone(row["first_token_s"])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name, rank in [("old", 4), ("new", 2)]:
                model = get_peft_model(GPT2LMHeadModel(config), LoraConfig(task_type="CAUSAL_LM", r=rank, target_modules=["c_attn"]))
                model.save_pretrained(root / name)
            model = PeftModel.from_pretrained(base, root / "old", adapter_name="old", is_trainable=False).eval()
            model.load_adapter(root / "new", adapter_name="new", is_trainable=False)
            for name in ["old", "new"]:
                model.set_adapter(name); model.eval()
                self.assertEqual(list(model.active_adapters), [name])
                row = evaluation.generate_one(model, Decoder(), encoded, 3, generation, "cpu")
                self.assertIsNotNone(row["first_token_s"])
                self.assertIn(row["finish_reason"], ["stop", "length"])


if __name__ == "__main__":
    unittest.main()
