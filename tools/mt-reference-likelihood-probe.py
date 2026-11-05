"""Read-only original-BF16 likelihood of three nonce translations, no training."""
import argparse
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "training/mt-fixed-slots"))
spec = importlib.util.spec_from_file_location("mining_score", ROOT / "tools/mt-mining-score.py")
score = importlib.util.module_from_spec(spec)
spec.loader.exec_module(score)
parser = argparse.ArgumentParser()
for name in ["root", "base", "adapter", "mining-plan", "mining-scores", "output"]:
    parser.add_argument("--" + name, type=Path, required=True)
args = parser.parse_args()
if args.output.exists():
    raise ValueError("Preserve previous likelihood evidence")
read = lambda p: json.loads(p.read_text())
sha = score.sha256
identity = "v5-train-nonce-lifetimes-0"
config = read(ROOT / "training/mt-fixed-slots/config-preference-v6.json")
for file, wanted in [(args.base / "model.safetensors", config["base_weight_sha256"]),
                     (args.adapter / "adapter_model.safetensors", config["initial_adapter_sha256"]),
                     (args.adapter / "adapter_config.json", config["initial_adapter_config_sha256"])]:
    assert sha(file) == wanted
plan = read(args.root / "plan-final.json")
old_plan = read(args.mining_plan)
old_score = next(row for row in read(args.mining_scores)["rows"] if row["id"] == identity)
sample = next(c for c in old_plan["cases"] if c["id"] == identity)
assert sample["split"] == "train"
request = next(j["request"] for j in plan["jobs"] if j["case_id"] == identity and j["variant"] == "production-fixed:0")
assert request == next(j["request"] for j in old_plan["jobs"] if j["case_id"] == identity)
q5 = read(args.root / "old_r16_q5/run.json")
bf16 = read(args.root / "old_r16_bf16_controls/run.json")
assert q5["finished_utc"] and bf16["finished_utc"]
assert q5["model"]["sha256"] == "748c66dee23ec95583d0c84bd49bd3e516b0d2c1d242fbf4e152ff710e0f62bb"
assert bf16["model"]["sha256"] == "5264eab232fd1a9ae1f3c939a067849d2d8ebbf03d70d1d765f9be031bb39440"
rows = [next(g for g in run["generations"] if g["case_id"] == identity and g["variant"] == "production-fixed:0") for run in [q5, bf16]]
assert all(g["finish_reason"] == "stop" for g in rows)
assert rows[0]["request_sha256"] == rows[1]["request_sha256"] == hashlib.sha256(json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
audit = read(args.root / "audit.json")
assert next(r for r in audit["models"]["old_r16_q5"] if r["id"] == identity)["production"]["verdict"] == "semantic_error"
assert next(r for r in read(args.root / "bf16-audit.json")["rows"] if r["id"] == identity)["production"]["verdict"] == "faithful"

import torch
import transformers
import peft
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel
torch.set_num_threads(2)
torch.manual_seed(42)
tokenizer = AutoTokenizer.from_pretrained(args.base, local_files_only=True, trust_remote_code=False)
assert tokenizer.is_fast and tokenizer.eos_token_id == 120020
prompt = tokenizer.apply_chat_template(request["messages"], tokenize=False, add_generation_prompt=True)
ids = tokenizer(prompt, add_special_tokens=False)["input_ids"]
assert all(g["actual_prompt_sha256"] == hashlib.sha256(prompt.encode()).hexdigest() and
           g["input_token_ids_sha256"] == hashlib.sha256(json.dumps(ids, separators=(",", ":")).encode()).hexdigest() for g in rows)
started = time.perf_counter()
model = AutoModelForCausalLM.from_pretrained(args.base, local_files_only=True, trust_remote_code=False,
    dtype=torch.bfloat16, attn_implementation="sdpa", low_cpu_mem_usage=True)
model = PeftModel.from_pretrained(model, args.adapter, local_files_only=True, is_trainable=False).to("cpu").eval()
model.requires_grad_(False)
assert not any(p.requires_grad for p in model.parameters())
result = {"purpose": "Post-observation reference-likelihood diagnostic on one old training source; not training or heldout accuracy.",
    "independent_human_review": False, "training_executed": False, "optimizer_inputs_approved": False,
    "case_id": identity, "device": "cpu", "dtype": "bfloat16", "grammar_in_likelihood": False,
    "versions": {"torch": torch.__version__, "transformers": transformers.__version__, "peft": peft.__version__},
    "input_hashes": {str(p): sha(p) for p in [args.mining_plan, args.mining_scores, args.root / "plan-final.json",
        args.root / "old_r16_q5/run.json", args.root / "old_r16_bf16_controls/run.json", args.root / "audit.json", args.root / "bf16-audit.json"]},
    "model_identities": {k: config[k] for k in ["base_weight_sha256", "initial_adapter_sha256", "initial_adapter_config_sha256"]},
    "source_sha256": {str(p.relative_to(ROOT)): sha(p) for p in [Path(__file__), ROOT / "tools/mt-mining-score.py", ROOT / "training/mt-fixed-slots/validation_metrics.py"]},
    "model_load_window_s": time.perf_counter() - started, "rows": []}
with torch.inference_mode():
    for name, text in [("old_stiff_reference", sample["reference_wire"]), ("q5_actual_wrong", rows[0]["text"]), ("bf16_actual_correct", rows[1]["text"])]:
        tokens = tokenizer(text, add_special_tokens=False, return_offsets_mapping=True)
        target = tokens["input_ids"] + [120020]
        assert len(ids) + len(target) <= 3072
        kinds = score.target_kinds(text, tokens["offset_mapping"])
        inputs = torch.tensor([ids + target], dtype=torch.long)
        out = model(input_ids=inputs, attention_mask=torch.ones_like(inputs), use_cache=False)
        losses = score.target_losses(out.logits, len(ids), target).cpu().tolist()
        result["rows"].append({"name": name, "text": text, "text_sha256": hashlib.sha256(text.encode()).hexdigest(),
                               **score.likelihood_metrics(score.loss_summary(losses, kinds))})
        del out, inputs
result["cached_old_score_max_abs_difference"] = max(abs(result["rows"][0]["sequence_logp"] - old_score["chosen"]["sequence_logp"]),
    abs(result["rows"][1]["sequence_logp"] - old_score["actual_wrong"]["sequence_logp"]))
result["proc_status"] = [s for s in Path("/proc/self/status").read_text().splitlines() if s.startswith(("VmHWM:", "VmRSS:"))]
result["finished_utc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"scores": [{k: r[k] for k in ["name", "sequence_logp", "content_mean_logp", "target_tokens"]} for r in result["rows"]], "cached_old_score_max_abs_difference": result["cached_old_score_max_abs_difference"]}))
