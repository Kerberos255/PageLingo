"""Stable, stdlib-only launcher for the currently installed immutable GPU kit."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import re
import subprocess
import sys
import time


def inside(root, relative):
    if not isinstance(relative, str) or PureWindowsPath(relative).drive or relative.startswith(("/", "\\")):
        raise ValueError("Expected a project-relative path")
    target = (root / relative).resolve()
    if not target.is_relative_to(root) or ".." in Path(relative.replace("\\", "/")).parts:
        raise ValueError("Path escapes the project")
    return target


def read_json(path):
    for attempt in range(3):
        try:
            return json.loads(path.read_text(encoding="utf-8-sig"))
        except json.JSONDecodeError:
            if attempt == 2:
                raise ValueError("Status is being written; try PageLingo-MT.cmd status again")
            time.sleep(.05)


def task_spec(root):
    task = read_json(root / "tools/mt-control/current-task.json")
    if task.get("schema_version") != 1 or not re.fullmatch(r"[a-z0-9-]+", task["run_prefix"]):
        raise ValueError("Invalid current task")
    package = inside(root, task["package"])
    raw = (package / "package-manifest.json").read_bytes()
    manifest = json.loads(raw)
    if hashlib.sha256(raw).hexdigest() != task["manifest_sha256"] or manifest["source_commit"] != task["source_commit"]:
        raise ValueError("Installed task identity changed")
    return task, package


def latest_run(root, prefix):
    outputs = root / "outputs"
    runs = sorted(p for p in outputs.glob(prefix + "-run-*") if p.is_dir() and not p.is_symlink())
    if not runs:
        return None, None
    run = runs[-1]
    return run, read_json(run / "workflow-result.json")


def run_state(status):
    if status is None:
        return "new"
    if status.get("error"):
        return "failed"
    if status.get("training_completed") and status.get("gpu_comparison_completed") and status.get("handoff"):
        return "complete"
    return "running"


def show_status(task, run, status):
    state = run_state(status)
    stage = (status or {}).get("stages", [])
    print("PageLingo-MT: " + state.upper(), flush=True)
    print("Task: " + task.get("description", task["run_prefix"]), flush=True)
    if run:
        print("Results: " + str(run), flush=True)
        if stage:
            print("Stage: " + stage[-1]["name"], flush=True)
        if status.get("error"):
            print("Error: " + status["error"], flush=True)
    if state == "complete":
        print("GPU results are ready for Cloud evaluation. The same task will not restart automatically.", flush=True)
    elif state == "running":
        print("Existing run is unfinished. No second training process will be started.", flush=True)


def validate_training_root(value):
    path = PureWindowsPath(str(value))
    if path.drive.lower() == "c:":
        raise ValueError("Use the project's non-C drive")
    if str(value).startswith("\\\\"):
        raise ValueError("Start PageLingo-MT.cmd on the GPU PC using its local drive, not the network share")


def training_environment(root, inherited):
    env = dict(inherited)
    cache, hf = root / ".cache", root / ".cache/huggingface"
    paths = {"TEMP": root / ".tmp", "TMP": root / ".tmp", "TMPDIR": root / ".tmp",
        "PIP_CACHE_DIR": cache / "pip", "PYTHONPYCACHEPREFIX": cache / "pycache",
        "HF_HOME": hf, "HF_HUB_CACHE": hf / "hub", "HUGGINGFACE_HUB_CACHE": hf / "hub",
        "HF_DATASETS_CACHE": hf / "datasets", "HF_XET_CACHE": hf / "xet", "HF_ASSETS_CACHE": hf / "assets",
        "HF_MODULES_CACHE": hf / "modules", "TORCH_HOME": cache / "torch", "TORCH_EXTENSIONS_DIR": cache / "torch_extensions",
        "TORCHINDUCTOR_CACHE_DIR": cache / "torch_inductor", "TRITON_CACHE_DIR": cache / "triton",
        "CUDA_CACHE_PATH": cache / "cuda", "XDG_CACHE_HOME": cache, "UV_CACHE_DIR": cache / "uv",
        "WANDB_DIR": cache / "wandb", "WANDB_CACHE_DIR": cache / "wandb/cache",
        "MPLCONFIGDIR": cache / "matplotlib", "NUMBA_CACHE_DIR": cache / "numba"}
    env.update({key: str(path) for key, path in paths.items()})
    env.update(ROOT=str(root), PYTHONUTF8="1", PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1",
        HF_HUB_OFFLINE="1", HF_DATASETS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1", HF_HUB_DISABLE_UPDATE_CHECK="1",
        DO_NOT_TRACK="1", TOKENIZERS_PARALLELISM="false", CUDA_VISIBLE_DEVICES="0", WANDB_MODE="disabled")
    env["PATH"] = str(root / ".venv/Scripts") + os.pathsep + env.get("PATH", "")
    return env, paths


@contextmanager
def launch_lock(root):
    folder = root / ".state"
    folder.mkdir(exist_ok=True)
    stream = (folder / "gpu-launch.lock").open("a+b")
    acquired = False
    try:
        if os.name == "nt":
            import msvcrt
            if stream.tell() == 0:
                stream.write(b"0"); stream.flush()
            stream.seek(0); msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        acquired = True
        yield
    except OSError as error:
        if acquired:
            raise
        raise ValueError("Another PageLingo-MT.cmd process owns the GPU launch lock") from error
    finally:
        if acquired and os.name == "nt":
            stream.seek(0); msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        stream.close()


def dispatch(root, action, run_child=subprocess.run):
    task, package = task_spec(root)
    run, status = latest_run(root, task["run_prefix"])
    show_status(task, run, status)
    state = run_state(status)
    if action == "status":
        return 0
    if state == "running":
        return 10
    same_task = status is not None and status.get("source_commit") == task["source_commit"]
    if action == "auto" and same_task:
        return 10 if state == "complete" else 1
    if os.name == "nt":
        validate_training_root(root)
    with launch_lock(root):
        _, current = latest_run(root, task["run_prefix"])
        # Recheck after locking: a second launcher may have finished while we were waiting.
        if run_state(current) == "running":
            return 10
        if action == "auto" and current and current.get("source_commit") == task["source_commit"]:
            return 10 if run_state(current) == "complete" else 1
        python = root / ".venv/Scripts/python.exe" if os.name == "nt" else Path(sys.executable)
        if not python.is_file():
            raise ValueError("Existing project Python environment is missing")
        env, paths = training_environment(root, os.environ)
        for path in set(paths.values()):
            path.mkdir(parents=True, exist_ok=True)
        mode = "check" if action == "check" else "run"
        result = run_child([str(python), "-u", str(package / "research_v2.py"), "--root", str(root), "--mode", mode],
                           cwd=root, env=env)
        return result.returncode


def main():
    parser = argparse.ArgumentParser(description="One stable entry: PageLingo-MT.cmd. Active/completed tasks do not restart automatically.")
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("action", choices=["auto", "status", "check", "retry"], nargs="?", default="auto")
    args = parser.parse_args()
    try:
        return dispatch(args.root.resolve(), args.action)
    except (OSError, ValueError, KeyError) as error:
        print("PageLingo-MT: " + str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
