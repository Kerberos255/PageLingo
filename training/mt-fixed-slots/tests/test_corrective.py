import copy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

HERE = Path(__file__).resolve().parents[1]; sys.path.insert(0, str(HERE))
from evaluate_gpu import sha256
from evaluate_semantic import validate_plan
from corrective_contract import validate_corrective_config, validate_corrective_row
import corrective_workflow as workflow
from test_semantic_workflow import write_json
import test_semantic_evaluation as evaluation_fixtures

DIGEST = "d" * 64


class CorrectiveTests(unittest.TestCase):
    def kit(self, root):
        here = root / "kit"; here.mkdir()
        base = root / "base"; base.mkdir(); (base / "model.safetensors").write_bytes(b"fixture base")
        old = root / "old"; old.mkdir(); (old / "adapter_model.safetensors").write_bytes(b"fixture old r16"); (old / "adapter_config.json").write_text("{}")
        common = json.loads((HERE / "config-corrective-v5.json").read_text()); common.update(base_weight_sha256=sha256(base / "model.safetensors"),
            initial_adapter_directory="old", initial_adapter_sha256=sha256(old / "adapter_model.safetensors"), initial_adapter_config_sha256=sha256(old / "adapter_config.json"))
        for label, variant in workflow.VARIANTS.items():
            write_json(here / (label + ".json"), {**common, "corrective_prompt_variant": variant})
            manifest = {"corpus": "corrective-fixed-v5", "protocol": "production-fixed-text-v1", "prompt_variant": variant, "files": {}, "task_counts": {}}
            for split in ["train", "validation"]:
                row = {"pair_id": split + "-source", "family": split + "-family", "split": split, "messages": [{"role": "user", "content": variant}, {"role": "assistant", "content": "⟦0⟧译文⟦/0⟧"}]}
                file = here / "data" / variant / (split + ".jsonl"); file.parent.mkdir(parents=True, exist_ok=True); file.write_text(json.dumps(row) + "\n")
                manifest["files"][split] = {"file": file.name, "sha256": sha256(file), "rows": 1}; manifest["task_counts"][split] = {"fixed": 1}
            write_json(here / "data" / variant / "manifest.json", manifest)
        for name in ["manifest.json", "evaluation-cases.json", "evaluation-validation.jsonl", "reference-review.md"]: write_json(here / "data" / name, {})
        plan = evaluation_fixtures.SemanticEvaluationGuards().plan(); plan["protocol"] = "BF16-corrective-fixed-v5"; plan["jobs"] = plan["jobs"][:1]
        write_json(here / "evaluation-plan.json", plan)
        spec = {"run_prefix": "pagelingo-quality-v5", "candidates": list(workflow.VARIANTS),
            "base": {"directory": "base", "sha256": common["base_weight_sha256"]},
            "old_r16": {"directory": "old", "sha256": common["initial_adapter_sha256"], "config_sha256": common["initial_adapter_config_sha256"]}}
        write_json(here / "workflow.json", spec); write_json(here / "package-manifest.json", {"schema_version": 1, "source_commit": "fixture", "source_dirty": False, "files": {}})
        return here, spec

    def candidate(self, folder, config_file, data, expected, wrong=False):
        config = json.loads(config_file.read_text()); manifest = json.loads((data / "manifest.json").read_text()); digest = "e" * 64 if wrong else DIGEST
        result = {"training_executed": True, "run_kind": "synthetic_research_candidate", "optimizer_steps": 32, "config": config,
            "config_sha256": sha256(config_file), "input_manifest_sha256": sha256(data / "manifest.json"), "local_weight_sha256": config["base_weight_sha256"],
            "initial_adapter": {"sha256": config["initial_adapter_sha256"], "config_sha256": config["initial_adapter_config_sha256"]},
            "base_weights_frozen": True, "initial_trainable_sha256": digest, "selection": {"best_checkpoint": None},
            "validation_after": {"eval_loss": 1.0}, "loss_definition": {"kind": "trainer_default_causal_cross_entropy"},
            "splits": {split: {"sha256": record["sha256"], "rows": record["rows"], "task_counts": {"fixed": 1},
                "targets_truncated": False, "prompt_and_padding_masked": True, "eos_supervised": True} for split, record in manifest["files"].items()}}
        write_json(folder / "training-result.json", result); write_json(folder / "initialization.json", {"initial_trainable_sha256": digest,
            "expected_initial_sha256": expected, "base_weights_frozen": True, "optimization_started": False})
        write_json(folder / "adapter/adapter_config.json", {}); (folder / "adapter/adapter_model.safetensors").write_bytes(b"fixture corrected adapter")

    def test_contract_refuses_drafts_wrong_variants_fresh_base_or_reweighted_loss(self):
        config = json.loads((HERE / "config-corrective-v5.json").read_text()); config["corrective_prompt_variant"] = "legacy"
        manifest = {"corpus": "corrective-fixed-v5", "protocol": "production-fixed-text-v1", "prompt_variant": "legacy"}
        validate_corrective_config(config, manifest)
        for field, value in [("initialization", "fresh_base"), ("candidate_max_steps", 64), ("semantic_marker_weight", .25), ("corrective_prompt_variant", "roles")]:
            bad = {**config, field: value}
            with self.subTest(field=field), self.assertRaises(ValueError): validate_corrective_config(bad, manifest)
        row = {"task": "fixed", "pair_id": "source", "prompt_variant": "legacy"}; validate_corrective_row(row, manifest)
        for field, value in [("task", "rewrite"), ("task", "natural"), ("prompt_variant", "roles"), ("pair_id", None)]:
            with self.assertRaises(ValueError): validate_corrective_row({**row, field: value}, manifest)

    def test_pair_rejects_changed_source_order_targets_or_optimizer(self):
        with tempfile.TemporaryDirectory() as name:
            here, spec = self.kit(Path(name)); workflow.verify_pair(here, spec)
            file = here / "roles_v5.json"; original = json.loads(file.read_text()); write_json(file, {**original, "seed": 43})
            with self.assertRaisesRegex(ValueError, "only in prompt"): workflow.verify_pair(here, spec)
            write_json(file, original)
            file = here / "data/roles/train.jsonl"; row = json.loads(file.read_text()); row["messages"][1]["content"] = "changed"; file.write_text(json.dumps(row) + "\n")
            manifest = json.loads((file.parent / "manifest.json").read_text()); manifest["files"]["train"]["sha256"] = sha256(file); write_json(file.parent / "manifest.json", manifest)
            with self.assertRaisesRegex(ValueError, "source order or targets"): workflow.verify_pair(here, spec)

    def test_v5_profile_cannot_silently_reenable_draft_rewriting(self):
        plan = evaluation_fixtures.SemanticEvaluationGuards().plan(); plan["protocol"] = "BF16-corrective-fixed-v5"
        with self.assertRaisesRegex(ValueError, "excludes draft"): validate_plan(plan)
        plan["jobs"] = plan["jobs"][:1]; validate_plan(plan)

    def test_complete_workflow_and_initialization_failure_after_first_saved_candidate(self):
        for mode, wrong in [("check", False), ("run", False), ("run", True)]:
            with self.subTest(mode=mode, wrong=wrong), tempfile.TemporaryDirectory() as name:
                root = Path(name); here, spec = self.kit(root); commands = []; owner = self
                class Process:
                    def __init__(self, command, **kwargs):
                        commands.append(command); self.stdout = iter(["fixture stage\n"])
                        if "--train" in command:
                            output = Path(command[command.index("--output") + 1]); config = Path(command[command.index("--config") + 1]); data = Path(command[command.index("--data") + 1])
                            expected = command[command.index("--expected-initial-sha256") + 1] if "--expected-initial-sha256" in command else None
                            owner.candidate(output, config, data, expected, wrong and output.name == "roles_v5")
                        if command[2].endswith("evaluate_semantic.py") and "--check-only" not in command:
                            output = Path(command[command.index("--output") + 1]); output.mkdir()
                            runs = {"finished_utc": "fixture", "plan_sha256": sha256(here / "evaluation-plan.json"), "files": {}}
                            for label in ["base", "old_r16", "legacy_v5", "roles_v5"]:
                                file = output / (label + ".json"); write_json(file, {"finished_utc": "fixture", "generations": [{"key": "natural/test"}]})
                                runs["files"][label] = {"file": file.name, "sha256": sha256(file)}
                            write_json(output / "runs.json", runs)
                    def __enter__(self): return self
                    def __exit__(self, *args): return False
                    def wait(self, **kwargs): return 0
                torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True, is_bf16_supported=lambda: True))
                with patch.object(workflow, "HERE", here), patch.dict(sys.modules, {"torch": torch}), patch.object(sys, "argv", ["workflow", "--root", str(root), "--mode", mode]), patch.object(workflow.subprocess, "Popen", Process):
                    if wrong:
                        with self.assertRaisesRegex(ValueError, "initialization differs"): workflow.main()
                    else: self.assertEqual(workflow.main(), 0)
                out = next((root / "outputs").iterdir()); status = json.loads((out / "workflow-result.json").read_text())
                self.assertEqual(sum("--train" in command for command in commands), 0 if mode == "check" else 2)
                self.assertFalse(status["release_approved"]); self.assertFalse(status["upload_executed"])
                if wrong:
                    self.assertFalse(status["workflow_completed"]); self.assertEqual(status["error_type"], "ValueError")
                    self.assertTrue((out / "legacy_v5/adapter/adapter_model.safetensors").exists())
                    self.assertIn("Traceback", (out / "console.log").read_text()); self.assertFalse((out / "evidence.zip").exists())
                elif mode == "run":
                    self.assertTrue(status["workflow_completed"]); self.assertEqual(status["paired_initial_sha256"], DIGEST)
                    with zipfile.ZipFile(out / "evidence.zip") as bundle:
                        self.assertIn("training/roles_v5-initialization.json", bundle.namelist()); self.assertFalse(any("safetensors" in n for n in bundle.namelist()))


if __name__ == "__main__": unittest.main()
