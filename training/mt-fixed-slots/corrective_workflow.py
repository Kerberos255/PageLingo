"""Two 32-step fixed-only corrections from the same old r16, GPU evidence only."""
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
import traceback
import uuid
import zipfile

from curriculum_workflow import validate_package
from corrective_contract import validate_corrective_config, completed_corrective_candidate
from evaluate_gpu import sha256, write_json
from evaluate_matrix import pinned
from evaluate_semantic import validate_plan, PLAN_LABELS

HERE = Path(__file__).resolve().parent
VARIANTS = {"legacy_v5": "legacy", "roles_v5": "roles"}


def verify_pair(here, workflow):
    if workflow.get("run_prefix") != "pagelingo-quality-v5" or workflow.get("candidates") != list(VARIANTS):
        raise ValueError("Wrong corrective task/candidate identity")
    configs, corpora = {}, {}
    for label, variant in VARIANTS.items():
        config = json.loads((here / (label + ".json")).read_text(encoding="utf-8"))
        data = here / "data" / variant; manifest = json.loads((data / "manifest.json").read_text(encoding="utf-8"))
        validate_corrective_config(config, manifest); configs[label] = config
        if workflow["base"]["sha256"] != config["base_weight_sha256"] or workflow["old_r16"] != {
                "directory": config["initial_adapter_directory"], "sha256": config["initial_adapter_sha256"], "config_sha256": config["initial_adapter_config_sha256"]}:
            raise ValueError("Corrective model/initial adapter identity changed")
        corpora[label] = {}
        for split in ["train", "validation"]:
            record = manifest["files"][split]; file = data / record["file"]
            if sha256(file) != record["sha256"]:
                raise ValueError("Corrective corpus changed")
            rows = [json.loads(line) for line in file.read_text(encoding="utf-8").splitlines() if line]
            if len(rows) != record["rows"]:
                raise ValueError("Corrective row count changed")
            corpora[label][split] = [(row["pair_id"], row["family"], row["split"], row["messages"][1]) for row in rows]
    a, b = configs.values()
    if {k: v for k, v in a.items() if k != "corrective_prompt_variant"} != {k: v for k, v in b.items() if k != "corrective_prompt_variant"}:
        raise ValueError("Candidates may differ only in prompt variant")
    if corpora["legacy_v5"] != corpora["roles_v5"]:
        raise ValueError("Paired source order or targets changed")
    return configs


