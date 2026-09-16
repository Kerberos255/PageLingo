#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.ui import WebDriverWait

ADDON_ID = "local-immersive-translate-dev@kerberos255.local"
CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        pass


def start_fixture_server(directory: Path) -> tuple[ThreadingHTTPServer, str]:
    handler = lambda *args, **kwargs: QuietHandler(*args, directory=str(directory), **kwargs)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    return server, f"http://127.0.0.1:{port}/e2e.html"


def get_extension_uuid(driver: webdriver.Firefox, addon_id: str) -> str:
    with driver.context(driver.CONTEXT_CHROME):
        raw = driver.execute_script(
            """
            if (typeof Services !== 'undefined') {
              return Services.prefs.getStringPref('extensions.webextensions.uuids');
            }
            const prefs = Components.classes['@mozilla.org/preferences-service;1']
              .getService(Components.interfaces.nsIPrefBranch);
            return prefs.getStringPref('extensions.webextensions.uuids');
            """
        )
    mapping = json.loads(raw)
    if addon_id not in mapping:
        raise AssertionError(f"Extension UUID not found for {addon_id}: {mapping}")
    return mapping[addon_id]


def extension_message(driver: webdriver.Firefox, target_url: str, message_type: str) -> dict:
    driver.set_script_timeout(180)
    result = driver.execute_async_script(
        """
        const targetUrl = arguments[0];
        const messageType = arguments[1];
        const done = arguments[arguments.length - 1];
        browser.tabs.query({}).then((tabs) => {
          const target = tabs.find((tab) => tab.url === targetUrl);
          if (!target || target.id === undefined) {
            throw new Error(`Target tab not found: ${targetUrl}`);
          }
          return browser.tabs.sendMessage(target.id, { type: messageType });
        }).then((value) => done({ ok: true, value }))
          .catch((error) => done({ ok: false, error: String(error) }));
        """,
        target_url,
        message_type,
    )
    if not result.get("ok"):
        raise AssertionError(f"Extension message {message_type} failed: {result}")
    return result.get("value") or {}


def background_ready(driver: webdriver.Firefox) -> bool:
    try:
        result = driver.execute_async_script(
            """
            const done = arguments[arguments.length - 1];
            browser.runtime.sendMessage({ type: 'ping-backend' })
              .then((value) => done({ ok: true, value }))
              .catch((error) => done({ ok: false, error: String(error) }));
            """
        )
        return result.get("ok") is True and result.get("value", {}).get("ok") is True
    except Exception:
        return False


def runtime_translate(
    driver: webdriver.Firefox,
    html: str,
    source_language: str,
    target_language: str,
) -> str:
    driver.set_script_timeout(300)
    result = driver.execute_async_script(
        """
        const html = arguments[0];
        const sourceLanguage = arguments[1];
        const targetLanguage = arguments[2];
        const done = arguments[arguments.length - 1];
        browser.runtime.sendMessage({
          type: 'translate-html',
          request: { html, sourceLanguage, targetLanguage },
        }).then((value) => done(value))
          .catch((error) => done({ ok: false, error: String(error) }));
        """,
        html,
        source_language,
        target_language,
    )
    if not result or result.get("ok") is not True:
        raise AssertionError(
            f"Runtime translation failed {source_language}->{target_language}: {result}"
        )
    return result.get("html") or ""


def content_script_ready(driver: webdriver.Firefox, target_url: str) -> bool:
    try:
        response = extension_message(driver, target_url, "ping")
        return response.get("ok") is True
    except AssertionError:
        return False


