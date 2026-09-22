#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.ui import WebDriverWait

TARGET_URL = "https://github.com/Kerberos255/chatgpt-codex-tools-mcp"
# Controlled CI trigger: validates release hardening, strict typing, layout, terminology, relative-time, and GitHub SPA continuity.
ARTIFACTS = Path("artifacts")
ARTIFACTS.mkdir(exist_ok=True)


class TranslationHandler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        pass

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        translated = body.get("html", "")
        exact = {
            "Kerberos255": "克尔贝罗斯255",
            "chatgpt-codex-tools-mcp": "已翻译仓库名",
            "Code": "代码",
            "Issues": "问题",
            "Pull requests": "拉取请求",
            "Actions": "操作",
            "Projects": "项目",
            "Security": "安全",
            "Security and quality": "安全与质量",
            "Insights": "洞察",
            "src": "源代码",
            "tests": "测试目录",
            "README.md": "说明文件",
        }
        translated = exact.get(translated.strip(), translated)
        # Deliberately behave like an unstable MT model for immutable brands. The
        # extension must recover these from hard-preserve markers before display.
        translated = translated.replace("Configure ", "配置 ")
        translated = translated.replace(" notifications for ", " 通知，供 ")
        translated = translated.replace(" with ", "，使用 ")
        translated = translated.replace(" settings.", " 设置。")
        translated = translated.replace("settings", "设置")
        translated = translated.replace("Slack", "松��")
        translated = translated.replace("OpenAI", "开放人工智能")
        translated = translated.replace("NVIDIA", "英伟达")
        translated = translated.replace("PayPal", "贝宝")
        translated = translated.replace("Toyota", "丰田")
        translated = translated.replace("Spotify", "声田")
        translated = translated.replace("Airbnb", "爱彼迎")
        translated = translated.replace("Pfizer", "辉瑞")
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


def readme_divider_state(driver: webdriver.Firefox) -> dict | None:
    return driver.execute_script(
        """
        const candidates = Array.from(document.querySelectorAll('article.markdown-body h2, .markdown-body h2'));
        const heading = candidates.find((el) => {
          const s = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && Number.parseFloat(s.borderBottomWidth || '0') > 0;
        }) || null;
        if (!heading) return null;
        const s = getComputedStyle(heading);
        const r = heading.getBoundingClientRect();
        return {
          text: (heading.innerText || heading.textContent || '').replace(/\s+/g, ' ').trim(),
          display: s.display,
          visibility: s.visibility,
          width: r.width,
          height: r.height,
          borderBottomWidth: s.borderBottomWidth,
          borderBottomStyle: s.borderBottomStyle,
          borderBottomColor: s.borderBottomColor,
          generated: heading.querySelectorAll('[data-flt-generated="translation"]').length,
          wrappers: heading.querySelectorAll('[data-flt-source-text-wrapper]').length,
        };
        """
    )


def relative_time_state(driver: webdriver.Firefox, datetime_value: str | None = None) -> dict | None:
    return driver.execute_script(
        """
        const wanted = arguments[0];
        const visible = (el) => {
          const s = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        };
        const elements = Array.from(document.querySelectorAll('relative-time')).filter(visible);
        let el = wanted ? elements.find((item) => item.getAttribute('datetime') === wanted) : null;
        if (!el) {
          el = elements.find((item) => /ago|minute|hour|day|week|yesterday|last/i.test(item.shadowRoot?.textContent || '')) || elements[0] || null;
        }
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          datetime: el.getAttribute('datetime'),
          lang: el.getAttribute('lang'),
          fallbackText: (el.textContent || '').replace(/\s+/g, ' ').trim(),
          renderedText: (el.shadowRoot?.textContent || '').replace(/\s+/g, ' ').trim(),
          width: r.width,
          height: r.height,
          generated: el.querySelectorAll('[data-flt-generated="translation"]').length,
          wrappers: el.querySelectorAll('[data-flt-source-text-wrapper]').length,
        };
        """,
        datetime_value,
    )


