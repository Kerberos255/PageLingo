"""Merge a separately evaluated LoRA into a new directory. Never modifies base weights."""
import argparse
from pathlib import Path
import json

parser = argparse.ArgumentParser()
parser.add_argument("--base", type=Path, required=True)
parser.add_argument("--adapter", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
args.output = args.output.resolve()
if args.output.exists() and any(args.output.iterdir()):
    raise ValueError("Output directory must be empty")
if args.output in [args.base.resolve(), args.adapter.resolve()]:
    raise ValueError("Output must not replace the base or adapter")
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel
base = AutoModelForCausalLM.from_pretrained(args.base, dtype=torch.bfloat16, local_files_only=True,
    trust_remote_code=False, attn_implementation="sdpa", low_cpu_mem_usage=True)
merged = PeftModel.from_pretrained(base, args.adapter, local_files_only=True).merge_and_unload(safe_merge=True)
merged.save_pretrained(args.output, safe_serialization=True, max_shard_size="2GB")
AutoTokenizer.from_pretrained(args.base, local_files_only=True, trust_remote_code=False).save_pretrained(args.output)
(args.output / "pagelingo-lineage.json").write_text(json.dumps({"base_path": str(args.base.resolve()),
    "adapter_path": str(args.adapter.resolve()), "purpose": "Candidate for Q5 export and regression; not automatically approved for release"}, indent=2) + "\n")
