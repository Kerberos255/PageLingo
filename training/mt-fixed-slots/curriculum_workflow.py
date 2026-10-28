"""Two bounded v3 adapter updates, four-arm evaluation, evidence-only handoff."""
import argparse
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid
import zipfile

from evaluate_gpu import sha256, write_json
from evaluate_matrix import pinned, validate_matrix_plan

HERE = Path(__file__).resolve().parent


def validate_package(here, allow_dirty=False):
    package = json.loads((here / 'package-manifest.json').read_text(encoding='utf-8'))
    if package.get('schema_version') != 1 or (package.get('source_dirty') is not False and not allow_dirty):
        raise ValueError('Expected a clean immutable source package')
    for name, record in package['files'].items():
        file = (here / name).resolve()
        if not file.is_relative_to(here) or file.stat().st_size != record['bytes'] or sha256(file) != record['sha256']:
            raise ValueError('Frozen runtime file changed: ' + name)
    return package


def completed_candidate(folder, config):
    result = json.loads((folder / 'training-result.json').read_text(encoding='utf-8'))
    if not result.get('training_executed') or result.get('run_kind') != 'synthetic_research_candidate':
        raise ValueError('Incomplete v3 training result')
    if result['optimizer_steps'] != config['candidate_max_steps'] or config['checkpoint_selection'] != 'final':
        raise ValueError('Fixed final checkpoint required')
    if result['config'] != config or result.get('initial_adapter', {}).get('sha256') != config['initial_adapter_sha256']:
        raise ValueError('Training configuration or initial adapter identity changed')
    if result['selection']['best_checkpoint'] is not None:
        raise ValueError('Validation loss selected an unexpected checkpoint')
    if not math.isfinite(float(result['validation_after']['eval_loss'])):
        raise ValueError('Non-finite validation result')
    adapter = folder / 'adapter'
    return {'directory': adapter, 'sha256': sha256(adapter / 'adapter_model.safetensors'),
            'config_sha256': sha256(adapter / 'adapter_config.json')}


