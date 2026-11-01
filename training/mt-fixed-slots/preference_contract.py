"""Bounded v6 experiment identity and reference-cache checks, without ML imports."""
import json
import math
import re

from curriculum_workflow import completed_candidate
from evaluate_gpu import sha256

PROFILE = "BF16-semantic-preference-v6"
ARMS = {"sft_v6": 0.0, "dpo_v6": 0.25}


def validate_config(config, manifest):
    if manifest.get("corpus") != "semantic-preference-v6" or manifest.get("protocol") != "production-fixed-text-v1" or manifest.get("prompt_variant") != "legacy":
        raise ValueError("Expected explicit v6 production fixed-slot preferences")
    if config.get("preference_weight") not in ARMS.values() or isinstance(config.get("preference_weight"), bool):
        raise ValueError("Unexpected v6 preference weight")
    expected = {"initialization": "resume_verified_adapter", "checkpoint_selection": "final", "candidate_max_steps": 48,
        "epochs": 2, "batch_size": 1, "gradient_accumulation_steps": 8, "preference_beta": 0.1,
        "disable_all_dropout": True, "lora_dropout": 0.0}
    if any(config.get(key) != value for key, value in expected.items()) or config.get("semantic_marker_weight") is not None:
        raise ValueError("v6 requires paired 48-step settings, ordinary SFT, fixed reference and no dropout")


def read_corpus(data, manifest):
    splits, seen_ids, seen_prompts, families = {}, set(), set(), {}
    for split in ["train", "validation"]:
        record = manifest["files"][split]; file = data / record["file"]
        if file.parent.resolve() != data.resolve() or sha256(file) != record["sha256"]: raise ValueError("Corpus hash or path changed")
        rows = [json.loads(line) for line in file.read_text(encoding="utf-8").splitlines() if line]
        if len(rows) != record["rows"] or not rows: raise ValueError("Corpus row count changed")
        kinds = {"contrast": 0, "replay": 0}
        for row in rows:
            if row.get("split") != split or row.get("task") != "fixed" or row.get("prompt_variant") != "legacy" or row.get("review_status") != "assistant_audited_synthetic":
                raise ValueError("Unexpected training task or review provenance")
            if row["id"] in seen_ids or row["messages"][0]["content"] in seen_prompts: raise ValueError("Duplicate row/prompt")
            seen_ids.add(row["id"]); seen_prompts.add(row["messages"][0]["content"])
            if families.setdefault(row["family"], split) != split: raise ValueError("Family crosses optimizer/validation split")
            if [message["role"] for message in row["messages"]] != ["user", "assistant"]: raise ValueError("Unexpected message roles")
            if row.get("kind") not in kinds: raise ValueError("Unexpected row kind")
            kinds[row["kind"]] += 1
            chosen, rejected = row["messages"][1]["content"], row.get("rejected")
            if row["kind"] == "contrast":
                if not isinstance(rejected, str) or chosen == rejected or not row.get("rejected_error"): raise ValueError("Missing semantic negative")
                if re.findall(r"⟦/?\d+⟧|⟪P\d+⟫", chosen) != re.findall(r"⟦/?\d+⟧|⟪P\d+⟫", rejected): raise ValueError("Negative changes the fixed frame")
            elif rejected is not None or not row.get("source_id"): raise ValueError("Replay must have old train provenance and no negative")
        if kinds != record["kinds"]: raise ValueError("Contrast/replay count changed")
        splits[split] = rows
    return splits


def validate_cache(cache, manifest_sha, config, encoded, expected_initial=None):
    if cache.get("schema_version") != 1 or cache.get("input_manifest_sha256") != manifest_sha or cache.get("disable_all_dropout") is not True or cache.get("precision") != "cuda_bf16_autocast":
        raise ValueError("Reference cache input identity changed")
    for key in ["base_weight_sha256", "initial_adapter_sha256", "initial_adapter_config_sha256"]:
        if cache.get(key) != config[key]: raise ValueError("Reference model identity changed: " + key)
    digest = cache.get("initial_trainable_sha256", "")
    if not isinstance(digest, str) or not re.fullmatch("[a-f0-9]{64}", digest) or (expected_initial and digest != expected_initial):
        raise ValueError("Reference/paired initial adapter tensors differ")
    if set(cache.get("records", {})) != set(encoded): raise ValueError("Missing or extra reference records")
    for identity, item in encoded.items():
        row = cache["records"][identity]
        if row.get("tokens_sha256") != item["tokens_sha256"]: raise ValueError("Reference token identity changed")
        counts = [sum(token != -100 for token in sequence["labels"][1:]) for sequence in item["sequences"]]
        if row.get("target_counts") != counts: raise ValueError("Reference target counts changed")
        values = row.get("logps")
        if not isinstance(values, list) or len(values) != 2 or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v > 0 for v in values):
            raise ValueError("Invalid reference log probabilities")
    return digest


def completed_preference_candidate(folder, config_file, data, reference_file, expected_initial):
    config = json.loads(config_file.read_text(encoding="utf-8")); manifest = json.loads((data / "manifest.json").read_text(encoding="utf-8"))
    validate_config(config, manifest); read_corpus(data, manifest)
    result = json.loads((folder / "training-result.json").read_text(encoding="utf-8")); identity = completed_candidate(folder, config)
    for key, wanted in [("config_sha256", sha256(config_file)), ("input_manifest_sha256", sha256(data / "manifest.json")),
            ("reference_cache_sha256", sha256(reference_file)), ("local_weight_sha256", config["base_weight_sha256"]),
            ("initial_trainable_sha256", expected_initial), ("base_weights_frozen", True), ("dropout_disabled", True)]:
        if result.get(key) != wanted: raise ValueError("Preference result identity changed: " + key)
    init = json.loads((folder / "initialization.json").read_text(encoding="utf-8"))
    if init.get("initial_trainable_sha256") != expected_initial or init.get("optimization_started") is not False: raise ValueError("Preference initialization changed")
    final = result.get("final_trainable_sha256", "")
    if not isinstance(final, str) or not re.fullmatch("[a-f0-9]{64}", final) or final == expected_initial: raise ValueError("Trainable tensors did not update")
    if result.get("loss_definition") != {"kind": "chosen_ce_plus_reference_relative_dpo", "sft_weight": 1.0, "preference_weight": config["preference_weight"],
            "beta": config["preference_beta"], "logps": "target_sequence_sum_including_markers_and_eos", "replay_preference_weight": 0.0}:
        raise ValueError("Preference objective changed")
    for split, record in manifest["files"].items():
        actual = result["splits"][split]
        if actual["sha256"] != record["sha256"] or actual["rows"] != record["rows"] or actual["kinds"] != record["kinds"] or actual.get("targets_truncated") is not False or actual.get("prompt_and_padding_masked") is not True or actual.get("eos_supervised") is not True:
            raise ValueError("Preference target supervision changed")
    return identity
