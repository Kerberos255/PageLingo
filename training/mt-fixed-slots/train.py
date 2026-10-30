"""Prepare masked SFT data or run a bounded CUDA LoRA pilot. Never uploads weights."""
import argparse
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import random
import re
import struct
import time

HERE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument("--data", type=Path, required=True, help="Directory exported by tools/mt-quality-data.mjs")
parser.add_argument("--base", default=None, help="Local original base weights or pinned Hub model")
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--config", type=Path, default=HERE / "config.json")
parser.add_argument("--project-root", type=Path, help="Explicit local project for the verified initial adapter")
parser.add_argument("--train", action="store_true", help="Requires CUDA; otherwise only validate/tokenize data")
parser.add_argument("--probe", action="store_true", help="Cap optimization at the configured 12 steps")
parser.add_argument("--allow-unreviewed-seed-data", action="store_true", help="Label the resulting run as a pipeline probe, not a release candidate")
parser.add_argument("--synthetic-candidate", action="store_true", help="Explicit bounded research run on an audited v2/v3/v4 synthetic corpus; never marks data as human reviewed")
parser.add_argument("--expected-initial-sha256", help="Explicit paired-run guard, checked after LoRA initialization and before optimization")
args = parser.parse_args()
config = json.loads(args.config.read_text())
if args.synthetic_candidate:
    if args.probe or args.allow_unreviewed_seed_data:
        raise ValueError("Synthetic candidate and seed-probe modes must not be mixed")
    if not isinstance(config.get("candidate_max_steps"), int) or not 1 <= config["candidate_max_steps"] <= 128:
        raise ValueError("Synthetic candidates require an explicit 1..128 optimizer-step limit")
args.output = args.output.resolve()
if args.train and args.output.exists() and any(args.output.iterdir()):
    raise ValueError("Training output must be a new or empty directory")
args.output.mkdir(parents=True, exist_ok=True)
manifest = json.loads((args.data / "manifest.json").read_text())
semantic = manifest.get("corpus") == "semantic-rewrite-v4"
corrective = manifest.get("corpus") == "corrective-fixed-v5"
paired = semantic or corrective
if manifest.get("protocol") != ("semantic-rewrite-multitask-v1" if semantic else "production-fixed-text-v1"):
    raise ValueError("Training data must be exported with the production fixed-text protocol")
if args.synthetic_candidate and manifest.get("corpus") not in ["targeted-synthetic-v2", "targeted-synthetic-v3", "semantic-rewrite-v4", "corrective-fixed-v5"]:
    raise ValueError("Synthetic candidate mode requires a separate audited curriculum, not the old seed or an evaluation set")
if manifest.get("corpus") == "targeted-synthetic-v3" and config.get("checkpoint_selection") != "final":
    raise ValueError("v3 compares both fixed final checkpoints; total validation loss must not silently select one")
if semantic:
    if not args.synthetic_candidate or config.get("checkpoint_selection") != "final" or config.get("initialization") != "fresh_base":
        raise ValueError("v4 requires bounded synthetic mode, fresh base LoRA and fixed final checkpoints")
    from semantic_loss import token_weights, semantic_trainer_class
    token_weights("text", [(0, 4)], config.get("semantic_marker_weight"))
elif config.get("semantic_marker_weight") is not None:
    raise ValueError("Semantic loss weights are restricted to the explicit v4 corpus")
if corrective:
    if not args.synthetic_candidate:
        raise ValueError("Corrective data requires bounded synthetic research mode")
    from corrective_contract import validate_corrective_config, validate_corrective_row
    from validation_metrics import target_kinds
    validate_corrective_config(config, manifest)
if args.expected_initial_sha256 and (not paired or not re.fullmatch(r"[a-f0-9]{64}", args.expected_initial_sha256)):
    raise ValueError("Expected initialization digest must identify an explicit paired curriculum")

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
import torch
import transformers
import peft
from transformers import AutoModelForCausalLM, AutoTokenizer, Trainer, TrainerCallback
from peft import LoraConfig, PeftModel, get_peft_model
from training_options import build_training_arguments

