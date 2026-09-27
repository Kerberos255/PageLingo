#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.ui import WebDriverWait

OPENCLAW_URL = "https://docs.openclaw.ai/start/getting-started"
ADDON_ID = "pagelingo@kerberos255"
LOCAL_ENGINE_ID = "firefox-local"


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
    value = mapping.get(addon_id)
    if not value:
        raise AssertionError(f"Extension UUID not found for {addon_id}")
    return value


def runtime_message(driver: webdriver.Firefox, message: dict, timeout: int = 600) -> dict:
    driver.set_script_timeout(timeout)
    result = driver.execute_async_script(
        """
        const message = arguments[0];
        const done = arguments[arguments.length - 1];
        browser.runtime.sendMessage(message)
          .then((value) => done(value))
          .catch((error) => done({ok:false,error:String(error)}));
        """,
        message,
    )
    if not isinstance(result, dict):
        raise AssertionError(f"Unexpected runtime response: {result!r}")
    return result


def content_message(driver: webdriver.Firefox, url_prefix: str, message: dict, timeout: int = 180) -> dict:
    driver.set_script_timeout(timeout)
    result = driver.execute_async_script(
        """
        const prefix = arguments[0];
        const message = arguments[1];
        const done = arguments[arguments.length - 1];
        browser.tabs.query({}).then((tabs) => {
          const candidates = tabs.filter((item) => item.url && item.url.startsWith(prefix));
          const tab = candidates[candidates.length - 1];
          if (!tab || tab.id === undefined) throw new Error('Target tab not found: ' + prefix);
          return browser.tabs.sendMessage(tab.id, message);
        }).then((value) => done(value))
          .catch((error) => done({ok:false,error:String(error)}));
        """,
        url_prefix,
        message,
    )
    if not isinstance(result, dict):
        raise AssertionError(f"Unexpected content response: {result!r}")
    return result


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("Usage: openclaw_bergamot_perf.py <xpi> <output-json>")

    xpi = Path(sys.argv[1]).resolve()
    output = Path(sys.argv[2]).resolve()
    if not xpi.is_file():
        raise SystemExit(f"XPI not found: {xpi}")
    output.parent.mkdir(parents=True, exist_ok=True)

    options = Options()
    options.add_argument("-headless")
    firefox_binary = os.environ.get("FIREFOX_BINARY")
    if firefox_binary:
        options.binary_location = firefox_binary

    driver = webdriver.Firefox(options=options, service=Service(service_args=["--allow-system-access"]))
    driver.set_page_load_timeout(120)
    driver.set_script_timeout(900)

    try:
        addon_id = driver.install_addon(str(xpi), temporary=True)
        if addon_id != ADDON_ID:
            raise AssertionError(f"Unexpected add-on id: {addon_id}")

        uuid = extension_uuid(driver, addon_id)
        driver.switch_to.new_window("tab")
        extension_handle = driver.current_window_handle
        driver.get(f"moz-extension://{uuid}/settings.html")
        WebDriverWait(driver, 30).until(lambda d: d.execute_script("return typeof browser !== 'undefined'"))

        settings_result = driver.execute_async_script(
            """
            const done = arguments[0];
            browser.storage.local.set({
              displayMode: 'translation',
              targetLanguage: 'zh-Hans',
              autoTranslateEnabled: false,
              neverTranslateSites: [],
              alwaysTranslateSites: [],
              neverTranslateLanguages: [],
              alwaysTranslateLanguages: []
            }).then(() => done({ok:true}))
              .catch((error) => done({ok:false,error:String(error)}));
            """
        )
        if not settings_result.get("ok"):
            raise AssertionError(settings_result)

        engine = runtime_message(driver, {"type": "set-active-translation-engine", "id": LOCAL_ENGINE_ID}, timeout=60)
        if not engine.get("ok"):
            raise AssertionError(f"Could not select local engine: {engine}")

        pack = runtime_message(driver, {"type": "download-language-pack", "language": "zh-Hans"}, timeout=900)
        if not pack.get("ok"):
            raise AssertionError(f"Could not install zh-Hans pack: {pack}")

        driver.switch_to.new_window("tab")
        target_handle = driver.current_window_handle
        driver.get(OPENCLAW_URL)
        WebDriverWait(driver, 90).until(lambda d: d.execute_script("return document.readyState") == "complete")

        driver.switch_to.window(extension_handle)
        WebDriverWait(driver, 60).until(
            lambda d: content_message(d, "https://docs.openclaw.ai/", {"type": "ping"}, timeout=10).get("ok") is True
        )

        reset = runtime_message(driver, {"type": "reset-translation-performance"}, timeout=30)
        if not reset.get("ok"):
            raise AssertionError(f"Could not reset performance counters: {reset}")

        started = time.monotonic()
        translated = content_message(
            driver,
            "https://docs.openclaw.ai/",
            {"type": "translate-page", "sourceLanguage": "en", "targetLanguage": "zh-Hans"},
            timeout=300,
        )
        elapsed_ms = (time.monotonic() - started) * 1000.0
        if not translated.get("ok"):
            raise AssertionError(f"OpenClaw translation failed: {translated}")

        perf = runtime_message(driver, {"type": "get-translation-performance"}, timeout=30)
        if not perf.get("ok"):
            raise AssertionError(f"Could not read performance counters: {perf}")
        stats = perf.get("stats") or {}

        driver.switch_to.window(target_handle)
        responsive = driver.execute_script("return document.readyState === 'complete' && document.body !== null")
        generated_count = driver.execute_script(
            "return document.querySelectorAll('[data-flt-generated=\"translation\"]').length"
        )
        if not responsive or generated_count <= 0:
            raise AssertionError(f"OpenClaw page did not remain translated/responsive: generated={generated_count}")

        result = {
            "url": OPENCLAW_URL,
            "elapsedMilliseconds": round(elapsed_ms, 3),
            "rootCount": int(translated.get("count") or 0),
            "generatedCount": int(generated_count),
            "inferenceCount": int(stats.get("inferenceCount") or 0),
            "inferenceMilliseconds": round(float(stats.get("inferenceMilliseconds") or 0.0), 3),
            "translatedInputs": int(stats.get("translatedInputs") or 0),
        }
        if result["rootCount"] <= 0:
            raise AssertionError(f"Unexpected root count: {result}")
        if result["inferenceCount"] <= 0 or result["inferenceMilliseconds"] <= 0:
            raise AssertionError(f"Missing Bergamot inference metrics: {result}")

        output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("OPENCLAW_BERGAMOT_PERF=" + json.dumps(result, ensure_ascii=False))
    finally:
        driver.quit()


if __name__ == "__main__":
    main()
