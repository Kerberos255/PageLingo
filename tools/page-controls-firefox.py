#!/usr/bin/env python3
"""Real popup code, iframe isolation, image-enabled layout and optional WASM cache A/B.

No real API key is used. Optional public-page responses are recorded actual
provider outputs; replay does not count as fresh inference. --cache-cases
loads the public English-to-Chinese model and runs real Firefox WASM inference.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import zipfile

from mt_public_firefox import public_firefox

ROOT = Path(__file__).resolve().parents[1]
ADDON_ID = "pagelingo@kerberos255"
helper_spec = importlib.util.spec_from_file_location("external_firefox_helpers", ROOT/"tools/external-engine-firefox.py")
assert helper_spec and helper_spec.loader
helpers = importlib.util.module_from_spec(helper_spec); helper_spec.loader.exec_module(helpers)
SNAPSHOT, write_json = helpers.SNAPSHOT, helpers.write_json


def package(output, legacy_cache=False):
    path = output / "page-controls.xpi"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
        for source in sorted((ROOT / "dist").rglob("*")):
            if not source.is_file(): continue
            name = source.relative_to(ROOT / "dist").as_posix()
            if name == "manifest.json":
                manifest = json.loads(source.read_text())
                permissions = manifest["browser_specific_settings"]["gecko"]["data_collection_permissions"]
                permissions["required"] = ["websiteContent", "authenticationInfo"]; permissions["optional"] = []
                archive.writestr(name, json.dumps(manifest))
            elif name == "background.js" and legacy_cache:
                text = source.read_text(); needle = "maxInputCharacters = 4096"
                assert text.count(needle) == 1
                archive.writestr(name, text.replace(needle, "maxInputCharacters = 512"))
            else: archive.write(source, name)
    return path


def async_value(driver, script, *args):
    value = driver.execute_async_script("const done=arguments[arguments.length-1];Promise.resolve().then(async()=>{" + script + "}).then(v=>done({ok:true,value:v}),e=>done({ok:false,error:String(e)}));", *args)
    if not value["ok"]: raise RuntimeError(value["error"])
    return value["value"]


def activate_page(driver, popup, url):
    driver.switch_to.window(popup)
    return async_value(driver, "const tab=(await browser.tabs.query({})).find(t=>t.url===arguments[0]);if(!tab)throw Error('Source tab missing');await browser.tabs.update(tab.id,{active:true});return tab.id;", url)


def click_popup(driver, button, deadline=180):
    driver.execute_script("document.getElementById(arguments[0]).click();", button)
    start = time.perf_counter(); last_progress = 0
    while True:
        text = driver.execute_script("return document.getElementById('status').textContent;")
        if text not in ["正在翻译…", "恢复中…"]: return text, time.perf_counter()-start
        if time.perf_counter()-start > deadline: raise TimeoutError(button)
        if time.perf_counter()-start > last_progress+15:
            last_progress = time.perf_counter()-start; print(json.dumps({"waiting":button,"elapsed_s":last_progress}),flush=True)
        time.sleep(.1)


def visual_atoms(driver):
    return driver.execute_script("""
return [...document.querySelectorAll('header svg,header img,.minimal-header-logo')].map(e=>{
 const r=e.getBoundingClientRect(),s=getComputedStyle(e);
 return {tag:e.tagName,classes:e.getAttribute('class'),box:{x:r.x,y:r.y,width:r.width,height:r.height},
   display:s.display,visibility:s.visibility,opacity:s.opacity,fill:s.fill,color:s.color,
   loaded:e.tagName==='IMG'?e.complete&&e.naturalWidth>0:null};});
