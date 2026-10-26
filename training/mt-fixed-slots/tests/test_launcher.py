import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("mt_stable_launcher", Path(__file__).resolve().parents[1] / "windows/launcher.py")
launcher = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(launcher)


class StableLauncher(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve(); self.source = "a" * 40
        package = self.root / "training-packages/test"; package.mkdir(parents=True)
        raw = json.dumps({"source_commit": self.source, "files": {}}).encode()
        (package / "package-manifest.json").write_bytes(raw)
        control = self.root / "tools/mt-control"; control.mkdir(parents=True)
        self.task = {"schema_version": 1, "package": "training-packages/test", "run_prefix": "test-gpu",
                     "source_commit": self.source, "manifest_sha256": hashlib.sha256(raw).hexdigest()}
        (control / "current-task.json").write_text(json.dumps(self.task))
        python = self.root / ".venv/Scripts/python.exe"; python.parent.mkdir(parents=True); python.write_bytes(b"not executed")
        self.calls = []

    def child(self, command, **kwargs):
        self.calls.append((command, kwargs)); return SimpleNamespace(returncode=0)

    def record(self, **values):
        p = self.root / "outputs/test-gpu-run-20261026-000001"; p.mkdir(parents=True)
        status = {"source_commit": self.source, "training_completed": False, "gpu_comparison_completed": False, "stages": []}
        status.update(values); (p / "workflow-result.json").write_text(json.dumps(status))

    def test_unfinished_legacy_run_never_starts_a_second_training_or_creates_caches(self):
        self.record()
        self.assertEqual(launcher.dispatch(self.root, "auto", self.child), 10)
        self.assertEqual(launcher.dispatch(self.root, "retry", self.child), 10)
        self.assertEqual(self.calls, [])
        self.assertFalse((self.root / ".cache").exists())
        self.assertFalse((self.root / ".state").exists())

    def test_completed_same_task_never_repeats_without_explicit_retry(self):
        self.record(training_completed=True, gpu_comparison_completed=True, handoff={"sha256": "verified"})
        self.assertEqual(launcher.dispatch(self.root, "auto", self.child), 10)
        self.assertEqual(self.calls, [])
        # Disposable test roots may be C: or UNC on Windows; the fake child never executes.
        with patch.object(launcher, "validate_training_root"):
            self.assertEqual(launcher.dispatch(self.root, "retry", self.child), 0)
        self.assertEqual(len(self.calls), 1)

    def test_preflight_dispatches_check_and_preserves_non_c_cache_policy(self):
        with patch.object(launcher, "validate_training_root"):
            self.assertEqual(launcher.dispatch(self.root, "check", self.child), 0)
        command, options = self.calls[0]
        self.assertEqual(command[-2:], ["--mode", "check"])
        self.assertNotIn("--train", command)
        self.assertEqual(options["cwd"], self.root)
        self.assertEqual(options["env"]["HF_HUB_OFFLINE"], "1")
        self.assertTrue(Path(options["env"]["HF_HOME"]).is_relative_to(self.root))

    def test_status_is_read_only_and_failed_run_is_not_restarted_automatically(self):
        self.record(error="recorded GPU failure")
        self.assertEqual(launcher.dispatch(self.root, "status", self.child), 0)
        self.assertEqual(launcher.dispatch(self.root, "auto", self.child), 1)
        self.assertEqual(self.calls, [])
        self.assertFalse((self.root / ".cache").exists())
        self.assertFalse((self.root / ".state").exists())

    def test_completed_evaluation_does_not_claim_training_or_repeat(self):
        self.record(workflow_completed=True,training_executed=False)
        self.assertEqual(launcher.dispatch(self.root,"auto",self.child),10)
        self.assertEqual(self.calls,[])
        self.assertFalse((self.root/".state").exists())

    def test_changed_package_and_escaping_paths_are_rejected_before_launch(self):
        (self.root / "training-packages/test/package-manifest.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "identity changed"):
            launcher.dispatch(self.root, "auto", self.child)
        for value in ["../other", "C:/other", r"\\server\share\other"]:
            with self.assertRaises(ValueError): launcher.inside(self.root, value)
        self.assertEqual(self.calls, [])

    def test_drive_guards_and_cache_map_leave_user_home_and_inherited_settings_unchanged(self):
        for value in [r"C:\PageLingo-MT", r"\\server\share"]:
            with self.assertRaises(ValueError): launcher.validate_training_root(value)
        launcher.validate_training_root(r"E:\PageLingo-MT")
        original = {"HOME": "user-home", "CODEX_HOME": "codex-home", "CUSTOM_SETTING": "keep"}
        env, paths = launcher.training_environment(self.root, original)
        for key, value in original.items(): self.assertEqual(env[key], value)
        self.assertEqual(len(original), 3)
        self.assertTrue(all(path.is_relative_to(self.root) for path in paths.values()))

    def test_operating_system_lock_blocks_another_launcher_and_releases_after_exit(self):
        with launcher.launch_lock(self.root):
            with self.assertRaisesRegex(ValueError, "launch lock"):
                with launcher.launch_lock(self.root): self.fail("Second lock unexpectedly acquired")
        with launcher.launch_lock(self.root): pass


if __name__ == "__main__": unittest.main()
