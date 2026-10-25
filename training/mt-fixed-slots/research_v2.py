"""GPU-only training/BF16 comparison and a verified adapter handoff. No browser or uploads."""
import argparse
import hashlib
import datetime
import json
import math
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import uuid
import zipfile

from evaluate_gpu import sha256, write_json, validate_plan
from run_local import validate_package, CACHE_KEYS

HERE = Path(__file__).resolve().parent


def select_candidate(candidates):
    eligible = []
    for candidate in candidates:
        result = json.loads((candidate["output"] / "training-result.json").read_text(encoding="utf-8"))
        loss = float(result["validation_after"]["eval_loss"])
        if not result["training_executed"] or result["run_kind"] != "synthetic_research_candidate" or not math.isfinite(loss):
            raise ValueError("Incomplete or non-finite candidate result")
        if not 1 <= result["optimizer_steps"] <= 128:
            raise ValueError("Unexpected optimizer step count")
        eligible.append({**candidate, "loss": loss, "result": result})
    return min(eligible, key=lambda item: (item["loss"], item["name"]))


def create_handoff(out, adapter, here, candidates, source_commit):
    """Pack selected adapter and evaluation evidence; never base weights or caches."""
    files = {"adapter/" + name: adapter / name for name in ["adapter_model.safetensors", "adapter_config.json"]}
    runs = json.loads((out / "bf16/runs.json").read_text(encoding="utf-8"))
    plan = json.loads((here / "research-plan.json").read_text(encoding="utf-8"))
    if not runs.get("finished_utc") or runs.get("check_only") or runs["plan_sha256"] != sha256(here / "research-plan.json"):
        raise ValueError("Completed BF16 evidence required before creating a handoff")
    files["bf16/runs.json"] = out / "bf16/runs.json"
    for label in ["base", "v022", "probe"]:
        record = runs["files"][label]
        if record["file"] != label + ".json": raise ValueError("Unexpected evaluation filename")
        file = out / "bf16" / record["file"]
        if sha256(file) != record["sha256"]: raise ValueError("Evaluation evidence changed")
        data = json.loads(file.read_text(encoding="utf-8"))
        if not data.get("finished_utc") or len(data["generations"]) != len(plan["jobs"]):
            raise ValueError("Incomplete evaluation arm")
        files["bf16/" + file.name] = file
    files.update({"research-plan.json": here / "research-plan.json", "evaluation-config.json": out / "evaluation-config.json",
                  "data-manifest.json": here / "data/manifest.json", "package-manifest.json": here / "package-manifest.json"})
    for candidate in candidates:
        files["candidates/" + candidate["name"] + "/training-result.json"] = candidate["output"] / "training-result.json"
        files["candidates/" + candidate["name"] + "/config.json"] = here / candidate["config"]
    manifest = {"schema_version": 1, "source_commit": source_commit,
                "scope": "GPU training and BF16 evidence only; CPU merge, Q5 and Firefox remain on Cloud",
                "release_approved": False, "upload_executed": False,
                "files": {name: {"bytes": file.stat().st_size, "sha256": sha256(file)} for name, file in files.items()}}
    archive = out / "gpu-handoff.zip"
    if archive.exists(): raise ValueError("Handoff output must be new")
    temporary = archive.with_suffix(".zip.tmp")
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
        for name, file in files.items(): bundle.write(file, name)
    with zipfile.ZipFile(temporary) as bundle:
        for name, record in manifest["files"].items():
            with bundle.open(name) as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != record["sha256"]:
                    raise ValueError("Handoff verification failed: " + name)
    temporary.replace(archive)
    manifest["bundle"] = {"file": archive.name, "bytes": archive.stat().st_size, "sha256": sha256(archive)}
    write_json(out / "handoff-manifest.json", manifest)
    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--mode", choices=["check", "run"], default="run")
    parser.add_argument("--plan", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    if not HERE.is_relative_to(root): raise ValueError("Kit must remain inside the project")
    package = validate_package(HERE)
    config = json.loads((HERE / "workflow.json").read_text(encoding="utf-8"))
    evaluation_plan = json.loads((HERE / "research-plan.json").read_text(encoding="utf-8")); validate_plan(evaluation_plan)
    if os.name == "nt":
        if root.drive.upper() == "C:" or root.drive.startswith("\\\\"):
            raise ValueError("Use the GPU PC's local non-C project drive")
        if not args.plan:
            for key in CACHE_KEYS:
                if key not in os.environ or not Path(os.environ[key]).resolve().is_relative_to(root):
                    raise ValueError("Task cache escapes the project or CMD environment is missing: " + key)
    if args.plan:
        print(json.dumps({"mode": args.mode, "scope": "GPU training and BF16 only", "candidates": config["candidates"], "source_commit": package["source_commit"],
            "model_upload": False, "release_evaluation_used_for_selection": False,
            "bf16_generations": len(evaluation_plan["jobs"]) * 3, "cloud_postprocessing": ["merge", "Q5_K_M", "CPU regression", "Firefox/wllama"]}, indent=2))
        return 0
    import torch
    import psutil
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    out = root / "outputs" / ("pagelingo-quality-v2-" + args.mode + "-" + stamp); out.mkdir(parents=True, exist_ok=False)
    print("RUN_DIRECTORY=" + str(out), flush=True)
    log = (out / "console.log").open("w", encoding="utf-8", buffering=1)
    status = {"source_commit": package["source_commit"], "source_dirty": package["source_dirty"], "training_completed": False,
              "gpu_comparison_completed": False, "cloud_postprocessing_pending": True,
              "scope": "GPU training and BF16 only; no browser, merge, quantization or uploads on this PC",
              "release_approved": False, "upload_executed": False, "stages": [], "platform": platform.platform(),
              "cpu_count": os.cpu_count(), "host_memory_bytes": psutil.virtual_memory().total,
              "free_disk_bytes_at_start": shutil.disk_usage(root).free}
    def save(): write_json(out / "workflow-result.json", status)
    def run(stage, command, env=None):
        print("STAGE=" + stage, flush=True); log.write("STAGE=" + stage + "\n")
        record = {"name": stage, "command": list(map(str, command))}; status["stages"].append(record); save()
        with subprocess.Popen(list(map(str, command)), cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True, encoding="utf-8", errors="replace", env=env) as child:
            try:
                for line in child.stdout:
                    print(line, end="", flush=True); log.write(line)
                code = child.wait()
            except BaseException:
                child.terminate()
                try: child.wait(timeout=15)
                except subprocess.TimeoutExpired: child.kill(); child.wait()
                raise
        record["exit_code"] = code; save()
        if code: raise RuntimeError(stage + " failed; see console.log")
    try:
        status["cuda_available"] = torch.cuda.is_available()
        status["bf16_supported"] = status["cuda_available"] and torch.cuda.is_bf16_supported(); save()
        if args.mode == "run" and not status["bf16_supported"]:
            raise RuntimeError("BF16 CUDA GPU required; no training started")
        if shutil.disk_usage(root).free < config["minimum_free_bytes"]:
            raise RuntimeError("Insufficient free space for the configured output reserve")
        base = root / config["base_directory"]
        if sha256(base / "model.safetensors") != config["base_weight_sha256"]: raise ValueError("Original base identity changed")
        old = config["old_adapter"]
        for file, key in [("adapter_model.safetensors", "sha256"), ("adapter_config.json", "config_sha256")]:
            if sha256(root / old["directory"] / file) != old[key]: raise ValueError("Old adapter identity changed")
        for candidate in config["candidates"]:
            run("preflight-" + candidate["name"], [sys.executable, "-u", HERE / "train.py", "--data", HERE / "data",
                "--base", base, "--project-root", root, "--output", out / ("preflight-" + candidate["name"]), "--config", HERE / candidate["config"], "--synthetic-candidate"])
        if args.mode == "check":
            status["check_completed"] = True; save(); return 0
        status["gpu"] = {"name": torch.cuda.get_device_name(0), "total_memory_bytes": torch.cuda.get_device_properties(0).total_memory}; save()
        candidates = []
        for candidate in config["candidates"]:
            folder = out / candidate["name"]
            run("train-" + candidate["name"], [sys.executable, "-u", HERE / "train.py", "--data", HERE / "data", "--base", base, "--project-root", root,
                "--output", folder, "--config", HERE / candidate["config"], "--synthetic-candidate", "--train"])
            candidates.append({**candidate, "output": folder})
        selected = select_candidate(candidates); adapter = selected["output"] / "adapter"
        status["training_completed"] = True
        status["selection"] = {"name": selected["name"], "criterion": "lowest validation loss; release cases were not used",
            "validation_loss": selected["loss"], "adapter_directory": str(adapter.relative_to(root)),
            "sha256": sha256(adapter / "adapter_model.safetensors"), "config_sha256": sha256(adapter / "adapter_config.json")}; save()
        evaluation = json.loads((HERE / "evaluation_config.json").read_text(encoding="utf-8"))
        evaluation["probe_adapter"] = {"directory": str(adapter.relative_to(root)), "sha256": status["selection"]["sha256"],
            "config_sha256": status["selection"]["config_sha256"], "candidate_name": selected["name"]}
        eval_file = out / "evaluation-config.json"; write_json(eval_file, evaluation)
        run("bf16-comparison", [sys.executable, "-u", HERE / "evaluate_gpu.py", "--root", root, "--output", out / "bf16",
            "--config", eval_file, "--plan", HERE / "research-plan.json"])
        status["gpu_comparison_completed"] = True; save()
        status["handoff"] = create_handoff(out, adapter, HERE, candidates, package["source_commit"])["bundle"]; save()
        print("GPU_COMPLETE: adapter and BF16 evidence packaged in gpu-handoff.zip. Cloud handles Q5 and Firefox; no model upload.", flush=True)
        return 0
    except BaseException as error:
        status["error"] = repr(error); save(); raise
    finally:
        log.close(); print("RUN_DIRECTORY=" + str(out), flush=True)


if __name__ == "__main__": raise SystemExit(main())