""")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--firefox", required=True, type=Path)
    parser.add_argument("--geckodriver", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--capture", type=Path)
    parser.add_argument("--responses", type=Path)
    parser.add_argument("--cache-cases", type=Path)
    parser.add_argument("--legacy-cache", action="store_true")
    parser.add_argument("--whole-pages", action="store_true")
    parser.add_argument("--skip-page-cases", action="store_true", help="Run only the cache benchmark and optional whole-page checks")
    args = parser.parse_args(); out = args.output.resolve(); out.mkdir(parents=True, exist_ok=True)
    if args.whole_pages and not args.cache_cases: parser.error("--whole-pages requires --cache-cases to load the public local model")
    capture = json.loads(args.capture.read_text()) if args.capture else None
    responses = json.loads(args.responses.read_text()) if args.responses else None
    if bool(capture) != bool(responses): parser.error("--capture and --responses must be supplied together")
    recorded = {r["source_html"]: r for r in responses["rows"] if r["status"]=="validated_actual_provider_response"} if responses else {}
    state = {"calls": [], "mode": "fixture"}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def reply(self, code, payload, content_type="application/json"):
            data = payload.encode() if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(code); self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
        def do_GET(self):
            if self.path.startswith("/child"):
                self.reply(200, '<html lang="zh-CN"><p>子框架已经就绪，不应决定主文档的翻译状态。</p></html>', "text/html; charset=utf-8"); return
            base = "http://127.0.0.1:"+str(self.server.server_address[1])
            other = "http://localhost:"+str(self.server.server_address[1])
            html = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Page control iframe regression</title><style>body{font:16px sans-serif;margin:20px}p{line-height:1.6}iframe{display:block;width:90%;height:100px;margin-top:20px}</style><main id="e2e-root"><p>Read the <a href="/guide" onclick="return false;">guide</a> and run <code>npm test</code> before continuing.</p><iframe src="'+base+'/child"></iframe><iframe src="'+other+'/child"></iframe></main></html>'
            self.reply(200, html, "text/html; charset=utf-8")
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode(); html = json.loads(body)["messages"][1]["content"]
            call = {"mode": state["mode"], "body_sha256": hashlib.sha256(body.encode()).hexdigest(), "source_html": html}
            state["calls"].append(call)
            if state["mode"] == "recorded":
                r = recorded.get(html)
                if r is None: call["scope_refusal"] = True; self.reply(422, {"error": {"message": "Outside selected public evaluation source"}}); return
                self.reply(200, {"choices": [{"finish_reason": r["finish_reason"], "message": {"content": r["raw_model_html"]}}]}); return
            translated = html.replace("Read the ", "请阅读 ").replace("guide", "指南").replace(" and run ", "，运行 ").replace(" before continuing.", "后再继续。")
            self.reply(200, {"choices": [{"finish_reason": "stop", "message": {"content": translated}}]})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler); server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start(); base = "http://127.0.0.1:"+str(server.server_address[1])
    xpi = package(out, args.legacy_cache)
    result = {"protocol": "page-controls-layout-cache-v21", "rows": [], "calls": state["calls"], "real_user_keys_used": False,
              "recorded_responses_are_new_inference": False, "legacy_cache_input_limit": args.legacy_cache,
              "xpi_sha256": hashlib.sha256(xpi.read_bytes()).hexdigest()}
    save = lambda: write_json(out/"result.json", result)
    try:
        with public_firefox(args.firefox, args.geckodriver, out/"geckodriver.log", system_access=True, load_images=True) as driver:
            result["browser_version"] = driver.capabilities["browserVersion"]; result["accept_insecure_certs"] = driver.capabilities["acceptInsecureCerts"]
            assert driver.install_addon(str(xpi), temporary=True) == ADDON_ID
            with driver.context(driver.CONTEXT_CHROME): mapping = json.loads(driver.execute_script("return Services.prefs.getStringPref('extensions.webextensions.uuids');"))
            extension_url = "moz-extension://"+mapping[ADDON_ID]
            driver.get(extension_url+"/settings.html"); extension = driver.current_window_handle
            settings = {"displayMode": "translation", "targetLanguage": "zh-Hans", "autoTranslateEnabled": False,
                        "builtinGlossaryEnabled": False, "glossaryCollections": [], "neverTranslateSites": [], "alwaysTranslateSites": [],
                        "neverTranslateLanguages": [], "alwaysTranslateLanguages": [], "modelUpdatePolicy": "manual",
                        "activeTranslationEngineId": "popup-fixture", "translationEngines": [{"id": "popup-fixture", "name": "Popup fixture", "type": "openai-compatible", "enabled": True,
                        "baseUrl": base+"/v1", "apiKey": "local-fixture-key", "model": "recorded-model", "region": "", "prompt": "", "headersJson": "", "bodyJson": "", "responsePath": ""}]}
            async_value(driver, "await browser.storage.local.set(arguments[0]);return true;", settings)
            driver.switch_to.new_window("tab"); page = driver.current_window_handle
            if not args.legacy_cache and not args.skip_page_cases:
                cases = [("iframe-main", base+"/main", "#e2e-root", 500, None), ("iframe-main-wide", base+"/main", "#e2e-root", 1440, None)]
                if capture:
                    for c in capture["cases"]:
                        if c["id"] in ["sqlite-v17-1", "shadow-dom-v17-1", "w3c-accordion-v17-2"]:
                            for width in [500,1440]: cases.append((c["id"], c["context_url"], c["locator"], width, c))
                for index,(name,url,selector,width,source) in enumerate(cases):
                    state["mode"] = "recorded" if source else "fixture"; print(json.dumps({"starting":name,"width":width}),flush=True)
                    driver.switch_to.window(page); driver.set_window_size(width, 1000); driver.get(url)
                    start = time.perf_counter()
                    while not driver.execute_script("return document.readyState==='complete';"):
                        if time.perf_counter()-start>25: raise TimeoutError("document ready")
                        time.sleep(.1)
                    if "developer.mozilla.org" in url:
                        while not driver.execute_script("return !!document.querySelector('mdn-code-example');"):
                            if time.perf_counter()-start>25: raise TimeoutError("MDN hydration")
                            time.sleep(.1)
                    if source: assert driver.execute_script("return document.querySelector(arguments[0])?.outerHTML;",selector)==source["html"]
                    driver.execute_script("document.querySelector(arguments[0]).scrollIntoView({block:'center',behavior:'instant'});",selector)
                    time.sleep(.6)
                    before_meta = driver.execute_script("const e=document.querySelector(arguments[0]),r=e.getBoundingClientRect(),s=getComputedStyle(e);return {width:r.width,height:r.height,fontSize:s.fontSize,lineHeight:s.lineHeight,iframes:document.querySelectorAll('iframe').length,images:[...document.images].map(i=>({complete:i.complete,naturalWidth:i.naturalWidth}))};",selector)
                    driver.execute_script(SNAPSHOT,selector); stem=str(index)+"-"+name+"-"+str(width)
                    driver.save_screenshot(str(out/(stem+"-before.png")))
                    driver.switch_to.window(extension); driver.get(extension_url+"/popup.html")
                    activate_page(driver,extension,url)
                    driver.execute_script("document.getElementById('source-language').value='en';document.getElementById('source-language').dispatchEvent(new Event('change'));")
                    start=time.perf_counter()
                    while True:
                        detected=driver.execute_script("return document.getElementById('detected-language').textContent;")
                        if "英语" in detected or "English" in detected: break
                        if time.perf_counter()-start>15: raise TimeoutError("main-document language detection: "+detected)
                        time.sleep(.1)
                    status,wall=click_popup(driver,"translate"); match=re.match(r"已翻译 (\d+) 个段落",status)
                    assert match and int(match.group(1))==1,(name,status)
                    driver.switch_to.window(page); checks=driver.execute_script("return window.__e2eSnapshot.check();")
                    driver.execute_script("document.querySelector(arguments[0]).scrollIntoView({block:'center',behavior:'instant'});",selector)
                    driver.execute_async_script("const done=arguments[arguments.length-1];requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)));")
                    driver.save_screenshot(str(out/(stem+"-after.png"))); driver.find_element("css selector",selector).screenshot(str(out/(stem+"-target.png")))
                    after_meta=driver.execute_script("const r=document.querySelector(arguments[0]).getBoundingClientRect();return {width:r.width,height:r.height,viewport:innerWidth,pageWidth:document.documentElement.scrollWidth};",selector)
                    activate_page(driver,extension,url); restored,_=click_popup(driver,"restore"); assert restored=="已恢复原文"
                    driver.switch_to.window(page); checks.update(driver.execute_script("return window.__e2eSnapshot.restored();"))
                    row={"name":name,"width":width,"status":status,"detected_language":detected,"wall_s":wall,"checks":checks,"before":before_meta,"after":after_meta,"screenshots":stem}
                    result["rows"].append(row);save()
                    for key in ["original_structure_unchanged","ancestor_structure_unchanged","code_unchanged","link_targets_and_handlers_unchanged","nonnavigation_listeners_preserved","restored_exact","restored_source_text_nodes"]: assert checks[key],(name,key)
                    assert not checks["horizontal_overflow"] and after_meta["pageWidth"]<=after_meta["viewport"]
                    if not source: assert before_meta["iframes"]==2 and checks["text"].startswith("请阅读指南，运行 npm test 后再继续。")
            if args.cache_cases:
                driver.switch_to.window(extension);driver.get(extension_url+"/settings.html")
                async_value(driver,"await browser.storage.local.set({activeTranslationEngineId:'firefox-local',translationEngines:[]});return true;")
                driver.execute_script("window.__warmupResult=null;browser.runtime.sendMessage({type:'translate-html',request:{html:'Hello',sourceLanguage:'en',targetLanguage:'zh-Hans'}}).then(v=>window.__warmupResult=v,e=>window.__warmupResult={ok:false,error:String(e)});")
                print(json.dumps({"starting":"public Bergamot English-to-Chinese warmup"}),flush=True); start=time.perf_counter()
                while True:
                    warmup=driver.execute_script("return window.__warmupResult;")
                    if warmup is not None:break
                    if time.perf_counter()-start>180:raise TimeoutError("Bergamot model download/warmup")
                    time.sleep(.25)
                result["warmup"]={"wall_s":time.perf_counter()-start,"response":warmup,"includes_download_and_one_inference":True};save();assert warmup.get("ok"),warmup
                result["model_assets"]=async_value(driver,"const cache=await caches.open('pagelingo-models-v3');return await Promise.all((await cache.keys()).map(async r=>({url:r.url,sha256:(await cache.match(r)).headers.get('x-pagelingo-sha256')})));")
                result["cache_rounds_have_warm_model"]=True
                sources=json.loads(args.cache_cases.read_text())["cases"]
                result["cache_rounds"]=[]
                for round_name in ["cold","repeat"]:
                    async_value(driver,"return await browser.runtime.sendMessage({type:'reset-translation-performance'});")
                    start=time.perf_counter();outputs=[]
                    for c in sources:
                        reply=async_value(driver,"return await browser.runtime.sendMessage({type:'translate-html',request:arguments[0]});",{"html":c["fixed_html"],"sourceLanguage":"en","targetLanguage":"zh-Hans"})
                        assert reply.get("ok"),reply;outputs.append(reply["html"])
                    wall=time.perf_counter()-start;stats=async_value(driver,"return await browser.runtime.sendMessage({type:'get-translation-performance'});")
                    row={"name":round_name,"wall_s":wall,"stats":stats,"outputs":outputs};result["cache_rounds"].append(row);save();print(json.dumps({"round":round_name,"wall_s":wall,"stats":stats}),flush=True)
                assert result["cache_rounds"][0]["outputs"]==result["cache_rounds"][1]["outputs"]
                if args.whole_pages:
                    result["whole_pages"] = []
                    urls = ["https://www.w3.org/WAI/ARIA/apg/patterns/accordion/", "https://docs.python.org/3/library/sqlite3.html"]
                    for site_index,url in enumerate(urls):
                        for width in [500,1440]:
                            print(json.dumps({"starting":"whole-page real Bergamot","url":url,"width":width}),flush=True)
                            driver.switch_to.window(page); driver.set_window_size(width,1000); driver.get(url)
                            start=time.perf_counter()
                            while not driver.execute_script("return document.readyState==='complete';"):
                                if time.perf_counter()-start>25: raise TimeoutError("whole page readiness")
                                time.sleep(.1)
                            driver.execute_script(SNAPSHOT,"body")
                            before_width=driver.execute_script("return document.documentElement.scrollWidth;")
                            atoms_before=visual_atoms(driver)
                            stem="whole-"+str(site_index)+"-"+str(width)
                            driver.save_screenshot(str(out/(stem+"-before.png")))
                            driver.switch_to.window(extension);driver.get(extension_url+"/popup.html");activate_page(driver,extension,url)
                            driver.execute_script("document.getElementById('source-language').value='en';")
                            async_value(driver,"return await browser.runtime.sendMessage({type:'reset-translation-performance'});")
                            status,wall=click_popup(driver,"translate",deadline=300)
                            stats=async_value(driver,"return await browser.runtime.sendMessage({type:'get-translation-performance'});")
                            match=re.match(r"已翻译 (\d+) 个段落",status);assert match and int(match.group(1))>0,status
                            driver.switch_to.window(page)
                            driver.execute_async_script("const done=arguments[arguments.length-1];requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)));")
                            time.sleep(.5)
                            checks=driver.execute_script("return window.__e2eSnapshot.check();");checks["text"]=checks["text"][:2000]
                            atoms_after=visual_atoms(driver)
                            after_width=driver.execute_script("return document.documentElement.scrollWidth;")
                            driver.save_screenshot(str(out/(stem+"-after.png")))
                            for label,selector in [("table","table"),("code","pre")]:
                                if driver.find_elements("css selector",selector):
                                    driver.execute_script("document.querySelector(arguments[0]).scrollIntoView({block:'center',behavior:'instant'});",selector)
                                    driver.execute_async_script("const done=arguments[arguments.length-1];requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)));")
                                    driver.save_screenshot(str(out/(stem+"-"+label+".png")))
                            driver.execute_script("scrollTo({top:0,behavior:'instant'});")
                            activate_page(driver,extension,url);restored,_=click_popup(driver,"restore");assert restored=="已恢复原文"
                            driver.switch_to.window(page);driver.execute_async_script("const done=arguments[arguments.length-1];requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)));")
                            checks.update(driver.execute_script("return window.__e2eSnapshot.restored();"))
                            row={"url":url,"width":width,"status":status,"wall_s":wall,"performance":stats,"checks":checks,"page_width_before":before_width,"page_width_after":after_width,"visual_atoms_before":atoms_before,"visual_atoms_after":atoms_after,"prewarmed_by_cache_benchmark":True,"local_wasm_engine":True}
                            result["whole_pages"].append(row);save();print(json.dumps({"url":url,"width":width,"status":status,"wall_s":wall}),flush=True)
                            for key in ["original_structure_unchanged","ancestor_structure_unchanged","code_unchanged","link_targets_and_handlers_unchanged","nonnavigation_listeners_preserved","restored_exact","restored_source_text_nodes"]:assert checks[key],(url,key)
                            assert after_width<=max(before_width,width)+2,(url,before_width,after_width)
            result["completed"]=True;save()
    finally: server.shutdown();server.server_close();save()


if __name__=="__main__":main()
