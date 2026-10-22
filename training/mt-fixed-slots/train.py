"""Prepare masked SFT data or run a bounded CUDA LoRA pilot. Never uploads weights."""
import argparse
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import random
import struct
import time

HERE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument("--data", type=Path, required=True, help="Directory exported by tools/mt-quality-data.mjs")
parser.add_argument("--base", default=None, help="Local original base weights or pinned Hub model")
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--train", action="store_true", help="Requires CUDA; otherwise only validate/tokenize data")
parser.add_argument("--probe", action="store_true", help="Cap optimization at the configured 12 steps")
parser.add_argument("--allow-unreviewed-seed-data", action="store_true", help="Label the resulting run as a pipeline probe, not a release candidate")
args = parser.parse_args()
config = json.loads((HERE / "config.json").read_text())
args.output = args.output.resolve()
if args.train and args.output.exists() and any(args.output.iterdir()):
    raise ValueError("Training output must be a new or empty directory")
args.output.mkdir(parents=True, exist_ok=True)
manifest = json.loads((args.data / "manifest.json").read_text())
if manifest.get("protocol") != "production-fixed-text-v1":
    raise ValueError("Training data must be exported with the production fixed-text protocol")

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
import torch
import transformers
import peft
from transformers import AutoModelForCausalLM, AutoTokenizer, Trainer, TrainerCallback, TrainingArguments
from peft import LoraConfig, get_peft_model

random.seed(config["seed"])
torch.manual_seed(config["seed"])
torch.set_num_threads(2)
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
        prompt = tokenizer.apply_chat_template(messages[:1], tokenize=False, add_generation_prompt=True)
        prompt_ids = tokenizer(prompt, add_special_tokens=False)["input_ids"]
        target_ids = tokenizer(messages[1]["content"], add_special_tokens=False)["input_ids"] + [tokenizer.eos_token_id]
        input_ids = prompt_ids + target_ids
        if len(input_ids) > config["max_length"]:
            raise ValueError(f"Refusing to truncate a supervised target: {row['id']} ({len(input_ids)} tokens)")
        labels = [-100] * len(prompt_ids) + target_ids
        assert labels[:len(prompt_ids)] == [-100] * len(prompt_ids)
        assert labels[len(prompt_ids):] == target_ids and labels[-1] == tokenizer.eos_token_id
        encoded.append({"input_ids": input_ids, "attention_mask": [1] * len(input_ids), "labels": labels})
        lengths.append(len(input_ids)); targets.append(len(target_ids))
    datasets[split] = encoded
    stats["splits"][split] = {"rows": len(rows), "max_tokens": max(lengths), "target_tokens": sum(targets), "prompt_and_padding_masked": True, "eos_supervised": True, "targets_truncated": False, "sha256": record["sha256"]}

def collate(rows):
    size = max(len(row["input_ids"]) for row in rows)
    return {key: torch.tensor([row[key] + [(-100 if key == "labels" else 0 if key == "attention_mask" else tokenizer.pad_token_id)] * (size - len(row[key])) for row in rows], dtype=torch.long)
            for key in ["input_ids", "attention_mask", "labels"]}

batch = collate([datasets["train"][0], datasets["validation"][0]])
assert torch.all(batch["labels"][batch["attention_mask"] == 0] == -100)
stats["review_status"] = "assistant_authored_needs_human_review" if unreviewed else "human_reviewed"
stats["run_kind"] = "pipeline_probe" if unreviewed or args.probe else "fine_tuning_candidate"
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
if unreviewed and not args.allow_unreviewed_seed_data:
    raise ValueError("Seed references need human review; use --probe --allow-unreviewed-seed-data only for a pipeline trial")
if unreviewed and not args.probe:
    raise ValueError("Unreviewed seed data is restricted to the bounded --probe run")
if not torch.cuda.is_bf16_supported():
    raise RuntimeError("This BF16 pilot requires a GPU with BF16 support")

stats["gpu"] = {"name": torch.cuda.get_device_name(0), "total_memory_bytes": torch.cuda.get_device_properties(0).total_memory}
torch.cuda.reset_peak_memory_stats()
load_started = time.perf_counter()
model = AutoModelForCausalLM.from_pretrained(base, dtype=torch.bfloat16, attn_implementation="sdpa", low_cpu_mem_usage=True, **load_options)
model.config.use_cache = False
model = get_peft_model(model, LoraConfig(task_type="CAUSAL_LM", r=config["lora_r"], lora_alpha=config["lora_alpha"],
    lora_dropout=config["lora_dropout"], target_modules=config["target_modules"], bias="none"))
model.enable_input_require_grads()
stats["model_and_adapter_load_wall_s"] = time.perf_counter() - load_started
stats["parameters"] = {"total": sum(p.numel() for p in model.parameters()), "trainable": sum(p.numel() for p in model.parameters() if p.requires_grad)}
arguments = TrainingArguments(output_dir=str(args.output / "checkpoints"), num_train_epochs=config["epochs"],
    max_steps=config["probe_max_steps"] if args.probe else -1, per_device_train_batch_size=config["batch_size"], per_device_eval_batch_size=1,
    gradient_accumulation_steps=config["gradient_accumulation_steps"], learning_rate=config["learning_rate"], weight_decay=config["weight_decay"],
    warmup_ratio=config["warmup_ratio"], lr_scheduler_type="cosine", bf16=True, gradient_checkpointing=True,
    gradient_checkpointing_kwargs={"use_reentrant": False}, optim="adamw_torch", max_grad_norm=1.0,
    eval_strategy="epoch", save_strategy="epoch", save_total_limit=2, logging_steps=1, report_to=[],
    seed=config["seed"], data_seed=config["seed"], dataloader_num_workers=0, push_to_hub=False)
class FiniteMetrics(TrainerCallback):
    def on_log(self, args, state, control, logs=None, **kwargs):
        for key in ["loss", "eval_loss", "grad_norm"]:
            if key in (logs or {}) and not math.isfinite(float(logs[key])):
                raise FloatingPointError("Non-finite training metric: " + key)

trainer = Trainer(model=model, args=arguments, train_dataset=datasets["train"], eval_dataset=datasets["validation"], data_collator=collate, callbacks=[FiniteMetrics()])
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
(args.output / "training-result.json").write_text(json.dumps(stats, indent=2) + "\n")
print(json.dumps({"event": "completed", "run_kind": stats["run_kind"], "training_executed": True}), flush=True)
