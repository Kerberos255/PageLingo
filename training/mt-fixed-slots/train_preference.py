"""v6: pinned old-r16 reference cache and paired, bounded CUDA research training."""
import argparse
from contextlib import nullcontext
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import random
import time

from evaluate_gpu import sha256, write_json
from evaluate_matrix import pinned
from preference_contract import validate_config, read_corpus, validate_cache
from training_options import build_training_arguments


def tensor_digest(model):
    import torch
    digest = hashlib.sha256()
    for name, parameter in sorted(model.named_parameters()):
        if parameter.requires_grad:
            digest.update(name.encode()); digest.update(str(parameter.dtype).encode()); digest.update(str(tuple(parameter.shape)).encode())
            digest.update(parameter.detach().cpu().contiguous().view(torch.uint8).numpy().tobytes())
    return digest.hexdigest()


def tokenize_rows(tokenizer, splits, max_length):
    result, stats = {}, {}
    if tokenizer.eos_token_id != 120020 or tokenizer.pad_token_id is None or not tokenizer.is_fast: raise ValueError("Pinned original fast tokenizer/EOS required")
    for split, rows in splits.items():
        sizes, target_sizes, kinds = [], [], {"contrast": 0, "replay": 0}
        for row in rows:
            prompt = tokenizer.apply_chat_template(row["messages"][:1], tokenize=False, add_generation_prompt=True)
            prompt_ids = tokenizer(prompt, add_special_tokens=False)["input_ids"]
            if not prompt_ids: raise ValueError("Empty chat prompt")
            sequences = []
            chosen = row["messages"][1]["content"]
            for text in [chosen, row["rejected"] if row["kind"] == "contrast" else chosen]:
                target = tokenizer(text, add_special_tokens=False)["input_ids"] + [tokenizer.eos_token_id]
                if len(prompt_ids) + len(target) > max_length: raise ValueError("Refusing to truncate chosen/rejected target: " + row["id"])
                sequences.append({"input_ids": prompt_ids + target, "labels": [-100] * len(prompt_ids) + target})
                sizes.append(len(prompt_ids) + len(target)); target_sizes.append(len(target))
            raw = json.dumps(sequences, separators=(",", ":")).encode()
            result[row["id"]] = {"sequences": sequences, "paired": row["kind"] == "contrast", "tokens_sha256": hashlib.sha256(raw).hexdigest()}
            kinds[row["kind"]] += 1
        stats[split] = {"rows": len(rows), "kinds": kinds, "max_tokens": max(sizes), "target_tokens_both_alternatives": sum(target_sizes),
            "targets_truncated": False, "prompt_and_padding_masked": True, "eos_supervised": True}
    return result, stats


def collator(pad_token_id):
    import torch
    def collate(rows):
        sequences = [sequence for row in rows for sequence in row["sequences"]]
        width = max(len(s["input_ids"]) for s in sequences)
        batch = {"input_ids": [], "labels": [], "attention_mask": []}
        for sequence in sequences:
            length = len(sequence["input_ids"]); padding = width - length
            batch["input_ids"].append(sequence["input_ids"] + [pad_token_id] * padding)
            batch["labels"].append(sequence["labels"] + [-100] * padding)
            batch["attention_mask"].append([1] * length + [0] * padding)
        return {**{key: torch.tensor(value, dtype=torch.long) for key, value in batch.items()},
            "reference_logps": torch.tensor([row.get("reference_logps", [0.0, 0.0]) for row in rows], dtype=torch.float32),
            "paired": torch.tensor([row["paired"] for row in rows], dtype=torch.bool)}
    return collate


