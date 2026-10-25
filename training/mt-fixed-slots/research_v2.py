"""One local GPU run: two bounded candidates, validation selection, BF16/Q5 and Firefox evidence. No uploads."""
import argparse
import copy
import datetime
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import uuid

from evaluate_gpu import sha256, write_json, validate_plan, request_hash
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
        print(json.dumps({"mode": args.mode, "candidates": config["candidates"], "source_commit": package["source_commit"],
            "model_upload": False, "release_evaluation_used_for_selection": False,
            "bf16_generations": len(evaluation_plan["jobs"]) * 3, "cpu_fixed_generations": len([j for j in evaluation_plan["jobs"] if j["mode"]=="fixed"])*2}, indent=2))
        return 0
    import torch
    import psutil
    from browser_v2 import prepare_assets, find_firefox
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    out = root / "outputs" / ("pagelingo-quality-v2-" + args.mode + "-" + stamp); out.mkdir(parents=True, exist_ok=False)
    print("RUN_DIRECTORY=" + str(out), flush=True)
    log = (out / "console.log").open("w", encoding="utf-8", buffering=1)
    status = {"source_commit": package["source_commit"], "source_dirty": package["source_dirty"], "training_completed": False,
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
        old_q5 = root / config["old_q5"]["directory"]
        if sha256(old_q5) != config["old_q5"]["sha256"]: raise ValueError("Release Q5 identity changed")
        server, quantizer = root / config["server"], root / config["quantizer"]
        run("llama-server-version", [server, "--version"])
        probe = subprocess.run([str(quantizer), "--help"], cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if probe.returncode not in [0, 1] or "Q5_K_M" not in probe.stdout + probe.stderr:
            raise RuntimeError("Quantizer preflight failed before training: " + str(probe.returncode))
        converter = root / config["converter"]; converter_env = os.environ.copy()
        converter_env["PYTHONPATH"] = str(converter.parent / "gguf-py") + os.pathsep + converter_env.get("PYTHONPATH", "")
        run("converter-preflight", [sys.executable, converter, "--help"], env=converter_env)
        firefox = find_firefox(); assets = prepare_assets(root / ".cache/pagelingo-quality-v2", config["browser_assets"])
        status["browser_assets"] = assets; status["firefox_binary"] = str(firefox); save()
        smoke = copy.deepcopy(evaluation_plan)
        job = next(j for j in smoke["jobs"] if j["mode"] == "fixed")
        job["request"]["max_tokens"] = 1; job["request_sha256"] = request_hash(job["request"])
        smoke["jobs"] = [job]; smoke["cases"] = [c for c in smoke["cases"] if c["id"] == job["case_id"]]
        smoke["purpose"] = "One-token CPU/grammar compatibility check; not a translation quality evaluation"
        smoke_file = out / "native-preflight-plan.json"; write_json(smoke_file, smoke)
        smoke_models = out / "native-preflight-models.json"
        write_json(smoke_models, [{"label": "v022", "path": str(old_q5), "sha256": config["old_q5"]["sha256"]}])
        run("native-grammar-preflight", [sys.executable, "-u", HERE / "native_v2.py", "--server", server, "--models", smoke_models,
            "--plan", smoke_file, "--source-config", base, "--output", out / "native-preflight", "--threads", str(config["cpu_threads"])])
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
        merged = out / "exports/merged"; bf16 = out / "exports/candidate-BF16.gguf"; unchecked = out / "exports/candidate-unchecked.gguf"
        final = out / "exports/PageLingo-Translate-1.8B-v0.3.0-rc1-Q5_K_M.gguf"
        run("merge", [sys.executable, HERE / "merge_adapter.py", "--base", base, "--adapter", adapter, "--output", merged, "--threads", "2"])
        converter = root / config["converter"]; env = os.environ.copy()
        env["PYTHONPATH"] = str(converter.parent / "gguf-py") + os.pathsep + env.get("PYTHONPATH", "")
        run("convert-bf16", [sys.executable, converter, merged, "--outtype", "bf16", "--outfile", bf16], env=env)
        run("quantize-q5", [quantizer, bf16, unchecked, "Q5_K_M", str(config["cpu_threads"])])
        spec = importlib.util.spec_from_file_location("research_metadata", HERE / "mt-gguf-metadata.py")
        guard = importlib.util.module_from_spec(spec); spec.loader.exec_module(guard)
        check, _ = guard.verify(unchecked, base)
        if check["passed"]: unchecked.replace(final)
        else: run("verify-and-repair-eos-copy", [sys.executable, HERE / "mt-gguf-metadata.py", "--model", unchecked,
                "--source-config", base, "--repair-eos", "--output", final])
        check, _ = guard.verify(final, base)
        if not check["passed"]: raise ValueError("Export metadata remains invalid")
        status["q5"] = {"path": str(final.relative_to(root)), "bytes": final.stat().st_size, "sha256": sha256(final), "metadata": check,
                        "converter_sha256": sha256(converter), "quantizer_sha256": sha256(quantizer)}; save()
        model_file = out / "q5-models.json"; write_json(model_file, [{"label": "v022", "path": str(old_q5), "sha256": config["old_q5"]["sha256"]},
            {"label": "candidate", "path": str(final), "sha256": status["q5"]["sha256"]}])
        run("q5-comparison", [sys.executable, "-u", HERE / "native_v2.py", "--server", server, "--models", model_file,
            "--plan", HERE / "research-plan.json", "--source-config", base, "--output", out / "q5", "--threads", str(config["cpu_threads"])])
        run("firefox-wllama", [sys.executable, "-u", HERE / "browser_v2.py", "--model", final, "--sha256", status["q5"]["sha256"],
            "--plan", HERE / "research-plan.json", "--assets", root / ".cache/pagelingo-quality-v2", "--firefox", firefox, "--output", out / "firefox"])
        status["comparison_completed"] = True; save()
        print("COMPLETE: evidence ready for review. No model upload or release approval was performed.", flush=True)
        return 0
    except BaseException as error:
        status["error"] = repr(error); save(); raise
    finally:
        log.close(); print("RUN_DIRECTORY=" + str(out), flush=True)


if __name__ == "__main__": raise SystemExit(main())
