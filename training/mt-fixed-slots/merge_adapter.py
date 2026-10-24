"""Merge a separately evaluated LoRA into a new directory. Never modifies base weights."""
import argparse
from pathlib import Path
import hashlib
import json
import time

parser = argparse.ArgumentParser()
parser.add_argument("--base", type=Path, required=True)
parser.add_argument("--adapter", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--threads", type=int, default=2)
args = parser.parse_args()
args.output = args.output.resolve()
if args.output.exists() and any(args.output.iterdir()):
    raise ValueError("Output directory must be empty")
if any(args.output.is_relative_to(path.resolve()) for path in [args.base, args.adapter]):
    raise ValueError("Output must not replace the base or adapter")
if args.threads < 1:
    raise ValueError("Positive thread count required")
import torch
import transformers
import peft
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel
torch.set_num_threads(args.threads)
started = time.perf_counter()
original_config = json.loads((args.base / "config.json").read_text(encoding="utf-8"))
base = AutoModelForCausalLM.from_pretrained(args.base, dtype=torch.bfloat16, local_files_only=True,
    trust_remote_code=False, attn_implementation="sdpa", low_cpu_mem_usage=True)
merged = PeftModel.from_pretrained(base, args.adapter, local_files_only=True).merge_and_unload(safe_merge=True)
merged.save_pretrained(args.output, safe_serialization=True, max_shard_size="2GB")
AutoTokenizer.from_pretrained(args.base, local_files_only=True, trust_remote_code=False).save_pretrained(args.output)
config_path = args.output / "config.json"
config = json.loads(config_path.read_text(encoding="utf-8"))
sanitized = []
if "eod_token_id" not in original_config and config.get("eod_token_id") == 3:
    del config["eod_token_id"]
    sanitized.append("synthetic eod_token_id=3")
    config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
def file_hash(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()
(args.output / "pagelingo-lineage.json").write_text(json.dumps({"base_path": str(args.base.resolve()),
    "adapter_path": str(args.adapter.resolve()), "base_weight_sha256": file_hash(args.base / "model.safetensors"),
    "adapter_sha256": file_hash(args.adapter / "adapter_model.safetensors"), "merge_wall_s": time.perf_counter() - started,
    "dtype": "bfloat16", "config_sanitized_fields": sanitized,
    "versions": {"torch": torch.__version__, "transformers": transformers.__version__, "peft": peft.__version__},
    "purpose": "Candidate for Q5 export and regression; not automatically approved for release"}, indent=2) + "\n", encoding="utf-8")
