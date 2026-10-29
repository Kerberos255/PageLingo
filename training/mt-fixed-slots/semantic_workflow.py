"""Two controlled 32-step v4 pilots and four-arm GPU evidence; no browser/upload."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid
import zipfile

from curriculum_workflow import validate_package, completed_candidate
from evaluate_gpu import sha256, write_json
from evaluate_matrix import pinned
from evaluate_semantic import validate_plan

HERE = Path(__file__).resolve().parent


def verify_candidates(configs):
    if set(configs) != {"ce_v4", "marker025_v4"}:
        raise ValueError("Both fixed-final candidates required")
    cleaned = [{k: v for k, v in config.items() if k not in ["semantic_marker_weight", "purpose"]} for config in configs.values()]
    if cleaned[0] != cleaned[1] or any(c.get("initialization") != "fresh_base" or c.get("candidate_max_steps") != 32 or c.get("checkpoint_selection") != "final" for c in configs.values()):
        raise ValueError("Candidates must differ only in marker weight and start fresh with 32 steps")
    if configs["ce_v4"]["semantic_marker_weight"] != 1 or configs["marker025_v4"]["semantic_marker_weight"] != .25:
        raise ValueError("Expected CE and marker-0.25 arms")


def bundle_evidence(out, package):
    plan = json.loads((HERE / "evaluation-plan.json").read_text(encoding="utf-8"))
    runs = json.loads((out / "comparison/runs.json").read_text(encoding="utf-8"))
    labels = ["base", "old_r16", "ce_v4", "marker025_v4"]
    if not runs.get("finished_utc") or list(runs["files"]) != labels or runs["plan_sha256"] != sha256(HERE / "evaluation-plan.json"):
        raise ValueError("Incomplete four-arm comparison")
    files = {"comparison/runs.json": out / "comparison/runs.json", "model-identities.json": out / "model-identities.json",
        "evaluation-plan.json": HERE / "evaluation-plan.json", "package-manifest.json": HERE / "package-manifest.json",
        "data/manifest.json": HERE / "data/manifest.json", "data/reference-review.md": HERE / "data/reference-review.md",
        "data/validation.jsonl": HERE / "data/validation.jsonl", "data/evaluation-cases.json": HERE / "data/evaluation-cases.json"}
    for label in labels:
        record = runs["files"][label]; file = out / "comparison" / record["file"]
        if record["file"] != label + ".json" or sha256(file) != record["sha256"]:
            raise ValueError("Changed comparison output")
        result = json.loads(file.read_text(encoding="utf-8"))
        if not result.get("finished_utc") or [r["key"] for r in result["generations"]] != [j["key"] for j in plan["jobs"]]:
            raise ValueError("Missing generation records")
        files["comparison/" + file.name] = file
    for label in ["ce_v4", "marker025_v4"]:
        files["training/" + label + ".json"] = out / label / "training-result.json"
        files["configs/" + label + ".json"] = HERE / (label + ".json")
    manifest = {"schema_version": 1, "source_commit": package["source_commit"], "release_approved": False,
        "scope": "GPU BF16 evidence only. No weights in ZIP; Cloud must review actual meanings and downstream decoder results.",
        "files": {name: {"bytes": file.stat().st_size, "sha256": sha256(file)} for name, file in files.items()}}
    archive = out / "evidence.zip"
    with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED) as bundle:
        for name, file in files.items():
            bundle.write(file, name)
    with zipfile.ZipFile(archive) as bundle:
        if bundle.testzip() is not None:
            raise ValueError("Evidence CRC mismatch")
        for name, record in manifest["files"].items():
            if hashlib.sha256(bundle.read(name)).hexdigest() != record["sha256"]:
                raise ValueError("Evidence member changed")
    manifest["bundle"] = {"file": archive.name, "bytes": archive.stat().st_size, "sha256": sha256(archive)}
    write_json(out / "evidence-manifest.json", manifest)
    return manifest["bundle"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--mode", choices=["check", "run"], default="run")
    parser.add_argument("--plan", action="store_true")
    args = parser.parse_args(); root = args.root.resolve()
    if not HERE.is_relative_to(root):
        raise ValueError("Keep the installed kit inside the project")
    package = validate_package(HERE, allow_dirty=args.mode == "check" or args.plan)
    workflow = json.loads((HERE / "workflow.json").read_text(encoding="utf-8"))
    plan = json.loads((HERE / "evaluation-plan.json").read_text(encoding="utf-8")); validate_plan(plan)
    configs = {label: json.loads((HERE / (label + ".json")).read_text(encoding="utf-8")) for label in workflow["candidates"]}
    verify_candidates(configs)
    if workflow["run_prefix"] != "pagelingo-quality-v4":
        raise ValueError("Wrong v4 task identity")
    if args.plan:
        print(json.dumps({"source_commit": package["source_commit"], "candidates": workflow["candidates"], "steps_each": 32,
            "maximum_generations": len(plan["jobs"]) * 4, "browser_required": False, "cpu_conversion_required": False, "upload_executed": False}))
        return 0
    if os.name == "nt":
        if root.drive.upper() == "C:" or root.drive.startswith("\\\\"):
            raise ValueError("Use the local non-C project path on the GPU PC")
        for key in ["TEMP", "TMP", "HF_HOME", "HF_HUB_CACHE", "TORCH_HOME", "PIP_CACHE_DIR"]:
            if key not in os.environ or not Path(os.environ[key]).resolve().is_relative_to(root):
                raise ValueError("Cache escapes project: " + key)
    if shutil.disk_usage(root).free < 2 * 2**30:
        raise RuntimeError("At least 2 GiB output space required")
    models = {"base": workflow["base"], "adapters": {"old_r16": workflow["old_r16"]}}
    base = pinned(root, models["base"], "model.safetensors")
    pinned(root, models["adapters"]["old_r16"], "adapter_model.safetensors")
    import torch
    if args.mode == "run" and (not torch.cuda.is_available() or not torch.cuda.is_bf16_supported()):
        raise RuntimeError("BF16 CUDA required; no training started")
    out = root / "outputs" / (workflow["run_prefix"] + "-" + args.mode + "-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6])
    out.mkdir(parents=True, exist_ok=False)
    status = {"source_commit": package["source_commit"], "workflow_completed": False, "training_completed": False, "gpu_comparison_completed": False,
        "cloud_postprocessing_pending": True, "release_approved": False, "upload_executed": False, "started_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "stages": []}
    write_json(out / "workflow-result.json", status); print("RUN_DIRECTORY=" + str(out), flush=True)
    log = (out / "console.log").open("w", encoding="utf-8", buffering=1)

    def run(name, command):
        start = time.perf_counter(); row = {"name": name, "started_utc": datetime.datetime.now(datetime.timezone.utc).isoformat()}
        status["stages"].append(row); write_json(out / "workflow-result.json", status); print("STAGE=" + name, flush=True)
        with subprocess.Popen(list(map(str, command)), cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace") as process:
            try:
                for line in process.stdout:
                    print(line, end="", flush=True); log.write(line)
                code = process.wait()
            except BaseException:
                process.terminate()
                try: process.wait(timeout=15)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
                raise
        row.update(exit_code=code, wall_s=time.perf_counter() - start); write_json(out / "workflow-result.json", status)
        if code:
            raise RuntimeError(name + " failed; see console.log")
    try:
        for label in workflow["candidates"]:
            run("preflight-" + label, [sys.executable, "-u", HERE / "train.py", "--data", HERE / "data", "--base", base,
                "--output", out / ("preflight-" + label), "--config", HERE / (label + ".json"), "--synthetic-candidate"])
        write_json(out / "baseline-models.json", models)
        eval_args = ["--root", root, "--plan", HERE / "evaluation-plan.json", "--validation", HERE / "data/validation.jsonl"]
        run("evaluation-preflight", [sys.executable, "-u", HERE / "evaluate_semantic.py", *eval_args, "--models", out / "baseline-models.json", "--output", out / "comparison-check", "--check-only"])
        if args.mode == "check":
            status["check_completed"] = True; write_json(out / "workflow-result.json", status); return 0
        initial_digests = []
        for label in workflow["candidates"]:
            paired = ["--expected-initial-sha256", initial_digests[0]] if initial_digests else []
            run("train-" + label, [sys.executable, "-u", HERE / "train.py", "--data", HERE / "data", "--base", base,
                "--output", out / label, "--config", HERE / (label + ".json"), "--synthetic-candidate", "--train", *paired])
            identity = completed_candidate(out / label, configs[label]); identity["directory"] = str(identity["directory"].relative_to(root))
            models["adapters"][label] = identity
            trained = json.loads((out / label / "training-result.json").read_text(encoding="utf-8")); initial_digests.append(trained["initial_trainable_sha256"])
        if len(set(initial_digests)) != 1:
            raise RuntimeError("Paired runs did not start from identical LoRA tensors")
        status["training_completed"] = True; status["paired_initial_sha256"] = initial_digests[0]
        write_json(out / "model-identities.json", models); write_json(out / "workflow-result.json", status)
        run("four-arm-comparison", [sys.executable, "-u", HERE / "evaluate_semantic.py", *eval_args, "--models", out / "model-identities.json", "--output", out / "comparison"])
        status["gpu_comparison_completed"] = True
        status["evidence"] = bundle_evidence(out, package)
        status.update(workflow_completed=True, finished_utc=datetime.datetime.now(datetime.timezone.utc).isoformat())
        write_json(out / "workflow-result.json", status)
        print("COMPLETE: evidence ready for Cloud review; no model selected or uploaded.", flush=True)
        return 0
    except Exception as error:
        status["error"] = str(error); write_json(out / "workflow-result.json", status); raise
    finally:
        log.close()


if __name__ == "__main__":
    raise SystemExit(main())
