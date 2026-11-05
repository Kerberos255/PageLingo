"""Actual Firefox DOM replay of frozen native frames, not WASM inference."""
import argparse
import datetime
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import threading
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
for flag in ("root", "firefox", "geckodriver", "output"):
    parser.add_argument("--" + flag, type=Path, required=True)
args = parser.parse_args()
if args.output.exists():
    raise ValueError("Preserve previous browser evidence")
plan_path = args.root / "plan-final.json"
plan = json.loads(plan_path.read_text())
plan_sha = hashlib.sha256(plan_path.read_bytes()).hexdigest()
inputs = []
arms = [(arm, plan) for arm in ["base_hymt_q5", "old_r16_q5", "qwen3_4b_q5"]]
if (args.root / "old_r16_bf16_controls/run.json").exists():
    precision_plan = json.loads((args.root / "plan-bf16-controls.json").read_text())
    assert precision_plan["parent_plan_sha256"] == plan_sha
    arms.append(("old_r16_bf16_controls", precision_plan))
for arm, arm_plan in arms:
    run_path = args.root / arm / "run.json"
    replay = json.loads((args.root / arm / "replay.json").read_text())
    run = json.loads(run_path.read_text())
    arm_sha = plan_sha if arm != "old_r16_bf16_controls" else hashlib.sha256((args.root / "plan-bf16-controls.json").read_bytes()).hexdigest()
    assert run.get("finished_utc") and run["plan_sha256"] == arm_sha
    assert replay["run_sha256"] == hashlib.sha256(run_path.read_bytes()).hexdigest()
    assert len(run["generations"]) == len(arm_plan["jobs"])
    for job, row in zip(arm_plan["jobs"], run["generations"]):
        assert (row["case_id"], row["variant"], row["request_sha256"]) == (job["case_id"], job["variant"], job["request_sha256"])
    outputs = {(row["case_id"], row["variant"]): row for row in run["generations"]}
    decoded = {row["id"]: row for row in replay["results"]}
    for case in arm_plan["cases"]:
        for variant in ["production"] + (["context-research"] if case["context_check"] else []):
            completion = [outputs[(case["id"], "production-fixed:" + str(i))] for i in range(case["fixed_calls"])] if variant == "production" else [outputs[(case["id"], "context-fixed")]]
            expected = decoded[case["id"]]["production"] if variant == "production" else decoded[case["id"]]["context_research"]["replay"]
            inputs.append({"model": arm, "variant": variant, "sample": {key: case[key] for key in ["id", "html", "context_url"]},
                           "fixed_source": case["model_visible_fixed_source"], "completions": completion, "expected": expected})
args.output.mkdir(parents=True)
runtime = args.output.resolve() / "runtime.mjs"
subprocess.run(["node", "--input-type=module", "-e", "import{build}from'esbuild';await build({entryPoints:['eval/mt-quality/browser-source-diagnostic.ts'],bundle:true,platform:'browser',format:'esm',outfile:process.argv[1],logLevel:'silent'});", str(runtime)], cwd=ROOT, check=True)
(args.output / "input.json").write_text(json.dumps(inputs, ensure_ascii=False))
(args.output / "index.html").write_text('<!doctype html><meta charset="utf-8"><title>Source diagnostic recorded-frame replay</title>')


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(args.output.resolve()), **kw)

    def log_message(self, *a):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
options = Options()
options.binary_location = str(args.firefox.resolve())
options.add_argument("-headless")
options.ignore_local_proxy_environment_variables()
driver = None
try:
    driver = webdriver.Firefox(options=options, service=Service(str(args.geckodriver.resolve()), log_output=str(args.output / "geckodriver.log")))
    driver.get(f"http://127.0.0.1:{server.server_port}/index.html")
    driver.set_script_timeout(120)
    result = driver.execute_async_script("""const done=arguments[0];Promise.all([import('./runtime.mjs'),fetch('./input.json').then(r=>r.json())]).then(([api,input])=>api.replaySourceFramesInBrowser(input)).then(done).catch(e=>done({error:String(e),stack:e.stack}));""")
    if "error" in result:
        raise RuntimeError(json.dumps(result))
    result.update(browser_version=driver.capabilities["browserVersion"], timestamp_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  plan_sha256=plan_sha, runtime_sha256=hashlib.sha256(runtime.read_bytes()).hexdigest())
    assert len(result["results"]) == len(inputs)
    keys = ["native_serialized_source_matches", "node_replay_text_matches", "node_replay_display_matches", "original_structure_unchanged", "code_unchanged", "restored_exact"]
    (args.output / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"records": len(inputs), "browser": result["browser_version"], "checks": {k: sum(row[k] for row in result["results"]) for k in keys}, "new_wllama_inference": False}))
    assert all(row[k] for row in result["results"] for k in keys)
finally:
    if driver:
        driver.quit()
    server.shutdown()
