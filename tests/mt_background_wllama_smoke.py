#!/usr/bin/env python3
from __future__ import annotations
import json, os, sys, time
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.ui import WebDriverWait

ADDON_ID="pagelingo@kerberos255"

def extension_uuid(driver, addon_id):
    with driver.context(driver.CONTEXT_CHROME):
        raw=driver.execute_script("""
          const prefs=Components.classes['@mozilla.org/preferences-service;1']
            .getService(Components.interfaces.nsIPrefBranch);
          return prefs.getStringPref('extensions.webextensions.uuids');
        """)
    return json.loads(raw)[addon_id]

def main():
    xpi=Path(sys.argv[1]).resolve()
    options=Options(); options.add_argument("-headless")
    if os.environ.get("FIREFOX_BINARY"): options.binary_location=os.environ["FIREFOX_BINARY"]
    driver=webdriver.Firefox(options=options,service=Service(service_args=["--allow-system-access"]))
    try:
        addon=driver.install_addon(str(xpi),temporary=True)
        uuid=extension_uuid(driver,addon)
        driver.get(f"moz-extension://{uuid}/mt-runtime-diag.html")
        started=time.monotonic()
        WebDriverWait(driver,60).until(
            lambda d:d.execute_script("return window.__mtRuntimeDiag && window.__mtRuntimeDiag.state !== 'running'")
        )
        result=driver.execute_script("return window.__mtRuntimeDiag")
        elapsed=time.monotonic()-started
        print("TINY_WLLAMA_RESULT=",json.dumps(result,ensure_ascii=False))
        print("TINY_WLLAMA_SECONDS=",elapsed)
        if not result.get("ok"):
            raise AssertionError(result)
        print("TINY_WLLAMA_EXTENSION_DOCUMENT=PASS")
    finally:
        driver.quit()

if __name__=="__main__": main()