random.seed(config["seed"])
torch.manual_seed(config["seed"])
torch.set_num_threads(2)
# This runs in check mode too, before hashing/tokenizing/loading the base.
# CPU-only preflight checks the same constructor with CPU precision settings.
arguments = build_training_arguments(config, args.output / "checkpoints", probe=args.probe,
                                     use_cpu=not torch.cuda.is_available(), synthetic_candidate=args.synthetic_candidate)
argument_check = {"passed": True, "device": str(arguments.device), "bf16": arguments.bf16,
                  "warmup_steps_argument": arguments.warmup_steps,
                  "warmup_steps_for_12_step_probe": arguments.get_warmup_steps(config["probe_max_steps"]),
                  "model_weights_loaded": False}
if args.synthetic_candidate:
    argument_check.update(max_optimizer_steps=arguments.max_steps,
                          warmup_steps_for_this_run=arguments.get_warmup_steps(arguments.max_steps))
print(json.dumps({"event": "training_arguments_checked", **argument_check}), flush=True)
base = args.base or config["base_model"]
local = Path(base).is_dir()
local_weight_digest = None
if local:
    with (Path(base) / config["base_weight_file"]).open("rb") as stream:
        local_weight_digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if local_weight_digest != config["base_weight_sha256"]:
        raise ValueError("Local weights differ from the pinned original base checkpoint")
load_options = {"trust_remote_code": False, **({"local_files_only": True} if local else {"revision": config["base_revision"]})}
tokenizer = AutoTokenizer.from_pretrained(base, **load_options)
if tokenizer.eos_token_id is None or tokenizer.pad_token_id is None:
    raise ValueError("Base tokenizer must define EOS and padding")
if local:
    original_config = json.loads((Path(base) / "config.json").read_text())
    if tokenizer.eos_token_id != original_config["eos_token_id"]:
        raise ValueError("Tokenizer EOS does not match the original model config")

stats = {"created_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "training_executed": False,
         "cuda_available": torch.cuda.is_available(), "base_model": config["base_model"], "base_revision": config["base_revision"],
         "base_path": base, "config": config, "versions": {"torch": torch.__version__, "transformers": transformers.__version__, "peft": peft.__version__},
         "local_weight_sha256": local_weight_digest,
         "config_sha256": hashlib.sha256(args.config.read_bytes()).hexdigest(),
         "training_argument_check": argument_check,
         "input_manifest_sha256": hashlib.sha256((args.data / "manifest.json").read_bytes()).hexdigest(), "splits": {}}
