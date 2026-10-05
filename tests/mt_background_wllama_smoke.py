#!/usr/bin/env python3
from __future__ import annotations
import json, os, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.ui import WebDriverWait

ADDON_ID="pagelingo@kerberos255"

def extension_uuid(driver, addon_id):
    with driver.context(driver.CONTEXT_CHROME):
        raw=driver.execute_script("""
          const prefs=Components.classes['@mozilla.org/preferences-service;1']
            .getService(Components.interfaces.nsIPrefBranch);
          return prefs.getStringPref('extensions.webextensions.uuids');
        """)
    return json.loads(raw)[addon_id]

def main():
    if len(sys.argv) != 3:
        raise SystemExit("Usage: mt_background_wllama_smoke.py <xpi> <tiny.gguf>")
    xpi=Path(sys.argv[1]).resolve()
    model=Path(sys.argv[2]).resolve()
    payload=model.read_bytes()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_GET(self):
            if self.path != "/model.gguf":
                self.send_response(404); self.end_headers(); return
            self.send_response(200)
            self.send_header("Content-Type","application/octet-stream")
            self.send_header("Content-Length",str(len(payload)))
            self.send_header("Access-Control-Allow-Origin","*")
            self.send_header("Cache-Control","no-store")
            self.end_headers()
            self.wfile.write(payload)

    server=ThreadingHTTPServer(("127.0.0.1",0),Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    model_url=f"http://127.0.0.1:{server.server_address[1]}/model.gguf"

    options=Options(); options.add_argument("-headless")
    if os.environ.get("FIREFOX_BINARY"): options.binary_location=os.environ["FIREFOX_BINARY"]
    driver=webdriver.Firefox(options=options,service=Service(service_args=["--allow-system-access"]))
    try:
        addon=driver.install_addon(str(xpi),temporary=True)
        uuid=extension_uuid(driver,addon)
        driver.get(f"moz-extension://{uuid}/mt-runtime-diag.html?model={quote(model_url,safe='')}")
        started=time.monotonic()
        WebDriverWait(driver,60).until(
            lambda d:d.execute_script("return window.__mtRuntimeDiag && window.__mtRuntimeDiag.state !== 'running'")
        )
        result=driver.execute_script("return window.__mtRuntimeDiag")
        elapsed=time.monotonic()-started
        print("TINY_WLLAMA_RESULT=",json.dumps(result,ensure_ascii=False))
        print("TINY_WLLAMA_SECONDS=",elapsed)
        if not result.get("ok"):
            raise AssertionError(result)
        print("TINY_WLLAMA_EXTENSION_DOCUMENT=PASS")
    finally:
        driver.quit()
        server.shutdown()
        server.server_close()

if __name__=="__main__": main()
