"""Paired BF16 generations plus unweighted reference NLL; no grammar or upload."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import time

from evaluate_gpu import generate_one, request_hash, sha256, write_json
from evaluate_matrix import pinned
from validation_metrics import aggregate, loss_summary, target_kinds, target_losses

HERE = Path(__file__).resolve().parent
PLAN_LABELS = {
    "BF16-semantic-multitask-v4": ["base", "old_r16", "ce_v4", "marker025_v4"],
    "BF16-corrective-fixed-v5": ["base", "old_r16", "legacy_v5", "roles_v5"],
}


def validate_plan(plan):
    if plan.get("protocol") not in PLAN_LABELS or plan.get("grammar_applied") is not False:
        raise ValueError("Expected an explicit unconstrained paired plan")
    cases = {row["id"]: row for row in plan["cases"]}
    if len(cases) != len(plan["cases"]) or any(row["split"] not in ["validation", "holdout", "diagnostic"] for row in cases.values()):
        raise ValueError("Only unique non-training evaluation cases allowed")
    seen = {}
    for job in plan["jobs"]:
        if job["key"] in seen or job["case_id"] not in cases or job["split"] != cases[job["case_id"]]["split"]:
            raise ValueError("Duplicate job or split/source mismatch")
        if job["mode"] not in ["legacy", "natural", "direct", "rewrite"]:
            raise ValueError("Unknown evaluation task")
        if plan["protocol"] == "BF16-corrective-fixed-v5" and job["mode"] == "rewrite":
            raise ValueError("v5 deliberately excludes draft-rewrite inference")
        request = job.get("request") if job["mode"] != "rewrite" else job.get("request_template")
        if not request or request_hash(request) != job["request_sha256"] or not 1 <= request["max_tokens"] <= 768:
            raise ValueError("Evaluation request identity or budget changed")
        if job["mode"] == "rewrite":
            parent = seen.get(job.get("draft_from_key"))
            if not parent or parent["case_id"] != job["case_id"] or parent["mode"] != "natural":
                raise ValueError("Rewrite must follow its own source's natural generation")
            if not isinstance(request.get("prefix"), str) or not isinstance(request.get("suffix"), str):
                raise ValueError("Missing literal draft template")
        elif [message["role"] for message in request["messages"]] != ["user"]:
            raise ValueError("Expected one frozen user message")
        if job["mode"] != "natural" and not job.get("production_grammar"):
            raise ValueError("Missing downstream fixed-frame grammar identity")
        seen[job["key"]] = job
    if not seen or {job["case_id"] for job in plan["jobs"]} != set(cases):
        raise ValueError("Missing evaluation cases")


def materialize_rewrite(job, prior):
    draft = prior.get(job["draft_from_key"])
    if not draft or draft.get("executed") is not True or draft["finish_reason"] != "stop":
        raise ValueError("Natural draft did not finish normally")
    frame = job["request_template"]
    # JSON encoding is shared with semanticFixedPrompt; never interpolate raw
    # draft text into structure or use another model's draft.
    request = {"messages": [{"role": "user", "content": frame["prefix"] + json.dumps(draft["text"], ensure_ascii=False) + frame["suffix"]}],
               "max_tokens": frame["max_tokens"]}
    return request, hashlib.sha256(draft["text"].encode()).hexdigest()


def encoded_request(tokenizer, request):
    prompt = tokenizer.apply_chat_template(request["messages"], tokenize=False, add_generation_prompt=True)
    encoded = tokenizer(prompt, add_special_tokens=False, return_tensors="pt")
    size = int(encoded["input_ids"].shape[1])
    if size + request["max_tokens"] > 3072:
        raise ValueError("Actual input and generation budget exceed context; no truncation allowed")
    return encoded, {"prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(), "prompt_tokens": size,
        "input_ids_sha256": hashlib.sha256(json.dumps(encoded["input_ids"][0].tolist(), separators=(",", ":")).encode()).hexdigest()}


def reference_inputs(tokenizer, rows):
    if not rows or len({row["id"] for row in rows}) != len(rows):
        raise ValueError("Expected unique validation task references")
    result = []
    for row in rows:
        if row["split"] != "validation" or row["task"] not in ["natural", "fixed", "rewrite"]:
            raise ValueError("Reference NLL may only consume validation tasks")
        target = tokenizer(row["messages"][1]["content"], add_special_tokens=False, return_offsets_mapping=True)
        ids = target["input_ids"] + [tokenizer.eos_token_id]
        request = {"messages": row["messages"][:1], "max_tokens": len(ids)}
        encoded, hashes = encoded_request(tokenizer, request)
        kinds = target_kinds(row["messages"][1]["content"], target["offset_mapping"])
        if len(kinds) != len(ids):
            raise ValueError("Target category/offset mismatch")
        result.append((row, encoded, ids, kinds, hashes))
    return result


def main():
    parser = argparse.ArgumentParser()
    for name in ["root", "output", "models", "plan", "validation"]:
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()
    root, out = args.root.resolve(), args.output.resolve()
    if not out.is_relative_to(root) or out.exists():
        raise ValueError("Use a new output directory inside the project")
    plan = json.loads(args.plan.read_text(encoding="utf-8")); validate_plan(plan)
    identities = json.loads(args.models.read_text(encoding="utf-8"))
    base = pinned(root, identities["base"], "model.safetensors")
    folders = {label: pinned(root, record, "adapter_model.safetensors") for label, record in identities["adapters"].items()}
    labels = PLAN_LABELS[plan["protocol"]]
    expected = {"old_r16"} if args.check_only else set(labels[1:])
    if set(folders) != expected:
        raise ValueError("Expected the pinned baseline and both candidates for this plan profile")
    import torch
    import transformers
    import peft
    from transformers import AutoModelForCausalLM, AutoTokenizer, GenerationConfig
    from peft import PeftModel
    tokenizer = AutoTokenizer.from_pretrained(base, local_files_only=True, trust_remote_code=False)
    if not tokenizer.is_fast or tokenizer.eos_token_id != 120020:
        raise ValueError("Original fast tokenizer/EOS identity required")
    static = {job["key"]: encoded_request(tokenizer, job["request"]) for job in plan["jobs"] if job["mode"] != "rewrite"}
    validation = [json.loads(line) for line in args.validation.read_text(encoding="utf-8").splitlines() if line.strip()]
    targets = reference_inputs(tokenizer, validation)
    print(json.dumps({"event": "semantic_evaluation_preflight", "cases": len(plan["cases"]), "jobs_per_arm": len(plan["jobs"]),
        "static_inputs_tokenized": len(static), "dynamic_drafts": len(plan["jobs"]) - len(static), "validation_tasks": len(targets),
        "model_weights_loaded": False, "dynamic_context_checked_at_runtime": True}), flush=True)
    if args.check_only:
        return 0
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise RuntimeError("BF16 CUDA required; no model loaded")
    out.mkdir(parents=True, exist_ok=False)
    manifest = {"protocol": plan["protocol"], "grammar_applied": False, "plan_sha256": sha256(args.plan), "validation_sha256": sha256(args.validation),
        "created_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "identities": identities, "files": {},
        "maximum_planned_generations": len(plan["jobs"]) * 4, "automatic_selection": False,
        "versions": {"torch": torch.__version__, "transformers": transformers.__version__, "peft": peft.__version__},
        "gpu": {"name": torch.cuda.get_device_name(0), "total_memory_bytes": torch.cuda.get_device_properties(0).total_memory}}
    write_json(out / "runs.json", manifest)
    torch.manual_seed(42); torch.cuda.manual_seed_all(42)
    started = time.perf_counter()
    model = AutoModelForCausalLM.from_pretrained(base, local_files_only=True, trust_remote_code=False,
        dtype=torch.bfloat16, attn_implementation="sdpa").to("cuda").eval()
    manifest["base_load_wall_s"] = time.perf_counter() - started
    generation = GenerationConfig(do_sample=False, num_beams=1, use_cache=True, repetition_penalty=1.,
        bos_token_id=tokenizer.bos_token_id, eos_token_id=tokenizer.eos_token_id, pad_token_id=tokenizer.pad_token_id)
    try:
        for index, label in enumerate(labels):
            if label != "base":
                if index == 1:
                    model = PeftModel.from_pretrained(model, folders[label], adapter_name=label, is_trainable=False)
                else:
                    model.load_adapter(folders[label], adapter_name=label, is_trainable=False)
                model.set_adapter(label)
                if list(model.active_adapters) != [label]:
                    raise RuntimeError("Wrong active adapter")
            model.eval(); model.requires_grad_(False); torch.cuda.reset_peak_memory_stats()
            identity = {"base": identities["base"], "adapter": identities["adapters"].get(label)}
            result = {"model": label, "identity": identity, "grammar_applied": False, "training_executed": False,
                "validation_losses": [], "generations": []}
            for row, encoded, ids, kinds, hashes in targets:
                tokens = torch.cat([encoded["input_ids"], torch.tensor([ids], dtype=torch.long)], dim=1).to("cuda")
                with torch.inference_mode():
                    logits = model(input_ids=tokens, attention_mask=torch.ones_like(tokens), use_cache=False).logits
                    losses = target_losses(logits, encoded["input_ids"].shape[1], ids).cpu().tolist()
                del logits, tokens
                result["validation_losses"].append({"id": row["id"], "task": row["task"], "prompt_variant": row.get("prompt_variant"), "guide_is_reference_only": row["task"] == "rewrite",
                    **hashes, "loss": loss_summary(losses, kinds)})
            result["loss_components"] = aggregate([row["loss"] for row in result["validation_losses"]])
            result["loss_by_task"] = {task: aggregate([row["loss"] for row in result["validation_losses"] if row["task"] == task]) for task in ["natural", "fixed", "rewrite"] if any(row["task"] == task for row in result["validation_losses"])}
            if plan["protocol"] == "BF16-corrective-fixed-v5":
                result["loss_by_prompt_variant"] = {variant: aggregate([row["loss"] for row in result["validation_losses"] if row["prompt_variant"] == variant]) for variant in ["legacy", "roles"]}
            prior = {}
            for job in plan["jobs"]:
                recorded = {"key": job["key"], "case_id": job["case_id"], "mode": job["mode"], "planned_request_sha256": job["request_sha256"],
                    "production_grammar_sha256": hashlib.sha256((job.get("production_grammar") or "").encode()).hexdigest()}
                try:
                    if job["mode"] == "rewrite":
                        request, draft_hash = materialize_rewrite(job, prior)
                        encoded, hashes = encoded_request(tokenizer, request)
                        recorded.update(actual_messages=request["messages"], draft_from_key=job["draft_from_key"], draft_text_sha256=draft_hash)
                    else:
                        request = job["request"]; encoded, hashes = static[job["key"]]
                except ValueError as error:
                    recorded.update(executed=False, skip_reason=str(error), text="", finish_reason="skipped")
                else:
                    recorded.update(executed=True, actual_request_sha256=request_hash(request), max_tokens=request["max_tokens"], **hashes,
                        **generate_one(model, tokenizer, encoded, request["max_tokens"], generation, "cuda"))
                result["generations"].append(recorded); prior[job["key"]] = recorded
                write_json(out / (label + ".json"), result)
                print(json.dumps({"event": "semantic_generation", "model": label, "key": job["key"], "executed": recorded["executed"]}), flush=True)
            result.update(finished_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                executed_generations=sum(row["executed"] for row in result["generations"]),
                cuda_peak_allocated_bytes=torch.cuda.max_memory_allocated(), cuda_peak_reserved_bytes=torch.cuda.max_memory_reserved())
            write_json(out / (label + ".json"), result)
            manifest["files"][label] = {"file": label + ".json", "sha256": sha256(out / (label + ".json"))}
            write_json(out / "runs.json", manifest)
        manifest["finished_utc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        write_json(out / "runs.json", manifest)
    finally:
        del model; torch.cuda.empty_cache()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
