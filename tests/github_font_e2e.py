#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.ui import WebDriverWait

TARGET_URL = "https://github.com/Kerberos255/chatgpt-codex-tools-mcp"
ARTIFACTS = Path("artifacts")
ARTIFACTS.mkdir(exist_ok=True)


class TranslationHandler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        pass

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        translated = body.get("html", "")
        translated = translated.replace("Kerberos255", "克尔贝罗斯255")
        translated = translated.replace("chatgpt-codex-tools-mcp", "已翻译仓库名")
        payload = json.dumps({"translated": translated}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def start_translation_server() -> tuple[ThreadingHTTPServer, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), TranslationHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/translate"


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


def hidden_heading_snapshot(driver: webdriver.Firefox) -> list[dict]:
    return driver.execute_script(
        """
        const isSrOnly = (el) => {
          const s = getComputedStyle(el);
          const px = (value) => {
            const n = Number.parseFloat(value);
            return Number.isFinite(n) ? n : Infinity;
          };
          const tiny = px(s.width) <= 2 && px(s.height) <= 2;
          const positioned = s.position === 'absolute' || s.position === 'fixed';
          const overflowHidden = [s.overflow, s.overflowX, s.overflowY]
            .some((value) => value === 'hidden' || value === 'clip');
          const clipped =
            (s.clip && s.clip !== 'auto' && s.clip !== 'rect(auto, auto, auto, auto)') ||
            (s.clipPath && s.clipPath !== 'none');
          return tiny && positioned && overflowHidden && Boolean(clipped);
        };
        return Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
          .filter(isSrOnly)
          .map((el) => ({
            text: (el.textContent || '').trim(),
            tag: el.tagName,
            className: el.className,
            translatedSibling: el.nextElementSibling?.classList.contains('flt-translation') === true,
          }));
        """
    )


def repository_identity_snapshot(driver: webdriver.Firefox) -> dict:
    return driver.execute_script(
        """
        const pickVisible = (selector) => Array.from(document.querySelectorAll(selector))
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.top >= 0 && r.top < 240;
          })
          .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0] || null;
        const owner = pickVisible('a[href="/Kerberos255"]');
        const repo = pickVisible('a[href="/Kerberos255/chatgpt-codex-tools-mcp"]');
        const snap = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return {
            text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
            rect: {x:r.x,y:r.y,width:r.width,height:r.height},
            generated: el.querySelectorAll('[data-flt-generated="translation"]').length,
            wrappers: el.querySelectorAll('[data-flt-source-text-wrapper]').length,
          };
        };
        return { owner: snap(owner), repo: snap(repo) };
        """
    )


def layout_risk_snapshot(driver: webdriver.Firefox) -> dict:
    return driver.execute_script(
        """
        const rect = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return {
            tag: el.tagName,
            text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 260),
            className: String(el.className || ''),
            display: s.display,
            visibility: s.visibility,
            opacity: s.opacity,
            position: s.position,
            width: r.width,
            height: r.height,
            x: r.x,
            y: r.y,
            generated: el.querySelectorAll?.('[data-flt-generated="translation"]').length || 0,
            wrappers: el.querySelectorAll?.('[data-flt-source-text-wrapper]').length || 0,
            html: el.outerHTML?.slice(0, 1800) || ''
          };
        };
        const byText = (value) => Array.from(document.querySelectorAll('a,button,span,div,li,td,th'))
          .filter((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim() === value)
          .slice(0, 6)
          .map((el) => rect(el));
        const nav = Array.from(document.querySelectorAll('nav a, [role="navigation"] a'))
          .filter((el) => /^(Code|Issues|Pull requests|Actions|Projects|Security|Insights|代码|问题|拉取请求|行动|项目|安全)/i.test((el.textContent || '').replace(/\\s+/g,' ').trim()))
          .slice(0, 12)
          .map((el) => rect(el));
        const firstFileRow = Array.from(document.querySelectorAll('tr, li'))
          .find((el) => {
            const t=(el.textContent||'').replace(/\\s+/g,' ').trim();
            return /README|CHANGELOG|package\.json|src|tests/i.test(t) && el.querySelector('svg,img');
          });
        const notification = Array.from(document.querySelectorAll('button,a,span,div'))
          .find((el) => /Notifications|You must be signed in to change notification settings/i.test((el.textContent || '').replace(/\\s+/g,' ').trim()));
        return {
          nav,
          zero: byText('0'),
          notification: rect(notification),
          firstFileRow: rect(firstFileRow)
        };
        """
    )


def repository_chrome_snapshot(driver: webdriver.Firefox) -> dict:
    return driver.execute_script(
        """
        const exactTextElements = (value) => Array.from(document.querySelectorAll('body *'))
          .filter((el) => el.children.length === 0 && (el.textContent || '').trim() === value)
          .slice(0, 8)
          .map((el) => {
            const s = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return {
              tag: el.tagName,
              className: String(el.className || ''),
              text: (el.textContent || '').trim(),
              display: s.display,
              rect: {x:r.x,y:r.y,width:r.width,height:r.height},
              parent: el.parentElement ? {
                tag: el.parentElement.tagName,
                className: String(el.parentElement.className || ''),
                text: (el.parentElement.textContent || '').trim().slice(0, 180),
                display: getComputedStyle(el.parentElement).display
              } : null,
              html: el.outerHTML.slice(0, 1000)
            };
          });
        const shortcutNodes = Array.from(document.querySelectorAll('[aria-label],[title],[data-hotkey]'))
          .filter((el) => {
            const value = [
              el.getAttribute('aria-label') || '',
              el.getAttribute('title') || '',
              el.getAttribute('data-hotkey') || '',
              el.textContent || ''
            ].join(' ');
            return /switch repository|alt\+?shift\+?r/i.test(value);
          })
          .slice(0, 12)
          .map((el) => ({
            tag: el.tagName,
            className: String(el.className || ''),
            ariaLabel: el.getAttribute('aria-label'),
            title: el.getAttribute('title'),
            hotkey: el.getAttribute('data-hotkey'),
            text: (el.textContent || '').trim().slice(0, 220),
            html: el.outerHTML.slice(0, 1400)
          }));
        return {
          owner: exactTextElements('Kerberos255'),
          repo: exactTextElements('chatgpt-codex-tools-mcp'),
          shortcutNodes,
        };
        """
    )


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: github_font_e2e.py <xpi>")

    xpi = Path(sys.argv[1]).resolve()
    if not xpi.is_file():
        raise SystemExit(f"XPI not found: {xpi}")

    translation_server, translation_url = start_translation_server()

    options = Options()
    options.add_argument("-headless")
    firefox_binary = os.environ.get("FIREFOX_BINARY")
    if firefox_binary:
        options.binary_location = firefox_binary
    driver = webdriver.Firefox(options=options, service=Service(service_args=["--allow-system-access"]))
    driver.set_page_load_timeout(90)
    driver.set_script_timeout(420)

    try:
        addon_id = driver.install_addon(str(xpi), temporary=True)
        driver.get(TARGET_URL)
        WebDriverWait(driver, 60).until(
            lambda d: d.execute_script("return document.readyState") == "complete"
        )
        WebDriverWait(driver, 30).until(
            lambda d: "chatgpt-codex-tools-mcp" in d.title.lower()
        )
        layout_before = layout_risk_snapshot(driver)
        identity_before = repository_identity_snapshot(driver)
        chrome_before = repository_chrome_snapshot(driver)
        before = hidden_heading_snapshot(driver)
        if not before:
            raise AssertionError("GitHub page exposed no screen-reader-only headings; fixture changed")
        if not any(item["text"] in {"Latest commit", "Folders and files", "History"} for item in before):
            raise AssertionError(f"Expected GitHub hidden headings not found: {before[:12]}")
        driver.execute_script(
            """
            const probe = document.createElement('p');
            probe.id = 'pagelingo-e2e-visible';
            probe.textContent = 'Visible repository translation test.';
            probe.style.cssText = 'display:block;position:relative;margin:8px;font-size:16px;line-height:20px';
            document.body.append(probe);
            """
        )
        driver.save_screenshot(str(ARTIFACTS / "github-before.png"))
        target_handle = driver.current_window_handle

        uuid = extension_uuid(driver, addon_id)
        driver.switch_to.new_window("tab")
        extension_handle = driver.current_window_handle
        driver.get(f"moz-extension://{uuid}/settings.html")
        WebDriverWait(driver, 30).until(
            lambda d: d.execute_script("return typeof browser !== 'undefined'")
        )
        driver.execute_async_script(
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
              activeTranslationEngineId: 'e2e-rest',
              translationEngines: [{
                id: 'e2e-rest',
                name: 'E2E Echo REST',
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

        result = driver.execute_async_script(
            """
            const target = arguments[0];
            const done = arguments[arguments.length - 1];
            browser.tabs.query({}).then((tabs) => {
              const tab = tabs.find((item) => item.url && item.url.startsWith(target));
              if (!tab || tab.id === undefined) throw new Error('GitHub tab not found');
              return browser.tabs.sendMessage(tab.id, {
                type: 'translate-page',
                sourceLanguage: 'en',
                targetLanguage: 'zh-Hans'
              });
            }).then((value) => done({ok:true,value}))
              .catch((error) => done({ok:false,error:String(error)}));
            """,
            TARGET_URL,
        )
        if not result.get("ok"):
            raise AssertionError(f"translate-page failed: {result}")
        value = result.get("value") or {}
        if value.get("ok") is not True or int(value.get("count") or 0) <= 0:
            raise AssertionError(f"translation returned no translated roots: {value}")

        driver.switch_to.window(target_handle)
        WebDriverWait(driver, 60).until(
            lambda d: d.execute_script(
                """
                const probe = document.getElementById('pagelingo-e2e-visible');
                return Boolean(
                  probe &&
                  probe.nextElementSibling?.classList.contains('flt-translation')
                );
                """
            )
        )
        probe_state = driver.execute_script(
            """
            const probe = document.getElementById('pagelingo-e2e-visible');
            const translation = probe?.nextElementSibling;
            return {
              sourceHidden: probe?.classList.contains('flt-source-hidden') === true,
              translated: translation?.classList.contains('flt-translation') === true,
              translationDisplay: translation ? getComputedStyle(translation).display : null,
              translationFontSize: translation ? getComputedStyle(translation).fontSize : null
            };
            """
        )
        if not probe_state.get("sourceHidden") or not probe_state.get("translated"):
            raise AssertionError(f"Visible probe was not translated normally: {probe_state}")
        layout_after = layout_risk_snapshot(driver)
        identity_after = repository_identity_snapshot(driver)
        chrome_after = repository_chrome_snapshot(driver)
        if not identity_before.get("owner") or not identity_before.get("repo"):
            raise AssertionError(f"GitHub repository identity was not found: {identity_before}")
        if identity_after.get("owner", {}).get("text") != identity_before["owner"]["text"]:
            raise AssertionError(f"GitHub owner identifier changed during translation: {identity_before} -> {identity_after}")
        if identity_after.get("repo", {}).get("text") != identity_before["repo"]["text"]:
            raise AssertionError(f"GitHub repository identifier changed during translation: {identity_before} -> {identity_after}")
        if identity_after["owner"]["generated"] or identity_after["repo"]["generated"]:
            raise AssertionError(f"GitHub repository identifiers received generated translation nodes: {identity_after}")
        if abs(identity_after["repo"]["rect"]["x"] - identity_before["repo"]["rect"]["x"]) > 1:
            raise AssertionError(f"GitHub repository title shifted horizontally: {identity_before} -> {identity_after}")
        after = hidden_heading_snapshot(driver)
        leaked = [item for item in after if item["translatedSibling"]]
        if leaked:
            raise AssertionError(f"Screen-reader-only headings leaked visible translations: {leaked}")

        visible_leaks = driver.execute_script(
            """
            const isSrOnly = (el) => {
              const s = getComputedStyle(el);
              const px = (value) => {
                const n = Number.parseFloat(value);
                return Number.isFinite(n) ? n : Infinity;
              };
              const tiny = px(s.width) <= 2 && px(s.height) <= 2;
              const positioned = s.position === 'absolute' || s.position === 'fixed';
              const overflowHidden = [s.overflow, s.overflowX, s.overflowY]
                .some((value) => value === 'hidden' || value === 'clip');
              const clipped =
                (s.clip && s.clip !== 'auto' && s.clip !== 'rect(auto, auto, auto, auto)') ||
                (s.clipPath && s.clipPath !== 'none');
              return tiny && positioned && overflowHidden && Boolean(clipped);
            };
            return Array.from(document.querySelectorAll('.flt-translation'))
              .filter((node) => node.previousElementSibling && isSrOnly(node.previousElementSibling))
              .map((node) => ({
                text: (node.textContent || '').trim(),
                fontSize: getComputedStyle(node).fontSize
              }));
            """
        )
        if visible_leaks:
            raise AssertionError(f"Visible translation nodes escaped hidden GitHub roots: {visible_leaks}")

        driver.save_screenshot(str(ARTIFACTS / "github-after.png"))
        print(json.dumps({
            "translated_roots": value.get("count"),
            "layout_before": layout_before,
            "layout_after": layout_after,
            "repository_identity_before": identity_before,
            "repository_identity_after": identity_after,
            "repository_chrome_before": chrome_before,
            "repository_chrome_after": chrome_after,
            "visible_probe": probe_state,
            "hidden_headings_before": before,
            "hidden_headings_after": after,
            "visible_leaks": visible_leaks,
        }, ensure_ascii=False, indent=2))
        driver.switch_to.window(extension_handle)
    finally:
        driver.quit()
        translation_server.shutdown()
        translation_server.server_close()


if __name__ == "__main__":
    main()
