#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.ui import WebDriverWait

OPENCLAW_URL = "https://docs.openclaw.ai/start/getting-started"
CLAUDE_URL = "https://claude.ai/new"
ADDON_ID = "pagelingo@local"
ARTIFACTS = Path("artifacts")
ARTIFACTS.mkdir(exist_ok=True)


class TranslationHandler(BaseHTTPRequestHandler):
    request_count = 0

    def log_message(self, format: str, *args: object) -> None:
        pass

    def do_GET(self) -> None:
        if self.path != "/dynamic-ui":
            self.send_response(404)
            self.end_headers()
            return
        html = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Dynamic UI fixture</title>
<style>
body{font:16px system-ui;margin:24px}
nav{display:flex;gap:12px}
#editor{position:relative;border:1px solid #aaa;padding:12px;width:420px}
#editor:empty::before{content:attr(data-placeholder);color:#777}
.tip{position:fixed;left:100px;top:120px;background:#111;color:#fff;padding:8px;border-radius:6px}
.pulse{outline:0}
</style>
</head>
<body>
<nav><a href="#start">GET STARTED</a><a href="#overview">Overview</a></nav>
<div id="editor" contenteditable="true" data-placeholder="How can I help you today?"></div>
<button id="hover">Cowork</button>
<script>
const button=document.getElementById('hover');
button.addEventListener('pointerenter',()=>{
  setTimeout(()=>{
    if(document.getElementById('tip'))return;
    const tip=document.createElement('div');
    tip.id='tip'; tip.className='tip'; tip.textContent='Upgrade to use Cowork for long-running tasks';
    document.body.append(tip);
  },80);
});
let n=0;
const churn=setInterval(()=>{
  document.body.classList.toggle('pulse');
  button.classList.toggle('pulse');
  n++;
  if(n>=10000){clearInterval(churn);window.__churnDone=true;}
},0);
</script>
</body>
</html>"""
        payload = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self) -> None:
        type(self).request_count += 1
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        translated = str(body.get("html", ""))
        replacements = [
            ("Upgrade to use Cowork for long-running tasks", "升级后可使用 Cowork 处理长时间任务"),
            ("How can I help you today?", "今天我能为你做什么？"),
            ("Getting started", "开始使用"),
            ("GET STARTED", "开始"),
            ("Get started", "开始"),
            ("First steps", "第一步"),
            ("Overview", "概述"),
            ("Search documentation", "搜索文档"),
            ("What you need", "你需要什么"),
            ("Quick setup", "快速设置"),
        ]
        for source, target in replacements:
            translated = translated.replace(source, target)
        payload = json.dumps({"translated": translated}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def start_server() -> tuple[ThreadingHTTPServer, str, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), TranslationHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    return server, f"{base}/translate", f"{base}/dynamic-ui"


def extension_uuid(driver: webdriver.Firefox, addon_id: str) -> str:
    with driver.context(driver.CONTEXT_CHROME):
        raw = driver.execute_script(
            """
            const prefs = Components.classes['@mozilla.org/preferences-service;1']
              .getService(Components.interfaces.nsIPrefBranch);
            return prefs.getStringPref('extensions.webextensions.uuids');
            """
        )
    mapping = json.loads(raw)
    if addon_id not in mapping:
        raise AssertionError(f"Extension UUID not found for {addon_id}: {mapping}")
    return mapping[addon_id]


def configure_extension(driver: webdriver.Firefox, extension_handle: str, translation_url: str) -> None:
    driver.switch_to.window(extension_handle)
    result = driver.execute_async_script(
        """
        const baseUrl = arguments[0];
        const done = arguments[arguments.length - 1];
        browser.storage.local.set({
          displayMode: 'translation',
          targetLanguage: 'zh-Hans',
          autoTranslateEnabled: false,
          neverTranslateSites: [],
          alwaysTranslateSites: [],
          neverTranslateLanguages: [],
          alwaysTranslateLanguages: [],
          activeTranslationEngineId: 'live-ui-rest',
          translationEngines: [{
            id: 'live-ui-rest',
            name: 'Live UI E2E REST',
            type: 'custom-rest',
            enabled: true,
            baseUrl,
            apiKey: '',
            model: '',
            region: '',
            prompt: '',
            headersJson: '{}',
            bodyJson: '{"html":"{{html}}"}',
            responsePath: 'translated'
          }]
        }).then(() => done({ok:true}))
          .catch((error) => done({ok:false,error:String(error)}));
        """,
        translation_url,
    )
    if not result.get("ok"):
        raise AssertionError(f"Could not configure extension: {result}")


def translate_tab(driver: webdriver.Firefox, extension_handle: str, url_prefix: str, timeout: int = 60) -> dict:
    driver.switch_to.window(extension_handle)
    driver.set_script_timeout(timeout)
    started = time.monotonic()
    result = driver.execute_async_script(
        """
        const prefix = arguments[0];
        const done = arguments[arguments.length - 1];
        browser.tabs.query({}).then((tabs) => {
          const candidates = tabs.filter((item) => item.url && item.url.startsWith(prefix));
          const tab = candidates[candidates.length - 1];
          if (!tab || tab.id === undefined) throw new Error('Target tab not found: ' + prefix);
          return browser.tabs.sendMessage(tab.id, {
            type: 'translate-page',
            sourceLanguage: 'en',
            targetLanguage: 'zh-Hans'
          });
        }).then((value) => done({ok:true,value}))
          .catch((error) => done({ok:false,error:String(error)}));
        """,
        url_prefix,
    )
    elapsed = time.monotonic() - started
    result["elapsed"] = elapsed
    return result


def page_responsive(driver: webdriver.Firefox) -> bool:
    started = time.monotonic()
    for _ in range(12):
        value = driver.execute_script(
            "return {ready:document.readyState, now:performance.now(), nodes:document.getElementsByTagName('*').length};"
        )
        if not value or not value.get("ready"):
            return False
        time.sleep(0.04)
    return (time.monotonic() - started) < 5


def visible_text_snapshot(driver: webdriver.Firefox, needle: str) -> list[dict]:
    return driver.execute_script(
        """
        const needle = arguments[0];
        return Array.from(document.querySelectorAll('body *'))
          .filter((el) => {
            const text=(el.innerText || el.textContent || '').replace(/\s+/g,' ').trim();
            if (!text || !text.includes(needle)) return false;
            const s=getComputedStyle(el); const r=el.getBoundingClientRect();
            return s.display!=='none' && s.visibility!=='hidden' && r.width>0 && r.height>0;
          })
          .slice(0,20)
          .map((el) => {
            const s=getComputedStyle(el); const r=el.getBoundingClientRect();
            return {
              tag:el.tagName,
              text:(el.innerText || el.textContent || '').replace(/\s+/g,' ').trim().slice(0,180),
              width:r.width,
              minInlineSize:s.minInlineSize,
              display:s.display,
              generated:el.matches('[data-flt-generated="translation"]') || Boolean(el.querySelector('[data-flt-generated="translation"]'))
            };
          });
        """,
        needle,
    )


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: live_ui_regression.py <xpi>")
    xpi = Path(sys.argv[1]).resolve()
    if not xpi.is_file():
        raise SystemExit(f"XPI not found: {xpi}")

    server, translation_url, fixture_url = start_server()
    options = Options()
    options.add_argument("-headless")
    firefox_binary = os.environ.get("FIREFOX_BINARY")
    if firefox_binary:
        options.binary_location = firefox_binary
    driver = webdriver.Firefox(options=options, service=Service(service_args=["--allow-system-access"]))
    driver.set_page_load_timeout(90)
    driver.set_script_timeout(90)

    try:
        addon_id = driver.install_addon(str(xpi), temporary=True)
        if addon_id != ADDON_ID:
            raise AssertionError(f"Unexpected add-on id: {addon_id}")

        uuid = extension_uuid(driver, addon_id)
        driver.switch_to.new_window("tab")
        extension_handle = driver.current_window_handle
        driver.get(f"moz-extension://{uuid}/settings.html")
        WebDriverWait(driver, 30).until(lambda d: d.execute_script("return typeof browser !== 'undefined'"))
        configure_extension(driver, extension_handle, translation_url)

        # 1) Deterministic high-mutation fixture: this catches observer feedback loops.
        driver.switch_to.new_window("tab")
        fixture_handle = driver.current_window_handle
        driver.get(fixture_url)
        WebDriverWait(driver, 20).until(lambda d: d.execute_script("return document.readyState") == "complete")
        WebDriverWait(driver, 20).until(lambda d: d.execute_script("return window.__churnDone === true"))
        before_requests = TranslationHandler.request_count
        result = translate_tab(driver, extension_handle, fixture_url, timeout=30)
        if not result.get("ok") or (result.get("value") or {}).get("ok") is not True:
            raise AssertionError(f"Fixture translation failed: {result}")
        driver.switch_to.window(fixture_handle)
        if not page_responsive(driver):
            raise AssertionError("Dynamic fixture became unresponsive after translation")
        time.sleep(1)
        request_delta = TranslationHandler.request_count - before_requests
        if request_delta > 200:
            raise AssertionError(f"Dynamic fixture caused translation request storm: {request_delta}")
        driver.save_screenshot(str(ARTIFACTS / "dynamic-ui-after.png"))
        print("Dynamic UI fixture:", {"requests": request_delta, "elapsed": result["elapsed"]})

        # 2) Real OpenClaw docs: screenshot and ensure temporary width guard is released.
        driver.switch_to.new_window("tab")
        openclaw_handle = driver.current_window_handle
        driver.get(OPENCLAW_URL)
        WebDriverWait(driver, 60).until(lambda d: d.execute_script("return document.readyState") == "complete")
        driver.save_screenshot(str(ARTIFACTS / "openclaw-before.png"))
        result = translate_tab(driver, extension_handle, "https://docs.openclaw.ai/", timeout=60)
        if not result.get("ok") or (result.get("value") or {}).get("ok") is not True:
            raise AssertionError(f"OpenClaw translation failed: {result}")
        driver.switch_to.window(openclaw_handle)
        time.sleep(1.0)
        leaked_guards = driver.execute_script(
            """
            return Array.from(document.querySelectorAll("nav *,[role='navigation'] *"))
              .filter((el) => el instanceof HTMLElement && el.style.getPropertyValue('min-inline-size'))
              .map((el) => ({
                tag:el.tagName,
                text:(el.textContent||'').replace(/\s+/g,' ').trim().slice(0,100),
                minInlineSize:el.style.getPropertyValue('min-inline-size')
              }));
            """
        )
        if leaked_guards:
            raise AssertionError(f"Navigation width guard leaked after translation: {leaked_guards[:10]}")
        start_nodes = visible_text_snapshot(driver, "开始")
        if not start_nodes:
            raise AssertionError("OpenClaw screenshot contained no visible translated '开始' label")
        driver.save_screenshot(str(ARTIFACTS / "openclaw-after.png"))
        print("OpenClaw translated label:", start_nodes[:4])

        # 3) Real Claude smoke: anonymous CI may be redirected, but translation must never hang the tab.
        driver.switch_to.new_window("tab")
        claude_handle = driver.current_window_handle
        driver.get(CLAUDE_URL)
        WebDriverWait(driver, 60).until(lambda d: d.execute_script("return document.readyState") in ("interactive", "complete"))
        current_url = driver.current_url
        driver.save_screenshot(str(ARTIFACTS / "claude-before.png"))
        before_requests = TranslationHandler.request_count
        result = translate_tab(driver, extension_handle, "https://claude.ai/", timeout=45)
        if not result.get("ok"):
            raise AssertionError(f"Claude tab messaging failed: {result}")
        value = result.get("value") or {}
        if value.get("ok") is not True:
            raise AssertionError(f"Claude translation returned failure: {value}")
        if result["elapsed"] > 40:
            raise AssertionError(f"Claude translation took too long: {result['elapsed']:.2f}s")
        driver.switch_to.window(claude_handle)
        if not page_responsive(driver):
            raise AssertionError("Claude page became unresponsive after translation")
        time.sleep(2)
        request_delta = TranslationHandler.request_count - before_requests
        if request_delta > 800:
            raise AssertionError(f"Claude caused translation request storm: {request_delta}")
        driver.save_screenshot(str(ARTIFACTS / "claude-after.png"))
        print("Claude smoke:", {"url": current_url, "requests": request_delta, "elapsed": result["elapsed"]})

        print("LIVE_UI_REGRESSION=PASS")
    finally:
        driver.quit()
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
