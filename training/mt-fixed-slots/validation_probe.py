"""GPU evaluation of existing adapters on validation data. Never creates an optimizer."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import uuid
import zipfile

from evaluate_gpu import generate_one, sha256, write_json
from validation_metrics import aggregate, loss_summary, target_kinds, target_losses

HERE = Path(__file__).resolve().parent


def pinned(root, record, weight):
    folder = (root / record["directory"]).resolve()
    if not folder.is_relative_to(root) or sha256(folder / weight) != record["sha256"]:
        raise ValueError("Model identity changed or path escaped project")
    if weight != "model.safetensors" and sha256(folder / "adapter_config.json") != record["config_sha256"]:
        raise ValueError("Adapter configuration changed")
    return folder


def prepare_jobs(tokenizer, rows):
    jobs = []
    for row in rows:
        prompt = tokenizer.apply_chat_template(row["messages"][:1], tokenize=False, add_generation_prompt=True)
        encoded = tokenizer(prompt, add_special_tokens=False, return_tensors="pt")
        target = tokenizer(row["messages"][1]["content"], add_special_tokens=False, return_offsets_mapping=True)
        ids = target["input_ids"] + [tokenizer.eos_token_id]
        kinds = target_kinds(row["messages"][1]["content"], target["offset_mapping"])
        if encoded["input_ids"].shape[1] + max(len(ids), row["max_tokens"]) > 3072 or len(kinds) != len(ids):
            raise ValueError("Validation target/output would be truncated")
        jobs.append((row, encoded, ids, kinds, hashlib.sha256(prompt.encode()).hexdigest()))
    if sum(len(j[2]) for j in jobs) != 4343:
        raise ValueError("Tokenizer/supervised target differs from the frozen training validation split")
    return jobs


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--mode", choices=["check", "run"], default="run")
    args = parser.parse_args(); root = args.root.resolve()
    package = json.loads((HERE / "package-manifest.json").read_text())
    for name, record in package["files"].items():
        path = (HERE / name).resolve()
        if not path.is_relative_to(HERE) or sha256(path) != record["sha256"]:
            raise ValueError("Frozen evaluation file changed: " + name)
    plan = json.loads((HERE / "validation-plan.json").read_text())
    rows = plan["rows"]
    if plan["scope"] != "validation-only-no-training" or len(rows) != 64 or len({r["id"] for r in rows}) != 64:
        raise ValueError("Expected the frozen 64-row validation split")
    if any(r["split"] != "validation" for r in rows):
        raise ValueError("Only validation rows may enter this probe")
    config = json.loads((HERE / "validation-models.json").read_text())
    base = pinned(root, config["base"], "model.safetensors")
    adapters = {label: pinned(root, record, "adapter_model.safetensors") for label, record in config["adapters"].items()}
    if list(adapters) != ["fresh_r16", "resume_r32"]:
        raise ValueError("Both existing candidates must be evaluated")
    import torch
    import transformers
    import peft
    from transformers import AutoModelForCausalLM, AutoTokenizer, GenerationConfig
    from peft import PeftModel

    tokenizer = AutoTokenizer.from_pretrained(base, local_files_only=True, trust_remote_code=False)
    if not tokenizer.is_fast or tokenizer.eos_token_id != 120020:
        raise ValueError("Pinned fast tokenizer and EOS are required")
    jobs = prepare_jobs(tokenizer,rows)
    print(json.dumps({"event":"validation_preflight","rows":len(jobs),"supervised_tokens":sum(len(j[2]) for j in jobs),
        "training_executed":False,"model_weights_loaded":False,"mode":args.mode}), flush=True)
    if args.mode == "check":return 0
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise RuntimeError("BF16 CUDA GPU required; no optimizer or model inference started")
    out = root / "outputs" / ("pagelingo-validation-v1-run-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6])
    out.mkdir(parents=True, exist_ok=False)
    status = {"source_commit":package["source_commit"],"workflow_completed":False,"training_executed":False,
        "scope":"Validation loss components and free generation of existing base/r16/r32 weights only; not release approval",
        "release_approved":False,"plan_sha256":sha256(HERE/"validation-plan.json"),"stages":[],
        "versions":{"torch":torch.__version__,"transformers":transformers.__version__,"peft":peft.__version__},
        "gpu":{"name":torch.cuda.get_device_name(0),"total_memory_bytes":torch.cuda.get_device_properties(0).total_memory}}
    write_json(out/"workflow-result.json",status)
    print("RUN_DIRECTORY=" + str(out), flush=True)
    try:
        torch.manual_seed(42);torch.cuda.manual_seed_all(42)
        model=AutoModelForCausalLM.from_pretrained(base,local_files_only=True,trust_remote_code=False,
            dtype=torch.bfloat16,attn_implementation="sdpa").to("cuda").eval()
        model.requires_grad_(False)
        generation=GenerationConfig(do_sample=False,num_beams=1,use_cache=True,repetition_penalty=1.0,
            bos_token_id=tokenizer.bos_token_id,eos_token_id=tokenizer.eos_token_id,pad_token_id=tokenizer.pad_token_id)
        for label in ["base",*adapters]:
            if label == "fresh_r16":model=PeftModel.from_pretrained(model,adapters[label],adapter_name=label,is_trainable=False).eval()
            elif label == "resume_r32":model.load_adapter(adapters[label],adapter_name=label,is_trainable=False)
            if label != "base":
                model.set_adapter(label);model.eval()
                if list(model.active_adapters) != [label]:raise RuntimeError("Wrong active validation adapter")
            model.requires_grad_(False)
            if any(p.requires_grad for p in model.parameters()):raise RuntimeError("Validation weights must remain frozen")
            result={"model":label,"identity":config["base"] if label=="base" else config["adapters"][label],
                "training_executed":False,"grammar_applied":False,"rows":[]}
            torch.cuda.reset_peak_memory_stats()
            for row,encoded,ids,kinds,prompt_hash in jobs:
                prefix=encoded["input_ids"].shape[1]
                supervised=torch.cat([encoded["input_ids"],torch.tensor([ids],dtype=torch.long)],dim=1).to("cuda")
                with torch.inference_mode():
                    logits=model(input_ids=supervised,attention_mask=torch.ones_like(supervised),use_cache=False).logits
                    losses=target_losses(logits,prefix,ids).cpu().tolist()
                del logits,supervised
                measured=loss_summary(losses,kinds)
                produced=generate_one(model,tokenizer,encoded,row["max_tokens"],generation,"cuda")
                result["rows"].append({"id":row["id"],"family":row["family"],"semantic_contract":row["semantic_contract"],
                    "prompt_sha256":prompt_hash,"loss":measured,**produced})
                result["loss_components"]=aggregate([v["loss"] for v in result["rows"]])
                write_json(out/(label+".json"),result)
                print(json.dumps({"event":"validation_generation","model":label,"id":row["id"]}),flush=True)
            result.update(finished_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                cuda_peak_allocated_bytes=torch.cuda.max_memory_allocated(),cuda_peak_reserved_bytes=torch.cuda.max_memory_reserved())
            write_json(out/(label+".json"),result)
            status["stages"].append({"name":label,"file":label+".json","sha256":sha256(out/(label+".json"))})
            write_json(out/"workflow-result.json",status)
        with zipfile.ZipFile(out/"validation-results.zip","w",compression=zipfile.ZIP_DEFLATED) as bundle:
            for label in ["base",*adapters]:bundle.write(out/(label+".json"),label+".json")
            bundle.write(HERE/"validation-plan.json","validation-plan.json")
            bundle.write(HERE/"validation-models.json","validation-models.json")
            bundle.write(HERE/"package-manifest.json","package-manifest.json")
        status.update(workflow_completed=True,validation_completed=True,
            handoff={"file":"validation-results.zip","bytes":(out/"validation-results.zip").stat().st_size,"sha256":sha256(out/"validation-results.zip")})
        write_json(out/"workflow-result.json",status)
        print(json.dumps({"event":"validation_complete","generations":len(jobs)*3,"training_executed":False}),flush=True)
    except BaseException as error:
        status["error"]=repr(error);write_json(out/"workflow-result.json",status);raise
    return 0


if __name__ == "__main__":raise SystemExit(main())