datasets, families, sources, ids = {}, {}, set(), set()
unreviewed = False
for split in ["train", "validation"]:  # Evaluation/diagnostic files can never enter optimizer inputs.
    record = manifest["files"][split]
    data_path = args.data / record["file"]
    raw = data_path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != record["sha256"]:
        raise ValueError("Data does not match export manifest: " + split)
    rows = [json.loads(line) for line in raw.decode().splitlines() if line.strip()]
    if not rows or len(rows) != record["rows"]:
        raise ValueError("Missing rows: " + split)
    encoded, lengths, targets = [], [], []
    task_counts, kind_counts, weighted_mass = {}, {}, {}
    for row in rows:
        if row["split"] != split or row["id"] in ids:
            raise ValueError("Incorrect split or duplicate ID")
        ids.add(row["id"])
        previous = families.setdefault(row["family"], split)
        if previous != split:
            raise ValueError("A template family crosses train/validation")
        messages = row["messages"]
        if [m["role"] for m in messages] != ["user", "assistant"]:
            raise ValueError("Expected one user prompt and one assistant target")
        if messages[0]["content"] in sources:
            raise ValueError("Duplicate source prompt")
        sources.add(messages[0]["content"])
        unreviewed |= row["review_status"] != "human_reviewed"
        if args.synthetic_candidate and row["review_status"] not in ["assistant_audited_synthetic", "human_reviewed"]:
            raise ValueError("Synthetic candidate contains an unaudited or evaluation reference: " + row["id"])
        if semantic and (row.get("task") not in ["natural", "fixed", "rewrite"] or not row.get("pair_id")):
            raise ValueError("v4 requires an explicit task and paired source identity")
        if corrective:
            validate_corrective_row(row, manifest)
        prompt = tokenizer.apply_chat_template(messages[:1], tokenize=False, add_generation_prompt=True)
        prompt_ids = tokenizer(prompt, add_special_tokens=False)["input_ids"]
        target_tokens = tokenizer(messages[1]["content"], add_special_tokens=False, **({"return_offsets_mapping": True} if paired else {}))
        target_ids = target_tokens["input_ids"] + [tokenizer.eos_token_id]
        input_ids = prompt_ids + target_ids
        if len(input_ids) > config["max_length"]:
            raise ValueError(f"Refusing to truncate a supervised target: {row['id']} ({len(input_ids)} tokens)")
        labels = [-100] * len(prompt_ids) + target_ids
        assert labels[:len(prompt_ids)] == [-100] * len(prompt_ids)
        assert labels[len(prompt_ids):] == target_ids and labels[-1] == tokenizer.eos_token_id
        item = {"input_ids": input_ids, "attention_mask": [1] * len(input_ids), "labels": labels}
        if paired:
            if semantic:
                weights, kinds = token_weights(messages[1]["content"], target_tokens["offset_mapping"], config["semantic_marker_weight"])
            else:
                kinds = target_kinds(messages[1]["content"], target_tokens["offset_mapping"]); weights = [1.] * len(kinds)
            assert len(weights) == len(target_ids)
            if semantic:
                item["loss_weights"] = [0.] * len(prompt_ids) + weights
            task_counts[row["task"]] = task_counts.get(row["task"], 0) + 1
            for kind, weight in zip(kinds, weights):
                kind_counts[kind] = kind_counts.get(kind, 0) + 1
                weighted_mass[kind] = weighted_mass.get(kind, 0.) + weight
        encoded.append(item)
        lengths.append(len(input_ids)); targets.append(len(target_ids))
    datasets[split] = encoded
    stats["splits"][split] = {"rows": len(rows), "max_tokens": max(lengths), "target_tokens": sum(targets), "prompt_and_padding_masked": True, "eos_supervised": True, "targets_truncated": False, "sha256": record["sha256"]}
    if paired:
        if task_counts != manifest["task_counts"][split]:
            raise ValueError("Task counts differ from the frozen manifest")
        stats["splits"][split].update(task_counts=task_counts, target_kind_tokens=kind_counts, weighted_target_mass=weighted_mass)

def collate(rows):
    size = max(len(row["input_ids"]) for row in rows)
    result = {key: torch.tensor([row[key] + [(-100 if key == "labels" else 0 if key == "attention_mask" else tokenizer.pad_token_id)] * (size - len(row[key])) for row in rows], dtype=torch.long)
              for key in ["input_ids", "attention_mask", "labels"]}
    if semantic:
        result["loss_weights"] = torch.tensor([row["loss_weights"] + [0.] * (size - len(row["loss_weights"])) for row in rows], dtype=torch.float32)
    return result

batch = collate([datasets["train"][0], datasets["validation"][0]])
assert torch.all(batch["labels"][batch["attention_mask"] == 0] == -100)
if semantic:
    assert torch.all(batch["loss_weights"][batch["labels"] == -100] == 0)
    stats["loss_definition"] = {"kind": "weighted_causal_target_mean", "marker_weight": config["semantic_marker_weight"], "content_weight": 1., "eos_weight": 1.,
                                "prompt_weight": 0., "padding_weight": 0., "validation_loss_is_weighted": True,
                                "note": "Unweighted content/marker/EOS NLL and real generations are evaluated separately; weighted losses never choose a winner."}
