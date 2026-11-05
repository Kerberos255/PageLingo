"""Replay recorded span assignments in actual Firefox; no model inference here."""
import argparse
import datetime
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import threading
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
for name in ['root', 'firefox', 'geckodriver', 'output']: parser.add_argument('--' + name, type=Path, required=True)
args = parser.parse_args()
if args.output.exists(): raise ValueError('Preserve browser evidence')
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
plan_file = args.root / 'final-plan.json'
plan = json.loads(plan_file.read_text()); inputs = []
for name, expected_model in [('fp32', '960f81703cbb279235260457c39ab8d106224245d85bab5e59f6895096d94edc'),
                              ('int8', 'beb17c2e9520155f7da7bb94a1fb8e74f5e528acdbd8f4415854c99a3d84f429')]:
    run_file = args.root / (name + '-final-run.json')
    run = json.loads(run_file.read_text()); replay = json.loads((args.root / (name + '-final-replay.json')).read_text())
    assert run.get('finished_utc') and run['plan_sha256'] == replay['plan_sha256'] == sha(plan_file)
    assert run['model_sha256'] == expected_model and replay['alignment_run_sha256'] == sha(run_file)
    assert len(run['rows']) == len(replay['results']) == len(plan['cases'])
    for sample, row, expected in zip(plan['cases'], run['rows'], replay['results']):
        assert row['id'] == expected['id'] == sample['id'] and row['target_sha256'] == hashlib.sha256(sample['frozen_target'].encode()).hexdigest()
        inputs.append({'model': name, 'sample': {'id': sample['id'], 'html': sample['html']}, 'target': sample['frozen_target'],
                       'spans': row['spans'] if row['status'] == 'projected' else [], 'expected': expected})
args.output.mkdir(parents=True)
runtime = args.output.resolve() / 'runtime.mjs'
subprocess.run(['node', '--input-type=module', '-e', "import{build}from'esbuild';await build({entryPoints:['eval/mt-quality/browser-frozen-projection.ts'],bundle:true,platform:'browser',format:'esm',outfile:process.argv[1],logLevel:'silent'});", str(runtime)], cwd=ROOT, check=True)
(args.output / 'input.json').write_text(json.dumps(inputs, ensure_ascii=False))
(args.output / 'index.html').write_text('<!doctype html><meta charset="utf-8"><title>Frozen target structure check</title>')


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw): super().__init__(*a, directory=str(args.output.resolve()), **kw)
    def log_message(self, *a): pass


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
options = Options(); options.binary_location = str(args.firefox.resolve()); options.add_argument('-headless')
options.ignore_local_proxy_environment_variables(); driver = None
try:
    driver = webdriver.Firefox(options=options, service=Service(str(args.geckodriver.resolve()), log_output=str(args.output / 'geckodriver.log')))
    driver.get(f'http://127.0.0.1:{server.server_port}/index.html'); driver.set_script_timeout(120)
    result = driver.execute_async_script("""const done=arguments[0];Promise.all([import('./runtime.mjs'),fetch('./input.json').then(r=>r.json())]).then(([api,input])=>api.runFrozenProjectionBrowser(input)).then(done).catch(e=>done({error:String(e),stack:e.stack}));""")
    if 'error' in result: raise RuntimeError(json.dumps(result))
    result.update(browser_version=driver.capabilities['browserVersion'], timestamp_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  plan_sha256=sha(plan_file), runtime_sha256=sha(runtime))
    (args.output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    keys = ['original_structure_unchanged', 'code_unchanged', 'original_link_listeners_preserved', 'surrounding_text_unchanged', 'restored_exact']
    rows = result['actual'] + result['manual_structure_fixtures']
    assert len(result['actual']) == len(inputs)
    assert all(row[k] for row in rows for k in keys)
    assert all(r['node_text_matches'] and r['node_display_matches'] for r in result['actual'])
    assert all(r['expected_display_matches'] for r in result['manual_structure_fixtures'])
    assert all(r['frozen_target_exact'] for r in rows if r['displayed'])
    assert all(r['rejected_source_untouched'] for r in rows if not r['displayed'])
    print(json.dumps({'browser': result['browser_version'], 'recorded_assignments': len(result['actual']),
                      'manual_structure_fixtures': len(result['manual_structure_fixtures']), 'checks': {k: sum(r[k] for r in rows) for k in keys},
                      'frozen_text_exact_for_displayed': True, 'new_browser_model_inference': False}))
finally:
    if driver: driver.quit()
    server.shutdown()
