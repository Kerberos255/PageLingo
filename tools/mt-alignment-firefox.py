"""Replay recorded native generations in Firefox. No model inference is done here."""
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


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verified_group(plan_path, run_paths, method):
    plan = json.loads(plan_path.read_text())
    for file, expected in plan["source_hashes"].items():
        if digest(ROOT / file) != expected:
            raise ValueError("Frozen source changed: " + file)
    group = {"method": method, "plan": plan, "plan_sha256": digest(plan_path), "runs": []}
    for path in run_paths:
        run = json.loads(path.read_text())
        if run["plan_sha256"] != group["plan_sha256"] or len(run["generations"]) != len(plan["jobs"]):
            raise ValueError("Incomplete or mismatched native run")
        for job, row in zip(plan["jobs"], run["generations"]):
            request_hash = hashlib.sha256(json.dumps(job["request"], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
            if (job["case_id"], job["variant"], request_hash) != (row["case_id"], row["variant"], row["request_sha256"]):
                raise ValueError("Generation provenance mismatch")
        group["runs"].append({"run": run, "sha256": digest(path)})
    return group


def main():
    parser = argparse.ArgumentParser()
    for flag in ("sentence-plan", "phrase-plan", "firefox", "geckodriver", "output"):
        parser.add_argument("--" + flag, type=Path, required=True)
    parser.add_argument("--sentence-runs", type=Path, nargs="+", required=True)
    parser.add_argument("--phrase-runs", type=Path, nargs="+", required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("Use a new evidence directory")
    groups = [verified_group(args.sentence_plan, args.sentence_runs, "sentence"), verified_group(args.phrase_plan, args.phrase_runs, "phrase")]
    args.output.mkdir(parents=True)
    runtime = args.output.resolve() / "runtime.mjs"
    build = "import {build} from 'esbuild'; await build({entryPoints:['eval/mt-quality/browser-alignment.ts'],bundle:true,platform:'browser',format:'esm',outfile:process.argv[1],logLevel:'silent'});"
    subprocess.run(["node", "--input-type=module", "-e", build, str(runtime)], cwd=ROOT, check=True)
    (args.output / "index.html").write_text('<!doctype html><meta charset="utf-8"><title>PageLingo alignment rendering replay</title>')

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args_, **kwargs):
            super().__init__(*args_, directory=str(args.output.resolve()), **kwargs)

        def log_message(self, *args_):
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
        result = driver.execute_async_script("""const groups=arguments[0],done=arguments[1];(async()=>{
            const api=await import('./runtime.mjs'),rows=[];
            for(const group of groups)for(const recorded of group.runs)for(const sample of group.plan.cases){
                const generations=recorded.run.generations.filter(row=>row.case_id===sample.id);
                const variants=group.method==='phrase'?['phrase_alignment']:['fixed','fixed_context','sentence_free','sentence_ordered'];
                for(const variant of variants){
                    const row=await api.replayAlignmentInBrowser(sample,generations,variant);
                    if(!row.original_structure_unchanged||!row.code_unchanged||!row.link_listener_preserved||!row.serialized_source_matches||!row.restored_exact||row.calls!==1)
                        throw new Error('Browser DOM invariant failed: '+JSON.stringify(row));
                    rows.push({model_sha256:recorded.run.model.sha256,run_sha256:recorded.sha256,...row});
                }
            }
            return {user_agent:navigator.userAgent,rows};
        })().then(done).catch(error=>done({error:String(error),stack:error.stack}));""", groups)
        if "error" in result:
            raise RuntimeError(json.dumps(result))
        result.update(scope="Recorded native CPU generations, replayed in real Firefox using source fixtures and the real PageTranslator. No new Firefox/wllama inference and no live-site claim.",
                      browser_version=driver.capabilities["browserVersion"], timestamp_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                      browser_runtime_sha256=digest(runtime), groups=[{"method": group["method"], "plan_sha256": group["plan_sha256"], "runs": [row["sha256"] for row in group["runs"]]} for group in groups])
        (args.output / "replay.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({"browser": result["browser_version"], "rows": len(result["rows"]), "all_dom_checks_passed": True}))
    finally:
        if driver:
            driver.quit()
        server.shutdown()


if __name__ == "__main__":
    main()
