"""Explicit v5 fixed-only training contract, separate from the v4 loss experiment."""
import json
import re

from curriculum_workflow import completed_candidate
from evaluate_gpu import sha256


def validate_corrective_config(config, manifest):
    if manifest.get("corpus") != "corrective-fixed-v5" or manifest.get("protocol") != "production-fixed-text-v1":
        raise ValueError("Expected explicit v5 production fixed-slot corpus")
    if manifest.get("prompt_variant") not in ["legacy", "roles"] or config.get("corrective_prompt_variant") != manifest["prompt_variant"]:
        raise ValueError("Corrective prompt variant changed")
    if config.get("initialization") != "resume_verified_adapter" or config.get("checkpoint_selection") != "final" or config.get("candidate_max_steps") != 32:
        raise ValueError("v5 requires a verified initial adapter and fixed 32-step final checkpoint")
    if config.get("semantic_marker_weight") is not None:
        raise ValueError("v5 uses the same ordinary causal CE in both arms")


def validate_corrective_row(row, manifest):
    if row.get("task") != "fixed" or row.get("prompt_variant") != manifest["prompt_variant"] or not row.get("pair_id"):
        raise ValueError("v5 optimization may only consume its own fixed-slot prompt variant")


def completed_corrective_candidate(folder, config_file, data, expected_initial=None):
    config = json.loads(config_file.read_text(encoding="utf-8"))
    manifest = json.loads((data / "manifest.json").read_text(encoding="utf-8"))
    validate_corrective_config(config, manifest)
    result = json.loads((folder / "training-result.json").read_text(encoding="utf-8"))
    identity = completed_candidate(folder, config)
    if result.get("config_sha256") != sha256(config_file) or result.get("input_manifest_sha256") != sha256(data / "manifest.json"):
        raise ValueError("Corrective training configuration/corpus changed")
    if result.get("local_weight_sha256") != config["base_weight_sha256"] or result.get("initial_adapter", {}).get("config_sha256") != config["initial_adapter_config_sha256"]:
        raise ValueError("Corrective base or initial adapter changed")
    digest = result.get("initial_trainable_sha256", "")
    if not isinstance(digest, str) or not re.fullmatch("[a-f0-9]{64}", digest) or (expected_initial is not None and digest != expected_initial):
        raise ValueError("Paired corrective LoRA initialization differs")
    initialization = json.loads((folder / "initialization.json").read_text(encoding="utf-8"))
    if result.get("base_weights_frozen") is not True or initialization != {"initial_trainable_sha256": digest,
            "expected_initial_sha256": expected_initial, "base_weights_frozen": True, "optimization_started": False}:
        raise ValueError("Corrective frozen-base initialization record changed")
    for split in ["train", "validation"]:
        actual = result["splits"][split]; record = manifest["files"][split]
        if actual["sha256"] != record["sha256"] or sha256(data / record["file"]) != record["sha256"] or actual["rows"] != record["rows"] or actual["task_counts"] != manifest["task_counts"][split]:
            raise ValueError("Corrective split identity changed")
        if actual.get("targets_truncated") is not False or actual.get("prompt_and_padding_masked") is not True or actual.get("eos_supervised") is not True:
            raise ValueError("Corrective target supervision changed")
    if result.get("loss_definition", {}).get("kind") != "trainer_default_causal_cross_entropy":
        raise ValueError("Unexpected corrective training loss")
    return identity
