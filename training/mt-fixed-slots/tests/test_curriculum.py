import copy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evaluate_matrix import validate_matrix_plan
from evaluate_gpu import request_hash, sha256
from curriculum_workflow import completed_candidate, create_evidence, validate_package
import curriculum_workflow


def plan_fixture():
    request = {'messages': [{'role': 'user', 'content': 'frozen prompt'}], 'max_tokens': 64}
    return {'protocol': 'BF16-production-prompt-unconstrained-v1', 'grammar_applied': False,
            'cases': [{'id': 'case', 'split': 'validation'}],
            'jobs': [{'key': 'fixed/case/0', 'case_id': 'case', 'split': 'validation', 'mode': 'fixed',
                      'request': request, 'request_sha256': request_hash(request)}]}


class CurriculumGuardTests(unittest.TestCase):
    def test_training_rows_cannot_enter_matrix(self):
        plan = plan_fixture(); validate_matrix_plan(plan)
        plan['cases'][0]['split'] = 'train'; plan['jobs'][0]['split'] = 'train'
        with self.assertRaisesRegex(ValueError, 'evaluation cases'):
            validate_matrix_plan(plan)

    def test_changed_prompt_duplicate_and_missing_jobs_are_rejected(self):
        for change in ['prompt', 'duplicate', 'missing']:
            with self.subTest(change=change):
                plan = plan_fixture()
                if change == 'prompt': plan['jobs'][0]['request']['messages'][0]['content'] = 'different prompt'
                elif change == 'duplicate': plan['jobs'].append(copy.deepcopy(plan['jobs'][0]))
                else: plan['jobs'] = []
                with self.assertRaises(ValueError): validate_matrix_plan(plan)

    def test_dirty_development_package_cannot_train_and_changed_file_fails(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); file = root / 'runtime.py'; file.write_text('original')
            package = {'schema_version': 1, 'source_dirty': True, 'files': {'runtime.py': {'bytes': file.stat().st_size, 'sha256': sha256(file)}}}
            (root / 'package-manifest.json').write_text(json.dumps(package))
            with self.assertRaisesRegex(ValueError, 'clean immutable'): validate_package(root)
            validate_package(root, allow_dirty=True)
            file.write_text('modified')
            with self.assertRaisesRegex(ValueError, 'runtime file changed'): validate_package(root, allow_dirty=True)

    def test_candidate_requires_requested_steps_and_unselected_final_weights(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); (root / 'adapter').mkdir()
            for file in ['adapter_model.safetensors', 'adapter_config.json']: (root / 'adapter' / file).write_bytes(b'fixture')
            config = {'candidate_max_steps': 64, 'checkpoint_selection': 'final', 'initial_adapter_sha256': 'pinned'}
            result = {'training_executed': True, 'run_kind': 'synthetic_research_candidate', 'optimizer_steps': 64,
                      'config': config, 'initial_adapter': {'sha256': 'pinned'}, 'selection': {'best_checkpoint': None},
                      'validation_after': {'eval_loss': .5}}
            file = root / 'training-result.json'; file.write_text(json.dumps(result))
            completed_candidate(root, config)
            result['selection']['best_checkpoint'] = 'checkpoint-32'; file.write_text(json.dumps(result))
            with self.assertRaisesRegex(ValueError, 'unexpected checkpoint'): completed_candidate(root, config)

    def test_evidence_keeps_all_four_arms_and_never_includes_weights(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); out = root / 'out'; here = root / 'kit'; (out / 'matrix').mkdir(parents=True); (here / 'data').mkdir(parents=True)
            plan = plan_fixture(); (here / 'matrix-plan.json').write_text(json.dumps(plan))
            for path in ['matrix-models.json', 'r16/training-result.json', 'r32/training-result.json', 'r16/adapter/adapter_model.safetensors']:
                p = out / path; p.parent.mkdir(parents=True, exist_ok=True); p.write_text('{}')
            for path in ['package-manifest.json', 'data/manifest.json', 'data/template-review.md', 'config-r16.json', 'config-r32.json']:
                (here / path).write_text('{}')
            runs = {'finished_utc': 'fixture', 'plan_sha256': sha256(here / 'matrix-plan.json'), 'files': {}}
            for label in ['old_r16', 'old_r32', 'v3_r16', 'v3_r32']:
                p = out / 'matrix' / (label + '.json'); p.write_text(json.dumps({'finished_utc': 'fixture', 'generations': [{}]}))
                runs['files'][label] = {'file': p.name, 'sha256': sha256(p)}
            (out / 'matrix/runs.json').write_text(json.dumps(runs))
            bundle = create_evidence(out, here, plan, 'fixture')
            self.assertEqual(bundle['sha256'], sha256(out / 'evidence.zip'))
            with zipfile.ZipFile(out / 'evidence.zip') as archive:
                self.assertEqual(sum(name.startswith('matrix/') and name != 'matrix/runs.json' for name in archive.namelist()), 4)
                self.assertFalse(any('safetensors' in name for name in archive.namelist()))
            missing = runs['files'].pop('v3_r32'); (out / 'matrix/runs.json').write_text(json.dumps(runs))
            with self.assertRaisesRegex(ValueError, 'All four'): create_evidence(out, here, plan, 'fixture')

    def test_workflow_check_and_run_keep_gpu_training_and_evaluation_separate(self):
        for mode in ['check', 'run']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as name:
                root = Path(name); here = root / 'kit'; (here / 'data').mkdir(parents=True)
                plan = plan_fixture(); (here / 'matrix-plan.json').write_text(json.dumps(plan))
                package = {'schema_version': 1, 'source_dirty': False, 'source_commit': 'fixture', 'files': {}}
                (here / 'package-manifest.json').write_text(json.dumps(package))
                for file in ['manifest.json', 'template-review.md']: (here / 'data' / file).write_text('{}')
                base = root / 'base'; base.mkdir(); (base / 'model.safetensors').write_bytes(b'fixture base')
                baselines = {}
                for rank in [16, 32]:
                    folder = root / ('old-' + str(rank)); folder.mkdir()
                    (folder / 'adapter_model.safetensors').write_bytes(b'fixture adapter'); (folder / 'adapter_config.json').write_text('{}')
                    baselines['old_r' + str(rank)] = {'directory': folder.name, 'sha256': sha256(folder / 'adapter_model.safetensors'), 'config_sha256': sha256(folder / 'adapter_config.json')}
                    (here / ('config-r' + str(rank) + '.json')).write_text(json.dumps({'candidate_max_steps': 64, 'checkpoint_selection': 'final', 'initial_adapter_sha256': baselines['old_r' + str(rank)]['sha256']}))
                workflow = {'run_prefix': 'pagelingo-quality-v3', 'base': {'directory': 'base', 'sha256': sha256(base / 'model.safetensors')}, 'baselines': baselines,
                            'candidates': [{'name': 'r16', 'config': 'config-r16.json'}, {'name': 'r32', 'config': 'config-r32.json'}]}
                (here / 'workflow.json').write_text(json.dumps(workflow))
                commands = []

                class Process:
                    def __init__(self, command, **kwargs):
                        commands.append(command); self.stdout = iter(['fixture stage\n'])
                        if '--train' in command:
                            output = Path(command[command.index('--output') + 1]); (output / 'adapter').mkdir(parents=True)
                            config = json.loads(Path(command[command.index('--config') + 1]).read_text())
                            for file in ['adapter_model.safetensors', 'adapter_config.json']: (output / 'adapter' / file).write_text('{}')
                            (output / 'training-result.json').write_text(json.dumps({'training_executed': True, 'run_kind': 'synthetic_research_candidate',
                                'optimizer_steps': 64, 'config': config, 'initial_adapter': {'sha256': config['initial_adapter_sha256']},
                                'selection': {'best_checkpoint': None}, 'validation_after': {'eval_loss': .5}}))
                        if command[2].endswith('evaluate_matrix.py') and '--check-only' not in command:
                            output = Path(command[command.index('--output') + 1]); output.mkdir()
                            identities = json.loads(Path(command[command.index('--models') + 1]).read_text())
                            runs = {'finished_utc': 'fixture', 'plan_sha256': sha256(here / 'matrix-plan.json'), 'files': {}}
                            for label in identities['adapters']:
                                file = output / (label + '.json'); file.write_text(json.dumps({'finished_utc': 'fixture', 'generations': [{}]}))
                                runs['files'][label] = {'file': file.name, 'sha256': sha256(file)}
                            (output / 'runs.json').write_text(json.dumps(runs))

                    def __enter__(self): return self
                    def __exit__(self, *args): return False
                    def wait(self, **kwargs): return 0

                fake_torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True, is_bf16_supported=lambda: True))
                with patch.object(curriculum_workflow, 'HERE', here), patch.dict(sys.modules, {'torch': fake_torch}), \
                        patch.object(sys, 'argv', ['workflow', '--root', str(root), '--mode', mode]), \
                        patch.object(curriculum_workflow.subprocess, 'Popen', Process):
                    self.assertEqual(curriculum_workflow.main(), 0)
                status = json.loads(next((root / 'outputs').glob('*/workflow-result.json')).read_text())
                self.assertEqual(sum('--train' in command for command in commands), 0 if mode == 'check' else 2)
                self.assertEqual(status['workflow_completed'], mode == 'run')
                self.assertFalse(status['release_approved'])
                self.assertFalse(any(any(word in arg.lower() for word in ['firefox', 'quantize', 'merge_adapter']) for command in commands for arg in command))


if __name__ == '__main__': unittest.main()
