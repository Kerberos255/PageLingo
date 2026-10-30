"""Exercise post-training v4 validation and recovery through four-arm bundling."""
import copy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
from evaluate_gpu import sha256
import semantic_workflow as workflow

DIGEST = "a" * 64


def write_json(file, data):
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def create_candidate(folder, config_file, data, expected=None):
    config = json.loads(config_file.read_text())
    manifest = json.loads((data / "manifest.json").read_text())
    result = {"training_executed": True, "run_kind": "synthetic_research_candidate", "optimizer_steps": 32,
        "config": config, "config_sha256": sha256(config_file), "local_weight_sha256": config["base_weight_sha256"],
        "base_model": config["base_model"], "base_revision": config["base_revision"], "input_manifest_sha256": sha256(data / "manifest.json"),
        "splits": {split: {"sha256": record["sha256"], "rows": record["rows"], "task_counts": manifest["task_counts"][split],
            "targets_truncated": False, "prompt_and_padding_masked": True, "eos_supervised": True} for split, record in manifest["files"].items()},
        "initial_trainable_sha256": DIGEST, "base_weights_frozen": True,
        "selection": {"best_checkpoint": None, "best_metric": None, "max_optimizer_steps": 32, "release_approved": False},
        "validation_before": {"eval_loss": 1.2}, "validation_after": {"eval_loss": 1.0},
        "loss_definition": {"marker_weight": config["semantic_marker_weight"]}}
    write_json(folder / "training-result.json", result)
    write_json(folder / "initialization.json", {"initial_trainable_sha256": DIGEST, "expected_initial_sha256": expected,
        "base_weights_frozen": True, "optimization_started": False})
    write_json(folder / "adapter/adapter_config.json", {"r": config["lora_r"], "lora_alpha": config["lora_alpha"], "target_modules": config["target_modules"]})
    (folder / "adapter/adapter_model.safetensors").write_bytes(b"fixture LoRA weights")


