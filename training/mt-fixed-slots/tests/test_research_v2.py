import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

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


class GpuHandoff(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(HERE))
        sys.path.insert(0, str(HERE / 'windows'))
        from research_v2 import create_handoff, sha256
        self.pack, self.sha = create_handoff, sha256
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.out = self.root / 'out'; self.stage = self.root / 'stage'
        self.adapter = self.root / 'selected'; self.adapter.mkdir(); (self.out / 'bf16').mkdir(parents=True)
        (self.stage / 'data').mkdir(parents=True)
        for name in ['adapter_model.safetensors', 'adapter_config.json']: (self.adapter / name).write_bytes(b'test fixture')
        for name in ['evaluation-config.json']: (self.out / name).write_text('{}')
        for name in ['data/manifest.json', 'package-manifest.json']: (self.stage / name).write_text('{"test_fixture": true}')
        (self.stage / 'research-plan.json').write_text('{"jobs": [{}]}')
        runs = {'finished_utc': 'test fixture', 'plan_sha256': self.sha(self.stage / 'research-plan.json'), 'files': {}}
        for label in ['base', 'v022', 'probe']:
            path = self.out / 'bf16' / (label + '.json'); path.write_text('{"finished_utc": "test fixture", "generations": [{}]}')
            runs['files'][label] = {'file': path.name, 'sha256': self.sha(path)}
        (self.out / 'bf16/runs.json').write_text(json.dumps(runs))
        self.candidates = []
        for name in ['resume', 'fresh']:
            folder = self.out / name; folder.mkdir(); (folder / 'training-result.json').write_text('{"test_fixture": true}')
            (self.stage / (name + '.json')).write_text('{"test_fixture": true}')
            self.candidates.append({'name': name, 'config': name + '.json', 'output': folder})

    def test_only_selected_adapter_and_verified_evidence_enter_the_transfer_bundle(self):
        (self.adapter / 'optimizer.pt').write_bytes(b'not transferred')
        (self.root / 'base.safetensors').write_bytes(b'not transferred')
        manifest = self.pack(self.out, self.adapter, self.stage, self.candidates, 'fixture-commit')
        self.assertEqual(manifest['bundle']['sha256'], self.sha(self.out / 'gpu-handoff.zip'))
        with zipfile.ZipFile(self.out / 'gpu-handoff.zip') as bundle:
            self.assertEqual(set(bundle.namelist()), set(manifest['files']))
            self.assertNotIn('adapter/optimizer.pt', bundle.namelist())
            self.assertIn('bf16/probe.json', bundle.namelist())
        self.assertFalse(manifest['release_approved'])

    def test_changed_model_output_is_rejected_before_packaging(self):
        (self.out / 'bf16/probe.json').write_text('{"changed": true}')
        with self.assertRaisesRegex(ValueError, 'evidence changed'):
            self.pack(self.out, self.adapter, self.stage, self.candidates, 'fixture-commit')
        self.assertFalse((self.out / 'gpu-handoff.zip').exists())

    def test_incomplete_comparison_is_not_packaged_as_completed_evidence(self):
        path = self.out / 'bf16/runs.json'; runs = json.loads(path.read_text()); del runs['finished_utc']; path.write_text(json.dumps(runs))
        with self.assertRaisesRegex(ValueError, 'Completed BF16'):
            self.pack(self.out, self.adapter, self.stage, self.candidates, 'fixture-commit')


@unittest.skipUnless(importlib.util.find_spec("transformers"), "Optional real TrainingArguments API")
class CandidateTrainerApi(unittest.TestCase):
    def test_complex_slot_revision_keeps_a_bounded_validation_selected_run(self):
        sys.path.insert(0, str(HERE))
        from training_options import build_training_arguments
        for name in ['config-lr1e5-v2b.json', 'config-lr3e5-v2b.json']:
            config = json.loads((HERE / name).read_text())
            with tempfile.TemporaryDirectory() as temp:
                args = build_training_arguments(config, temp, synthetic_candidate=True, use_cpu=True)
                self.assertEqual(args.max_steps, 120)
                self.assertEqual(args.get_warmup_steps(120), 6)
                self.assertTrue(args.load_best_model_at_end)
                self.assertEqual(args.metric_for_best_model, 'eval_loss')

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
