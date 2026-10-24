"""Run fixed-slot and plain diagnostic comparisons using a supplied llama.cpp server.

Only reads model weights. No downloads, training, Hub writes, or model replacement.
"""
import argparse
import contextlib
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import socket
import subprocess
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--server", required=True, type=Path)
parser.add_argument("--base-model", required=True, type=Path)
parser.add_argument("--mt-model", required=True, type=Path)
parser.add_argument("--candidate-model", type=Path, help="Optional third Q5 candidate; same inputs and settings")
parser.add_argument("--project-root", type=Path, help="Use a frozen source checkout for baseline validation")
parser.add_argument("--source-config", required=True, type=Path, help="Original base config/tokenizer directory for stop-token verification")
parser.add_argument("--out", type=Path, default=ROOT / "artifacts/mt-quality/results")
parser.add_argument("--threads", type=int, default=2)
parser.add_argument("--skip-plain", action="store_true")
args = parser.parse_args()
if args.project_root:
    ROOT = args.project_root.resolve()
    if not (ROOT / "tools/mt-quality-eval.mjs").is_file():
        raise ValueError("Project root does not contain the MT evaluator")
args.out = args.out.resolve()
args.out.mkdir(parents=True, exist_ok=True)
http = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # Loopback only.
spec = importlib.util.spec_from_file_location("mt_metadata_guard", ROOT / "tools/mt-gguf-metadata.py")
metadata_guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metadata_guard)
manifest = {"created_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "source_root": str(ROOT), "runs": []}


def save():
    (args.out / "runs.json").write_text(json.dumps(manifest, indent=2) + "\n")


models = [("base", args.base_model), ("pagelingo-mt-v0.2.2", args.mt_model)]
if args.candidate_model:
    models.append(("probe-12step", args.candidate_model))
for label, model_path in models:
    model_path = model_path.resolve()
    token_check, _ = metadata_guard.verify(model_path, args.source_config)
    if not token_check["passed"]:
        raise ValueError("Invalid model stop tokens/chat template; refusing evaluation: " + json.dumps(token_check))
    with model_path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    url = f"http://127.0.0.1:{port}"
    command = [str(args.server.resolve()), "-m", str(model_path), "-t", str(args.threads), "-tb", str(args.threads),
               "-c", "3072", "-b", "512", "-ub", "512", "-ngl", "0", "-np", "1", "--host", "127.0.0.1",
               "--port", str(port), "--no-webui", "--no-warmup", "--no-cache-prompt", "--cache-ram", "0", "--fit", "off", "--flash-attn", "off"]
    row = {"model": label, "path": str(model_path), "bytes": model_path.stat().st_size, "sha256": digest, "token_metadata_check": token_check, "command": command, "evaluations": []}
    manifest["runs"].append(row)
    save()
    with (args.out / (label + "-server.log")).open("w") as log:
        start = time.perf_counter()
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = start + 90
            while True:
                if process.poll() is not None:
                    raise RuntimeError(f"{label}: model server exited")
                try:
                    with http.open(url + "/health", timeout=.5) as response:
                        if response.status == 200:
                            break
                except (urllib.error.URLError, TimeoutError):
                    pass
                if time.perf_counter() > deadline:
                    raise TimeoutError("Model startup")
                time.sleep(.05)
            row["ready_wall_s"] = time.perf_counter() - start
            for mode in (["fixed"] if args.skip_plain else ["fixed", "plain"]):
                output = args.out / f"{label}-{mode}.json"
                child = ["node", str(ROOT / "tools/mt-quality-eval.mjs"), "--server", url, "--model", label,
                         "--mode", mode, "--split", "diagnostic" if mode == "plain" else "all", "--out", str(output)]
                with (args.out / f"{label}-{mode}.log").open("w") as child_log:
                    completed = subprocess.run(child, cwd=ROOT, stdout=child_log, stderr=subprocess.STDOUT, timeout=1800)
                row["evaluations"].append({"mode": mode, "output": str(output), "exit_code": completed.returncode})
                save()
                if completed.returncode:
                    raise RuntimeError(f"{label}/{mode}: evaluator failed; see its log")
        finally:
            with contextlib.suppress(FileNotFoundError):
                row["final_process_status"] = [line for line in Path(f"/proc/{process.pid}/status").read_text().splitlines() if line.startswith(("VmHWM:", "VmRSS:", "Threads:"))]
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            row["finished_utc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            save()
manifest["finished_utc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
save()
