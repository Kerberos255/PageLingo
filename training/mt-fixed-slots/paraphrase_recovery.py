"""Resume a verified BF16 baseline prefix without touching the failed run."""
import json
import math
from pathlib import Path, PurePosixPath

from evaluate_gpu import sha256


RECOVERY_FILES = ('workflow-result.json', 'baseline/runs.json', 'baseline/v022.json', 'baseline/v022.json.tmp')


def checked_baseline(root, specification, plan_file, plan, identities, encoded):
    spec = json.loads(specification.read_text(encoding='utf-8'))
    relative = PurePosixPath(spec['run_directory'])
    if len(relative.parts) != 2 or relative.parts[0] != 'outputs' or not relative.name.startswith('paraphrase-v29-run-'):
        raise ValueError('Baseline recovery must reference a previous v29 run')
    if any(char in str(relative) for char in '\\:'):
        raise ValueError('Baseline recovery requires a project-relative path')
    folder = (root / Path(relative)).resolve()
    if not folder.is_relative_to(root / 'outputs'):
        raise ValueError('Baseline recovery path escapes outputs')
    if set(spec['files']) != set(RECOVERY_FILES):
        raise ValueError('Baseline recovery file inventory differs')

    def checked(name):
        file = (folder / name).resolve()
        if not file.is_relative_to(folder) or sha256(file) != spec['files'][name]:
            raise ValueError('Baseline recovery file identity changed: ' + name)
        return json.loads(file.read_text(encoding='utf-8'))

    status, runs, saved, temporary = map(checked, RECOVERY_FILES)
    stages = status['stages']
    if (status['source_commit'] != spec['source_commit'] or not status.get('source_exclusion_completed')
            or status.get('workflow_completed') or status.get('training_completed') or not status.get('error')
            or not stages or stages[-1]['name'] != 'baseline-bf16' or stages[-1]['exit_code'] == 0
            or any(stage['name'].startswith('train-') for stage in stages)):
        raise ValueError('Baseline recovery requires a failed baseline before optimization')
    if (runs['protocol'] != plan['protocol'] or runs['phase'] != 'baseline' or runs.get('finished_utc')
            or runs['files'] or runs['identities'] != identities or runs.get('grammar_applied') is not False
            or runs['plan_sha256'] != sha256(plan_file) or runs['planned_generations'] != len(plan['jobs'])):
        raise ValueError('Baseline recovery run identity differs')
    for result in [saved, temporary]:
        if (result['model'] != 'v022' or result['identity'] != identities['adapters']['v022']
                or result.get('grammar_applied') is not False or result.get('training_executed') is not False
                or result.get('finished_utc')):
            raise ValueError('Baseline recovery model identity differs')
    previous = saved['generations']
    prefix = temporary['generations']
    if (len(prefix) != spec['prefix_count'] or not 0 < len(prefix) < len(plan['jobs'])
            or len(prefix) != len(previous) + 1 or prefix[:len(previous)] != previous):
        raise ValueError('Baseline recovery is not an exact checkpoint prefix')
    for row, job in zip(prefix, plan['jobs']):
        _, hashes = encoded[job['key']]
        expected = {key: job[key] for key in ['key', 'case_id', 'mode', 'request_sha256']}
        expected.update(hashes, max_tokens=job['request']['max_tokens'])
        if any(row.get(key) != value for key, value in expected.items()):
            raise ValueError('Recovered generation request or token identity differs: ' + job['key'])
        if (not isinstance(row.get('text'), str) or not 0 < row['new_tokens'] <= row['max_tokens']
                or not math.isfinite(row['wall_s']) or row['wall_s'] <= 0
                or row['finish_reason'] not in ['stop', 'length', 'other']
                or (row['finish_reason'] == 'stop' and row['last_token_id'] != 120020)):
            raise ValueError('Invalid recovered generation: ' + job['key'])
    return prefix, {'source_commit': spec['source_commit'], 'run_directory': relative.as_posix(),
                    'files': spec['files'], 'saved_generations': len(previous),
                    'restored_generations': len(prefix), 'remaining_generations': len(plan['jobs']) - len(prefix),
                    'previous_versions': runs['versions'], 'previous_gpu': runs['gpu']}
