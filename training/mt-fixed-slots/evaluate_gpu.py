"""Three-arm BF16 generation only. No optimizer, merging, quantization or uploads."""
import argparse
import copy
import datetime
import hashlib
import html
import json
from pathlib import Path
import time

HERE = Path(__file__).resolve().parent
MODELS = ["base", "v022", "probe"]


def sha256(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def request_hash(request):
    return hashlib.sha256(json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def validate_plan(plan):
    if plan.get("protocol") != "BF16-production-prompt-unconstrained-v1" or plan.get("grammar_applied") is not False:
        raise ValueError("Unexpected evaluation protocol")
    cases = {row["id"]: row for row in plan["cases"]}
    if len(cases) != len(plan["cases"]) or any(row["split"] not in ["holdout", "diagnostic"] for row in cases.values()):
        raise ValueError("Only unique evaluation cases may enter this runner")
    keys = set()
    for job in plan["jobs"]:
        if job["key"] in keys or job["case_id"] not in cases:
            raise ValueError("Duplicate or unknown generation job")
        keys.add(job["key"])
        if job["mode"] not in ["fixed", "plain"] or job["split"] != cases[job["case_id"]]["split"]:
            raise ValueError("Job split/mode differs from its case")
        if job["mode"] == "plain" and job["split"] != "diagnostic":
            raise ValueError("Plain controls are diagnostic-only")
        if request_hash(job["request"]) != job["request_sha256"]:
            raise ValueError("Generation input hash mismatch: " + job["key"])
        if not 1 <= job["request"]["max_tokens"] <= 768:
            raise ValueError("Unexpected output budget")
    if not keys:
        raise ValueError("Empty evaluation plan")


def finish_reason(token_ids, eos, budget):
    if token_ids and token_ids[-1] == eos:
        return "stop"
    return "length" if len(token_ids) >= budget else "other"


class TokenClock:
    def __init__(self):
        self.prompt_pending = True
        self.first = None

    def put(self, value):
        if self.prompt_pending:
            self.prompt_pending = False
        elif self.first is None and value.numel():
            self.first = time.perf_counter()

    def end(self):
        pass


def generate_one(model, tokenizer, encoded, budget, generation_config, device):
    import torch

    input_ids = encoded["input_ids"].to(device)
    attention_mask = encoded["attention_mask"].to(device)
    if device.startswith("cuda"):
        torch.cuda.synchronize()
    clock = TokenClock()
    settings = copy.deepcopy(generation_config)
    settings.max_new_tokens = budget
    started = time.perf_counter()
    with torch.inference_mode():
        sequence = model.generate(input_ids=input_ids, attention_mask=attention_mask,
            generation_config=settings, streamer=clock)
    if device.startswith("cuda"):
        torch.cuda.synchronize()
    wall = time.perf_counter() - started
    ids = sequence[0, input_ids.shape[1]:].detach().cpu().tolist()
    return {"text": tokenizer.decode(ids, skip_special_tokens=True),
        "finish_reason": finish_reason(ids, tokenizer.eos_token_id, budget),
        "new_tokens": len(ids), "last_token_id": ids[-1] if ids else None,
        "wall_s": wall, "first_token_s": None if clock.first is None else clock.first - started}


def write_json(path, value):
    # Checkpoints after each generation make partial failures reviewable.
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def write_preview(plan, results, out):
    lookup = {label: {row["key"]: row for row in result["generations"]} for label, result in results.items()}
    parts = ['<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>PageLingo BF16 原始生成对照</title>',
        '<style>body{font:16px system-ui;margin:24px;background:#fafafa;color:#222}table{width:100%;table-layout:fixed;border-collapse:collapse}td,th{vertical-align:top;padding:12px;border:1px solid #ccc}pre{white-space:pre-wrap;overflow-wrap:anywhere}small{color:#555}</style>',
        '<h1>PageLingo BF16 原始生成对照</h1><p>相同输入与贪心解码，无 grammar。此页仅展示生成文本，生产结构校验待回放；不能直接与旧 Q5/Firefox 结果排名。参考译文未独立审核。</p>']
    for job in plan["jobs"]:
        parts += ["<h2>" + html.escape(job["key"]) + "</h2><details><summary>输入提示</summary><pre>" + html.escape(job["request"]["messages"][0]["content"]) + "</pre></details><table><tr>"]
        parts += ["<th>" + label + "</th>" for label in MODELS]
        parts.append("</tr><tr>")
        for label in MODELS:
            row = lookup.get(label, {}).get(job["key"])
            parts.append("<td><small>" + (html.escape(row["finish_reason"]) if row else "未完成") + "</small><pre>" + html.escape(row["text"] if row else "") + "</pre></td>")
        parts.append("</tr></table>")
    parts.append("</html>")
    (out / "raw-preview.html").write_text("\n".join(parts), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--config", type=Path, default=HERE / "evaluation_config.json")
    parser.add_argument("--plan", type=Path, default=HERE / "evaluation-plan.json")
    args = parser.parse_args()
    root, out = args.root.resolve(), args.output.resolve()
    if not out.is_relative_to(root) or out.exists():
        raise ValueError("Evaluation requires a new output directory within the project")
    config = json.loads(args.config.read_text(encoding="utf-8"))
    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    validate_plan(plan)
    if config["protocol"] != plan["protocol"] or config["grammar_applied"] is not False:
        raise ValueError("Evaluation config/protocol mismatch")
    identities = {"base": {"directory": config["base_directory"], "sha256": config["base_weight_sha256"]},
                  "v022": config["old_adapter"], "probe": config["probe_adapter"]}
    for label, identity in identities.items():
        folder = (root / identity["directory"]).resolve()
        if not folder.is_relative_to(root):
            raise ValueError("Model path escapes project")
        file = folder / ("model.safetensors" if label == "base" else "adapter_model.safetensors")
        if sha256(file) != identity["sha256"]:
            raise ValueError("Pinned model weights changed: " + label)
        if label != "base" and sha256(folder / "adapter_config.json") != identity["config_sha256"]:
            raise ValueError("Pinned adapter configuration changed: " + label)
        identity["bytes"] = file.stat().st_size
    import torch
    import transformers
    import peft
    from transformers import AutoModelForCausalLM, AutoTokenizer, GenerationConfig
    from peft import PeftModel

    tokenizer = AutoTokenizer.from_pretrained(root / config["base_directory"], local_files_only=True, trust_remote_code=False)
    if tokenizer.eos_token_id != 120020:
        raise ValueError("Base tokenizer stop token differs from the evaluated source")
    generation = GenerationConfig(do_sample=False, num_beams=1, use_cache=True, repetition_penalty=1.0,
        bos_token_id=tokenizer.bos_token_id, eos_token_id=tokenizer.eos_token_id, pad_token_id=tokenizer.pad_token_id)
    encoded_jobs = {}
    for job in plan["jobs"]:
        prompt = tokenizer.apply_chat_template(job["request"]["messages"], tokenize=False, add_generation_prompt=True)
        encoded = tokenizer(prompt, add_special_tokens=False, return_tensors="pt")
        if encoded["input_ids"].shape[1] + job["request"]["max_tokens"] > config["context"]:
            raise ValueError("Input/output exceeds the fixed comparison context")
        encoded_jobs[job["key"]] = (encoded, {"prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(),
            "input_ids_sha256": hashlib.sha256(json.dumps(encoded["input_ids"][0].tolist(), separators=(",", ":")).encode()).hexdigest(),
            "prompt_tokens": int(encoded["input_ids"].shape[1])})
    out.mkdir(parents=True, exist_ok=False)
    manifest = {"schema_version": 1, "created_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "protocol": plan["protocol"], "grammar_applied": False, "training_executed": False,
        "plan_sha256": sha256(args.plan),
        "package_source_commit": json.loads((HERE / "package-manifest.json").read_text(encoding="utf-8"))["source_commit"],
        "planned_generations": len(plan["jobs"]) * len(MODELS), "identities": identities,
        "settings": config, "versions": {"torch": torch.__version__, "transformers": transformers.__version__, "peft": peft.__version__},
        "check_only": args.check_only, "files": {}}
    write_json(out / "runs.json", manifest)
    print(json.dumps({"event": "evaluation_preflight", "jobs_per_model": len(plan["jobs"]), "identities_verified": True, "check_only": args.check_only}), flush=True)
    if args.check_only:
        return 0
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise RuntimeError("BF16 CUDA GPU required; no generation started")
    torch.manual_seed(config["seed"])
    torch.cuda.manual_seed_all(config["seed"])
    manifest["gpu"] = {"name": torch.cuda.get_device_name(0), "total_memory_bytes": torch.cuda.get_device_properties(0).total_memory}
    model = AutoModelForCausalLM.from_pretrained(root / config["base_directory"], local_files_only=True,
        trust_remote_code=False, dtype=torch.bfloat16, attn_implementation="sdpa").to("cuda").eval()
    model.config.use_cache = True
    results = {}
    try:
        for label in MODELS:
            if label == "v022":
                model = PeftModel.from_pretrained(model, root / identities[label]["directory"], adapter_name=label, is_trainable=False).eval()
            elif label == "probe":
                model.load_adapter(root / identities[label]["directory"], adapter_name=label, is_trainable=False)
            if label != "base":
                model.set_adapter(label)
                model.eval()
                if list(model.active_adapters) != [label]:
                    raise RuntimeError("Wrong adapter active during comparison")
            torch.cuda.reset_peak_memory_stats()
            result = {"model": label, "identity": identities[label], "grammar_applied": False, "generations": []}
            results[label] = result
            for job in plan["jobs"]:
                encoded, hashes = encoded_jobs[job["key"]]
                row = generate_one(model, tokenizer, encoded, job["request"]["max_tokens"], generation, "cuda")
                result["generations"].append({"key": job["key"], "request_sha256": job["request_sha256"],
                    "max_tokens": job["request"]["max_tokens"], **hashes, **row})
                write_json(out / (label + ".json"), result)
                print(json.dumps({"model": label, "key": job["key"], "stop": row["finish_reason"], "tokens": row["new_tokens"]}), flush=True)
            result["finished_utc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            result["cuda_peak_allocated_bytes"] = torch.cuda.max_memory_allocated()
            result["cuda_peak_reserved_bytes"] = torch.cuda.max_memory_reserved()
            result["memory_note"] = "Loaded adapters accumulate across arms; memory/timings are diagnostic, not a performance ranking"
            write_json(out / (label + ".json"), result)
            manifest["files"][label] = {"file": label + ".json", "sha256": sha256(out / (label + ".json"))}
            write_json(out / "runs.json", manifest)
            write_preview(plan, results, out)
        manifest["finished_utc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        write_json(out / "runs.json", manifest)
    except Exception as error:
        manifest["error"] = repr(error)
        write_json(out / "runs.json", manifest)
        raise
    print(json.dumps({"event": "evaluation_completed", "generations": len(plan["jobs"]) * 3, "training_executed": False}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
