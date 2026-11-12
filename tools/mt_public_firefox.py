"""Public-page Firefox context with verified TLS and the inherited HTTP proxy."""
from contextlib import contextmanager
import os
from pathlib import Path
import subprocess
import tempfile
from urllib.parse import urlsplit
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service


@contextmanager
def public_firefox(firefox, geckodriver, log, *, system_access=False, load_images=False):
    with tempfile.TemporaryDirectory(prefix='pagelingo-public-firefox-') as profile:
        subprocess.run(['certutil', '-N', '-d', 'sql:' + profile, '--empty-password'], check=True, stdout=subprocess.DEVNULL)
        for i, cert in enumerate(Path('/usr/local/share/ca-certificates').glob('*.crt')):
            subprocess.run(['certutil', '-A', '-d', 'sql:' + profile, '-n', 'environment-ca-' + str(i), '-t', 'C,,', '-i', str(cert)], check=True, stdout=subprocess.DEVNULL)
        options = Options(); options.binary_location = str(firefox.resolve()); options.add_argument('-headless')
        options.ignore_local_proxy_environment_variables(); options.accept_insecure_certs = False
        options.profile = profile; options.page_load_strategy = 'eager'
        proxy = urlsplit(os.environ.get('HTTPS_PROXY') or os.environ['HTTP_PROXY'])
        for key, value in {'network.proxy.type': 1, 'network.proxy.http': proxy.hostname, 'network.proxy.http_port': proxy.port,
                           'network.proxy.ssl': proxy.hostname, 'network.proxy.ssl_port': proxy.port,
                           'network.proxy.no_proxies_on': '127.0.0.1,localhost', 'browser.cache.disk.enable': False,
                           'permissions.default.image': 1 if load_images else 2, 'dom.ipc.processCount': 2}.items(): options.set_preference(key, value)
        service_args = ['--allow-system-access'] if system_access else []
        driver = webdriver.Firefox(options=options, service=Service(str(geckodriver.resolve()), service_args=service_args, log_output=str(log)))
        try:
            assert driver.capabilities['acceptInsecureCerts'] is False
            driver.set_page_load_timeout(40); driver.set_script_timeout(40); driver.set_window_size(1440, 1000)
            yield driver
        finally:
            driver.quit()
