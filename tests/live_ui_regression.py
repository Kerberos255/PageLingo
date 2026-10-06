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
ADDON_ID = "pagelingo@kerberos255"
ARTIFACTS = Path("artifacts")
ARTIFACTS.mkdir(exist_ok=True)


class TranslationHandler(BaseHTTPRequestHandler):
    request_count = 0

    def log_message(self, format: str, *args: object) -> None:
        pass

    def do_GET(self) -> None:
        if self.path == "/v1/models":
            payload = json.dumps({
                "object": "list",
                "data": [
                    {"id": "deepseek-flash", "name": "DeepSeek-V4.1-Flash", "owned_by": "fixture", "context_window": 1048576, "max_output_tokens": 393216},
                    {"id": "deepseek-v4-pro", "name": "DeepSeek-V4-Pro", "owned_by": "fixture", "context_window": 1048576, "max_output_tokens": 393216},
                    {"id": "deepseek-v4.1-flash", "name": "DeepSeek V4.1 Flash", "owned_by": "fixture"},
                    {"id": "hy4-preview", "name": "Hy4 Preview", "owned_by": "fixture"},
                    {"id": "kimi-k2.6", "name": "Kimi K2.6", "owned_by": "fixture"},
                    {"id": "longcat-2.0", "name": "LongCat 2.0", "owned_by": "fixture"},
                    {"id": "mimo-v2.5", "name": "MiMo V2.5", "owned_by": "fixture"},
                    {"id": "mimo-v2.5-pro", "name": "MiMo V2.5 Pro", "owned_by": "fixture"},
                    {"id": "qwen3.8-flash", "name": "Qwen3.8 Flash", "owned_by": "fixture"},
                    {"id": "qwen3.8-max", "name": "Qwen3.8 Max", "owned_by": "fixture"},
                    {"id": "test-alpha", "owned_by": "fixture"},
                    {"id": "test-beta", "owned_by": "fixture"}
                ]
            }).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
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
<p id="complex">Status <strong>alpha</strong> <strong>bravo</strong> <strong>charlie</strong> <strong>delta</strong> <strong>echo</strong> <strong>foxtrot</strong> <strong>golf</strong> <strong>hotel</strong> <strong>india</strong> <strong>juliet</strong>.</p>
<script>
const button=document.getElementById('hover');
button.addEventListener('pointerenter',()=>{
  setTimeout(()=>{
    if(document.getElementById('tip'))return;
    const tip=document.createElement('div');
    tip.id='tip'; tip.className='tip'; tip.setAttribute('role','tooltip'); tip.textContent='Upgrade to use Cowork for long-running tasks';
    document.body.append(tip);
  },80);
});
window.__runChurn=()=>{
  for(let n=0;n<10000;n++){
    document.body.classList.toggle('pulse');
    button.classList.toggle('pulse');
  }
  window.__churnDone=true;
};
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
            ("Status", "状态"),
            ("alpha", "甲"),
            ("bravo", "乙"),
            ("charlie", "丙"),
            ("delta", "丁"),
            ("echo", "戊"),
            ("foxtrot", "己"),
            ("golf", "庚"),
            ("hotel", "辛"),
            ("india", "壬"),
            ("juliet", "癸"),
        ]
        for source, target in replacements:
            translated = translated.replace(source, target)
        payload = json.dumps({"translated": translated}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def start_server() -> tuple[ThreadingHTTPServer, str, str, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), TranslationHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    return server, f"{base}/translate", f"{base}/dynamic-ui", f"{base}/v1"


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

    server, translation_url, fixture_url, model_base_url = start_server()
    options = Options()
    options.add_argument("-headless")
    firefox_binary = os.environ.get("FIREFOX_BINARY")
    if firefox_binary:
        options.binary_location = firefox_binary
    driver = webdriver.Firefox(options=options, service=Service(service_args=["--allow-system-access"]))
    driver.set_window_size(1440, 1000)
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

        # Model picker UI: real extension runtime call against a local OpenAI-compatible /models fixture.
        driver.execute_script("location.hash='engine'")
        WebDriverWait(driver, 10).until(
            lambda d: d.execute_script("return document.getElementById('engine')?.classList.contains('active')")
        )
        picker_setup = driver.execute_script(
            """
            const baseUrl=arguments[0];
            const type=document.getElementById('engine-type');
            type.value='openai-compatible';
            type.dispatchEvent(new Event('change',{bubbles:true}));
            document.getElementById('engine-base-url').value=baseUrl;
            document.getElementById('engine-api-key').value='';
            document.getElementById('engine-model').value='deepseek-v4-pro';
            document.getElementById('get-engine-models').click();
            return {
              buttonHidden:document.getElementById('get-engine-models').hidden,
              dialogOpen:document.getElementById('model-picker-dialog').open
            };
            """,
            model_base_url,
        )
        if picker_setup.get("buttonHidden"):
            raise AssertionError(f"Model picker button unexpectedly hidden: {picker_setup}")
        WebDriverWait(driver, 10).until(
            lambda d: d.execute_script(
                "return document.querySelectorAll('#model-picker-list .model-picker-item').length >= 10"
            )
        )
        picker_state = driver.execute_script(
            """
            const dialog=document.getElementById('model-picker-dialog');
            return {
              open:dialog.open,
              count:document.querySelectorAll('#model-picker-list .model-picker-item').length,
              label:document.getElementById('model-picker-count').textContent,
              current:document.querySelector('#model-picker-list .model-picker-current')?.parentElement?.innerText || ''
            };
            """
        )
        if not picker_state.get("open") or picker_state.get("count", 0) < 10:
            raise AssertionError(f"Model picker did not render model list: {picker_state}")
        driver.save_screenshot(str(ARTIFACTS / "model-picker.png"))
        print("Model picker:", picker_state)

        driver.execute_script(
            """
            const search=document.getElementById('model-picker-search');
            search.value='deepseek';
            search.dispatchEvent(new Event('input',{bubbles:true}));
            """
        )
        WebDriverWait(driver, 5).until(
            lambda d: d.execute_script(
                "return document.querySelectorAll('#model-picker-list .model-picker-item').length === 3"
            )
        )
        driver.execute_script(
            """
            const radio=Array.from(document.querySelectorAll('#model-picker-list input[type=radio]'))
              .find((item)=>item.value==='deepseek-flash');
            if(!radio) throw new Error('deepseek-flash missing');
            radio.click();
            document.getElementById('select-model-picker').click();
            """
        )
        chosen_model = driver.execute_script("return document.getElementById('engine-model').value")
        if chosen_model != "deepseek-flash":
            raise AssertionError(f"Model picker did not fill selected model: {chosen_model}")

        configure_extension(driver, extension_handle, translation_url)

        # 1) Deterministic high-mutation fixture: this catches observer feedback loops.
        driver.switch_to.new_window("tab")
        fixture_handle = driver.current_window_handle
        driver.get(fixture_url)
        WebDriverWait(driver, 20).until(lambda d: d.execute_script("return document.readyState") == "complete")
        before_requests = TranslationHandler.request_count
        result = translate_tab(driver, extension_handle, fixture_url, timeout=30)
        if not result.get("ok") or (result.get("value") or {}).get("ok") is not True:
            raise AssertionError(f"Fixture translation failed: {result}")
        driver.switch_to.window(fixture_handle)
        if not page_responsive(driver):
            raise AssertionError("Dynamic fixture became unresponsive after translation")

        complex_result = driver.execute_script(
            """
            const source = document.getElementById('complex');
            const translated = source?.nextElementSibling;
            return {
              generated: Boolean(translated?.matches('.flt-translation')),
              strongCount: translated?.querySelectorAll('strong').length ?? 0,
              text: (translated?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
            };
            """
        )
        if not complex_result.get("generated"):
            raise AssertionError(f"Complex splitter fixture produced no translation: {complex_result}")
        if complex_result.get("strongCount") != 10:
            raise AssertionError(f"Complex splitter lost inline structure: {complex_result}")
        if "甲" not in complex_result.get("text", "") or "癸" not in complex_result.get("text", ""):
            raise AssertionError(f"Complex splitter did not translate both ends: {complex_result}")
        driver.save_screenshot(str(ARTIFACTS / "complex-splitter-after.png"))
        print("Complex splitter fixture:", complex_result)

        # Stress the translated page with the kind of high-frequency class churn used by
        # React/animation-heavy UIs. A translation observer must not turn these cosmetic
        # mutations into another translation pass.
        churn_before = TranslationHandler.request_count
        driver.execute_script("window.__runChurn();")
        WebDriverWait(driver, 5).until(lambda d: d.execute_script("return window.__churnDone === true"))
        time.sleep(1)
        churn_delta = TranslationHandler.request_count - churn_before
        if churn_delta > 5:
            raise AssertionError(f"Cosmetic class churn caused translation request storm: {churn_delta}")
        if not page_responsive(driver):
            raise AssertionError("Dynamic fixture became unresponsive after class churn")

        # Hover is the only trigger for the late portal tooltip. PageLingo may short-watch
        # child insertion after that event, but class/style churn above must stay invisible.
        tooltip_before = TranslationHandler.request_count
        driver.execute_script("""
          const button = document.getElementById('hover');
          button.dispatchEvent(new PointerEvent('pointerover', {bubbles:true}));
          button.dispatchEvent(new PointerEvent('pointerenter'));
        """)
        WebDriverWait(driver, 5).until(
            lambda d: d.execute_script("return document.getElementById('tip')?.textContent")
            == "升级后可使用 Cowork 处理长时间任务"
        )
        tooltip_delta = TranslationHandler.request_count - tooltip_before
        if tooltip_delta != 1:
            raise AssertionError(f"Hover tooltip used unexpected translation request count: {tooltip_delta}")
        if not page_responsive(driver):
            raise AssertionError("Dynamic fixture became unresponsive after tooltip translation")

        request_delta = TranslationHandler.request_count - before_requests
        if request_delta > 200:
            raise AssertionError(f"Dynamic fixture caused translation request storm: {request_delta}")
        driver.save_screenshot(str(ARTIFACTS / "dynamic-ui-after.png"))
        print("Dynamic UI fixture:", {"requests": request_delta, "churnRequests": churn_delta, "elapsed": result["elapsed"]})

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
        try:
            driver.save_screenshot(str(ARTIFACTS / "claude-before.png"))
        except Exception as error:
            print("CLAUDE_BEFORE_SCREENSHOT_WARNING=", repr(error))
        before_requests = TranslationHandler.request_count
        result = translate_tab(driver, extension_handle, "https://claude.ai/", timeout=45)
        messaging_unavailable = (
            not result.get("ok")
            and "Receiving end does not exist" in str(result.get("error") or "")
            and not current_url.startswith(CLAUDE_URL)
        )
        if not result.get("ok") and not messaging_unavailable:
            raise AssertionError(f"Claude tab messaging failed: {result}")
        if result.get("ok"):
            value = result.get("value") or {}
            if value.get("ok") is not True:
                raise AssertionError(f"Claude translation returned failure: {value}")
            if result["elapsed"] > 40:
                raise AssertionError(f"Claude translation took too long: {result['elapsed']:.2f}s")

        driver.switch_to.window(claude_handle)
        if not page_responsive(driver):
            raise AssertionError("Claude page became unresponsive during smoke test")
        time.sleep(2)
        request_delta = TranslationHandler.request_count - before_requests
        if request_delta > 800:
            raise AssertionError(f"Claude caused translation request storm: {request_delta}")
        try:
            driver.save_screenshot(str(ARTIFACTS / "claude-after.png"))
        except Exception as error:
            print("CLAUDE_AFTER_SCREENSHOT_WARNING=", repr(error))

        if messaging_unavailable:
            print("CLAUDE_MESSAGING_WARNING=", {
                "url": current_url,
                "error": result.get("error"),
                "note": "anonymous redirect had no PageLingo content-script receiver",
            })
        print("Claude smoke:", {
            "url": current_url,
            "requests": request_delta,
            "elapsed": result.get("elapsed"),
            "messaging": "unavailable-on-redirect" if messaging_unavailable else "ok",
        })

        print("LIVE_UI_REGRESSION=PASS")
    finally:
        driver.quit()
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