def policy_scores(model, encoded, collate, *, progress=False):
    import torch
    from preference_loss import causal_logps
    model.eval(); result = {}
    precision = torch.autocast(device_type="cuda", dtype=torch.bfloat16) if model.device.type == "cuda" else nullcontext()
    with torch.inference_mode(), precision:
        for index, (identity, item) in enumerate(encoded.items()):
            batch = collate([item]); labels = batch.pop("labels").to(model.device)
            batch.pop("reference_logps"); batch.pop("paired")
            logps, counts = causal_logps(model(**{key: value.to(model.device) for key, value in batch.items()}, use_cache=False).logits, labels)
            result[identity] = {"tokens_sha256": item["tokens_sha256"], "logps": logps.cpu().tolist(), "target_counts": counts.cpu().tolist()}
            if progress and (index + 1) % 32 == 0: print(json.dumps({"event": "reference_scored", "rows": index + 1, "total": len(encoded)}), flush=True)
    return result


def validation_summary(scores, rows, reference, beta):
    pairs = [row["id"] for row in rows if row["kind"] == "contrast"]
    if not pairs: raise ValueError("Missing validation contrasts")
    ids = [row["id"] for row in rows]
    margins = [scores[i]["logps"][0] - scores[i]["logps"][1] for i in pairs]
    relative = [margin - (reference[i]["logps"][0] - reference[i]["logps"][1]) for i, margin in zip(pairs, margins)]
    return {"eval_loss": sum(-scores[i]["logps"][0] / scores[i]["target_counts"][0] for i in ids) / len(ids),
        "pair_rows": len(pairs), "chosen_higher_sequence_logp": sum(margin > 0 for margin in margins),
        "mean_reference_relative_margin": sum(relative) / len(relative),
        "mean_dpo_loss": sum(math.log1p(math.exp(-abs(beta * margin))) + max(-beta * margin, 0) for margin in relative) / len(relative),
        "note": "Sequence-likelihood preference diagnostics, not generated semantic accuracy; ties are not positive."}


