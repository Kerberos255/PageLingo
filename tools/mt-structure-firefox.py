"""Run deterministic production structure regressions in Firefox, without weights."""
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
for flag in ("firefox", "geckodriver", "output"):
    parser.add_argument("--" + flag, type=Path, required=True)
args = parser.parse_args()
if args.output.exists():
    raise ValueError("Use a new evidence directory")
args.output.mkdir(parents=True)
runtime = args.output.resolve() / "runtime.mjs"
subprocess.run(["node", "--input-type=module", "-e", "import{build}from'esbuild';await build({entryPoints:['eval/mt-quality/browser-structure.ts'],bundle:true,platform:'browser',format:'esm',outfile:process.argv[1],logLevel:'silent'});", str(runtime)], cwd=ROOT, check=True)
(args.output / "index.html").write_text('<!doctype html><meta charset="utf-8"><title>PageLingo structure regression</title>')


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
    driver.set_script_timeout(60)
    result = driver.execute_async_script("""const done=arguments[0];import('./runtime.mjs').then(api=>api.runBrowserStructureRegressions()).then(done).catch(error=>done({error:String(error),stack:error.stack}));""")
    if "error" in result:
        raise RuntimeError(json.dumps(result))
    result.update(browser_version=driver.capabilities["browserVersion"], timestamp_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  runtime_sha256=hashlib.sha256(runtime.read_bytes()).hexdigest())
    (args.output / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result))
finally:
    if driver:
        driver.quit()
    server.shutdown()