def create_evidence(out, here, plan, source_commit):
    runs = json.loads((out / 'matrix/runs.json').read_text(encoding='utf-8'))
    labels = ['old_r16', 'old_r32', 'v3_r16', 'v3_r32']
    if not runs.get('finished_utc') or list(runs['files']) != labels or runs['plan_sha256'] != sha256(here / 'matrix-plan.json'):
        raise ValueError('All four matrix arms must finish before evidence is packaged')
    files = {'matrix/runs.json': out / 'matrix/runs.json', 'matrix-models.json': out / 'matrix-models.json',
             'matrix-plan.json': here / 'matrix-plan.json', 'package-manifest.json': here / 'package-manifest.json',
             'data-manifest.json': here / 'data/manifest.json', 'template-review.md': here / 'data/template-review.md'}
    for label in labels:
        record = runs['files'][label]
        if record['file'] != label + '.json':
            raise ValueError('Unexpected matrix result filename')
        file = out / 'matrix' / record['file']
        data = json.loads(file.read_text(encoding='utf-8'))
        if sha256(file) != record['sha256'] or not data.get('finished_utc') or len(data['generations']) != len(plan['jobs']):
            raise ValueError('Incomplete/changed matrix arm')
        files['matrix/' + file.name] = file
    for label in ['r16', 'r32']:
        files['training/' + label + '.json'] = out / label / 'training-result.json'
        files['configs/' + label + '.json'] = here / ('config-' + label + '.json')
    manifest = {'schema_version': 1, 'source_commit': source_commit, 'selection': 'none; retain both adapters',
                'scope': 'GPU training and BF16 evidence only; weights stay on GPU PC until a candidate is reviewed',
                'release_approved': False, 'files': {name: {'bytes': file.stat().st_size, 'sha256': sha256(file)} for name, file in files.items()}}
    archive = out / 'evidence.zip'
    if archive.exists():
        raise ValueError('Evidence output must be new')
    temporary = archive.with_suffix('.zip.tmp')
    with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
        for name, file in files.items():
            bundle.write(file, name)
    with zipfile.ZipFile(temporary) as bundle:
        for name, record in manifest['files'].items():
            if hashlib.sha256(bundle.read(name)).hexdigest() != record['sha256']:
                raise ValueError('Evidence ZIP verification failed')
    temporary.replace(archive)
    manifest['bundle'] = {'file': archive.name, 'bytes': archive.stat().st_size, 'sha256': sha256(archive)}
    write_json(out / 'evidence-manifest.json', manifest)
    return manifest['bundle']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--mode', choices=['check', 'run'], default='run')
    parser.add_argument('--plan', action='store_true')
    args = parser.parse_args(); root = args.root.resolve()
    if not HERE.is_relative_to(root):
        raise ValueError('Kit must stay within the project')
    package = validate_package(HERE, allow_dirty=args.mode == 'check' or args.plan)
    workflow = json.loads((HERE / 'workflow.json').read_text(encoding='utf-8'))
    plan = json.loads((HERE / 'matrix-plan.json').read_text(encoding='utf-8')); validate_matrix_plan(plan)
    if workflow['run_prefix'] != 'pagelingo-quality-v3' or [c['name'] for c in workflow['candidates']] != ['r16', 'r32']:
        raise ValueError('Unexpected v3 workflow')
    if args.plan:
        print(json.dumps({'source_commit': package['source_commit'], 'candidates': workflow['candidates'],
            'planned_generations': len(plan['jobs']) * 4, 'selection': 'none; all four arms evaluated',
            'browser_required': False, 'cpu_conversion_required': False, 'upload_executed': False}), flush=True)
        return 0
    if os.name == 'nt':
        if root.drive.upper() == 'C:' or root.drive.startswith('\\\\'):
            raise ValueError('Run on the GPU PC using the local non-C project drive')
        for key in ['TEMP', 'TMP', 'HF_HOME', 'HF_HUB_CACHE', 'TORCH_HOME', 'PIP_CACHE_DIR']:
            if key not in os.environ or not Path(os.environ[key]).resolve().is_relative_to(root):
                raise ValueError('Task cache escapes project or environment entry is missing: ' + key)
    if shutil.disk_usage(root).free < 2 * 2 ** 30:
        raise RuntimeError('At least 2 GiB free output space required')
    models = {'base': workflow['base'], 'adapters': workflow['baselines']}
    base = pinned(root, models['base'], 'model.safetensors')
    for record in models['adapters'].values():
        pinned(root, record, 'adapter_model.safetensors')
    configs = {candidate['name']: json.loads((HERE / candidate['config']).read_text(encoding='utf-8')) for candidate in workflow['candidates']}
    import torch
    if args.mode == 'run' and (not torch.cuda.is_available() or not torch.cuda.is_bf16_supported()):
        raise RuntimeError('BF16 CUDA GPU required; no training started')
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-') + uuid.uuid4().hex[:6]
    out = root / 'outputs' / (workflow['run_prefix'] + '-' + args.mode + '-' + stamp)
    out.mkdir(parents=True, exist_ok=False)
    status = {'source_commit': package['source_commit'], 'workflow_completed': False, 'training_completed': False,
              'gpu_comparison_completed': False, 'release_approved': False, 'upload_executed': False,
              'cloud_postprocessing_pending': True, 'selection': 'none; retain both fixed-final candidates',
              'started_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'stages': []}
    write_json(out / 'workflow-result.json', status)
    print('RUN_DIRECTORY=' + str(out), flush=True)
    log = (out / 'console.log').open('w', encoding='utf-8', buffering=1)
    def run(name, command):
        started = time.perf_counter()
        record = {'name': name, 'started_utc': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        status['stages'].append(record); write_json(out / 'workflow-result.json', status)
        print('STAGE=' + name, flush=True); log.write('STAGE=' + name + '\n')
        with subprocess.Popen(list(map(str, command)), cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True, encoding='utf-8', errors='replace') as process:
            try:
                for line in process.stdout:
                    print(line, end='', flush=True); log.write(line)
                code = process.wait()
            except BaseException:
                process.terminate()
                try: process.wait(timeout=15)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
                raise
        record.update(exit_code=code, wall_s=time.perf_counter() - started)
        write_json(out / 'workflow-result.json', status)
        if code:
            raise RuntimeError(name + ' failed; see console.log')
    try:
        for candidate in workflow['candidates']:
            run('preflight-' + candidate['name'], [sys.executable, '-u', HERE / 'train.py', '--data', HERE / 'data', '--base', base, '--project-root', root,
                 '--output', out / ('preflight-' + candidate['name']), '--config', HERE / candidate['config'], '--synthetic-candidate'])
        baseline_file = out / 'baseline-models.json'; write_json(baseline_file, models)
        run('matrix-preflight', [sys.executable, '-u', HERE / 'evaluate_matrix.py', '--root', root, '--output', out / 'matrix-check',
                                '--models', baseline_file, '--check-only'])
        if args.mode == 'check':
            status['check_completed'] = True; write_json(out / 'workflow-result.json', status)
            return 0
        for candidate in workflow['candidates']:
            name = candidate['name']
            run('train-' + name, [sys.executable, '-u', HERE / 'train.py', '--data', HERE / 'data', '--base', base,
                '--project-root', root, '--output', out / name, '--config', HERE / candidate['config'], '--synthetic-candidate', '--train'])
            record = completed_candidate(out / name, configs[name])
            record['directory'] = str(record['directory'].relative_to(root))
            models['adapters']['v3_' + name] = record
        status['training_completed'] = True; write_json(out / 'workflow-result.json', status)
        model_file = out / 'matrix-models.json'; write_json(model_file, models)
        run('matrix-four-arms', [sys.executable, '-u', HERE / 'evaluate_matrix.py', '--root', root, '--output', out / 'matrix', '--models', model_file])
        status['gpu_comparison_completed'] = True
        status['handoff'] = create_evidence(out, HERE, plan, package['source_commit'])
        status.update(workflow_completed=True, finished_utc=datetime.datetime.now(datetime.timezone.utc).isoformat())
        write_json(out / 'workflow-result.json', status)
        print('GPU_COMPLETE: both adapters retained; evidence.zip ready for Cloud review. No automatic winner or model upload.', flush=True)
        return 0
    except BaseException as error:
        status['error'] = repr(error); write_json(out / 'workflow-result.json', status)
        raise
    finally:
        log.close()


if __name__ == '__main__':
    raise SystemExit(main())
