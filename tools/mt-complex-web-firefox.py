"""Live public-page capture/replay. Native recorded model outputs, no browser inference."""
import argparse
import datetime
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from urllib.parse import urlsplit

from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

ROOT = Path(__file__).resolve().parents[1]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    for name in ['sites', 'firefox', 'geckodriver', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--input', type=Path)
    parser.add_argument('--api-protection', action='store_true')
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError('Preserve prior browser evidence; use a new directory')
    args.output.mkdir(parents=True)
    runtime = args.output.resolve() / 'runtime.js'
    subprocess.run(['node', '--input-type=module', '-e', "import{build}from'esbuild';await build({entryPoints:['eval/mt-quality/complex-web.ts'],bundle:true,platform:'browser',format:'iife',globalName:'PLComplexWeb',footer:{js:'window.__plComplexWeb=PLComplexWeb;'},outfile:process.argv[1],logLevel:'silent'});", str(runtime)], cwd=ROOT, check=True)
    script = runtime.read_text()
    sites = json.loads(args.sites.read_text())
    inputs = json.loads(args.input.read_text()) if args.input else None
    result = {'protocol': 'complex-live-web-v10', 'mode': 'api-protection' if args.api_protection else 'replay' if inputs else 'capture',
              'started_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'sites_sha256': sha(args.sites),
              'runtime_sha256': sha(runtime), 'new_browser_model_inference': False,
              'tls_verification_enabled': True, 'external_links_clicked': False, 'sites': []}
    if inputs:
        result['input_sha256'] = sha(args.input)
    driver = None
    with tempfile.TemporaryDirectory(prefix='pagelingo-complex-web-') as profile:
        subprocess.run(['certutil', '-N', '-d', 'sql:' + profile, '--empty-password'], check=True, stdout=subprocess.DEVNULL)
        # Import only public trust certificates; never read credential files.
        for i, cert in enumerate(Path('/usr/local/share/ca-certificates').glob('*.crt')):
            subprocess.run(['certutil', '-A', '-d', 'sql:' + profile, '-n', 'environment-ca-' + str(i),
                            '-t', 'C,,', '-i', str(cert)], check=True, stdout=subprocess.DEVNULL)
        options = Options()
        options.binary_location = str(args.firefox.resolve())
        options.add_argument('-headless')
        options.ignore_local_proxy_environment_variables()
        options.accept_insecure_certs = False
        options.profile = profile
        options.page_load_strategy = 'eager'
        proxy = urlsplit(os.environ.get('HTTPS_PROXY') or os.environ['HTTP_PROXY'])
        for key, value in {'network.proxy.type': 1, 'network.proxy.http': proxy.hostname, 'network.proxy.http_port': proxy.port,
                           'network.proxy.ssl': proxy.hostname, 'network.proxy.ssl_port': proxy.port,
                           'network.proxy.no_proxies_on': '127.0.0.1,localhost', 'browser.cache.disk.enable': False,
                           'permissions.default.image': 2, 'dom.ipc.processCount': 2}.items():
            options.set_preference(key, value)
        try:
            driver = webdriver.Firefox(options=options, service=Service(str(args.geckodriver.resolve()), log_output=str(args.output / 'geckodriver.log')))
            driver.set_page_load_timeout(40)
            driver.set_script_timeout(40)
            driver.set_window_size(1440, 1000)
            result['browser_version'] = driver.capabilities['browserVersion']
            result['accept_insecure_certs'] = driver.capabilities['acceptInsecureCerts']
            assert result['accept_insecure_certs'] is False
            for site in sites:
                began = time.perf_counter()
                row = {'id': site['id'], 'requested_url': site['url']}
                try:
                    driver.get(site['url'])
                    driver.execute_async_script("const done=arguments[0];Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,1800))]).then(()=>done(true));")
                    driver.execute_script(script)
                    if not inputs:
                        captured = driver.execute_script("return window.__plComplexWeb.captureComplexPage(arguments[0],arguments[1],3)", site['id'], site.get('selectors', ['main', 'article', 'body']))
                        source = driver.page_source.encode()
                        snapshot = args.output / (site['id'] + '.html.gz')
                        snapshot.write_bytes(gzip.compress(source, mtime=0))
                        row.update(captured=captured, document_sha256=hashlib.sha256(source).hexdigest(), document_bytes=len(source),
                                   compressed_document_sha256=sha(snapshot))
                    else:
                        replayed = []
                        if args.api_protection:
                            replayed = driver.execute_async_script("const items=arguments[0],done=arguments[1];window.__plComplexWeb.verifyLiveApiSignatures(items).then(done).catch(e=>done([{harness_error:String(e)}]));", [item for item in inputs if item['site_id'] == site['id']])
                        for item in [item for item in inputs if item['site_id'] == site['id']]:
                            if args.api_protection:
                                break
                            one = driver.execute_async_script("const item=arguments[0],done=arguments[1];window.__plComplexWeb.replayOnLiveRoot(item).then(done).catch(e=>done({harness_error:String(e),stack:e.stack,id:item.id}));", item)
                            replayed.append({'model': item['model'], **one})
                            if 'harness_error' in one:
                                raise RuntimeError(json.dumps(one))
                        row['replays'] = replayed
                        row['final_url'] = driver.current_url
                    row['ready_state'] = driver.execute_script('return document.readyState')
                except Exception as error:
                    row['error'] = str(error)[:1800]
                row['wall_s'] = time.perf_counter() - began
                result['sites'].append(row)
                (args.output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
                print(json.dumps({'site': site['id'], 'error': row.get('error'),
                                  'cases': len(row.get('captured', {}).get('cases', row.get('replays', []))), 'wall_s': row['wall_s']}), flush=True)
            result['finished_utc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            (args.output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        finally:
            if driver:
                driver.quit()


if __name__ == '__main__':
    main()
