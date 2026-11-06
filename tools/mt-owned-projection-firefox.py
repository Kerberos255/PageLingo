"""Capture, preview without writes, then apply scope-reviewed frozen proposals."""
import argparse
import datetime
import gzip
import hashlib
import json
from pathlib import Path
import subprocess
import time
from mt_public_firefox import public_firefox

ROOT = Path(__file__).resolve().parents[1]


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    for name in ['sites', 'parent', 'firefox', 'geckodriver', 'output']: parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--mode', choices=['capture', 'preview', 'commit'], default='capture')
    parser.add_argument('--input', type=Path)
    parser.add_argument('--punctuation-policy', choices=['strict', 'prose-v1'], default='strict')
    args = parser.parse_args()
    if args.output.exists(): raise ValueError('Preserve earlier evidence; use a new directory')
    if args.mode != 'capture' and not args.input: raise ValueError('Preview/commit require frozen input')
    args.output.mkdir(parents=True)
    runtime = args.output.resolve() / 'runtime.js'
    subprocess.run(['node', '--input-type=module', '-e', "import{build}from'esbuild';await build({entryPoints:['eval/mt-quality/browser-owned-projection.ts'],bundle:true,platform:'browser',format:'iife',globalName:'OwnedEval',footer:{js:'window.__ownedEval=OwnedEval;'},outfile:process.argv[1],logLevel:'silent'});", str(runtime)], cwd=ROOT, check=True)
    sites = json.loads(args.sites.read_text()); parent = json.loads(args.parent.read_text())
    items = parent['cases'] if args.mode == 'capture' else json.loads(args.input.read_text())
    if args.mode == 'capture': items = [{**x, 'punctuation_policy': args.punctuation_policy} for x in items]
    policy = 'prose-v1' if any(x.get('punctuation_policy') == 'prose-v1' for x in items) else 'strict'
    result = {'protocol': 'typed-punctuation-projection-v12-browser' if policy == 'prose-v1' else 'production-owned-projection-v11-browser', 'mode': args.mode,
              'punctuation_policy': policy,
              'started_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'parent_plan_sha256': sha(args.parent),
              'runtime_sha256': sha(runtime), 'sites_sha256': sha(args.sites), 'new_model_inference': False,
              'tls_verification_enabled': True, 'sites': []}
    if args.input: result['input_sha256'] = sha(args.input)
    internal_errors = []
    with public_firefox(args.firefox, args.geckodriver, args.output / 'geckodriver.log') as driver:
        result['browser_version'] = driver.capabilities['browserVersion']
        result['accept_insecure_certs'] = driver.capabilities['acceptInsecureCerts']
        for site in sites:
            selected = [x for x in items if x['site_id'] == site['id']]
            if not selected: continue
            began = time.perf_counter(); one = {'id': site['id'], 'url': site['url']}
            try:
                driver.get(site['url'])
                driver.execute_async_script("const done=arguments[0];Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,1800))]).then(()=>done(true));")
                driver.execute_script(runtime.read_text())
                if args.mode == 'capture':
                    one['results'] = driver.execute_script("return window.__ownedEval.captureOwnedWebCases(arguments[0]);", selected)
                    document = driver.page_source.encode(); file = args.output / (site['id'] + '.html.gz')
                    file.write_bytes(gzip.compress(document, mtime=0)); one['document_sha256'] = hashlib.sha256(document).hexdigest()
                else:
                    one['results'] = []
                    for item in selected:
                        row = driver.execute_script("return window.__ownedEval.inspectOwnedWebCase(arguments[0],arguments[1]);", item, args.mode)
                        one['results'].append(row)
                one['final_url'] = driver.current_url
            except Exception as error:
                one['error'] = str(error)[:2200]
                internal_errors.append(site['id'])
            one['wall_s'] = time.perf_counter() - began; result['sites'].append(one)
            (args.output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
            print(json.dumps({'site': site['id'], 'mode': args.mode, 'records': len(one.get('results', [])), 'error': one.get('error')}), flush=True)
    result['finished_utc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    result['site_errors'] = internal_errors
    (args.output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    if internal_errors: raise RuntimeError('Browser stage had failures; inspect saved site evidence')


if __name__ == '__main__': main()
