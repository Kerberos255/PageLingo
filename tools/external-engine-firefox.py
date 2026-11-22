#!/usr/bin/env python3
"""Installed-extension HTTP regressions; optional fresh API via a key-free relay.

The relay writes pending-upstream.json and waits for upstream-response.json.
Neither file may contain credentials. A separate operator resolves credentials
at the upstream host. Local fixture responses never count as model inference.
"""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
import uuid
import zipfile

from mt_public_firefox import public_firefox

ROOT = Path(__file__).resolve().parents[1]
ADDON_ID = "pagelingo@kerberos255"
SIMPLE = '<p>Read the <a href="https://example.org/guide" onclick="return false;"><strong>API guide</strong></a> and run <code>npm test</code> before continuing.</p>'


def write_json(path, data):
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    temp.replace(path)


def translated(html):
    for source, target in [("Read the ", "请阅读 "), ("API guide", "API指南"),
                           (" and run ", "，运行 "), (" before continuing.", "后再继续。")]:
        html = html.replace(source, target)
    return html


SNAPSHOT = """
const root=document.querySelector(arguments[0]),walk=n=>[n,...[...n.childNodes].flatMap(walk)];
const attrs=n=>n.nodeType===1?[...n.attributes].map(a=>[a.name,a.value]):[];
const nodes=walk(root),children=nodes.map(n=>[...n.childNodes]),attributes=nodes.map(attrs);
const texts=nodes.map(n=>n.nodeType===3?n.data:null),handlers=nodes.map(n=>n.onclick);
const atoms=[...root.querySelectorAll('code,kbd,samp,var,svg,math')],atomHtml=atoms.map(n=>n.outerHTML);
const links=[...root.querySelectorAll('a')],hrefs=links.map(n=>n.getAttribute('href'));
let events=0;links.forEach(n=>n.addEventListener('pagelingo-e2e-probe',()=>events++));
const ancestors=[];for(let p=root.parentElement;p;p=p.parentElement)ancestors.push(p);
const ancestorChildren=ancestors.map(n=>[...n.childNodes]),ancestorAttrs=ancestors.map(attrs);
const before=root.outerHTML,same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const label=n=>({tag:n.nodeName,id:n.id??null,classes:n.className??null});
window.__e2eSnapshot={check(){
 const current=walk(root);links.forEach(n=>n.dispatchEvent(new Event('pagelingo-e2e-probe')));
 return {text:root.textContent,source_untouched:root.outerHTML===before,
  original_structure_unchanged:nodes.length===current.length&&nodes.every((n,i)=>n===current[i]&&same(attrs(n),attributes[i])&&n.childNodes.length===children[i].length&&[...n.childNodes].every((c,j)=>c===children[i][j])),
  ancestor_structure_unchanged:ancestors.every((n,i)=>same(attrs(n),ancestorAttrs[i])&&n.childNodes.length===ancestorChildren[i].length&&[...n.childNodes].every((c,j)=>c===ancestorChildren[i][j])),
  ancestor_differences:ancestors.flatMap((n,i)=>same(attrs(n),ancestorAttrs[i])&&n.childNodes.length===ancestorChildren[i].length&&[...n.childNodes].every((c,j)=>c===ancestorChildren[i][j])?[]:[{node:label(n),attributes_before:ancestorAttrs[i],attributes_after:attrs(n),children_before:ancestorChildren[i].map(label),children_after:[...n.childNodes].map(label)}]),
  code_unchanged:atoms.every((n,i)=>n.isConnected&&n.outerHTML===atomHtml[i]),
  link_targets_and_handlers_unchanged:links.every((n,i)=>n.isConnected&&n.getAttribute('href')===hrefs[i])&&nodes.every((n,i)=>n.onclick===handlers[i]),
  nonnavigation_listeners_preserved:events===links.length,
  horizontal_overflow:root.clientWidth>0&&root.scrollWidth>root.clientWidth+2,actual_width:innerWidth};
 },restored(){return {restored_exact:root.outerHTML===before,restored_source_text_nodes:nodes.every((n,i)=>texts[i]===null||n.data===texts[i])};}};
return {source_html:before,actual_width:innerWidth};
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--firefox", required=True, type=Path)
    parser.add_argument("--geckodriver", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--live-relay", action="store_true")
    parser.add_argument("--capture", type=Path)
    parser.add_argument("--only", action="append", help="Run only these cases; repeat to select several")
    parser.add_argument("--recorded-upstream", type=Path, help="Replay an actual recorded response; never count this as a fresh API call")
    args = parser.parse_args()
    out = args.output.resolve(); out.mkdir(parents=True, exist_ok=True)
    recorded = json.loads((ROOT / "tests/fixtures/opencode-incomplete-agent-clause.json").read_text())
    state = {"mode": "", "calls": [], "fresh_count": 0}
    token = uuid.uuid4().hex
    live_case = None
    if args.live_relay or args.recorded_upstream:
        if not args.capture:
            parser.error("--live-relay requires a frozen public-page --capture")
        capture = json.loads(args.capture.read_text())
        live_case = next(c for c in capture["cases"] if c["id"] == "shadow-dom-v17-1")
        if (out / "upstream-response.json").exists():
            raise RuntimeError("Use a fresh output directory; never reuse an upstream response")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, status, body, content_type="application/json"):
            payload = body.encode() if isinstance(body, str) else json.dumps(body, ensure_ascii=False).encode()
            try:
                self.send_response(status); self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(payload))); self.end_headers(); self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                pass  # The real browser deadline deliberately aborts the timeout case.

        def do_GET(self):
            if not self.path.startswith("/case/"):
                self.reply(404, {}); return
            mode = self.path.split("/case/", 1)[1]
            html = recorded["original_html"] if mode.startswith("incomplete") else SIMPLE
            if mode == "partial":
                html += recorded["original_html"]
            if mode == "fresh-go":
                html = live_case["html"]
            page = '<!doctype html><html lang="en"><meta charset="utf-8"><title>External engine regression</title><style>body{font:16px sans-serif;padding:16px}main{max-width:800px}p{line-height:1.6}</style><main id="e2e-root">' + html + "</main></html>"
            self.reply(200, page, "text/html; charset=utf-8")

        def do_POST(self):
            started = time.perf_counter(); mode = state["mode"]
            raw = self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode()
            body = json.loads(raw)
            html = body["messages"][1]["content"] if "messages" in body else body[0]["Text"] if isinstance(body, list) else body.get("q")
            if "contents" in body:
                html = body["contents"][0]["parts"][0]["text"].split("\n\nHTML:\n", 1)[1]
            auth = self.headers.get("Authorization") == "Bearer " + token
            if mode == "microsoft": auth = self.headers.get("Ocp-Apim-Subscription-Key") == token
            if mode in ("google", "gemini-truncated"): auth = self.headers.get("x-goog-api-key") == token
            call = {"mode": mode, "path": urlsplit(self.path).path, "authentication_matches_surrogate": auth,
                    "request_body": raw, "request_body_sha256": hashlib.sha256(raw.encode()).hexdigest()}
            state["calls"].append(call)
            assert auth, "Extension did not send its configured surrogate credential"
            if mode == "fresh-go":
                if html != live_case["fixed_html"]:
                    call["evaluation_scope_refusal"] = True
                    self.reply(422, {"error": {"message": "Outside the selected evaluation paragraph; no upstream call was made"}})
                    return
                state["fresh_count"] += 1
                assert state["fresh_count"] == 1, "Never retry the fresh upstream generation"
                assert html == live_case["fixed_html"], "Frozen public source changed"
                job = {"provider": "opencode-go", "model": "longcat-2.5-free", "source_url": live_case["context_url"],
                       "url": "https://opencode.ai/inference/go/openai/v1/chat/completions", "method": "POST",
                       "body": raw, "request_body_sha256": call["request_body_sha256"],
                       "session": self.headers.get("x-opencode-session")}
                assert job["session"] == "pagelingo"
                write_json(out / "pending-upstream.json", job)
                if args.recorded_upstream:
                    recorded_remote = json.loads(args.recorded_upstream.read_text())
                    assert recorded_remote["request_body_sha256"] == call["request_body_sha256"]
                    recorded_remote["recorded_response_replay"] = True
                    write_json(out / "upstream-response.json", recorded_remote)
                while not (out / "upstream-response.json").exists() and time.perf_counter() - started < 115:
                    time.sleep(.1)
                if (out / "upstream-response.json").exists():
                    remote = json.loads((out / "upstream-response.json").read_text())
                    state["fresh_remote"] = remote
                    assert remote["request_body_sha256"] == call["request_body_sha256"]
                    self.reply(remote.get("http_status") or 502, remote.get("response_body") or {"error": {"message": remote.get("error", "Upstream failed")}})
                    call["upstream_status"] = remote.get("http_status")
                else:
                    self.reply(504, {"error": {"message": "Upstream relay did not finish within its deadline"}})
                call["wall_s"] = time.perf_counter() - started; return
            if mode == "slow-success": time.sleep(31)
            if mode == "timeout": time.sleep(125)
            if mode == "http-error": self.reply(503, {"error": {"message": "Controlled service unavailable"}}); return
            incomplete = mode.startswith("incomplete") or mode == "partial" and "PEP 249" in html
            if incomplete:
                assert html == recorded["source_html"], "Recorded response must match its exact source template"
                payload = recorded["response"]
            elif mode == "microsoft": payload = [{"translations": [{"text": translated(html)}]}]
            elif mode == "google": payload = {"data": {"translations": [{"translatedText": translated(html)}]}}
            elif mode == "gemini-truncated": payload = {"candidates": [{"finishReason": "MAX_TOKENS", "content": {"parts": [{"text": translated(html)}]}}]}
            else: payload = {"choices": [{"finish_reason": "length" if mode.startswith("length") else "stop", "message": {"content": translated(html)}}]}
            call["wall_s"] = time.perf_counter() - started
            self.reply(200, payload)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler); server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:" + str(server.server_address[1])
    package = out / "installed-e2e.xpi"
    with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
        for path in sorted((ROOT / "dist").rglob("*")):
            if not path.is_file(): continue
            name = path.relative_to(ROOT / "dist").as_posix()
            if name == "manifest.json":
                manifest = json.loads(path.read_text()); perms = manifest["browser_specific_settings"]["gecko"]["data_collection_permissions"]
                perms["required"] = ["websiteContent", "authenticationInfo"]; perms["optional"] = []
                archive.writestr(name, json.dumps(manifest))
            else: archive.write(path, name)
    result = {"protocol": "installed-external-http-v19", "started_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "real_user_key_in_browser": False, "fixture_credentials_only": True,
              "test_manifest_required_data_permissions": ["websiteContent", "authenticationInfo"],
              "fixture_responses_are_model_inference": False, "rows": [], "calls": state["calls"]}
    save = lambda: write_json(out / "result.json", result)
    cases = [("slow-success", 1440, "openai-compatible", 1), ("length", 1440, "openai-compatible", 0),
             ("incomplete", 1440, "openai-compatible", 0), ("gemini-truncated", 1440, "gemini", 0),
             ("partial", 1440, "openai-compatible", 1), ("http-error", 1440, "openai-compatible", 0),
             ("timeout", 1440, "openai-compatible", 0), ("normal-narrow", 500, "openai-compatible", 1),
             ("length-narrow", 500, "openai-compatible", 0), ("incomplete-narrow", 500, "openai-compatible", 0),
             ("microsoft", 500, "microsoft", 1), ("google", 500, "google", 1)]
    if args.live_relay or args.recorded_upstream: cases.append(("fresh-go", 500, "opencode-go", None))
    if args.only: cases = [c for c in cases if c[0] in args.only]
    try:
        with public_firefox(args.firefox, args.geckodriver, out / "geckodriver.log", system_access=True) as driver:
            result["browser_version"] = driver.capabilities["browserVersion"]
            result["accept_insecure_certs"] = driver.capabilities["acceptInsecureCerts"]
            driver.install_addon(str(package), temporary=True)
            with driver.context(driver.CONTEXT_CHROME):
                mapping = json.loads(driver.execute_script("return Services.prefs.getStringPref('extensions.webextensions.uuids');"))
            driver.get("moz-extension://" + mapping[ADDON_ID] + "/settings.html"); extension = driver.current_window_handle
            driver.switch_to.new_window("tab"); page = driver.current_window_handle
            for mode, width, engine_type, expected_count in cases:
                print(json.dumps({"starting": mode, "width": width}), flush=True)
                state["mode"] = mode; driver.set_window_size(width, 1000)
                driver.switch_to.window(extension)
                model = "longcat-2.5-free" if mode == "fresh-go" else "fixture-model"
                config = {"id": "installed-e2e", "name": "Installed E2E", "type": engine_type, "enabled": True,
                          "baseUrl": base + "/v1", "apiKey": token, "model": model, "region": "", "prompt": "", "headersJson": "", "bodyJson": "", "responsePath": ""}
                settings = {"displayMode": "translation", "targetLanguage": "zh-Hans", "autoTranslateEnabled": False,
                            "builtinGlossaryEnabled": False, "glossaryCollections": [], "neverTranslateSites": [],
                            "alwaysTranslateSites": [], "neverTranslateLanguages": [], "alwaysTranslateLanguages": [],
                            "activeTranslationEngineId": config["id"], "translationEngines": [config]}
                driver.execute_async_script("const done=arguments[arguments.length-1];browser.storage.local.set(arguments[0]).then(()=>done(true));", settings)
                page_url = live_case["context_url"] if mode == "fresh-go" else base + "/case/" + mode
                selector = live_case["locator"] if mode == "fresh-go" else "#e2e-root"
                driver.switch_to.window(page); driver.get(page_url)
                readiness = None
                if mode == "fresh-go":
                    # MDN replaces server-rendered div.code-example siblings with
                    # mdn-code-example custom elements during its own hydration.
                    # Wait before taking the immutable ancestor baseline.
                    requests_before = len(state["calls"])
                    initial_divs = driver.execute_script("return document.querySelectorAll('div.code-example').length;")
                    ready_start = time.perf_counter()
                    while not driver.execute_script("return document.readyState==='complete'&&!!document.querySelector('mdn-code-example');"):
                        if time.perf_counter() - ready_start > 20: raise TimeoutError("MDN custom-element hydration")
                        time.sleep(.1)
                    readiness = {"wait_s": time.perf_counter()-ready_start, "initial_code_example_divs": initial_divs,
                                 "hydrated_code_examples": driver.execute_script("return document.querySelectorAll('mdn-code-example').length;"),
                                 "no_translation_requests_during_readiness": requests_before == len(state["calls"])}
                    actual_source = driver.execute_script("return document.querySelector(arguments[0])?.outerHTML;", selector)
                    if actual_source != live_case["html"]:
                        result["rows"].append({"mode": mode, "status": "blocked_source_changed", "fresh_upstream_request": False}); save(); continue
                snapshot = driver.execute_script(SNAPSHOT, selector)
                driver.switch_to.window(extension)
                for attempt in range(50):
                    ready = driver.execute_async_script("const done=arguments[arguments.length-1];browser.tabs.query({}).then(t=>browser.tabs.sendMessage(t.find(x=>x.url===arguments[0]).id,{type:'ping'})).then(done,()=>done(null));", page_url)
                    if ready and ready.get("ok"): break
                    time.sleep(.1)
                else: raise RuntimeError("Installed content script did not become ready")
                start = time.perf_counter(); keepalive = []; session_checked = False
                driver.execute_script("window.__e2eResult=null;browser.tabs.query({}).then(t=>browser.tabs.sendMessage(t.find(x=>x.url===arguments[0]).id,{type:'translate-page',sourceLanguage:'en',targetLanguage:'zh-Hans'})).then(x=>window.__e2eResult=x,e=>window.__e2eResult={ok:false,error:String(e)});", page_url)
                while True:
                    response = driver.execute_script("return window.__e2eResult;")
                    if response is not None: break
                    if time.perf_counter() - start > 12 and not session_checked:
                        keepalive = driver.execute_async_script("const done=arguments[arguments.length-1];browser.storage.session.get(null).then(v=>done(Object.entries(v).filter(([k])=>k.startsWith('pagelingo:keepalive:')).map(([,v])=>v))); ")
                        session_checked = True
                    if time.perf_counter() - start > 140: raise TimeoutError(mode)
                    time.sleep(.2)
                elapsed = time.perf_counter() - start
                driver.switch_to.window(page); checks = driver.execute_script("return window.__e2eSnapshot.check();")
                displayed = response.get("ok") and response.get("count", 0) > 0
                screenshot = None
                screenshot_target_visible = None
                if displayed:
                    driver.execute_script("document.querySelector(arguments[0]).scrollIntoView({block:'center',behavior:'instant'});", selector)
                    driver.execute_async_script("const done=arguments[arguments.length-1];requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)));")
                    screenshot_target_visible = driver.execute_script("const r=document.querySelector(arguments[0]).getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;", selector)
                    screenshot = mode + ".png"; driver.save_screenshot(str(out / screenshot))
                    driver.find_element("css selector", selector).screenshot(str(out / (mode + "-target.png")))
                driver.switch_to.window(extension)
                driver.execute_async_script("const done=arguments[arguments.length-1];browser.tabs.query({}).then(t=>browser.tabs.sendMessage(t.find(x=>x.url===arguments[0]).id,{type:'restore-page'})).then(done);", page_url)
                remaining = driver.execute_async_script("const done=arguments[arguments.length-1];browser.storage.session.get(null).then(v=>done(Object.keys(v).filter(k=>k.startsWith('pagelingo:keepalive:'))));")
                driver.switch_to.window(page); checks.update(driver.execute_script("return window.__e2eSnapshot.restored();"))
                row = {"mode": mode, "engine_type": engine_type, "width_requested": width, "wall_s": elapsed,
                       "response": response, "checks": checks, "keepalive_pulses_at_12s": keepalive,
                       "keepalive_cleaned_up": not remaining, "screenshot": screenshot,
                       "screenshot_target_visible": screenshot_target_visible,
                       "source_url": page_url, "fresh_upstream_request": mode == "fresh-go" and "fresh_remote" in state and not args.recorded_upstream,
                       "recorded_response_replay": bool(mode == "fresh-go" and args.recorded_upstream), "site_readiness": readiness}
                result["rows"].append(row); save(); print(json.dumps({"mode": mode, "response": response, "wall_s": elapsed}), flush=True)
                assert snapshot["actual_width"] == width == checks["actual_width"]
                for key in ["original_structure_unchanged", "ancestor_structure_unchanged", "code_unchanged", "link_targets_and_handlers_unchanged", "nonnavigation_listeners_preserved", "restored_exact", "restored_source_text_nodes"]:
                    assert checks[key], (mode, key)
                assert not checks["horizontal_overflow"] and not remaining
                if displayed: assert screenshot_target_visible
                if expected_count is not None:
                    assert bool(displayed) == (expected_count > 0), (mode, response)
                    if expected_count: assert response["count"] == expected_count
                    else: assert response.get("ok") is False and checks["source_untouched"]
                if mode == "partial": assert response["failedCount"] == 1
                if mode.startswith("length") or mode == "gemini-truncated": assert "未完整结束" in response.get("error", "")
                if mode.startswith("incomplete"): assert "句子可能不完整" in response.get("error", "")
                if mode == "http-error": assert "HTTP 503" in response.get("error", "")
                if mode == "slow-success": assert elapsed >= 31 and keepalive
                if mode == "timeout": assert 119 <= elapsed < 140 and "超时" in response.get("error", "") and keepalive
            driver.switch_to.window(extension)
            result["surrogate_key_cleared"] = driver.execute_async_script("const done=arguments[arguments.length-1];browser.storage.local.set({translationEngines:[],activeTranslationEngineId:'firefox-local'}).then(()=>browser.storage.local.get('translationEngines')).then(v=>done(v.translationEngines.length===0));")
            result["finished_utc"] = datetime.datetime.now(datetime.timezone.utc).isoformat(); result["completed"] = True; save()
    finally:
        server.shutdown(); server.server_close(); save()


if __name__ == "__main__":
    main()
