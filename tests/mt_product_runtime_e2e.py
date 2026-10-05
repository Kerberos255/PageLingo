#!/usr/bin/env python3
from __future__ import annotations
import json, os, sys, threading, time, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.ui import WebDriverWait

ADDON_ID = "pagelingo@kerberos255"
ARTIFACTS = Path("artifacts")
ARTIFACTS.mkdir(exist_ok=True)

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        body = b"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>MT fixture</title></head>
<body><main>
<p id="one">Hello world.</p>
</main></body></html>"""
        self.send_response(200)
        self.send_header("Content-Type","text/html; charset=utf-8")
        self.send_header("Content-Length",str(len(body)))
        self.end_headers()
        self.wfile.write(body)

def extension_uuid(driver, addon_id):
    with driver.context(driver.CONTEXT_CHROME):
        raw = driver.execute_script("""
          const prefs=Components.classes['@mozilla.org/preferences-service;1']
            .getService(Components.interfaces.nsIPrefBranch);
          return prefs.getStringPref('extensions.webextensions.uuids');
        """)
    return json.loads(raw)[addon_id]

def ext_async(driver, script, *args, timeout=1200):
    driver.set_script_timeout(timeout)
    return driver.execute_async_script(script, *args)

def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: mt_product_runtime_e2e.py <xpi>")
    xpi=Path(sys.argv[1]).resolve()
    server=ThreadingHTTPServer(("127.0.0.1",0),Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    fixture=f"http://127.0.0.1:{server.server_address[1]}/"

    options=Options(); options.add_argument("-headless")
    if os.environ.get("FIREFOX_BINARY"): options.binary_location=os.environ["FIREFOX_BINARY"]
    driver=webdriver.Firefox(options=options,service=Service(service_args=["--allow-system-access"]))
    result={"fixture":fixture}
    try:
        addon_id=driver.install_addon(str(xpi),temporary=True)
        if addon_id != ADDON_ID: raise AssertionError(addon_id)
        uuid=extension_uuid(driver,addon_id)
        driver.get(f"moz-extension://{uuid}/settings.html")
        WebDriverWait(driver,30).until(lambda d:d.execute_script("return typeof browser !== 'undefined'"))

        before=ext_async(driver, """
          const done=arguments[arguments.length-1];
          browser.runtime.sendMessage({type:'get-pagelingo-mt-status'})
            .then(v=>done({ok:true,value:v})).catch(e=>done({ok:false,error:String(e),name:e?.name,message:e?.message}));
        """)
        result["before"]=before
        print("MT_STATUS_BEFORE=",json.dumps(before,ensure_ascii=False))

        started=time.monotonic()
        try:
            download=ext_async(driver, """
              const done=arguments[arguments.length-1];
              browser.runtime.sendMessage({type:'download-pagelingo-mt'})
                .then(v=>done({ok:true,value:v}))
                .catch(e=>done({ok:false,error:String(e),name:e?.name,message:e?.message,stack:e?.stack}));
            """, timeout=1200)
        except Exception as exc:
            download={"ok":False,"selenium_exception":repr(exc),"traceback":traceback.format_exc()}
        result["download"]=download
        result["download_seconds"]=time.monotonic()-started
        print("MT_DOWNLOAD=",json.dumps(download,ensure_ascii=False)[:6000])
        print("MT_DOWNLOAD_SECONDS=",result["download_seconds"])
        if not download.get("ok") or not (download.get("value") or {}).get("ok"):
            raise AssertionError(f"MT download failed: {download}")

        selected=ext_async(driver, """
          const done=arguments[arguments.length-1];
          browser.runtime.sendMessage({type:'set-active-translation-engine',id:'pagelingo-mt'})
            .then(v=>done({ok:true,value:v})).catch(e=>done({ok:false,error:String(e),name:e?.name,message:e?.message}));
        """)
        result["selected"]=selected
        print("MT_SELECTED=",json.dumps(selected,ensure_ascii=False))
        if not selected.get("ok") or not (selected.get("value") or {}).get("ok"):
            raise AssertionError(f"Could not select MT: {selected}")

        driver.switch_to.new_window("tab")
        fixture_handle=driver.current_window_handle
        driver.get(fixture)
        WebDriverWait(driver,20).until(lambda d:d.execute_script("return document.readyState")=="complete")

        # Start translation without keeping a Selenium HTTP command open. Geckodriver's
        # transport has a ~120 second read timeout, while the hosted runner can need much
        # longer to load a 1.2 GiB GGUF and complete first-token inference.
        handles=driver.window_handles
        ext_handle=handles[0]
        driver.switch_to.window(ext_handle)
        started=time.monotonic()
        launched=driver.execute_script("""
          const prefix=arguments[0];
          window.__mtProductResult={state:'running'};
          browser.tabs.query({}).then(tabs=>{
            const tab=tabs.find(t=>t.url && t.url.startsWith(prefix));
            if(!tab?.id) throw new Error('fixture tab not found');
            return browser.tabs.sendMessage(tab.id,{type:'translate-page',sourceLanguage:'en',targetLanguage:'zh-Hans'});
          }).then(v=>{window.__mtProductResult={state:'done',value:v};})
            .catch(e=>{window.__mtProductResult={state:'error',error:String(e),name:e?.name,message:e?.message,stack:e?.stack};});
          return true;
        """, fixture)
        result["launched"]=bool(launched)

        translated=None
        page=None
        phases=[]
        last_phase=None
        deadline=time.monotonic()+240
        while time.monotonic() < deadline:
            time.sleep(3)
            driver.switch_to.window(fixture_handle)
            page=driver.execute_script("""
              return {
                translations:Array.from(document.querySelectorAll('.flt-translation')).map(x=>x.textContent.trim()),
                body:document.body.innerText,
                ready:document.readyState
              };
            """)
            driver.switch_to.window(ext_handle)
            state=driver.execute_script("return window.__mtProductResult || {state:'missing'};")
            try:
                status_probe=ext_async(driver, """
                  const done=arguments[arguments.length-1];
                  browser.runtime.sendMessage({type:'get-pagelingo-mt-status'})
                    .then(v=>done({ok:true,value:v})).catch(e=>done({ok:false,error:String(e)}));
                """, timeout=15)
                mt=((status_probe.get("value") or {}).get("mt") or {})
                phase=mt.get("runtimePhase")
                if phase != last_phase:
                    phase_row={"at":round(time.monotonic()-started,2),"phase":phase,"since":mt.get("runtimeSince"),"crossOriginIsolated":mt.get("crossOriginIsolated"),"requestedThreads":mt.get("requestedThreads"),"actualThreads":mt.get("actualThreads"),"lastLoadMs":mt.get("lastLoadMs"),"lastInferenceMs":mt.get("lastInferenceMs"),"error":mt.get("error")}
                    phases.append(phase_row)
                    print("MT_PHASE=",json.dumps(phase_row,ensure_ascii=False))
                    last_phase=phase
            except Exception as exc:
                phases.append({"at":round(time.monotonic()-started,2),"phase":"status-probe-error","error":repr(exc)})
            if state.get("state") in ("done","error"):
                translated={"ok":state.get("state")=="done", **state}
                break
            if page.get("translations"):
                translated={"ok":True,"state":"page-translated-before-message-finished"}
                break
        result["phases"]=phases

        result["translate"]=translated or {"ok":False,"state":"timeout"}
        result["translate_seconds"]=time.monotonic()-started
        print("MT_TRANSLATE=",json.dumps(result["translate"],ensure_ascii=False)[:10000])
        print("MT_TRANSLATE_SECONDS=",result["translate_seconds"])

        driver.switch_to.window(fixture_handle)
        page=driver.execute_script("""
          return {
            translations:Array.from(document.querySelectorAll('.flt-translation')).map(x=>x.textContent.trim()),
            body:document.body.innerText,
            ready:document.readyState
          };
        """)
        result["page"]=page
        print("MT_PAGE=",json.dumps(page,ensure_ascii=False))
        driver.save_screenshot(str(ARTIFACTS/"mt-product-runtime-after.png"))

        driver.switch_to.window(ext_handle)
        after=ext_async(driver, """
          const done=arguments[arguments.length-1];
          browser.runtime.sendMessage({type:'get-pagelingo-mt-status'})
            .then(v=>done({ok:true,value:v})).catch(e=>done({ok:false,error:String(e),name:e?.name,message:e?.message}));
        """)
        result["after"]=after
        print("MT_STATUS_AFTER=",json.dumps(after,ensure_ascii=False))

        translated_result=result["translate"]
        if not translated_result.get("ok"):
            raise AssertionError(f"Translation request failed: {translated_result}")
        if translated_result.get("state") == "done" and (translated_result.get("value") or {}).get("ok") is not True:
            raise AssertionError(f"Translation backend returned failure: {translated_result}")
        if not page.get("translations"):
            raise AssertionError(f"No .flt-translation nodes: {page}")
        if not any(any("\u4e00" <= ch <= "\u9fff" for ch in text) for text in page["translations"]):
            raise AssertionError(f"No Chinese output: {page}")
        print("MT_PRODUCT_RUNTIME_E2E=PASS")
    finally:
        (ARTIFACTS/"mt-product-runtime-result.json").write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf-8")
        driver.quit(); server.shutdown(); server.server_close()

if __name__=="__main__": main()
