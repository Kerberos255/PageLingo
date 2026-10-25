"""Test the candidate in actual Firefox/wllama and the bundled production renderer. No model downloads."""
import argparse
import base64
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tarfile
import threading
import time
import urllib.request
import zipfile

from evaluate_gpu import sha256, write_json
from metrics import PeakSampler

HERE = Path(__file__).resolve().parent


def find_firefox():
    candidates = [Path(os.environ.get(key, "C:/Program Files")) / "Mozilla Firefox/firefox.exe" for key in ["PROGRAMFILES", "PROGRAMFILES(X86)"]]
    candidates.append(Path(os.environ.get("LOCALAPPDATA", "C:/Users/Default/AppData/Local")) / "Mozilla Firefox/firefox.exe")
    for candidate in candidates:
        if candidate.is_file(): return candidate
    raise FileNotFoundError("Firefox is not installed in a standard location; no training was started")


def prepare_assets(cache, config):
    cache.mkdir(parents=True, exist_ok=True)
    def download(record, destination):
        algorithm, expected = record["digest"].split(":", 1)
        def digest():
            value = hashlib.new(algorithm, destination.read_bytes()).digest()
            return base64.b64encode(value).decode() if record.get("base64") else value.hex()
        if destination.exists() and digest() == expected: return
        temporary = destination.with_suffix(destination.suffix + ".part")
        with urllib.request.urlopen(record["url"], timeout=120) as response, temporary.open("wb") as stream:
            shutil.copyfileobj(response, stream)
        temporary.replace(destination)
        if digest() != expected: raise ValueError("Browser asset integrity check failed: " + destination.name)
    tgz = cache / "wllama-3.6.1.tgz"; archive = cache / "geckodriver-win64.zip"
    download(config["wllama"], tgz); download(config["geckodriver"], archive)
    npm = cache / "npm"; npm.mkdir(exist_ok=True)
    with tarfile.open(tgz) as source:
        members = source.getmembers()
        if sum(m.size for m in members) > 500_000_000: raise ValueError("Unexpected package size")
        for member in members:
            if not (npm / member.name).resolve().is_relative_to(npm.resolve()) or not (member.isfile() or member.isdir()):
                raise ValueError("Unsafe browser asset member")
        source.extractall(npm, filter="data")
    with zipfile.ZipFile(archive) as source:
        (cache / "geckodriver.exe").write_bytes(source.read("geckodriver.exe"))
    return {"wllama_tgz_sha256": sha256(tgz), "driver_zip_sha256": sha256(archive), "downloads_are_model_weights": False}


