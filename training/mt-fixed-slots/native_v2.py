"""Record actual CPU Q5/grammar generations from a frozen production plan; stdlib only."""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import socket
import subprocess
import time
import urllib.request

from evaluate_gpu import request_hash, validate_plan, write_json, sha256


def working_set(pid):
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
                (name, ctypes.c_size_t) for name in ["PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage",
                "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage"]]
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        handle = kernel.OpenProcess(0x0400 | 0x10, False, pid)
        if not handle:
            return {"measurement_error": ctypes.get_last_error()}
        try:
            value = Counters(); value.cb = ctypes.sizeof(value)
            if not psapi.GetProcessMemoryInfo(handle, ctypes.byref(value), value.cb):
                return {"measurement_error": ctypes.get_last_error()}
            return {"peak_working_set_bytes": value.PeakWorkingSetSize, "working_set_bytes": value.WorkingSetSize}
        finally:
            kernel.CloseHandle(handle)
    return {"proc_status": [line for line in Path(f"/proc/{pid}/status").read_text().splitlines() if line.startswith(("VmHWM:", "VmRSS:"))]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", type=Path, required=True)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--source-config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--threads", type=int, default=2)
    args = parser.parse_args()
    if args.threads < 1 or args.output.exists():
        raise ValueError("Positive threads and a new output directory required")
    plan = json.loads(args.plan.read_text(encoding="utf-8")); validate_plan(plan)
    jobs = [job for job in plan["jobs"] if job["mode"] == "fixed"]
    models = json.loads(args.models.read_text(encoding="utf-8"))
    if not models or len({m["label"] for m in models}) != len(models) or any(not re.fullmatch(r"[A-Za-z0-9_-]+", m["label"]) for m in models):
        raise ValueError("Unique model labels required")
    guard_file = Path(__file__).with_name("mt-gguf-metadata.py")
    if not guard_file.is_file():
        guard_file = Path(__file__).resolve().parents[2] / "tools/mt-gguf-metadata.py"
    spec = importlib.util.spec_from_file_location("mt_metadata_v2", guard_file)
    guard = importlib.util.module_from_spec(spec); spec.loader.exec_module(guard)
    http = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # Loopback only.
    args.output.mkdir(parents=True)
    manifest = {"schema_version": 1, "protocol": "Q5-production-grammar-v2", "created_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "plan_sha256": sha256(args.plan), "grammar_applied": True, "threads": args.threads, "files": {}, "models": []}
    def save(): write_json(args.output / "runs.json", manifest)
    for identity in models:
        model = Path(identity["path"]).resolve()
        if sha256(model) != identity["sha256"]:
            raise ValueError("Pinned Q5 identity changed: " + identity["label"])
        check, _ = guard.verify(model, args.source_config)
        if not check["passed"]:
            raise ValueError("Invalid token metadata: " + json.dumps(check))
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0)); port = sock.getsockname()[1]
        url = f"http://127.0.0.1:{port}"
        command = [str(args.server.resolve()), "-m", str(model), "-t", str(args.threads), "-tb", str(args.threads),
                   "-c", "3072", "-ngl", "0", "-np", "1", "--host", "127.0.0.1", "--port", str(port), "--no-webui", "--no-warmup"]
        result = {"model": identity["label"], "identity": identity, "grammar_applied": True, "token_check": check,
                  "command": command, "generations": []}
        manifest["models"].append({"label": identity["label"], "sha256": identity["sha256"], "bytes": model.stat().st_size})
        def post(endpoint, body):
            request = urllib.request.Request(url + endpoint, json.dumps(body, ensure_ascii=False).encode(), {"Content-Type": "application/json"})
            return http.open(request, timeout=300)
        with (args.output / (identity["label"] + "-server.log")).open("w", encoding="utf-8") as log:
            started = time.perf_counter(); process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
            try:
                while True:
                    if process.poll() is not None: raise RuntimeError("Q5 server exited; see server log")
                    try:
                        with http.open(url + "/health", timeout=.5) as response:
                            if response.status == 200: break
                    except (OSError, TimeoutError): pass
                    if time.perf_counter() - started > 120: raise TimeoutError("Q5 server startup")
                    time.sleep(.05)
                result["ready_wall_s"] = time.perf_counter() - started
                for job in jobs:
                    with post("/apply-template", {"messages": job["request"]["messages"], "add_generation_prompt": True}) as response:
                        prompt = json.load(response)["prompt"]
                    started = time.perf_counter(); first = None; content = ""; final = None
                    with post("/completion", {"prompt": prompt, "grammar": job["production_grammar"], "n_predict": job["request"]["max_tokens"],
                                             "temperature": 0, "top_k": 1, "seed": 42, "cache_prompt": False, "stream": True}) as response:
                        for raw in response:
                            line = raw.decode("utf-8").strip()
                            if not line.startswith("data:") or line[5:].strip() == "[DONE]": continue
                            event = json.loads(line[5:].strip())
                            if event.get("error"): raise RuntimeError(event["error"])
                            if event.get("content"):
                                if first is None: first = time.perf_counter()
                                content += event["content"]
                            if event.get("stop"): final = event
                    if final is None: raise RuntimeError("Missing final completion event")
                    result["generations"].append({"key": job["key"], "request_sha256": request_hash(job["request"]),
                        "grammar_sha256": hashlib.sha256(job["production_grammar"].encode()).hexdigest(),
                        "actual_prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(), "max_tokens": job["request"]["max_tokens"],
                        "text": content, "stop_type": final["stop_type"], "finish_reason": "stop" if final["stop_type"] == "eos" else "length",
                        "wall_s": time.perf_counter() - started, "first_token_s": None if first is None else first - started,
                        "timings": final["timings"]})
                    write_json(args.output / (identity["label"] + ".json"), result)
                    print(json.dumps({"event": "q5_generation", "model": identity["label"], "key": job["key"], "stop": final["stop_type"]}), flush=True)
                result["memory"] = working_set(process.pid)
                result["finished_utc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
                file = args.output / (identity["label"] + ".json"); write_json(file, result)
                manifest["files"][identity["label"]] = {"file": file.name, "sha256": sha256(file)}; save()
            finally:
                process.terminate()
                try: process.wait(timeout=15)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
    manifest["finished_utc"] = datetime.datetime.now(datetime.timezone.utc).isoformat(); save()


if __name__ == "__main__": main()
