"""Verify and import the small GPU result bundle; never execute files from the bundle."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import zipfile

BASE_SHA = '29e9117a44c79f81857613601968ff482d8a23c2d6736a1710bba9e5ca4762e5'
OLD_SHA = '28a0bd981feab75390ec045a9b97b02401e8a5ab973118d7e54da7b9e77cf859'


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--source-commit', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    metadata = json.loads(args.manifest.read_text(encoding='utf-8'))
    if not re.fullmatch('[0-9a-f]{40}', args.source_commit) or metadata['source_commit'] != args.source_commit:
        raise ValueError('Wrong GPU source snapshot')
    if metadata['release_approved'] or metadata['upload_executed']:
        raise ValueError('Expected unreleased research evidence')
    if args.archive.stat().st_size != metadata['bundle']['bytes'] or sha(args.archive) != metadata['bundle']['sha256']:
        raise ValueError('Transfer bundle identity mismatch')
    output = args.output.resolve(); temporary = output.with_name(output.name + '.partial')
    if output.exists() or temporary.exists():
        raise ValueError('Import requires a new output directory')
    with zipfile.ZipFile(args.archive) as bundle:
        entries = bundle.infolist()
        if len(entries) != len(metadata['files']) or {e.filename for e in entries} != set(metadata['files']):
            raise ValueError('Unexpected or duplicate archive entries')
        for entry in entries:
            name = PurePosixPath(entry.filename)
            if name.is_absolute() or '..' in name.parts or '\\' in entry.filename or ':' in entry.filename:
                raise ValueError('Invalid archive path')
            if name.suffix not in ['.json', '.safetensors'] or stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError('Unexpected bundle content type')
            record = metadata['files'][entry.filename]
            if entry.file_size != record['bytes']:
                raise ValueError('Archive size mismatch')
            with bundle.open(entry) as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() != record['sha256']:
                    raise ValueError('Archive member hash mismatch')
        temporary.mkdir(parents=True)
        try:
            for entry in entries:
                target = temporary.joinpath(*PurePosixPath(entry.filename).parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(entry) as source, target.open('xb') as destination:
                    shutil.copyfileobj(source, destination)
            read = lambda name: json.loads((temporary / name).read_text(encoding='utf-8'))
            plan, runs = read('research-plan.json'), read('bf16/runs.json')
            sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'training/mt-fixed-slots'))
            from evaluate_gpu import validate_plan
            validate_plan(plan)
            if not runs.get('finished_utc') or runs.get('check_only') or runs['grammar_applied'] is not False:
                raise ValueError('Incomplete or non-BF16 GPU evidence')
            if runs['plan_sha256'] != sha(temporary / 'research-plan.json') or runs['package_source_commit'] != args.source_commit:
                raise ValueError('Plan/source lineage mismatch')
            if read('package-manifest.json')['source_commit'] != args.source_commit:
                raise ValueError('Package lineage mismatch')
            identities = runs['identities']
            if identities['base']['sha256'] != BASE_SHA or identities['v022']['sha256'] != OLD_SHA:
                raise ValueError('Wrong base or pinned local historical adapter control')
            if identities['probe']['sha256'] != sha(temporary / 'adapter/adapter_model.safetensors'):
                raise ValueError('Adapter differs from the GPU-tested candidate')
            if identities['probe']['config_sha256'] != sha(temporary / 'adapter/adapter_config.json'):
                raise ValueError('Adapter configuration differs from the GPU-tested candidate')
            for label in ['base', 'v022', 'probe']:
                record = runs['files'][label]
                if record['file'] != label + '.json' or sha(temporary / 'bf16' / record['file']) != record['sha256']:
                    raise ValueError('GPU output lineage mismatch')
                arm = read('bf16/' + record['file'])
                if not arm.get('finished_utc') or len(arm['generations']) != len(plan['jobs']):
                    raise ValueError('Incomplete GPU output arm')
            (temporary / 'transfer-manifest.json').write_text(json.dumps(metadata, indent=2)+'\n', encoding='utf-8')
            temporary.rename(output)
        except BaseException:
            shutil.rmtree(temporary)
            raise
    print(json.dumps({'output': str(output), 'source_commit': args.source_commit,
                      'adapter_sha256': identities['probe']['sha256'], 'bf16_generations': len(plan['jobs']) * 3,
                      'release_approved': False}))


if __name__ == '__main__': main()
