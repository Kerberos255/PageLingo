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

from openclaw_bergamot_perf import ADDON_ID, content_message, extension_uuid

TARGETS = [
    ("openclaw-getting-started", "https://docs.openclaw.ai/getting-started"),
    ("openclaw-memory", "https://docs.openclaw.ai/concepts/memory"),
    ("openclaw-main-session", "https://docs.openclaw.ai/concepts/main-session"),
    ("openclaw-browser", "https://docs.openclaw.ai/tools/browser"),
    ("openclaw-feishu", "https://docs.openclaw.ai/channels/feishu"),
    ("openclaw-config-reference", "https://docs.openclaw.ai/gateway/configuration-reference"),
    ("github-docs-set-up-git", "https://docs.github.com/en/get-started/git-basics/set-up-git"),
    ("mdn-regular-expressions", "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Regular_expressions"),
    ("rust-book-getting-started", "https://doc.rust-lang.org/book/ch01-00-getting-started.html"),
    ("django-tutorial-1", "https://docs.djangoproject.com/en/stable/intro/tutorial01/"),
    ("game-a-dark-room", "https://adarkroom.doublespeakgames.com/"),
    ("game-universal-paperclips", "https://www.decisionproblem.com/paperclips/"),
    ("game-kittens", "https://kittensgame.com/web/"),
    ("game-trimps", "https://trimps.github.io/"),
    ("game-cookie-clicker", "https://orteil.dashnet.org/cookieclicker/"),
]


def percentile(values: list[float], q: float) -> float:
    if not values:
        return 0
    values = sorted(values)
    index = max(0, min(len(values) - 1, int(-(-q * len(values) // 1)) - 1))
    return values[index]


def distribution(values: list[float]) -> dict:
    return {
        "p50": percentile(values, 0.50),
        "p90": percentile(values, 0.90),
        "p95": percentile(values, 0.95),
        "p99": percentile(values, 0.99),
        "max": max(values) if values else 0,
    }


def summarize(pages: list[dict]) -> dict:
    roots = [root for page in pages if page.get("ok") for root in page["telemetry"].get("roots", [])]
    marker_counts = [float(root["markerCandidateCount"]) for root in roots]
    densities = [float(root["markerDensityPer100Chars"]) for root in roots]
    chars = [float(root["textChars"]) for root in roots]
    depths = [float(root["maxMarkerDepth"]) for root in roots]
    return {
        "pagesRequested": len(pages),
        "pagesSucceeded": sum(bool(page.get("ok")) for page in pages),
        "rootCount": len(roots),
        "markerCount": distribution(marker_counts),
        "markerDensityPer100Chars": distribution(densities),
        "textChars": distribution(chars),
        "maxMarkerDepth": distribution(depths),
        "rootsWithAtLeast8Markers": sum(value >= 8 for value in marker_counts),
        "rootsWithAtLeast12Markers": sum(value >= 12 for value in marker_counts),
        "rootsWithAtLeast16Markers": sum(value >= 16 for value in marker_counts),
    }


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("Usage: dom_marker_telemetry.py <xpi> <output-json>")

    xpi = Path(sys.argv[1]).resolve()
    output = Path(sys.argv[2]).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    options = Options()
    options.add_argument("-headless")
    options.set_preference("intl.accept_languages", "en-US,en")
    options.set_preference("intl.locale.requested", "en-US")
    firefox_binary = os.environ.get("FIREFOX_BINARY")
    if firefox_binary:
        options.binary_location = firefox_binary

    driver = webdriver.Firefox(options=options, service=Service(service_args=["--allow-system-access"]))
    driver.set_page_load_timeout(120)
    driver.set_script_timeout(120)
    driver.set_window_size(1440, 1000)
    pages: list[dict] = []

    try:
        addon_id = driver.install_addon(str(xpi), temporary=True)
        if addon_id != ADDON_ID:
            raise AssertionError(f"Unexpected add-on id: {addon_id}")

        uuid = extension_uuid(driver, addon_id)
        driver.switch_to.new_window("tab")
        extension_handle = driver.current_window_handle
        driver.get(f"moz-extension://{uuid}/settings.html")
        WebDriverWait(driver, 30).until(lambda d: d.execute_script("return typeof browser !== 'undefined'"))

        driver.switch_to.new_window("tab")
        target_handle = driver.current_window_handle

        for label, url in TARGETS:
            print(f"TELEMETRY_PAGE_START={label} {url}", flush=True)
            try:
                driver.switch_to.window(target_handle)
                driver.get(url)
                WebDriverWait(driver, 90).until(lambda d: d.execute_script("return document.readyState") == "complete")
                time.sleep(2.0)
                actual_url = driver.current_url

                driver.switch_to.window(extension_handle)
                response = None
                for _ in range(20):
                    response = content_message(
                        driver,
                        actual_url,
                        {"type": "get-dom-translation-telemetry"},
                        timeout=20,
                    )
                    if response.get("ok"):
                        break
                    time.sleep(0.5)
                if not response or not response.get("ok"):
                    raise AssertionError(f"Telemetry unavailable: {response}")

                telemetry = response["telemetry"]
                pages.append({
                    "label": label,
                    "requestedUrl": url,
                    "url": telemetry.get("url") or actual_url,
                    "ok": True,
                    "telemetry": telemetry,
                })
                summary = telemetry.get("summary", {})
                print(
                    "TELEMETRY_PAGE="
                    + json.dumps(
                        {
                            "label": label,
                            "rootCount": telemetry.get("rootCount"),
                            "markerCount": summary.get("markerCount"),
                            "rootsWithAtLeast8Markers": summary.get("rootsWithAtLeast8Markers"),
                            "rootsWithAtLeast12Markers": summary.get("rootsWithAtLeast12Markers"),
                            "rootsWithAtLeast16Markers": summary.get("rootsWithAtLeast16Markers"),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
            except Exception as exc:
                pages.append({
                    "label": label,
                    "requestedUrl": url,
                    "ok": False,
                    "error": f"{type(exc).__name__}: {exc}",
                })
                print(f"TELEMETRY_PAGE_FAILED={label} {type(exc).__name__}: {exc}", flush=True)

        result = {
            "version": "dom-marker-telemetry-v1",
            "privacy": "Counts/structure only; no source text or translated text is recorded.",
            "summary": summarize(pages),
            "pages": pages,
        }
        output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("DOM_MARKER_TELEMETRY=" + json.dumps(result["summary"], ensure_ascii=False), flush=True)

        openclaw_ok = sum(page.get("ok") and page["label"].startswith("openclaw-") for page in pages)
        external_ok = sum(page.get("ok") and not page["label"].startswith("openclaw-") for page in pages)
        if openclaw_ok != 6 or external_ok < 2:
            raise AssertionError(
                f"Insufficient telemetry coverage: openclaw={openclaw_ok}/6 external={external_ok}/4"
            )
    finally:
        driver.quit()


if __name__ == "__main__":
    main()