def wait_for_cjk_translation(driver: webdriver.Firefox, selector: str, timeout: int = 180) -> str:
    def probe(drv: webdriver.Firefox) -> str | bool:
        text = drv.execute_script(
            "return document.querySelector(arguments[0])?.textContent || '';",
            selector,
        )
        return text if CJK_RE.search(text) else False

    return WebDriverWait(driver, timeout).until(probe)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python tests/e2e_firefox.py <unsigned.xpi>")

    xpi = Path(sys.argv[1]).resolve()
    if not xpi.is_file():
        raise SystemExit(f"XPI not found: {xpi}")

    fixture_dir = Path(__file__).resolve().parent / "fixtures"
    server, target_url = start_fixture_server(fixture_dir)

    options = Options()
    firefox_binary = os.environ.get("FIREFOX_BINARY")
    if not firefox_binary:
        local_firefox = Path("artifacts/firefox-test/core/firefox.exe").resolve()
        if local_firefox.is_file():
            firefox_binary = str(local_firefox)
    if firefox_binary:
        options.binary_location = firefox_binary
    options.add_argument("-headless")
    service = Service(service_args=["--allow-system-access"])
    driver = webdriver.Firefox(options=options, service=service)

    try:
        addon_id = driver.install_addon(str(xpi), temporary=True)
        if addon_id != ADDON_ID:
            raise AssertionError(f"Unexpected add-on id: {addon_id}")

        driver.get(target_url)
        target_handle = driver.current_window_handle
        WebDriverWait(driver, 30).until(
            lambda d: d.execute_script("return document.readyState") == "complete"
        )

        original_href = driver.execute_script(
            """
            const link = document.getElementById('docs');
            link.__pageLingoSentinel = 42;
            window.__pageLingoClicks = 0;
            link.addEventListener('click', (event) => {
              event.preventDefault();
              window.__pageLingoClicks += 1;
            });
            return link.href;
            """
        )

        uuid = get_extension_uuid(driver, ADDON_ID)
        driver.switch_to.new_window("tab")
        extension_handle = driver.current_window_handle
        driver.get(f"moz-extension://{uuid}/settings.html")
        WebDriverWait(driver, 30).until(
            lambda d: d.execute_script("return typeof browser !== 'undefined'")
        )
        WebDriverWait(driver, 30).until(
            lambda d: d.execute_script(
                "return document.querySelector('input[name=\"display-mode\"][value=\"bilingual\"]')?.checked === true"
            )
        )
        WebDriverWait(driver, 30).until(lambda d: content_script_ready(d, target_url))
        WebDriverWait(driver, 30).until(background_ready)
        catalog_response = driver.execute_async_script(
            """
            const done = arguments[0];
            browser.runtime.sendMessage({ type: 'get-language-catalog' })
              .then((value) => done(value))
              .catch((error) => done({ ok: false, error: String(error) }));
            """
        )
        assert catalog_response.get("ok") is True, catalog_response
        initial_catalog = catalog_response.get("catalog") or {}
        assert len(initial_catalog.get("sourceLanguages") or []) > 20, initial_catalog
        assert len(initial_catalog.get("targetLanguages") or []) > 20, initial_catalog
        assert len(initial_catalog.get("packs") or []) > 20, initial_catalog
        WebDriverWait(driver, 30).until(
            lambda d: d.execute_script("return document.querySelectorAll('#language-pack-list .pack-item').length") > 20
        )
        print(
            "Language catalog:",
            len(initial_catalog.get("sourceLanguages") or []),
            "sources,",
            len(initial_catalog.get("targetLanguages") or []),
            "targets,",
            len(initial_catalog.get("packs") or []),
            "language packs",
        )
        # Keep the baseline E2E deterministic even though first install now chooses
        # the browser's preferred target language.
        driver.execute_async_script(
            """
            const done = arguments[0];
            browser.storage.local.set({
              targetLanguage: 'zh-Hans',
              autoSourceLanguage: 'en',
              autoTranslateEnabled: false,
              excludedSites: [],
            }).then(() => done(true));
            """
        )

        language = extension_message(driver, target_url, "get-page-language")
        assert language.get("ok") is True, language
        language_info = language.get("language") or {}
        assert language_info.get("effectiveLanguage") == "en", language_info
        print(
            "Detected page language:",
            language_info.get("effectiveLanguage"),
            language_info.get("percentage"),
            "reliable=", language_info.get("isReliable"),
        )

        response = extension_message(driver, target_url, "translate-page")
        if not response.get("ok"):
            raise AssertionError(f"translate-page returned failure: {response}")

        driver.switch_to.window(target_handle)
        translated = wait_for_cjk_translation(driver, "#rich + .flt-translation")
        print(f"Translated rich text: {translated}")

        source_state = driver.execute_script(
            """
            const link = document.getElementById('docs');
            const translatedLink = document.querySelector('#rich + .flt-translation a');
            return {
              sourceHref: link.href,
              sourceSentinel: link.__pageLingoSentinel,
              translatedHref: translatedLink?.href || null,
              translatedStrong: document.querySelector('#rich + .flt-translation strong')?.textContent || null,
              generatedCount: document.querySelectorAll('.flt-translation').length,
            };
            """
        )
        assert source_state["sourceHref"] == original_href, source_state
        assert source_state["sourceSentinel"] == 42, source_state
        assert source_state["translatedHref"] == original_href, source_state
        assert source_state["translatedStrong"], source_state
        assert source_state["generatedCount"] >= 2, source_state

        driver.execute_script("document.getElementById('docs').click();")
        clicks = driver.execute_script("return window.__pageLingoClicks;")
        assert clicks == 1, f"Original link listener was lost: clicks={clicks}"

        driver.switch_to.window(extension_handle)
        driver.execute_script(
            "document.querySelector('input[name=\"display-mode\"][value=\"translation\"]').click();"
        )
        WebDriverWait(driver, 30).until(
            lambda d: d.execute_async_script(
                "const done=arguments[0]; browser.storage.local.get('displayMode').then(v=>done(v.displayMode));"
            ) == "translation"
        )

        driver.switch_to.window(target_handle)
        WebDriverWait(driver, 30).until(
            lambda d: d.execute_script(
                "return document.getElementById('rich').classList.contains('flt-source-hidden')"
            )
        )
        translation_only = driver.execute_script(
            """
            const source = document.getElementById('rich');
            const translated = source.nextElementSibling;
            return {
              sourceNodeStillPresent: source === document.getElementById('rich'),
              sourceHidden: source.classList.contains('flt-source-hidden'),
              translatedVisible: translated?.classList.contains('flt-translation') || false,
              translatedHref: translated?.querySelector('a')?.href || null,
            };
            """
        )
        assert translation_only["sourceNodeStillPresent"], translation_only
        assert translation_only["sourceHidden"], translation_only
        assert translation_only["translatedVisible"], translation_only
        assert translation_only["translatedHref"] == original_href, translation_only

        driver.execute_script("document.querySelector('#rich + .flt-translation a').click();")
        clicks = driver.execute_script("return window.__pageLingoClicks;")
        assert clicks == 2, f"Translated link did not preserve source click behavior: clicks={clicks}"

        driver.switch_to.window(extension_handle)
        driver.execute_script(
            "document.querySelector('input[name=\"display-mode\"][value=\"bilingual\"]').click();"
        )
        driver.switch_to.window(target_handle)
        WebDriverWait(driver, 30).until(
            lambda d: not d.execute_script(
                "return document.getElementById('rich').classList.contains('flt-source-hidden')"
            )
        )

        driver.execute_script(
            """
            const p = document.createElement('p');
            p.id = 'dynamic-added';
            p.textContent = 'Dynamic content should be translated quickly without reloading the page.';
            document.getElementById('dynamic-host').append(p);
            """
        )
        dynamic_text = wait_for_cjk_translation(driver, "#dynamic-added + .flt-translation")
        print(f"Translated dynamic text: {dynamic_text}")

        driver.switch_to.window(extension_handle)
        response = extension_message(driver, target_url, "restore-page")
        if not response.get("ok"):
            raise AssertionError(f"restore-page returned failure: {response}")

        driver.switch_to.window(target_handle)
        WebDriverWait(driver, 30).until(
            lambda d: d.execute_script("return document.querySelectorAll('.flt-translation').length") == 0
        )
        restored = driver.execute_script(
            """
            const link = document.getElementById('docs');
            return {
              sentinel: link.__pageLingoSentinel,
              href: link.href,
              styleGone: !document.getElementById('flt-style'),
            };
            """
        )
        assert restored == {"sentinel": 42, "href": original_href, "styleGone": True}, restored

        # New auto-translation rule: English pages should translate on load.
        driver.switch_to.window(extension_handle)
        driver.execute_async_script(
            """
            const done = arguments[0];
            browser.storage.local.set({
              autoTranslateEnabled: true,
              autoSourceLanguage: 'en',
              targetLanguage: 'zh-Hans',
              excludedSites: [],
            }).then(() => done(true));
            """
        )
        driver.switch_to.window(target_handle)
        driver.get(target_url)
        WebDriverWait(driver, 30).until(
            lambda d: d.execute_script("return document.readyState") == "complete"
        )
        auto_text = wait_for_cjk_translation(driver, "#rich + .flt-translation")
        print(f"Automatic translation: {auto_text}")

        # The same page must remain untouched when its host is in the exception list.
        driver.switch_to.window(extension_handle)
        driver.execute_async_script(
            """
            const done = arguments[0];
            browser.storage.local.set({ excludedSites: ['127.0.0.1'] }).then(() => done(true));
            """
        )
        driver.switch_to.window(target_handle)
        driver.get(target_url)
        WebDriverWait(driver, 30).until(
            lambda d: d.execute_script("return document.readyState") == "complete"
        )
        time.sleep(2)
        excluded_count = driver.execute_script("return document.querySelectorAll('.flt-translation').length")
        assert excluded_count == 0, f"Excluded site was auto-translated: {excluded_count}"
        print("Exception rule prevented automatic translation")

        # Real multi-language model coverage: direct English -> Spanish, then
        # Spanish -> Simplified Chinese through the local English pivot.
        driver.switch_to.window(extension_handle)
        spanish = runtime_translate(
            driver,
            "Hello world. This is a local translation test.",
            "en",
            "es",
        )
        assert spanish and spanish != "Hello world. This is a local translation test.", spanish
        assert not CJK_RE.search(spanish), spanish
        print(f"English -> Spanish: {spanish}")

        chinese_via_pivot = runtime_translate(
            driver,
            "Hola mundo. Esta es una prueba de traducción local.",
            "es",
            "zh-Hans",
        )
        assert CJK_RE.search(chinese_via_pivot), chinese_via_pivot
        print(f"Spanish -> Simplified Chinese via English pivot: {chinese_via_pivot}")

        update_check = driver.execute_async_script(
            """
            const done = arguments[0];
            browser.runtime.sendMessage({ type: 'check-model-updates' })
              .then((value) => done(value))
              .catch((error) => done({ ok: false, error: String(error) }));
            """
        )
        assert update_check.get("ok") is True, update_check
        catalog = update_check.get("catalog") or {}
        assert isinstance(catalog.get("updateCount"), int), catalog
        print(f"Model update check: {catalog.get('updateCount')} available")

        # Model update policy controls the periodic alarm itself: manual means
        # no background wake-up, notify/auto restore the daily check.
        driver.execute_async_script(
            """
            const done = arguments[0];
            browser.storage.local.set({ modelUpdatePolicy: 'manual' }).then(() => done(true));
            """
        )
        WebDriverWait(driver, 30).until(
            lambda d: d.execute_async_script(
                "const done=arguments[0]; browser.alarms.get('pagelingo-model-updates').then(v=>done(v || null));"
            ) is None
        )
        print("Manual model update policy: periodic alarm disabled")

        driver.execute_async_script(
            """
            const done = arguments[0];
            browser.storage.local.set({ modelUpdatePolicy: 'notify' }).then(() => done(true));
            """
        )
        WebDriverWait(driver, 30).until(
            lambda d: d.execute_async_script(
                "const done=arguments[0]; browser.alarms.get('pagelingo-model-updates').then(v=>done(v || null));"
            ) is not None
        )
        print("Notify model update policy: periodic alarm restored")

        driver.execute_async_script(
            """
            const done = arguments[0];
            browser.storage.local.set({ modelUpdatePolicy: 'auto' }).then(() => done(true));
            """
        )

        print("PageLingo Firefox E2E passed (bilingual + translation-only + live mode switching)")
    finally:
        driver.quit()
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