def main():
    parser = argparse.ArgumentParser()
    for name in ["data", "base", "output", "config", "project-root"]: parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--train", action="store_true"); parser.add_argument("--reference-only", action="store_true")
    parser.add_argument("--reference-cache", type=Path); parser.add_argument("--expected-initial-sha256"); parser.add_argument("--expected-reference-sha256")
    args = parser.parse_args()
    if args.train and args.reference_only: raise ValueError("Reference creation and optimization are separate stages")
    if args.train and (not args.reference_cache or not args.expected_initial_sha256 or not args.expected_reference_sha256): raise ValueError("Training requires a frozen reference cache and paired initialization")
    output = args.output.resolve(); root = args.project_root.resolve()
    if not output.is_relative_to(root) or (output.exists() and any(output.iterdir())): raise ValueError("Use a new output inside the project")
    config = json.loads(args.config.read_text(encoding="utf-8")); manifest = json.loads((args.data / "manifest.json").read_text(encoding="utf-8"))
    validate_config(config, manifest); splits = read_corpus(args.data, manifest)
    base = pinned(root, {"directory": str(args.base), "sha256": config["base_weight_sha256"]}, config["base_weight_file"])
    adapter = pinned(root, {"directory": config["initial_adapter_directory"], "sha256": config["initial_adapter_sha256"],
        "config_sha256": config["initial_adapter_config_sha256"]}, "adapter_model.safetensors")
    adapter_config = json.loads((adapter / "adapter_config.json").read_text(encoding="utf-8"))
    if adapter_config["r"] != config["lora_r"] or adapter_config["lora_alpha"] != config["lora_alpha"]: raise ValueError("Old adapter rank/alpha changed")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    import torch
    import transformers
    import peft
    from transformers import AutoTokenizer, AutoModelForCausalLM, Trainer, TrainerCallback
    from peft import PeftModel
    from preference_loss import preference_trainer_class
    random.seed(config["seed"]); torch.manual_seed(config["seed"]); torch.set_num_threads(2)
    arguments = build_training_arguments(config, output / "checkpoints", synthetic_candidate=True, use_cpu=not torch.cuda.is_available())
    # Pair metadata is consumed by compute_loss, not by model.forward.
    arguments.remove_unused_columns = False; arguments.eval_strategy = "no"; arguments.save_strategy = "no"
    tokenizer = AutoTokenizer.from_pretrained(base, local_files_only=True, trust_remote_code=False)
    encoded, split_stats = tokenize_rows(tokenizer, splits, config["max_length"])
    for split in split_stats: split_stats[split]["sha256"] = manifest["files"][split]["sha256"]
    cache = None
    if args.reference_cache:
        if args.expected_reference_sha256 and sha256(args.reference_cache) != args.expected_reference_sha256: raise ValueError("Frozen reference cache file changed")
        cache = json.loads(args.reference_cache.read_text(encoding="utf-8"))
        validate_cache(cache, sha256(args.data / "manifest.json"), config, encoded, args.expected_initial_sha256)
    collate = collator(tokenizer.pad_token_id)
    sample = collate([encoded[splits["train"][0]["id"]], encoded[splits["validation"][-1]["id"]]])
    assert torch.all(sample["labels"][sample["attention_mask"] == 0] == -100)
    stats = {"created_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "training_executed": False,
        "run_kind": "synthetic_research_candidate", "config": config, "config_sha256": sha256(args.config),
        "input_manifest_sha256": sha256(args.data / "manifest.json"), "local_weight_sha256": config["base_weight_sha256"],
        "initial_adapter": {"sha256": config["initial_adapter_sha256"], "config_sha256": config["initial_adapter_config_sha256"]},
        "splits": split_stats, "review_status": "assistant_audited_synthetic", "independently_human_reviewed": False,
        "versions": {"torch": torch.__version__, "transformers": transformers.__version__, "peft": peft.__version__},
        "training_argument_check": {"passed": True, "device": str(arguments.device), "bf16": arguments.bf16,
            "max_optimizer_steps": arguments.max_steps, "warmup_steps_for_this_run": arguments.get_warmup_steps(arguments.max_steps), "model_weights_loaded": False},
        "loss_definition": {"kind": "chosen_ce_plus_reference_relative_dpo", "sft_weight": 1.0, "preference_weight": config["preference_weight"],
            "beta": config["preference_beta"], "logps": "target_sequence_sum_including_markers_and_eos", "replay_preference_weight": 0.0}}
    output.mkdir(parents=True, exist_ok=True); write_json(output / "preflight.json", stats)
    print(json.dumps({"event": "preference_preflight", "splits": split_stats, "model_weights_loaded": False}), flush=True)
    if not args.train and not args.reference_only: return 0
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported(): raise RuntimeError("BF16 CUDA required; CPU preflight passed, no model loaded")
    stats["gpu"] = {"name": torch.cuda.get_device_name(0), "total_memory_bytes": torch.cuda.get_device_properties(0).total_memory}
    torch.cuda.reset_peak_memory_stats(); started = time.perf_counter()
    model = AutoModelForCausalLM.from_pretrained(base, local_files_only=True, trust_remote_code=False, dtype=torch.bfloat16,
        attn_implementation="sdpa", low_cpu_mem_usage=True)
    model = PeftModel.from_pretrained(model, adapter, local_files_only=True, is_trainable=True).to("cuda")
    model.config.use_cache = False; model.enable_input_require_grads()
    if not any(p.requires_grad for p in model.parameters()) or any(p.requires_grad and "lora_" not in name for name, p in model.named_parameters()):
        raise ValueError("Only nonempty LoRA parameters may train")
    dropout_count = 0
    for module in model.modules():
        if isinstance(module, torch.nn.Dropout): module.p = 0.0; dropout_count += 1
        if hasattr(module, "attention_dropout") and isinstance(module.attention_dropout, (int, float)): module.attention_dropout = 0.0
    for adapter_options in model.peft_config.values(): adapter_options.lora_dropout = 0.0
    digest = tensor_digest(model)
    if args.expected_initial_sha256 and args.expected_initial_sha256 != digest: raise ValueError("Paired LoRA initialization differs; no optimization started")
    if cache: validate_cache(cache, stats["input_manifest_sha256"], config, encoded, digest)
    stats.update(initial_trainable_sha256=digest, base_weights_frozen=True, dropout_disabled=True, disabled_dropout_modules=dropout_count,
        model_and_adapter_load_wall_s=time.perf_counter() - started)
    write_json(output / "initialization.json", {"initial_trainable_sha256": digest, "expected_initial_sha256": args.expected_initial_sha256,
        "base_weights_frozen": True, "dropout_disabled": True, "optimization_started": False})
    if args.reference_only:
        started = time.perf_counter(); records = policy_scores(model, encoded, collate, progress=True)
        reference = {"schema_version": 1, "input_manifest_sha256": stats["input_manifest_sha256"], "disable_all_dropout": True, "precision": "cuda_bf16_autocast",
            "initial_trainable_sha256": digest, "records": records,
            **{key: config[key] for key in ["base_weight_sha256", "initial_adapter_sha256", "initial_adapter_config_sha256"]}}
        validate_cache(reference, stats["input_manifest_sha256"], config, encoded, digest)
        write_json(output / "reference-cache.json", reference)
        stats.update(reference_wall_s=time.perf_counter() - started, reference_rows=len(records), cuda_peak_allocated_bytes=torch.cuda.max_memory_allocated(),
            cuda_peak_reserved_bytes=torch.cuda.max_memory_reserved(), reference_cache_sha256=sha256(output / "reference-cache.json"))
        write_json(output / "reference-result.json", stats); print("REFERENCE_COMPLETE", flush=True); return 0
    stats["reference_cache_sha256"] = sha256(args.reference_cache)
    for identity, item in encoded.items(): item["reference_logps"] = cache["records"][identity]["logps"]
    datasets = {split: [encoded[row["id"]] for row in rows] for split, rows in splits.items()}
    stats["validation_before"] = validation_summary(cache["records"], splits["validation"], cache["records"], config["preference_beta"])
    class FiniteMetrics(TrainerCallback):
        def on_log(self, args, state, control, logs=None, **kwargs):
            for key in ["loss", "grad_norm"]:
                if key in (logs or {}) and not math.isfinite(float(logs[key])): raise FloatingPointError("Non-finite optimizer metric: " + key)
    TrainerType = preference_trainer_class(Trainer)
    trainer = TrainerType(model=model, args=arguments, train_dataset=datasets["train"], data_collator=collate, callbacks=[FiniteMetrics()],
        beta=config["preference_beta"], preference_weight=config["preference_weight"])
    started = time.perf_counter(); training = trainer.train(); stats["training_wall_s"] = time.perf_counter() - started
    if trainer.state.global_step != config["candidate_max_steps"]: raise ValueError("Optimization did not reach the frozen budget")
    model.save_pretrained(output / "adapter", safe_serialization=True); tokenizer.save_pretrained(output / "adapter")
    validation_ids = {row["id"] for row in splits["validation"]}
    scores = policy_scores(model, {key: item for key, item in encoded.items() if key in validation_ids}, collate)
    write_json(output / "validation-preferences.json", scores)
    final_digest = tensor_digest(model)
    if final_digest == digest: raise ValueError("Optimizer completed without changing trainable tensors")
    stats.update(training_executed=True, optimizer_steps=trainer.state.global_step, train_metrics=training.metrics, final_trainable_sha256=final_digest,
        validation_after=validation_summary(scores, splits["validation"], cache["records"], config["preference_beta"]),
        cuda_peak_allocated_bytes=torch.cuda.max_memory_allocated(), cuda_peak_reserved_bytes=torch.cuda.max_memory_reserved(),
        selection={"criterion": "fixed final checkpoint; generated meaning and coverage require Cloud review", "best_checkpoint": None, "release_approved": False})
    write_json(output / "training-result.json", stats); print("TRAINING_COMPLETE: research evidence only", flush=True); return 0


if __name__ == "__main__": raise SystemExit(main())