elif corrective:
    stats["loss_definition"] = {"kind": "trainer_default_causal_cross_entropy", "content_weight": 1., "marker_weight": 1.,
        "eos_weight": 1., "prompt_and_padding_masked": True, "validation_loss_is_weighted": False}
stats["review_status"] = "assistant_audited_synthetic" if args.synthetic_candidate and unreviewed else "assistant_authored_needs_human_review" if unreviewed else "human_reviewed"
stats["run_kind"] = "synthetic_research_candidate" if args.synthetic_candidate else "pipeline_probe" if unreviewed or args.probe else "fine_tuning_candidate"
resume_adapter = None
if config.get("initialization") in ["resume_verified_v022", "resume_verified_adapter"]:
    if not args.synthetic_candidate or not local:
        raise ValueError("Resuming a verified adapter requires the local synthetic-candidate workflow")
    project_root = args.project_root.resolve() if args.project_root else Path(base).resolve().parents[1]
    resume_adapter = (project_root / config["initial_adapter_directory"]).resolve()
    if not resume_adapter.is_relative_to(project_root):
        raise ValueError("Initial adapter escapes the local project")
    for filename, key in [("adapter_model.safetensors", "initial_adapter_sha256"), ("adapter_config.json", "initial_adapter_config_sha256")]:
        with (resume_adapter / filename).open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != config[key]:
                raise ValueError("Initial adapter identity changed: " + filename)
    adapter_config = json.loads((resume_adapter / "adapter_config.json").read_text())
    if adapter_config["r"] != config["lora_r"] or adapter_config["lora_alpha"] != config["lora_alpha"]:
        raise ValueError("Initial adapter rank/alpha differs from the candidate config")
    stats["initial_adapter"] = {"directory": str(resume_adapter), "sha256": config["initial_adapter_sha256"],
                                "config_sha256": config["initial_adapter_config_sha256"]}
stats["collator_padding_mask_checked"] = True
if local and (Path(base) / "model.safetensors").exists():
    with (Path(base) / "model.safetensors").open("rb") as stream:
        header = json.loads(stream.read(struct.unpack("<Q", stream.read(8))[0]))
    targets = {key: value["shape"] for key, value in header.items() if key != "__metadata__" and key.endswith(".weight") and key.split(".")[-2] in config["target_modules"]}
    if not all(any(key.split(".")[-2] == module for key in targets) for module in config["target_modules"]):
        raise ValueError("Configured LoRA target modules are not present in this base checkpoint")
    stats["checkpoint_target_check"] = {"matched_weight_tensors": len(targets),
        "lora_weights_from_tensor_shapes": sum(config["lora_r"] * sum(shape) for shape in targets.values())}
(args.output / "preflight.json").write_text(json.dumps(stats, indent=2) + "\n")
print(json.dumps({"event": "preflight", "training_executed": False, "splits": stats["splits"], "review_status": stats["review_status"]}), flush=True)
if not args.train:
    raise SystemExit(0)
if not torch.cuda.is_available():
    raise RuntimeError("CUDA GPU required for --train. CPU preflight succeeded; no optimization executed.")
if unreviewed and not args.allow_unreviewed_seed_data and not args.synthetic_candidate:
    raise ValueError("Seed references need human review; use --probe --allow-unreviewed-seed-data only for a pipeline trial")
if unreviewed and not args.probe and not args.synthetic_candidate:
    raise ValueError("Unreviewed seed data is restricted to the bounded --probe run")
if not torch.cuda.is_bf16_supported():
    raise RuntimeError("This BF16 pilot requires a GPU with BF16 support")

