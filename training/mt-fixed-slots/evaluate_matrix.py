"""Compare all pinned adapters; keep generations separate from reference-token NLL."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path

from evaluate_gpu import generate_one, request_hash, sha256, write_json
from validation_metrics import aggregate, loss_summary, target_kinds, target_losses

HERE = Path(__file__).resolve().parent


def validate_matrix_plan(plan):
    if plan.get('protocol') != 'BF16-production-prompt-unconstrained-v1' or plan.get('grammar_applied') is not False:
        raise ValueError('Unexpected matrix protocol')
    cases = {row['id']: row for row in plan['cases']}
    if len(cases) != len(plan['cases']) or any(row['split'] not in ['validation', 'holdout', 'diagnostic'] for row in cases.values()):
        raise ValueError('Only unique evaluation cases may enter the matrix')
    keys = set()
    for job in plan['jobs']:
        if job['key'] in keys or job['case_id'] not in cases:
            raise ValueError('Duplicate or unknown matrix job')
        keys.add(job['key'])
        if job['split'] != cases[job['case_id']]['split'] or job['mode'] not in ['fixed', 'plain']:
            raise ValueError('Matrix split/mode mismatch')
        if job['mode'] == 'plain' and job['split'] != 'diagnostic':
            raise ValueError('Plain controls are diagnostic-only')
        if not 1 <= job['request']['max_tokens'] <= 768 or request_hash(job['request']) != job['request_sha256']:
            raise ValueError('Matrix request identity or budget changed')
    if not keys or {job['case_id'] for job in plan['jobs']} != set(cases):
        raise ValueError('Missing evaluation jobs')


def pinned(root, identity, weight):
    folder = (root / identity['directory']).resolve()
    if not folder.is_relative_to(root) or sha256(folder / weight) != identity['sha256']:
        raise ValueError('Pinned model identity changed or path escaped the project')
    if weight != 'model.safetensors' and sha256(folder / 'adapter_config.json') != identity['config_sha256']:
        raise ValueError('Pinned adapter configuration changed')
    return folder


def prepare_inputs(tokenizer, plan, validation):
    encoded_jobs = {}
    for job in plan['jobs']:
        prompt = tokenizer.apply_chat_template(job['request']['messages'], tokenize=False, add_generation_prompt=True)
        encoded = tokenizer(prompt, add_special_tokens=False, return_tensors='pt')
        if encoded['input_ids'].shape[1] + job['request']['max_tokens'] > 3072:
            raise ValueError('Matrix input/output would exceed context')
        encoded_jobs[job['key']] = (encoded, {
            'prompt_sha256': hashlib.sha256(prompt.encode()).hexdigest(),
            'input_ids_sha256': hashlib.sha256(json.dumps(encoded['input_ids'][0].tolist(), separators=(',', ':')).encode()).hexdigest(),
            'prompt_tokens': int(encoded['input_ids'].shape[1]),
        })
    targets = []
    if not validation or len({row['id'] for row in validation}) != len(validation):
        raise ValueError('Expected unique validation references')
    jobs = {job['case_id']: job for job in plan['jobs'] if job['mode'] == 'fixed'}
    for row in validation:
        job = jobs[row['id']]
        if row['split'] != 'validation' or job['request']['messages'] != row['messages'][:1]:
            raise ValueError('Reference does not match validation inference prompt')
        encoded, hashes = encoded_jobs[job['key']]
        target = tokenizer(row['messages'][1]['content'], add_special_tokens=False, return_offsets_mapping=True)
        ids = target['input_ids'] + [tokenizer.eos_token_id]
        if encoded['input_ids'].shape[1] + len(ids) > 3072:
            raise ValueError('Supervised validation target would be truncated')
        kinds = target_kinds(row['messages'][1]['content'], target['offset_mapping'])
        if len(kinds) != len(ids):
            raise ValueError('Target token classification changed')
        targets.append((row['id'], encoded, ids, kinds, hashes['prompt_sha256']))
    return encoded_jobs, targets


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--models', type=Path, required=True)
    parser.add_argument('--plan', type=Path, default=HERE / 'matrix-plan.json')
    parser.add_argument('--validation', type=Path, default=HERE / 'data/validation.jsonl')
    parser.add_argument('--check-only', action='store_true')
    args = parser.parse_args()
    root, out = args.root.resolve(), args.output.resolve()
    if not out.is_relative_to(root) or out.exists():
        raise ValueError('Matrix output must be a new project directory')
    plan = json.loads(args.plan.read_text(encoding='utf-8')); validate_matrix_plan(plan)
    config = json.loads(args.models.read_text(encoding='utf-8'))
    base = pinned(root, config['base'], 'model.safetensors')
    adapters = {label: pinned(root, identity, 'adapter_model.safetensors') for label, identity in config['adapters'].items()}
    if len(adapters) not in [2, 4]:
        raise ValueError('Expected two baseline arms or four completed comparison arms')
    import torch
    import transformers
    import peft
    from transformers import AutoModelForCausalLM, AutoTokenizer, GenerationConfig
    from peft import PeftModel

    tokenizer = AutoTokenizer.from_pretrained(base, local_files_only=True, trust_remote_code=False)
    if not tokenizer.is_fast or tokenizer.eos_token_id != 120020:
        raise ValueError('Pinned fast tokenizer and EOS required')
    validation = [json.loads(line) for line in args.validation.read_text(encoding='utf-8').splitlines() if line.strip()]
    encoded_jobs, targets = prepare_inputs(tokenizer, plan, validation)
    preflight = {'event': 'matrix_preflight', 'jobs_per_arm': len(encoded_jobs), 'validation_rows': len(targets),
                 'validation_target_tokens': sum(len(t[2]) for t in targets), 'identities_verified': list(adapters),
                 'model_weights_loaded': False, 'check_only': args.check_only}
    print(json.dumps(preflight), flush=True)
    if args.check_only:
        return 0
    if len(adapters) != 4 or not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise RuntimeError('Four-arm BF16 CUDA comparison required')
    out.mkdir(parents=True, exist_ok=False)
    manifest = {'protocol': plan['protocol'], 'grammar_applied': False, 'plan_sha256': sha256(args.plan),
                'created_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'planned_generations': len(encoded_jobs) * len(adapters), 'identities': config, 'files': {},
                'versions': {'torch': torch.__version__, 'transformers': transformers.__version__, 'peft': peft.__version__},
                'gpu': {'name': torch.cuda.get_device_name(0), 'total_memory_bytes': torch.cuda.get_device_properties(0).total_memory},
                'selection': 'none; all four arms require Cloud semantic and production-decoder review'}
    write_json(out / 'runs.json', manifest)
    torch.manual_seed(42); torch.cuda.manual_seed_all(42)
    model = AutoModelForCausalLM.from_pretrained(base, local_files_only=True, trust_remote_code=False,
        dtype=torch.bfloat16, attn_implementation='sdpa').to('cuda').eval()
    generation = GenerationConfig(do_sample=False, num_beams=1, use_cache=True, repetition_penalty=1.0,
        bos_token_id=tokenizer.bos_token_id, eos_token_id=tokenizer.eos_token_id, pad_token_id=tokenizer.pad_token_id)
    try:
        for index, (label, folder) in enumerate(adapters.items()):
            if index == 0:
                model = PeftModel.from_pretrained(model, folder, adapter_name=label, is_trainable=False).eval()
            else:
                model.load_adapter(folder, adapter_name=label, is_trainable=False)
            model.set_adapter(label); model.eval(); model.requires_grad_(False)
            if list(model.active_adapters) != [label] or any(p.requires_grad for p in model.parameters()):
                raise RuntimeError('Matrix adapter activation/freezing failed')
            torch.cuda.reset_peak_memory_stats()
            result = {'model': label, 'identity': config['adapters'][label], 'grammar_applied': False,
                      'training_executed': False, 'validation_losses': [], 'generations': []}
            for case_id, encoded, ids, kinds, prompt_hash in targets:
                prefix = encoded['input_ids'].shape[1]
                tokens = torch.cat([encoded['input_ids'], torch.tensor([ids], dtype=torch.long)], dim=1).to('cuda')
                with torch.inference_mode():
                    logits = model(input_ids=tokens, attention_mask=torch.ones_like(tokens), use_cache=False).logits
                    losses = target_losses(logits, prefix, ids).cpu().tolist()
                del logits, tokens
                result['validation_losses'].append({'id': case_id, 'prompt_sha256': prompt_hash, 'loss': loss_summary(losses, kinds)})
            result['loss_components'] = aggregate([row['loss'] for row in result['validation_losses']])
            for job in plan['jobs']:
                encoded, hashes = encoded_jobs[job['key']]
                result['generations'].append({'key': job['key'], 'request_sha256': job['request_sha256'],
                    'max_tokens': job['request']['max_tokens'], **hashes,
                    **generate_one(model, tokenizer, encoded, job['request']['max_tokens'], generation, 'cuda')})
                write_json(out / (label + '.json'), result)
                print(json.dumps({'event': 'matrix_generation', 'model': label, 'key': job['key']}), flush=True)
            result.update(finished_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                cuda_peak_allocated_bytes=torch.cuda.max_memory_allocated(), cuda_peak_reserved_bytes=torch.cuda.max_memory_reserved())
            write_json(out / (label + '.json'), result)
            manifest['files'][label] = {'file': label + '.json', 'sha256': sha256(out / (label + '.json'))}
            write_json(out / 'runs.json', manifest)
        manifest['finished_utc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        write_json(out / 'runs.json', manifest)
    finally:
        del model
        torch.cuda.empty_cache()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
