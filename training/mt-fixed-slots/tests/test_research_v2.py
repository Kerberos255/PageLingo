import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parents[1]


class CandidatePolicy(unittest.TestCase):
    def run_invalid(self, config, extra=()):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / "config.json").write_text(json.dumps(config))
            result = subprocess.run([sys.executable, str(HERE / "train.py"), "--data", str(root), "--output", str(root / "output"),
                "--config", str(root / "config.json"), "--synthetic-candidate", *extra], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("training_arguments_checked", result.stdout)
            return result.stderr

    def test_rejects_unbounded_synthetic_runs_before_importing_training_libraries(self):
        for steps in [-1, 0, 129]:
            self.assertIn("step limit", self.run_invalid({"candidate_max_steps": steps}))

    def test_cannot_relabel_the_old_seed_probe_as_a_synthetic_candidate(self):
        self.assertIn("must not be mixed", self.run_invalid({"candidate_max_steps": 42}, ["--probe"]))


@unittest.skipUnless(importlib.util.find_spec("transformers"), "Optional real TrainingArguments API")
class CandidateTrainerApi(unittest.TestCase):
    def test_best_checkpoint_selection_uses_validation_loss_and_a_fixed_limit(self):
        sys.path.insert(0, str(HERE))
        from training_options import build_training_arguments
        config = json.loads((HERE / "config-lr3e5-v2.json").read_text())
        with tempfile.TemporaryDirectory() as temp:
            args = build_training_arguments(config, temp, synthetic_candidate=True, use_cpu=True)
            self.assertEqual(args.max_steps, 44)
            self.assertTrue(args.load_best_model_at_end)
            self.assertEqual(args.metric_for_best_model, "eval_loss")
            self.assertFalse(args.greater_is_better)


if __name__ == "__main__": unittest.main()
