import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]


class WindowsRunnerContract(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.kit = self.root / "codex-fixed-slots-v1"
        (self.kit / "data").mkdir(parents=True)
        shutil.copyfile(ROOT / "training/mt-fixed-slots/windows/run_local.py", self.kit / "run_local.py")
        (self.kit / "config.json").write_text(json.dumps({"base_revision": "test", "probe_max_steps": 12}))
        data = {"files": {}}
        for split in ["train", "validation"]:
            raw = (json.dumps({"split": split, "review_status": "assistant_authored_needs_human_review"}) + "\n").encode()
            (self.kit / "data" / (split + ".jsonl")).write_bytes(raw)
            data["files"][split] = {"file": split + ".jsonl", "rows": 1, "sha256": hashlib.sha256(raw).hexdigest()}
        (self.kit / "data/manifest.json").write_text(json.dumps(data))
        # No ML imports: observe whether the launcher requests optimization in check mode.
        (self.kit / "train.py").write_text("import pathlib,sys\np=pathlib.Path(sys.argv[sys.argv.index('--output')+1]);p.mkdir();(p/'observed.json').write_text(__import__('json').dumps(sys.argv))\n")
        manifest = {"source_commit": "test", "files": {}}
        for file in self.kit.rglob("*"):
            if file.is_file():
                manifest["files"][str(file.relative_to(self.kit))] = {"sha256": hashlib.sha256(file.read_bytes()).hexdigest()}
        (self.kit / "package-manifest.json").write_text(json.dumps(manifest))

    def tearDown(self):
        self.tmp.cleanup()

    def run_kit(self, *args):
        return subprocess.run([sys.executable, str(self.kit / "run_local.py"), "--root", str(self.root), *args],
                              capture_output=True, text=True, timeout=15)

    def test_plan_creates_no_outputs_and_requests_bounded_probe(self):
        result = self.run_kit("--plan")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["max_optimizer_steps"], 12)
        self.assertFalse((self.root / "outputs").exists())

    def test_changed_target_is_rejected_before_launch(self):
        (self.kit / "data/train.jsonl").write_text("changed reference")
        result = self.run_kit("--plan")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Staged package changed", result.stderr)
        self.assertFalse((self.root / "outputs").exists())

    def test_formal_training_refuses_unreviewed_seed(self):
        result = self.run_kit("--kind", "train", "--plan")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("requires reviewed data", result.stderr)

    @unittest.skipIf(sys.platform == "win32", "This isolated process test uses a disposable POSIX root; real Windows cache checks remain active")
    def test_check_never_requests_training_and_each_run_has_its_own_log(self):
        model = self.root / "models/hy-mt2-1.8b/model.safetensors"
        model.parent.mkdir(parents=True); model.write_bytes(b"not loaded by the fake check child")
        for _ in range(2):
            result = self.run_kit("--kind", "check")
            self.assertEqual(result.returncode, 0, result.stderr)
        runs = list((self.root / "outputs").iterdir())
        self.assertEqual(len(runs), 2)
        for run in runs:
            args = json.loads((run / "training/observed.json").read_text())
            self.assertNotIn("--train", args)
            self.assertTrue((run / "console.log").is_file())


if __name__ == "__main__":
    unittest.main()