class SemanticWorkflowTests(unittest.TestCase):
    def make_kit(self, root):
        here = root / "kit"; (here / "data").mkdir(parents=True)
        for label in ["ce_v4", "marker025_v4"]:
            source = "config-semantic-" + ("ce" if label == "ce_v4" else "marker025") + "-v4.json"
            (here / (label + ".json")).write_bytes((HERE / source).read_bytes())
        for name in ["train.py", "training_options.py", "semantic_loss.py", "validation_metrics.py"]:
            (here / name).write_bytes((HERE / name).read_bytes())
        manifest = {"files": {}, "task_counts": {}}
        for split in ["train", "validation"]:
            (here / "data" / (split + ".jsonl")).write_text('{"fixture":true}\n')
            manifest["files"][split] = {"file": split + ".jsonl", "rows": 1, "sha256": sha256(here / "data" / (split + ".jsonl"))}
            manifest["task_counts"][split] = {"natural": 1}
        write_json(here / "data/manifest.json", manifest)
        for name in ["reference-review.md", "evaluation-cases.json"]: (here / "data" / name).write_text("fixture")
        from test_semantic_evaluation import SemanticEvaluationGuards
        write_json(here / "evaluation-plan.json", SemanticEvaluationGuards().plan())
        base = root / "base"; base.mkdir(); (base / "model.safetensors").write_bytes(b"fixture base")
        adapter = root / "old"; adapter.mkdir()
        (adapter / "adapter_model.safetensors").write_bytes(b"fixture old"); (adapter / "adapter_config.json").write_text("{}")
        spec = {"run_prefix": "pagelingo-quality-v4", "candidates": ["ce_v4", "marker025_v4"],
            "base": {"directory": "base", "sha256": sha256(base / "model.safetensors")},
            "old_r16": {"directory": "old", "sha256": sha256(adapter / "adapter_model.safetensors"), "config_sha256": sha256(adapter / "adapter_config.json")}}
        write_json(here / "workflow.json", spec)
        self.freeze(here)
        return here, spec

    def freeze(self, here):
        write_json(here / "package-manifest.json", {"schema_version": 1, "source_commit": "b" * 40, "source_dirty": False,
            "files": {p.relative_to(here).as_posix(): {"bytes": p.stat().st_size, "sha256": sha256(p)}
                for p in here.rglob("*") if p.is_file() and p.name != "package-manifest.json"}})

    def reuse_record(self, root, here):
        previous = root / "previous-kit"
        import shutil
        shutil.copytree(here, previous)
        folder = root / "previous-run/ce_v4"
        create_candidate(folder, previous / "ce_v4.json", previous / "data")
        return {"directory": "previous-run/ce_v4", "package": {"directory": "previous-kit", "source_commit": "b" * 40,
            "manifest_sha256": sha256(previous / "package-manifest.json")},
            "files": {name: {"bytes": (folder / name).stat().st_size, "sha256": sha256(folder / name)} for name in [
                "training-result.json", "initialization.json", "adapter/adapter_model.safetensors", "adapter/adapter_config.json"]}}

    def test_fresh_candidate_needs_no_initial_adapter_field_and_checks_real_inputs(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); here, _ = self.make_kit(root); folder = root / "candidate"
            create_candidate(folder, here / "ce_v4.json", here / "data")
            identity = workflow.completed_semantic_candidate(folder, here / "ce_v4.json", here / "data")
            self.assertEqual(identity["sha256"], sha256(folder / "adapter/adapter_model.safetensors"))
            original = json.loads((folder / "training-result.json").read_text())
            self.assertNotIn("initial_adapter_sha256", original["config"])
            for field, value in [("optimizer_steps", 31), ("initial_trainable_sha256", ""), ("base_weights_frozen", False),
                    ("config_sha256", "c" * 64), ("input_manifest_sha256", "c" * 64), ("local_weight_sha256", "c" * 64)]:
                bad = copy.deepcopy(original); bad[field] = value; write_json(folder / "training-result.json", bad)
                with self.subTest(field=field), self.assertRaises(ValueError):
                    workflow.completed_semantic_candidate(folder, here / "ce_v4.json", here / "data")
            write_json(folder / "training-result.json", original)
            with self.assertRaisesRegex(ValueError, "initialization differs"):
                workflow.completed_semantic_candidate(folder, here / "ce_v4.json", here / "data", "c" * 64)
            (here / "data/train.jsonl").write_text("changed")
            with self.assertRaisesRegex(ValueError, "corpus identity"):
                workflow.completed_semantic_candidate(folder, here / "ce_v4.json", here / "data")

    def test_recovery_rejects_changed_weights_training_code_and_escaping_paths(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); here, _ = self.make_kit(root); record = self.reuse_record(root, here)
            workflow.verified_reuse(root, here, record)
            for field in ["directory", "package"]:
                bad = copy.deepcopy(record)
                if field == "directory": bad[field] = "../outside"
                else: bad[field]["directory"] = "C:\\other"
                with self.assertRaisesRegex(ValueError, "project"):
                    workflow.verified_reuse(root, here, bad)
            source = here / "train.py"; raw = source.read_bytes(); source.write_bytes(raw + b"\n# changed\n")
            with self.assertRaisesRegex(ValueError, "training inputs/code"):
                workflow.verified_reuse(root, here, record)
            source.write_bytes(raw)
            (root / record["directory"] / "adapter/adapter_model.safetensors").write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "artifact changed"):
                workflow.verified_reuse(root, here, record)

    def test_full_workflow_runs_both_fresh_or_reuses_ce_then_bundles_four_arms(self):
        for mode, reuse in [("check", False), ("run", False), ("run", True)]:
            with self.subTest(mode=mode, reuse=reuse), tempfile.TemporaryDirectory() as name:
                root = Path(name); here, spec = self.make_kit(root); original_bytes = None
                if reuse:
                    record = self.reuse_record(root, here)
                    original_bytes = {p: p.read_bytes() for p in (root / "previous-run").rglob("*") if p.is_file()}
                    spec.update(run_prefix="pagelingo-quality-v4-recovery", reuse_candidates={"ce_v4": record})
                    write_json(here / "workflow.json", spec); self.freeze(here)
                commands = []

                class Process:
                    def __init__(self, command, **kwargs):
                        commands.append(command); self.stdout = iter(["fixture stage\n"])
                        if "--train" in command:
                            output = Path(command[command.index("--output") + 1])
                            config = Path(command[command.index("--config") + 1])
                            expected = command[command.index("--expected-initial-sha256") + 1] if "--expected-initial-sha256" in command else None
                            create_candidate(output, config, here / "data", expected)
                        if command[2].endswith("evaluate_semantic.py") and "--check-only" not in command:
                            output = Path(command[command.index("--output") + 1]); output.mkdir()
                            runs = {"finished_utc": "fixture", "plan_sha256": sha256(here / "evaluation-plan.json"), "files": {}}
                            plan = json.loads((here / "evaluation-plan.json").read_text())
                            for label in ["base", "old_r16", "ce_v4", "marker025_v4"]:
                                file = output / (label + ".json")
                                write_json(file, {"finished_utc": "fixture", "generations": [{"key": j["key"]} for j in plan["jobs"]]})
                                runs["files"][label] = {"file": file.name, "sha256": sha256(file)}
                            write_json(output / "runs.json", runs)

                    def __enter__(self): return self
                    def __exit__(self, *args): return False
                    def wait(self, **kwargs): return 0

                torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True, is_bf16_supported=lambda: True))
                with patch.object(workflow, "HERE", here), patch.dict(sys.modules, {"torch": torch}), \
                        patch.object(sys, "argv", ["workflow", "--root", str(root), "--mode", mode]), \
                        patch.object(workflow.subprocess, "Popen", Process):
                    self.assertEqual(workflow.main(), 0)
                out = next((root / "outputs").iterdir()); status = json.loads((out / "workflow-result.json").read_text())
                expected_trains = 0 if mode == "check" else 1 if reuse else 2
                trained = [command for command in commands if "--train" in command]
                self.assertEqual(len(trained), expected_trains)
                if mode == "check":
                    self.assertTrue(status["check_completed"]); self.assertFalse(status["workflow_completed"]); continue
                self.assertTrue(status["workflow_completed"]); self.assertTrue(status["gpu_comparison_completed"])
                self.assertFalse(status["release_approved"]); self.assertFalse(status["upload_executed"])
                marker = trained[-1]; self.assertEqual(marker[marker.index("--expected-initial-sha256") + 1], DIGEST)
                models = json.loads((out / "model-identities.json").read_text())
                self.assertEqual(list(models["adapters"]), ["old_r16", "ce_v4", "marker025_v4"])
                with zipfile.ZipFile(out / "evidence.zip") as archive:
                    self.assertIsNone(archive.testzip()); self.assertIn("candidate-provenance.json", archive.namelist())
                    self.assertIn("training/ce_v4-initialization.json", archive.namelist())
                    self.assertFalse(any("safetensors" in path for path in archive.namelist()))
                if reuse:
                    self.assertTrue(models["adapters"]["ce_v4"]["directory"].startswith("previous-run"))
                    self.assertEqual(original_bytes, {p: p.read_bytes() for p in original_bytes})
                    provenance = json.loads((out / "candidate-provenance.json").read_text())
                    self.assertEqual(provenance["ce_v4"]["kind"], "verified_prior_run")


if __name__ == "__main__": unittest.main()
