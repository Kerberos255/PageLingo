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
from preference_contract import completed_preference_candidate
import preference_workflow as workflow
from test_semantic_workflow import write_json
import test_semantic_evaluation as evaluation_fixtures

DIGEST = "d" * 64


class PreferenceWorkflowTests(unittest.TestCase):
    def kit(self, root):
        here = root / "kit"; here.mkdir(); base = root / "base"; base.mkdir(); old = root / "old"; old.mkdir()
        (base / "model.safetensors").write_bytes(b"fixture base"); (old / "adapter_model.safetensors").write_bytes(b"fixture old")
        write_json(old / "adapter_config.json", {})
        common = json.loads((HERE / "config-preference-v6.json").read_text()); common.update(base_weight_sha256=sha256(base / "model.safetensors"),
            initial_adapter_directory="old", initial_adapter_sha256=sha256(old / "adapter_model.safetensors"), initial_adapter_config_sha256=sha256(old / "adapter_config.json"))
        for label, weight in workflow.ARMS.items(): write_json(here / (label + ".json"), {**common, "preference_weight": weight})
        manifest = {"corpus": "semantic-preference-v6", "protocol": "production-fixed-text-v1", "prompt_variant": "legacy", "files": {}}
        for split, count in [("train", 192), ("validation", 32)]:
            rows = []
            for i in range(count):
                paired = i % 2 == 0
                rows.append({"id": f"{split}-{i}", "pair_id": str(i), "source_id": None if paired else "old-" + str(i),
                    "family": split + "-family", "split": split, "task": "fixed", "prompt_variant": "legacy", "review_status": "assistant_audited_synthetic",
                    "kind": "contrast" if paired else "replay", "rejected_error": "temporal inversion" if paired else None,
                    "messages": [{"role": "user", "content": f"{split}-{i}"}, {"role": "assistant", "content": "⟦0⟧先执行，再通知。⟦/0⟧"}],
                    "rejected": "⟦0⟧先通知，再执行。⟦/0⟧" if paired else None})
            file = here / "data" / (split + ".jsonl"); file.parent.mkdir(exist_ok=True); file.write_text("".join(json.dumps(row) + "\n" for row in rows))
            manifest["files"][split] = {"file": file.name, "sha256": sha256(file), "rows": count, "kinds": {"contrast": count // 2, "replay": count // 2}}
        write_json(here / "data/manifest.json", manifest)
        for name in ["evaluation-cases.json", "reference-review.md"]: write_json(here / "data" / name, {})
        plan = evaluation_fixtures.SemanticEvaluationGuards().plan(); plan["protocol"] = workflow.PROFILE; plan["jobs"] = plan["jobs"][:1]; write_json(here / "evaluation-plan.json", plan)
        spec = {"run_prefix": "pagelingo-quality-v6", "candidates": list(workflow.ARMS), "base": {"directory": "base", "sha256": common["base_weight_sha256"]},
            "old_r16": {"directory": "old", "sha256": common["initial_adapter_sha256"], "config_sha256": common["initial_adapter_config_sha256"]}}
        write_json(here / "workflow.json", spec); write_json(here / "package-manifest.json", {"schema_version": 1, "source_commit": "fixture", "source_dirty": False, "files": {}})
        return here, spec

    def candidate(self, out, here, reference, wrong):
        config_file = here / (out.name + ".json"); config = json.loads(config_file.read_text()); manifest = json.loads((here / "data/manifest.json").read_text())
        digest = "e" * 64 if wrong else DIGEST
        result = {"training_executed": True, "run_kind": "synthetic_research_candidate", "optimizer_steps": 48, "config": config,
            "config_sha256": sha256(config_file), "input_manifest_sha256": sha256(here / "data/manifest.json"),
            "reference_cache_sha256": sha256(reference), "local_weight_sha256": config["base_weight_sha256"],
            "initial_adapter": {"sha256": config["initial_adapter_sha256"]}, "initial_trainable_sha256": digest, "final_trainable_sha256": "f" * 64,
            "base_weights_frozen": True, "dropout_disabled": True, "selection": {"best_checkpoint": None}, "validation_after": {"eval_loss": 1.},
            "loss_definition": {"kind": "chosen_ce_plus_reference_relative_dpo", "sft_weight": 1.0, "preference_weight": config["preference_weight"],
                "beta": .1, "logps": "target_sequence_sum_including_markers_and_eos", "replay_preference_weight": 0.0},
            "splits": {split: {"sha256": record["sha256"], "rows": record["rows"], "kinds": record["kinds"], "targets_truncated": False,
                "prompt_and_padding_masked": True, "eos_supervised": True} for split, record in manifest["files"].items()}}
        write_json(out / "training-result.json", result); write_json(out / "initialization.json", {"initial_trainable_sha256": digest, "optimization_started": False})
        write_json(out / "validation-preferences.json", {}); write_json(out / "adapter/adapter_config.json", {})
        (out / "adapter/adapter_model.safetensors").write_bytes(b"fixture candidate")

    def test_pair_refuses_optimizer_or_corpus_mutations(self):
        with tempfile.TemporaryDirectory() as name:
            here, spec = self.kit(Path(name)); workflow.verify_pair(here, spec)
            file = here / "dpo_v6.json"; config = json.loads(file.read_text()); write_json(file, {**config, "learning_rate": .1})
            with self.assertRaisesRegex(ValueError, "only in preference"): workflow.verify_pair(here, spec)
            write_json(file, config); file = here / "data/train.jsonl"; file.write_text(file.read_text() + "\n")
            with self.assertRaisesRegex(ValueError, "hash"): workflow.verify_pair(here, spec)

    def test_check_full_evidence_and_initialization_failure_preserve_first_candidate(self):
        for mode, wrong in [("check", False), ("run", False), ("run", True)]:
            with self.subTest(mode=mode, wrong=wrong), tempfile.TemporaryDirectory() as name:
                root = Path(name); here, spec = self.kit(root); commands = []; owner = self
                class Process:
                    def __init__(self, command, **kwargs):
                        commands.append(command); self.stdout = iter(["fixture stage\n"])
                        if "--reference-only" in command:
                            output = Path(command[command.index("--output") + 1]); write_json(output / "reference-cache.json", {"initial_trainable_sha256": DIGEST})
                            write_json(output / "reference-result.json", {})
                        if "--train" in command:
                            reference = Path(command[command.index("--reference-cache") + 1]); owner.assertEqual(command[command.index("--expected-reference-sha256") + 1], sha256(reference))
                            owner.assertEqual(command[command.index("--expected-initial-sha256") + 1], DIGEST)
                            output = Path(command[command.index("--output") + 1]); owner.candidate(output, here, reference, wrong and output.name == "dpo_v6")
                        if command[2].endswith("evaluate_semantic.py") and "--check-only" not in command:
                            output = Path(command[command.index("--output") + 1]); output.mkdir(); runs = {"finished_utc": "fixture", "plan_sha256": sha256(here / "evaluation-plan.json"), "files": {}}
                            for label in ["base", "old_r16", "sft_v6", "dpo_v6"]:
                                file = output / (label + ".json"); write_json(file, {"finished_utc": "fixture", "generations": [{"key": "natural/test"}]})
                                runs["files"][label] = {"file": file.name, "sha256": sha256(file)}
                            write_json(output / "runs.json", runs)
                    def __enter__(self): return self
                    def __exit__(self, *args): return False
                    def wait(self, **kwargs): return 0
                torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True, is_bf16_supported=lambda: True))
                with patch.object(workflow, "HERE", here), patch.dict(sys.modules, {"torch": torch}), patch.object(sys, "argv", ["workflow", "--root", str(root), "--mode", mode]), patch.object(workflow.subprocess, "Popen", Process):
                    if wrong:
                        with self.assertRaisesRegex(ValueError, "identity changed"): workflow.main()
                    else: self.assertEqual(workflow.main(), 0)
                out = next((root / "outputs").iterdir()); status = json.loads((out / "workflow-result.json").read_text())
                self.assertFalse(status["release_approved"]); self.assertFalse(status["upload_executed"])
                self.assertEqual(sum("--train" in command for command in commands), 0 if mode == "check" else 2)
                self.assertEqual(sum("--reference-only" in command for command in commands), 0 if mode == "check" else 1)
                if wrong:
                    self.assertFalse(status["workflow_completed"]); self.assertTrue((out / "sft_v6/adapter/adapter_model.safetensors").exists())
                    self.assertIn("Traceback", (out / "console.log").read_text()); self.assertFalse((out / "evidence.zip").exists())
                elif mode == "run":
                    self.assertTrue(status["workflow_completed"])
                    with zipfile.ZipFile(out / "evidence.zip") as bundle:
                        self.assertIn("reference/reference-cache.json", bundle.namelist()); self.assertFalse(any("safetensors" in n for n in bundle.namelist()))


if __name__ == "__main__": unittest.main()