def bundle_evidence(out, here, package):
    plan_file = here / "evaluation-plan.json"; plan = json.loads(plan_file.read_text(encoding="utf-8"))
    runs = json.loads((out / "comparison/runs.json").read_text(encoding="utf-8"))
    labels = PLAN_LABELS[plan["protocol"]]
    if not runs.get("finished_utc") or list(runs["files"]) != labels or runs["plan_sha256"] != sha256(plan_file):
        raise ValueError("Incomplete corrective comparison")
    files = {"comparison/runs.json": out / "comparison/runs.json", "model-identities.json": out / "model-identities.json",
        "evaluation-plan.json": plan_file, "package-manifest.json": here / "package-manifest.json", "workflow.json": here / "workflow.json",
        "data/manifest.json": here / "data/manifest.json", "data/reference-review.md": here / "data/reference-review.md",
        "data/evaluation-cases.json": here / "data/evaluation-cases.json", "data/validation.jsonl": here / "data/evaluation-validation.jsonl"}
    for label in labels:
        record = runs["files"][label]; file = out / "comparison" / record["file"]
        if record["file"] != label + ".json" or sha256(file) != record["sha256"]:
            raise ValueError("Corrective comparison file changed")
        result = json.loads(file.read_text(encoding="utf-8"))
        if not result.get("finished_utc") or [row["key"] for row in result["generations"]] != [job["key"] for job in plan["jobs"]]:
            raise ValueError("Corrective generation records missing")
        files["comparison/" + file.name] = file
    for label, variant in VARIANTS.items():
        files["training/" + label + ".json"] = out / label / "training-result.json"
        files["training/" + label + "-initialization.json"] = out / label / "initialization.json"
        files["configs/" + label + ".json"] = here / (label + ".json")
        files["data/" + variant + "/manifest.json"] = here / "data" / variant / "manifest.json"
    manifest = {"schema_version": 1, "source_commit": package["source_commit"], "release_approved": False,
        "scope": "Actual GPU BF16 evidence; no weights, conversion, browser or automatic model selection.",
        "files": {name: {"bytes": file.stat().st_size, "sha256": sha256(file)} for name, file in files.items()}}
    archive = out / "evidence.zip"
    with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED) as bundle:
        for name, file in files.items(): bundle.write(file, name)
    with zipfile.ZipFile(archive) as bundle:
        if bundle.testzip() is not None: raise ValueError("Evidence CRC failure")
        for name, record in manifest["files"].items():
            if hashlib.sha256(bundle.read(name)).hexdigest() != record["sha256"]: raise ValueError("Evidence member changed")
    manifest["bundle"] = {"file": archive.name, "bytes": archive.stat().st_size, "sha256": sha256(archive)}
    write_json(out / "evidence-manifest.json", manifest)
    return manifest["bundle"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--mode", choices=["check", "run"], default="run")
    parser.add_argument("--plan", action="store_true")
    args = parser.parse_args(); root = args.root.resolve()
    if not HERE.is_relative_to(root): raise ValueError("Keep the frozen kit inside the project")
    package = validate_package(HERE, allow_dirty=args.mode == "check" or args.plan)
    workflow = json.loads((HERE / "workflow.json").read_text(encoding="utf-8")); configs = verify_pair(HERE, workflow)
    plan = json.loads((HERE / "evaluation-plan.json").read_text(encoding="utf-8")); validate_plan(plan)
    if plan["protocol"] != "BF16-corrective-fixed-v5": raise ValueError("Wrong corrective plan profile")
    if args.plan:
        print(json.dumps({"source_commit": package["source_commit"], "candidates": list(VARIANTS), "steps_each": 32,
            "maximum_generations": len(plan["jobs"]) * 4, "browser_required": False, "cpu_conversion_required": False, "upload_executed": False}))
        return 0
    if os.name == "nt":
        if root.drive.upper() == "C:" or root.drive.startswith("\\\\"): raise ValueError("Run on the GPU PC's local non-C project drive")
        for key in ["TEMP", "TMP", "HF_HOME", "HF_HUB_CACHE", "TORCH_HOME", "PIP_CACHE_DIR"]:
            if key not in os.environ or not Path(os.environ[key]).resolve().is_relative_to(root): raise ValueError("Cache escapes project: " + key)
    if shutil.disk_usage(root).free < 2 * 2**30: raise RuntimeError("At least 2 GiB output space required")
    models = {"base": workflow["base"], "adapters": {"old_r16": workflow["old_r16"]}}
    base = pinned(root, models["base"], "model.safetensors"); pinned(root, models["adapters"]["old_r16"], "adapter_model.safetensors")
    import torch
    if args.mode == "run" and (not torch.cuda.is_available() or not torch.cuda.is_bf16_supported()): raise RuntimeError("BF16 CUDA required; no training started")
    out = root / "outputs" / ("pagelingo-quality-v5-" + args.mode + "-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]); out.mkdir(parents=True, exist_ok=False)
    status = {"source_commit": package["source_commit"], "started_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "workflow_completed": False, "training_completed": False, "gpu_comparison_completed": False, "cloud_postprocessing_pending": True,
        "release_approved": False, "upload_executed": False, "stages": []}
    write_json(out / "workflow-result.json", status); print("RUN_DIRECTORY=" + str(out), flush=True)
    log = (out / "console.log").open("w", encoding="utf-8", buffering=1)

    def run(name, command):
        start = time.perf_counter(); row = {"name": name, "started_utc": datetime.datetime.now(datetime.timezone.utc).isoformat()}
        status["stages"].append(row); write_json(out / "workflow-result.json", status); print("STAGE=" + name, flush=True); log.write("STAGE=" + name + "\n")
        with subprocess.Popen(list(map(str, command)), cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace") as process:
            try:
                for line in process.stdout: print(line, end="", flush=True); log.write(line)
                code = process.wait()
            except BaseException:
                process.terminate()
                try: process.wait(timeout=15)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
                raise
        row.update(exit_code=code, wall_s=time.perf_counter() - start); write_json(out / "workflow-result.json", status)
        if code: raise RuntimeError(name + " failed; see console.log")
    try:
        for label, variant in VARIANTS.items():
            run("preflight-" + label, [sys.executable, "-u", HERE / "train.py", "--data", HERE / "data" / variant, "--base", base, "--project-root", root,
                "--output", out / ("preflight-" + label), "--config", HERE / (label + ".json"), "--synthetic-candidate"])
        write_json(out / "baseline-models.json", models)
        eval_args = ["--root", root, "--plan", HERE / "evaluation-plan.json", "--validation", HERE / "data/evaluation-validation.jsonl"]
        run("evaluation-preflight", [sys.executable, "-u", HERE / "evaluate_semantic.py", *eval_args, "--models", out / "baseline-models.json", "--output", out / "comparison-check", "--check-only"])
        if args.mode == "check": status["check_completed"] = True; write_json(out / "workflow-result.json", status); return 0
        initial = None
        for label, variant in VARIANTS.items():
            paired = ["--expected-initial-sha256", initial] if initial else []
            run("train-" + label, [sys.executable, "-u", HERE / "train.py", "--data", HERE / "data" / variant, "--base", base, "--project-root", root,
                "--output", out / label, "--config", HERE / (label + ".json"), "--synthetic-candidate", "--train", *paired])
            identity = completed_corrective_candidate(out / label, HERE / (label + ".json"), HERE / "data" / variant, initial)
            digest = json.loads((out / label / "training-result.json").read_text(encoding="utf-8"))["initial_trainable_sha256"]
            if initial is not None and initial != digest: raise ValueError("Paired corrective initialization changed")
            initial = digest; identity["directory"] = str(identity["directory"].relative_to(root)); models["adapters"][label] = identity
        status.update(training_completed=True, paired_initial_sha256=initial)
        write_json(out / "model-identities.json", models); write_json(out / "workflow-result.json", status)
        run("four-arm-comparison", [sys.executable, "-u", HERE / "evaluate_semantic.py", *eval_args, "--models", out / "model-identities.json", "--output", out / "comparison"])
        status["gpu_comparison_completed"] = True; status["evidence"] = bundle_evidence(out, HERE, package)
        status.update(workflow_completed=True, finished_utc=datetime.datetime.now(datetime.timezone.utc).isoformat()); write_json(out / "workflow-result.json", status)
        print("COMPLETE: corrective GPU evidence ready for Cloud review. No model selected or uploaded.", flush=True)
        return 0
    except Exception as error:
        status.update(error=str(error), error_type=type(error).__name__); write_json(out / "workflow-result.json", status); traceback.print_exc(file=log); raise
    finally: log.close()


if __name__ == "__main__": raise SystemExit(main())