def repository_layout_state(driver: webdriver.Firefox) -> dict:
    return driver.execute_script(
        """
        const visible = (el) => {
          if (!el) return false;
          const s = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return s.display !== 'none' && s.visibility !== 'hidden' && Number.parseFloat(s.opacity || '1') > 0 && r.width > 0 && r.height > 0;
        };
        const tabIds = ['code-tab','issues-tab','pull-requests-tab','actions-tab','projects-tab','security-and-quality-tab','insights-tab'];
        const tabs = {};
        for (const id of tabIds) {
          const el = document.getElementById(id);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          tabs[id] = {
            visible: visible(el),
            display: getComputedStyle(el).display,
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            visibleIcons: Array.from(el.querySelectorAll('svg,img')).filter(visible).length,
            generated: el.querySelectorAll('[data-flt-generated="translation"]').length,
            wrappers: el.querySelectorAll('[data-flt-source-text-wrapper]').length,
            text: (el.innerText || el.textContent || '').replace(/\\s+/g,' ').trim(),
            href: el.getAttribute('href'),
          };
        }
        const repoPathPrefix = '/Kerberos255/chatgpt-codex-tools-mcp/';
        const pathIdentifiers = Array.from(document.querySelectorAll('a[href*="/tree/"],a[href*="/blob/"]'))
          .filter((el) => {
            const href = el.getAttribute('href') || '';
            const text = (el.textContent || '').replace(/\\s+/g,' ').trim();
            return visible(el) && href.startsWith(repoPathPrefix) && text.length > 0;
          })
          .slice(0, 40)
          .map((el) => {
            const row = el.closest('tr,[role="row"],li,div[role="row"]') || el.parentElement;
            const r = el.getBoundingClientRect();
            return {
              text: (el.textContent || '').replace(/\\s+/g,' ').trim(),
              href: el.getAttribute('href'),
              visible: visible(el),
              x: r.x,
              width: r.width,
              generated: el.querySelectorAll('[data-flt-generated="translation"]').length,
              wrappers: el.querySelectorAll('[data-flt-source-text-wrapper]').length,
              visibleIconsInRow: row ? Array.from(row.querySelectorAll('svg,img')).filter(visible).length : 0,
            };
          });
        const file = pathIdentifiers.find((item) => /(?:src|tests|README\.md|CHANGELOG\.md|package\.json|\.github)/i.test(item.text)) || pathIdentifiers[0] || null;
        const visibleGeneratedZeros = Array.from(document.querySelectorAll('.flt-translation'))
          .filter((el) => visible(el) && (el.textContent || '').trim() === '0').length;
        const hiddenStateLeaks = Array.from(document.querySelectorAll('.flt-translation'))
          .filter((el) => visible(el) && /You must be signed in to change notification settings/i.test(el.textContent || ''))
          .map((el) => (el.textContent || '').trim());
        return {tabs, file, pathIdentifiers, visibleGeneratedZeros, hiddenStateLeaks};
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
        divider_before = readme_divider_state(driver)
        relative_time_before = relative_time_state(driver)
        repo_layout_before = repository_layout_state(driver)
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

            const card = document.createElement('section');
            card.id = 'pagelingo-e2e-terminology-card';
            card.style.cssText = [
              'position:fixed','right:18px','top:210px','z-index:2147483640',
              'width:440px','padding:14px 16px','border:1px solid #6e7681',
              'border-radius:8px','background:#0d1117','color:#f0f6fc',
              'font:14px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
              'box-shadow:0 8px 24px rgba(0,0,0,.35)'
            ].join(';');
            card.innerHTML = [
              '<h3 style="margin:0 0 8px;font-size:16px">Terminology safety</h3>',
              '<p id="pagelingo-e2e-term-sentence" style="margin:0 0 8px">Configure Slack notifications for OpenAI with Gateway settings.</p>',
              '<p id="pagelingo-e2e-cross-industry" style="margin:0 0 8px">NVIDIA works with PayPal, Toyota, Spotify, Airbnb, and Pfizer.</p>',
              '<p style="margin:0"><a id="pagelingo-e2e-term-link" href="#term">Slack settings</a></p>'
            ].join('');
            document.body.append(card);
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
        WebDriverWait(driver, 30).until(
            lambda d: d.execute_script(
                """
                const sentence = document.getElementById('pagelingo-e2e-term-sentence');
                const crossIndustry = document.getElementById('pagelingo-e2e-cross-industry');
                const link = document.getElementById('pagelingo-e2e-term-link');
                const sentenceTranslation = sentence?.nextElementSibling;
                const crossIndustryTranslation = crossIndustry?.nextElementSibling;
                const linkTranslation = link?.querySelector('.flt-translation') || link?.nextElementSibling;
                const text = [
                  sentenceTranslation?.textContent || '',
                  crossIndustryTranslation?.textContent || '',
                  linkTranslation?.textContent || ''
                ].join(' ');
                return /Slack/.test(text) && /OpenAI/.test(text) && /网关/.test(text)
                  && /NVIDIA/.test(text) && /PayPal/.test(text) && /Toyota/.test(text)
                  && /Spotify/.test(text) && /Airbnb/.test(text) && /Pfizer/.test(text);
                """
            )
        )
        terminology_state = driver.execute_script(
            """
            const card = document.getElementById('pagelingo-e2e-terminology-card');
            const sentence = document.getElementById('pagelingo-e2e-term-sentence');
            const crossIndustry = document.getElementById('pagelingo-e2e-cross-industry');
            const link = document.getElementById('pagelingo-e2e-term-link');
            const sentenceTranslation = sentence?.nextElementSibling;
            const crossIndustryTranslation = crossIndustry?.nextElementSibling;
            const linkTranslation = link?.querySelector('.flt-translation') || link?.nextElementSibling;
            const visibleText = (card?.innerText || card?.textContent || '').replace(/\s+/g, ' ').trim();
            return {
              visibleText,
              sentenceTranslation: (sentenceTranslation?.textContent || '').trim(),
              crossIndustryTranslation: (crossIndustryTranslation?.textContent || '').trim(),
              linkTranslation: (linkTranslation?.textContent || '').trim(),
              containsSlack: /Slack/.test(visibleText),
              containsOpenAI: /OpenAI/.test(visibleText),
              containsGateway: /网关/.test(visibleText),
              containsCrossIndustry: ["NVIDIA","PayPal","Toyota","Spotify","Airbnb","Pfizer"].every((name) => visibleText.includes(name)),
              containsCorruptSlack: /松��/.test(visibleText),
              containsCorruptOpenAI: /开放人工智能/.test(visibleText),
              containsCorruptCrossIndustry: /英伟达|贝宝|丰田|声田|爱彼迎|辉瑞/.test(visibleText),
              containsReplacement: /�/.test(visibleText)
            };
            """
        )
        if (
            not terminology_state["containsSlack"]
            or not terminology_state["containsOpenAI"]
            or not terminology_state["containsGateway"]
            or not terminology_state["containsCrossIndustry"]
        ):
            raise AssertionError(f"Hard/preferred terminology was not preserved: {terminology_state}")
        if (
            terminology_state["containsCorruptSlack"]
            or terminology_state["containsCorruptOpenAI"]
            or terminology_state["containsCorruptCrossIndustry"]
            or terminology_state["containsReplacement"]
        ):
            raise AssertionError(f"Corrupt terminology leaked into visible output: {terminology_state}")
        driver.save_screenshot(str(ARTIFACTS / "github-terminology.png"))
        if not divider_before:
            raise AssertionError("No visible README h2 divider found on GitHub fixture")
        divider_after = readme_divider_state(driver)
        if not divider_after:
            raise AssertionError("README h2 divider disappeared after translation")
        if divider_after["borderBottomWidth"] != divider_before["borderBottomWidth"]:
            raise AssertionError(f"README divider width changed: {divider_before} -> {divider_after}")
        if divider_after["visibility"] == "hidden" or divider_after["display"] == "none":
            raise AssertionError(f"README divider heading became hidden: {divider_after}")
        if divider_after["generated"] <= 0:
            raise AssertionError(f"README heading was not translated in-place: {divider_after}")

        if not relative_time_before or not relative_time_before.get("datetime"):
            raise AssertionError("No visible GitHub relative-time element found")
        WebDriverWait(driver, 20).until(
            lambda d: (
                (state := relative_time_state(d, relative_time_before["datetime"])) is not None
                and state.get("lang") in {"zh-CN", "zh-Hans"}
                and bool(__import__("re").search(r"[\u3400-\u9fff]", state.get("renderedText", "")))
            )
        )
        relative_time_after = relative_time_state(driver, relative_time_before["datetime"])
        if relative_time_after["generated"] or relative_time_after["wrappers"]:
            raise AssertionError(f"relative-time fallback was translated as normal DOM text: {relative_time_after}")
        if relative_time_after["fallbackText"] != relative_time_before["fallbackText"]:
            raise AssertionError(f"relative-time fallback DOM was mutated: {relative_time_before} -> {relative_time_after}")

        repo_layout_after = repository_layout_state(driver)
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
        for tab_id, before_tab in repo_layout_before["tabs"].items():
            after_tab = repo_layout_after["tabs"].get(tab_id)
            if not after_tab:
                raise AssertionError(f"GitHub repository tab disappeared: {tab_id}")
            if before_tab["visible"] and not after_tab["visible"]:
                raise AssertionError(f"GitHub repository tab became hidden: {tab_id}: {before_tab} -> {after_tab}")
            if before_tab["visibleIcons"] > 0 and after_tab["visibleIcons"] < before_tab["visibleIcons"]:
                raise AssertionError(f"GitHub repository tab icon disappeared: {tab_id}: {before_tab} -> {after_tab}")
            if before_tab["visible"] and abs(after_tab["x"] - before_tab["x"]) > 1:
                raise AssertionError(f"GitHub repository tab shifted horizontally: {tab_id}: {before_tab} -> {after_tab}")
        if repo_layout_after["visibleGeneratedZeros"] != 0:
            raise AssertionError(f"Hidden numeric counters leaked into translations: {repo_layout_after}")
        if repo_layout_after["hiddenStateLeaks"]:
            raise AssertionError(f"Hidden notification state leaked into translations: {repo_layout_after}")
        before_paths = {item["href"]: item for item in repo_layout_before.get("pathIdentifiers", [])}
        after_paths = {item["href"]: item for item in repo_layout_after.get("pathIdentifiers", [])}
        if not before_paths:
            raise AssertionError("No visible GitHub tree/blob path identifiers were found")
        for href, before_path in before_paths.items():
            after_path = after_paths.get(href)
            if not after_path:
                raise AssertionError(f"GitHub path identifier disappeared: {before_path}")
            if after_path["text"] != before_path["text"]:
                raise AssertionError(f"GitHub file/path identifier changed: {before_path} -> {after_path}")
            if after_path["generated"] or after_path["wrappers"]:
                raise AssertionError(f"GitHub file/path identifier was translated: {after_path}")
            if before_path["visibleIconsInRow"] > 0 and after_path["visibleIconsInRow"] < before_path["visibleIconsInRow"]:
                raise AssertionError(f"GitHub file row icon disappeared: {before_path} -> {after_path}")
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

        # Automatic-translation regression: GitHub's Turbo/SPA lifecycle must not
        # restore the persistent repository navigation back to English after it was
        # translated. Configure the site for automatic translation, reload from a
        # clean document, then exercise both our route detector and a real GitHub tab
        # navigation.
        driver.switch_to.window(extension_handle)
        driver.execute_async_script(
            """
            const done = arguments[0];
            browser.storage.local.set({
              autoTranslateEnabled: true,
              alwaysTranslateSites: ['github.com'],
              neverTranslateSites: [],
              neverTranslateLanguages: [],
              alwaysTranslateLanguages: []
            }).then(() => done({ok:true}))
              .catch((error) => done({ok:false,error:String(error)}));
            """
        )
        driver.switch_to.window(target_handle)
        driver.get(TARGET_URL)
        WebDriverWait(driver, 60).until(
            lambda d: d.execute_script(
                """
                const tab = document.getElementById('code-tab');
                const translated = tab?.querySelector('[data-flt-generated="translation"]');
                return Boolean(translated && /代码/.test(tab.innerText || tab.textContent || ''));
                """
            )
        )
        time.sleep(1.0)
        auto_initial = repository_layout_state(driver)
        for tab_id in ("code-tab", "issues-tab", "pull-requests-tab", "actions-tab", "projects-tab"):
            tab = auto_initial["tabs"].get(tab_id)
            if tab and tab["visible"] and tab["generated"] <= 0:
                raise AssertionError(f"Automatic translation did not translate GitHub navigation: {tab_id}: {tab}")

        driver.execute_script(
            """
            window.__pagelingoContinuitySamples = [];
            if (window.__pagelingoContinuityTimer) clearInterval(window.__pagelingoContinuityTimer);
            const sample = () => {
              const tab = document.getElementById('code-tab');
              const generated = tab?.querySelectorAll('[data-flt-generated="translation"]').length ?? -1;
              const wrapper = tab?.querySelector('[data-flt-source-text-wrapper]');
              window.__pagelingoContinuitySamples.push({
                generated,
                text: (tab?.innerText || tab?.textContent || '').replace(/\s+/g, ' ').trim(),
                sourceDisplay: wrapper ? getComputedStyle(wrapper).display : null
              });
            };
            sample();
            window.__pagelingoContinuityTimer = setInterval(sample, 10);
            const url = new URL(location.href);
            url.searchParams.set('pagelingo-spa-e2e', String(Date.now()));
            history.pushState({}, '', url);
            window.dispatchEvent(new PopStateEvent('popstate'));
            setTimeout(() => {
              clearInterval(window.__pagelingoContinuityTimer);
              window.__pagelingoContinuityTimer = null;
            }, 1800);
            """
        )
        time.sleep(2.2)
        continuity_samples = driver.execute_script("return window.__pagelingoContinuitySamples || []")
        lost_translation = [
            item for item in continuity_samples
            if item.get("generated", -1) <= 0 or "代码" not in item.get("text", "")
        ]
        if lost_translation:
            raise AssertionError(
                f"GitHub automatic navigation flashed/restored to English during SPA route handling: "
                f"{lost_translation[:12]}"
            )

        driver.execute_script(
            """
            const issues = document.getElementById('issues-tab');
            if (!issues) throw new Error('issues-tab not found');
            issues.click();
            """
        )
        WebDriverWait(driver, 60).until(lambda d: "/issues" in d.current_url)
        WebDriverWait(driver, 60).until(
            lambda d: d.execute_script(
                """
                const code = document.getElementById('code-tab');
                const issues = document.getElementById('issues-tab');
                return Boolean(
                  code?.querySelector('[data-flt-generated="translation"]') &&
                  issues?.querySelector('[data-flt-generated="translation"]')
                );
                """
            )
        )
        time.sleep(4.0)
        auto_after_route = repository_layout_state(driver)
        for tab_id in ("code-tab", "issues-tab", "pull-requests-tab", "actions-tab", "projects-tab"):
            tab = auto_after_route["tabs"].get(tab_id)
            if tab and tab["visible"] and tab["generated"] <= 0:
                raise AssertionError(f"GitHub navigation reverted after automatic SPA navigation: {tab_id}: {tab}")
        driver.save_screenshot(str(ARTIFACTS / "github-auto-after-route.png"))

        print(json.dumps({
            "translated_roots": value.get("count"),
            "divider_before": divider_before,
            "divider_after": divider_after,
            "relative_time_before": relative_time_before,
            "relative_time_after": relative_time_after,
            "repository_layout_before": repo_layout_before,
            "repository_layout_after": repo_layout_after,
            "layout_before": layout_before,
            "layout_after": layout_after,
            "repository_identity_before": identity_before,
            "repository_identity_after": identity_after,
            "repository_chrome_before": chrome_before,
            "repository_chrome_after": chrome_after,
            "visible_probe": probe_state,
            "terminology_state": terminology_state,
            "hidden_headings_before": before,
            "hidden_headings_after": after,
            "visible_leaks": visible_leaks,
            "auto_initial": auto_initial,
            "auto_continuity_sample_count": len(continuity_samples),
            "auto_after_route": auto_after_route,
        }, ensure_ascii=False, indent=2))
        driver.switch_to.window(extension_handle)
    finally:
        driver.quit()
        translation_server.shutdown()
        translation_server.server_close()


if __name__ == "__main__":
    main()
