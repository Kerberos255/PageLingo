import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mt_training_options", HERE / "training_options.py")
options = importlib.util.module_from_spec(spec)
spec.loader.exec_module(options)


@unittest.skipUnless(importlib.util.find_spec("transformers"), "Real Trainer-API tests require the optional training environment")
class TrainerApiCompatibility(unittest.TestCase):
    def setUp(self):
        self.config = json.loads((HERE / "config.json").read_text())
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_actual_constructor_accepts_all_probe_options_without_a_model(self):
        args = options.build_training_arguments(self.config, self.tmp.name, probe=True, use_cpu=True)
        self.assertEqual(args.max_steps, 12)
        self.assertEqual(str(args.device), "cpu")
        self.assertFalse(args.bf16)
        self.assertFalse(args.push_to_hub)
        self.assertEqual(args.report_to, [])

    def test_fractional_warmup_keeps_the_requested_ratio(self):
        for ratio, expected in [(0.0, 0), (0.05, 1), (0.25, 3)]:
            with self.subTest(ratio=ratio):
                config = dict(self.config, warmup_ratio=ratio)
                args = options.build_training_arguments(config, self.tmp.name, probe=True, use_cpu=True)
                self.assertEqual(args.get_warmup_steps(12), expected)

    def test_epoch_mode_preserves_the_scheduler_for_larger_training_runs(self):
        args = options.build_training_arguments(self.config, self.tmp.name, use_cpu=True)
        self.assertEqual(args.max_steps, -1)
        self.assertEqual(args.num_train_epochs, self.config["epochs"])
        self.assertEqual(args.get_warmup_steps(100), 5)


if __name__ == "__main__":
    unittest.main()
