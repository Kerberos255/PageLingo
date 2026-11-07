"""Cloud CPU diagnostic for a frozen sentence-alignment plan; stdlib only."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import socket
import subprocess
import time
import urllib.request


def digest(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def validate_plan_protocol(plan):
    if plan.get("protocol") not in ["sentence-alignment-research-v1", "fixed-training-error-mining-v1", "source-format-diagnostic-v8", "scope-choice-evaluation-v1"] or not plan.get("jobs"):
        raise ValueError("Unsupported or empty diagnostic plan")
    if plan["protocol"] == "scope-choice-evaluation-v1":
        import importlib.util
        file = Path(__file__).resolve().parents[1] / "training/mt-fixed-slots/evaluate_scope_choice.py"
        spec = importlib.util.spec_from_file_location("scope_evaluation_guard", file)
        guard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(guard)
        guard.validate_eval_plan(plan)


def main():
    parser = argparse.ArgumentParser()
    for flag in ("server", "model", "plan", "output"):
        parser.add_argument("--" + flag, type=Path, required=True)
    parser.add_argument("--sha256", required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("Use a new output directory; preserve prior evidence")
    if digest(args.model) != args.sha256:
        raise ValueError("Pinned model identity changed")
    plan = json.loads(args.plan.read_text())
    validate_plan_protocol(plan)
    if plan["protocol"] == "fixed-training-error-mining-v1":
        from mt_mining_guard import validate_mining_plan
        validate_mining_plan(plan)
    if plan["protocol"] == "source-format-diagnostic-v8":
        import importlib.util
        spec = importlib.util.spec_from_file_location("source_diagnostic_guard", Path(__file__).with_name("mt-source-diagnostic-guard.py"))
        guard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(guard)
        guard.validate_source_diagnostic(plan)
    if plan["protocol"] in ["fixed-training-error-mining-v1", "source-format-diagnostic-v8", "scope-choice-evaluation-v1"]:
        for name, expected in plan["source_hashes"].items():
            source = (Path(__file__).resolve().parents[1] / name).resolve()
            if not source.is_relative_to(Path(__file__).resolve().parents[1]) or digest(source) != expected:
                raise ValueError("Frozen diagnostic source changed: " + name)
    if plan.get("model_binding_sha256") not in (None, args.sha256):
        raise ValueError("A chained draft must be compiled by its recorded model identity")
    args.output.mkdir(parents=True)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    url = f"http://127.0.0.1:{port}"
    http = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # Loopback only.
    command = [str(args.server.resolve()), "-m", str(args.model.resolve()), "-t", "2", "-tb", "2", "-c", "3072",
               "-ngl", "0", "-np", "1", "--host", "127.0.0.1", "--port", str(port), "--no-webui", "--no-warmup"]
    result = {"protocol": plan["protocol"], "plan_sha256": digest(args.plan),
              "model": {"path": str(args.model.resolve()), "sha256": args.sha256, "bytes": args.model.stat().st_size},
              "started_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "command": command,
              "server_sha256": digest(args.server), "generations": []}

    def save():
        (args.output / "run.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")

    def post(endpoint, body):
        request = urllib.request.Request(url + endpoint, json.dumps(body, ensure_ascii=False).encode(), {"Content-Type": "application/json"})
        return http.open(request, timeout=180)

    with (args.output / "server.log").open("w") as log:
        start = time.perf_counter()
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
        try:
            while True:
                if process.poll() is not None:
                    raise RuntimeError("Server exited; inspect server.log")
                try:
                    with http.open(url + "/health", timeout=.5) as response:
                        if response.status == 200:
                            break
                except (OSError, TimeoutError):
                    pass
                if time.perf_counter() - start > 120:
                    raise TimeoutError("Server startup")
                time.sleep(.05)
            result["ready_wall_s"] = time.perf_counter() - start
            for job in plan["jobs"]:
                options = job["request"]
                with post("/apply-template", {"messages": options["messages"], "add_generation_prompt": True}) as response:
                    prompt = json.load(response)["prompt"]
                with post("/tokenize", {"content": prompt, "add_special": False}) as response:
                    input_tokens = json.load(response)["tokens"]
                if len(input_tokens) + options["max_tokens"] > 3072:
                    raise ValueError("Frozen request exceeds context budget")
                body = {"prompt": prompt, "n_predict": options["max_tokens"], "temperature": 0, "top_k": 1,
                        "seed": 42, "cache_prompt": False, "stream": True}
                if options["grammar"] is not None:
                    body["grammar"] = options["grammar"]
                start = time.perf_counter()
                first, text, final = None, "", None
                with post("/completion", body) as response:
                    for raw in response:
                        line = raw.decode().strip()
                        if not line.startswith("data:") or line[5:].strip() == "[DONE]":
                            continue
                        event = json.loads(line[5:].strip())
                        if event.get("error"):
                            raise RuntimeError(event["error"])
                        if event.get("content"):
                            if first is None:
                                first = time.perf_counter()
                            text += event["content"]
                        if event.get("stop"):
                            final = event
                if final is None:
                    raise RuntimeError("Missing final generation event")
                row = {"case_id": job["case_id"], "variant": job["variant"], "text": text,
                       "request_sha256": hashlib.sha256(json.dumps(options, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest(),
                       "actual_prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(), "input_tokens": len(input_tokens),
                       "input_token_ids_sha256": hashlib.sha256(json.dumps(input_tokens, separators=(",", ":")).encode()).hexdigest(),
                       "stop_type": final["stop_type"], "finish_reason": "stop" if final["stop_type"] == "eos" else "length",
                       "first_token_s": None if first is None else first - start, "wall_s": time.perf_counter() - start,
                       "timings": final["timings"]}
                result["generations"].append(row)
                result["proc_status"] = [line for line in Path(f"/proc/{process.pid}/status").read_text().splitlines() if line.startswith(("VmHWM:", "VmRSS:"))]
                save()
                print(json.dumps({"case": row["case_id"], "variant": row["variant"], "stop": row["stop_type"]}), flush=True)
            result["finished_utc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            save()
        finally:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == "__main__":
    main()
