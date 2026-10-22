"""Launch the staged training kit on the user's GPU PC; never installs packages."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

CACHE_KEYS = ["TEMP", "TMP", "TMPDIR", "HF_HOME", "HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE",
              "HF_DATASETS_CACHE", "HF_XET_CACHE", "HF_ASSETS_CACHE", "PIP_CACHE_DIR",
              "PYTHONPYCACHEPREFIX", "TORCH_HOME", "TORCH_EXTENSIONS_DIR", "TORCHINDUCTOR_CACHE_DIR",
              "TRITON_CACHE_DIR", "CUDA_CACHE_PATH", "XDG_CACHE_HOME", "UV_CACHE_DIR", "WANDB_DIR", "WANDB_CACHE_DIR",
              "HF_MODULES_CACHE", "MPLCONFIGDIR", "NUMBA_CACHE_DIR"]


def validate_package(here):
    manifest = json.loads((here / "package-manifest.json").read_text(encoding="utf-8"))
    for name, record in manifest["files"].items():
        file = (here / name).resolve()
        if not file.is_relative_to(here.resolve()):
            raise ValueError("Invalid package manifest path")
        if hashlib.sha256(file.read_bytes()).hexdigest() != record["sha256"]:
            raise ValueError("Staged package changed; regenerate before running: " + name)
    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--kind", choices=["check", "probe", "train"], default="probe")
    parser.add_argument("--plan", action="store_true", help="Validate staged files and print the launch plan without importing torch or creating outputs")
    args = parser.parse_args()
    root = args.root.resolve()
    here = Path(__file__).resolve().parent
    if not here.is_relative_to(root):
        raise ValueError("The staged kit must be under the supplied project root")
    manifest = validate_package(here)
    config = json.loads((here / "config.json").read_text(encoding="utf-8"))
    rows = []
    data_manifest = json.loads((here / "data/manifest.json").read_text(encoding="utf-8"))
    for split in ["train", "validation"]:
        record = data_manifest["files"][split]
        file = (here / "data" / record["file"]).resolve()
        if not file.is_relative_to((here / "data").resolve()):
            raise ValueError("Invalid dataset path")
        raw = file.read_bytes()
        if hashlib.sha256(raw).hexdigest() != record["sha256"]:
            raise ValueError("Dataset differs from its export manifest")
        selected = [json.loads(line) for line in raw.decode("utf-8").splitlines() if line.strip()]
        if len(selected) != record["rows"] or any(row["split"] != split for row in selected):
            raise ValueError("Dataset count or split mismatch")
        rows.extend(selected)
    if args.kind == "train" and any(row["review_status"] != "human_reviewed" for row in rows):
        raise ValueError("Formal training requires reviewed data. The current seed supports check/probe only.")
    if os.name == "nt":
        if root.drive.upper() == "C:" or root.drive.startswith("\\\\"):
            raise ValueError("Run on the GPU PC using the local non-C project drive, not the SMB path")
        if not args.plan:
            for key in CACHE_KEYS:
                if key not in os.environ:
                    raise ValueError("Launch through run-fixed-slots-v1.cmd; missing cache variable: " + key)
                value = Path(os.environ[key]).resolve()
                if not value.is_relative_to(root) or value.drive.upper() == "C:":
                    raise ValueError("Task cache escapes the non-C project root: " + key)
    plan = {"kind": "pipeline_probe" if args.kind == "probe" else args.kind,
            "base": str(root / "models/hy-mt2-1.8b"), "base_revision": config["base_revision"],
            "source_commit": manifest["source_commit"], "rows": {s: data_manifest["files"][s]["rows"] for s in ["train", "validation"]},
            "max_optimizer_steps": config["probe_max_steps"] if args.kind == "probe" else None,
            "training_requested": args.kind != "check", "training_executed": False,
            "python": sys.executable, "auto_install": False, "upload": False}
    print(json.dumps(plan, ensure_ascii=True, indent=2), flush=True)
    if args.plan:
        return 0
    if not (root / "models/hy-mt2-1.8b/model.safetensors").is_file():
        raise ValueError("Original BF16 base model is missing")
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    output = root / "outputs" / ("pagelingo-fixed-slots-v1-" + args.kind + "-" + stamp)
    output.mkdir(parents=True, exist_ok=False)
    plan["run_directory"] = str(output)
    (output / "launch.json").write_text(json.dumps(plan, indent=2) + "\n", encoding="utf-8")
    print("RUN_DIRECTORY=" + str(output), flush=True)
    command = [sys.executable, "-u", str(here / "train.py"), "--data", str(here / "data"),
               "--base", plan["base"], "--output", str(output / "training")]
    if args.kind != "check":
        command.append("--train")
    if args.kind == "probe":
        command += ["--probe", "--allow-unreviewed-seed-data"]
    with (output / "console.log").open("w", encoding="utf-8", buffering=1) as log:
        child = subprocess.Popen(command, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 text=True, encoding="utf-8", errors="replace", env=os.environ.copy())
        try:
            for line in child.stdout:
                print(line, end="", flush=True)
                log.write(line)
            code = child.wait()
        except KeyboardInterrupt:
            child.terminate()
            try:
                child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
            code = 130
    (output / "exit.json").write_text(json.dumps({"exit_code": code, "training_completed": code == 0 and args.kind != "check"}) + "\n", encoding="utf-8")
    print("RUN_DIRECTORY=" + str(output), flush=True)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