stats["gpu"] = {"name": torch.cuda.get_device_name(0), "total_memory_bytes": torch.cuda.get_device_properties(0).total_memory}
torch.cuda.reset_peak_memory_stats()
load_started = time.perf_counter()
model = AutoModelForCausalLM.from_pretrained(base, dtype=torch.bfloat16, attn_implementation="sdpa", low_cpu_mem_usage=True, **load_options)
model.config.use_cache = False
if resume_adapter:
    model = PeftModel.from_pretrained(model, resume_adapter, local_files_only=True, is_trainable=True)
else:
    model = get_peft_model(model, LoraConfig(task_type="CAUSAL_LM", r=config["lora_r"], lora_alpha=config["lora_alpha"],
        lora_dropout=config["lora_dropout"], target_modules=config["target_modules"], bias="none"))
model.enable_input_require_grads()
stats["model_and_adapter_load_wall_s"] = time.perf_counter() - load_started
stats["parameters"] = {"total": sum(p.numel() for p in model.parameters()), "trainable": sum(p.numel() for p in model.parameters() if p.requires_grad)}
if paired:
    if not stats["parameters"]["trainable"] or any(p.requires_grad and "lora_" not in name for name, p in model.named_parameters()):
        raise RuntimeError("Only LoRA parameters may train in paired curricula")
    stats["base_weights_frozen"] = True
    initial = hashlib.sha256()
    for name, parameter in sorted(model.named_parameters()):
        if parameter.requires_grad:
            initial.update(name.encode()); initial.update(str(parameter.dtype).encode()); initial.update(str(tuple(parameter.shape)).encode())
            initial.update(parameter.detach().cpu().contiguous().view(torch.uint8).numpy().tobytes())
    stats["initial_trainable_sha256"] = initial.hexdigest()
    if args.expected_initial_sha256 and args.expected_initial_sha256 != stats["initial_trainable_sha256"]:
        raise ValueError("Paired LoRA initialization differs; optimization did not start")
    (args.output / "initialization.json").write_text(json.dumps({"initial_trainable_sha256": stats["initial_trainable_sha256"],
        "expected_initial_sha256": args.expected_initial_sha256, "base_weights_frozen": True, "optimization_started": False}, indent=2) + "\n")
class FiniteMetrics(TrainerCallback):
    def on_log(self, args, state, control, logs=None, **kwargs):
        for key in ["loss", "eval_loss", "grad_norm"]:
            if key in (logs or {}) and not math.isfinite(float(logs[key])):
                raise FloatingPointError("Non-finite training metric: " + key)

TrainerType = semantic_trainer_class(Trainer) if semantic else Trainer
trainer = TrainerType(model=model, args=arguments, train_dataset=datasets["train"], eval_dataset=datasets["validation"], data_collator=collate, callbacks=[FiniteMetrics()])
start = time.perf_counter()
before = trainer.evaluate()
training = trainer.train()
after = trainer.evaluate()
model.save_pretrained(args.output / "adapter", safe_serialization=True)
tokenizer.save_pretrained(args.output / "adapter")
stats.update(training_executed=True, training_wall_s=time.perf_counter() - start, validation_before=before,
             validation_after=after, train_metrics=training.metrics,
             optimizer_steps=trainer.state.global_step, cuda_peak_allocated_bytes=torch.cuda.max_memory_allocated(),
             cuda_peak_reserved_bytes=torch.cuda.max_memory_reserved())
if args.synthetic_candidate:
    stats["selection"] = {"criterion": "fixed final checkpoint; both candidates require semantic review" if config.get("checkpoint_selection") == "final" else "validation loss only; release evaluation was not used for checkpoint selection",
                          "best_checkpoint": trainer.state.best_model_checkpoint, "best_metric": trainer.state.best_metric,
                          "max_optimizer_steps": config["candidate_max_steps"], "release_approved": False}
(args.output / "training-result.json").write_text(json.dumps(stats, indent=2) + "\n")
print(json.dumps({"event": "completed", "run_kind": stats["run_kind"], "training_executed": True}), flush=True)