def build_worker(assets, out):
    source = assets / "npm/package"
    original = '''var createWorker = (workerCode) => {
  const workerURL = URL.createObjectURL(
    isString(workerCode) ? new Blob([workerCode], { type: "text/javascript" }) : workerCode
  );
  return new Worker(workerURL, { type: "module" });
};'''
    esm = (source / "esm/index.js").read_text(encoding="utf-8")
    if esm.count(original) != 1: raise ValueError("Pinned wllama worker source changed")
    npm = out / "npm/package/esm"; npm.mkdir(parents=True)
    (npm / "index.js").write_text(esm.replace(original, 'var createWorker = (_code) => new Worker("/audit-worker.js", {type: "module"});'), encoding="utf-8")
    (npm / "wasm").mkdir(); shutil.copyfile(source / "esm/wasm/wllama.wasm", npm / "wasm/wllama.wasm")
    jspi = '''if (!WebAssembly.Suspending) {
WebAssembly.Suspending=function(fn){return fn;};
WebAssembly.promising=function(fn){return function(...args){try{return Promise.resolve(fn(...args));}catch(e){return Promise.reject(e);}};};
}'''
    gpu = 'try{Object.defineProperty(WorkerNavigator.prototype,"gpu",{get:()=>({requestAdapter:async()=>null})});}catch(e){}'
    module = gpu + jspi + (source / "src/wasm/wllama.js").read_text(encoding="utf-8")
    if "var Module" not in module: raise ValueError("Pinned Emscripten module source changed")
    module = module.replace("var Module", "var ___Module", 1)
    options = 'const RUN_OPTIONS={pathConfig:{"wllama.wasm":new URL("/npm/package/esm/wasm/wllama.wasm",self.location.href).href},nbThread:0,compat:false};'
    worker = options + '\nfunction wModuleInit(){' + module + ';return Module;}\n' + (source / "src/workers-code/llama-cpp.js").read_text(encoding="utf-8")
    (out / "audit-worker.js").write_text(worker, encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True); parser.add_argument("--sha256", required=True)
    parser.add_argument("--plan", type=Path, required=True); parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--firefox", type=Path, required=True); parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--geckodriver", type=Path)
    args = parser.parse_args()
    if args.output.exists() or sha256(args.model) != args.sha256: raise ValueError("New output and verified candidate required")
    args.output.mkdir(parents=True)
    build_worker(args.assets, args.output)
    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    selected = ["release-v2-handoff-order-before", "release-v2-lease-permission-forbidden", "release-v2-protocol-definition-thenable", "d-html-headings-05", "d-pythread-06"]
    cases = [next(c for c in plan["cases"] if c["id"] == key) for key in selected]
    descriptor = {"cases": cases, "modelBytes": args.model.stat().st_size, "css": (HERE / "production.css").read_text(encoding="utf-8")}
    write_json(args.output / "descriptor.json", descriptor)
    for name in ["production-runtime.js", "browser-audit-v2.js"]: shutil.copyfile(HERE / name, args.output / name)
    (args.output / "bootstrap.js").write_text('window.__candidateAudit={phase:"loading",cases:[],errors:[],done:false};window.addEventListener("error",e=>{window.__candidateAudit.errors.push(String(e.message));window.__candidateAudit.done=true;});window.addEventListener("unhandledrejection",e=>{window.__candidateAudit.errors.push(String(e.reason));window.__candidateAudit.done=true;});', encoding="utf-8")
    (args.output / "index.html").write_text('<!doctype html><meta charset="utf-8"><title>PageLingo candidate verification</title><style>body{max-width:850px;margin:50px auto;font:18px/1.6 system-ui}code{background:#eee}a{color:#145caa}</style><script src="/bootstrap.js"></script><script type="module" src="/browser-audit-v2.js"></script>', encoding="utf-8")
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw): super().__init__(*a, directory=str(args.output), **kw)
        def translate_path(self, path):
            if path.split("?", 1)[0] == "/model.gguf": return str(args.model.resolve())
            return super().translate_path(path)
        def log_message(self, *a): pass
        def end_headers(self):
            self.send_header("Content-Security-Policy", "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; connect-src 'self'; worker-src 'self'")
            super().end_headers()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with socket.socket() as sock: sock.bind(("127.0.0.1", 0)); driver_port = sock.getsockname()[1]
    driver = args.geckodriver or args.assets / "geckodriver.exe"
    log = (args.output / "geckodriver.log").open("w", encoding="utf-8")
    process = subprocess.Popen([str(driver.resolve()), "--host", "127.0.0.1", "--port", str(driver_port)], stdout=log, stderr=subprocess.STDOUT)
    http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    result = {"model_sha256": args.sha256, "plan_sha256": sha256(args.plan), "scope": "Actual Firefox/wllama, same static-worker patches and CSP, production inference/renderer/CSS on frozen local source blocks. Fresh profile; Blob model loading, not extension OPFS or full-page startup.", "failures": []}
    session = None; sampler = None
    def request(method, endpoint, body=None):
        payload = None if body is None else json.dumps(body).encode()
        r = urllib.request.Request(f"http://127.0.0.1:{driver_port}" + endpoint, payload, {"Content-Type": "application/json"}, method=method)
        with http.open(r, timeout=180) as response: value = json.load(response)["value"]
        if isinstance(value, dict) and value.get("error"): raise RuntimeError(value)
        return value
    try:
        start = time.perf_counter()
        while True:
            if process.poll() is not None: raise RuntimeError("Geckodriver exited")
            try: request("GET", "/status"); break
            except OSError:
                if time.perf_counter() - start > 30: raise
                time.sleep(.1)
        profile = args.output / "profile"; profile.mkdir()
        created = request("POST", "/session", {"capabilities": {"alwaysMatch": {"browserName": "firefox", "acceptInsecureCerts": False,
            "moz:firefoxOptions": {"binary": str(args.firefox.resolve()), "args": ["-headless", "-profile", str(profile.resolve())],
            "prefs": {"javascript.options.wasm_optimizingjit": True, "javascript.options.wasm_baselinejit": True}}}}})
        session = created["sessionId"]; result["capabilities"] = created["capabilities"]
        pid = created["capabilities"]["moz:processID"]
        sampler = PeakSampler(lambda: [pid], args.output / "memory.jsonl", interval=.25); sampler.start()
        prefix = "/session/" + session
        request("POST", prefix + "/window/rect", {"width": 1440, "height": 1100})
        request("POST", prefix + "/url", {"url": f"http://127.0.0.1:{server.server_port}/index.html"})
        seen = set(); start = time.perf_counter(); last_progress = 0
        while True:
            current = request("POST", prefix + "/execute/sync", {"script": "return JSON.parse(JSON.stringify(window.__candidateAudit || {}));", "args": []})
            result["audit"] = current; write_json(args.output / "results.json", result)
            if current.get("done"): break
            phase = current.get("phase"); rows = current.get("cases", []); key = (len(rows), phase)
            if rows and phase in ["before", "translated", "bilingual", "restored"] and key not in seen:
                sampler.phase = rows[-1]["id"] + "-" + phase
                request("POST", prefix + "/execute/sync", {"script": "window.__candidateTarget.scrollIntoView({block:'center'});", "args": []})
                screenshot = request("GET", prefix + "/screenshot")
                (args.output / (rows[-1]["id"] + "-" + phase + ".png")).write_bytes(base64.b64decode(screenshot))
                seen.add(key)
                request("POST", prefix + "/execute/sync", {"script": "window.__candidateAudit.continue=true;", "args": []})
            if time.perf_counter() - last_progress > 15:
                print(json.dumps({"event": "firefox_progress", "phase": phase, "cases": len(rows)}), flush=True); last_progress = time.perf_counter()
            if time.perf_counter() - start > 1800: raise TimeoutError("Firefox verification exceeded 30 minutes")
            time.sleep(.5)
        if current.get("errors"): raise RuntimeError(current["errors"])
        if len(current.get("cases", [])) != len(cases): raise RuntimeError("Incomplete browser evidence")
        result["completed"] = True
    except BaseException as error:
        result["failures"].append(repr(error)); raise
    finally:
        if sampler:
            result["memory"] = sampler.stop()
            result["memory"]["pss_available"] = os.name != "nt"
            if os.name == "nt":
                result["memory"].pop("peak_sum_pss_bytes", None)
                for phase in result["memory"]["phase_peaks"].values(): phase.pop("pss_bytes", None)
        if session:
            try: request("DELETE", "/session/" + session)
            except OSError: pass
        process.terminate()
        try: process.wait(timeout=15)
        except subprocess.TimeoutExpired: process.kill(); process.wait()
        log.close(); server.shutdown(); write_json(args.output / "results.json", result)


if __name__ == "__main__": main()
