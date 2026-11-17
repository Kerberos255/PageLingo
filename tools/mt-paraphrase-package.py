"""Build an immutable single-x.cmd v29 kit; this does not start training or upload."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

W=Path(__file__).resolve().parents[1];T=W/'training/mt-fixed-slots';sys.path.insert(0,str(T))
from evaluate_paraphrase import validate_plan
from paraphrase_workflow import verify_pair
from evaluate_gpu import sha256


def build(out,data,plan_file,web,private_plan,registration):
    if out.exists():raise ValueError('Use a new package output; preserve previous kits')
    commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=W,text=True).strip()
    if subprocess.check_output(['git','status','--porcelain'],cwd=W,text=True).strip():raise ValueError('Commit and verify the source before freezing a GPU kit')
    plan=json.loads(plan_file.read_text());validate_plan(plan)
    if plan['data_manifest_sha256']!=sha256(data/'manifest.json') or plan['capture_sha256']!=sha256(web):raise ValueError('Evaluation belongs to different data/web sources')
    audit=json.loads(private_plan.read_text())
    if audit.get('mode')!='verify_on_gpu_host_before_model_load':raise ValueError('A mandatory original-source check must run before loading models')
    relative='.pagelingo-kits/paraphrase-v29-'+commit[:12];folder=out/relative;folder.mkdir(parents=True)
    runtime=['train.py','training_options.py','paraphrase_contract.py','paraphrase_workflow.py','evaluate_paraphrase.py','evaluate_gpu.py',
        'evaluate_matrix.py','evaluate_semantic.py','validation_metrics.py','curriculum_workflow.py','scope_choice_contract.py','handoff_archive.py','private_exclusions.py',
        'config-paraphrase-legacy-v29.json','config-paraphrase-compact-v29.json']
    for name in runtime:shutil.copyfile(T/name,folder/name)
    shutil.copytree(data,folder/'data')
    for source,name in [(plan_file,'evaluation-plan.json'),(web,'web-sources.json'),(private_plan,'private-exclusion-plan.json'),(private_plan.parent/'candidate-source-fingerprints.json','candidate-source-fingerprints.json'),(registration,'preregister.json')]:shutil.copyfile(source,folder/name)
    (folder/'research_v2.py').write_text('from paraphrase_workflow import main\nif __name__ == "__main__":\n    raise SystemExit(main())\n')
    verify_pair(folder)
    records={p.relative_to(folder).as_posix():{'bytes':p.stat().st_size,'sha256':sha256(p)} for p in folder.rglob('*') if p.is_file()}
    manifest={'schema_version':1,'source_commit':commit,'source_dirty':False,'gpu_only':True,'release_approved':False,'model_upload':False,
        'max_optimizer_steps_each':32,'total_optimizer_steps':64,'maximum_generation_calls':504,'files':records}
    (folder/'package-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    control=out/'tools/mt-control';control.mkdir(parents=True)
    shutil.copyfile(T/'windows/launcher.py',control/'launcher.py');shutil.copyfile(T/'windows/x.cmd',out/'x.cmd')
    task={'schema_version':1,'run_prefix':'paraphrase-v29','description':'v29 GPU-only paired paraphrase: two final32-step candidates, 504 BF16 generation calls',
        'source_commit':commit,'package':relative,'manifest_sha256':sha256(folder/'package-manifest.json')}
    (control/'current-task.json').write_text(json.dumps(task,indent=2)+'\n')
    (out/'README-TRAINING.txt').write_text('Keep PageLingo-MT.cmd unchanged. Open it on the GPU PC using E:\\PageLingo-MT, then execute x.cmd.\n'
        'One x.cmd run: verify original private-source exclusions before model loading, then files, tokenizer/EOS and original weights; BF16 formal baseline; two paired 32-step updates from the exact formal v0.2.2 r32; BF16 comparisons; model-free GPU handoff.\n'
        'Training sources are newly authored fictional APIs, paired fixed/natural tasks. Real webpages, v28 diagnostics and FLORES remain evaluation only. No loss/keyword winner.\n'
        'No Firefox, CPU conversion, dependency installation or uploads run on the GPU PC. All caches/temporary files stay on the project drive. Old weights/adapters/results remain unchanged.\n'
        'Outputs: outputs/paraphrase-v29-run-*/gpu-handoff.zip. Completion means evidence is ready, not model release approval. Repeating x.cmd shows completed status rather than retraining.\n'
        'x.cmd status reads status. x.cmd check preflights without training and does not consume the actual run.\n')
    files={p.relative_to(out).as_posix():{'bytes':p.stat().st_size,'sha256':sha256(p)} for p in out.rglob('*') if p.is_file()}
    (out/'INSTALL-MANIFEST.json').write_text(json.dumps({'schema_version':1,'source_commit':commit,'source_dirty':False,'original_environment_entry_included':False,'root_cmds':['x.cmd'],'files':files},indent=2)+'\n')
    archive=out.with_suffix('.zip')
    with zipfile.ZipFile(archive,'x',zipfile.ZIP_DEFLATED) as z:
        for p in out.rglob('*'):
            if p.is_file():z.write(p,p.relative_to(out).as_posix())
    with zipfile.ZipFile(archive) as z:
        if z.testzip() is not None:raise ValueError('GPU package CRC failed')
        for name,record in files.items():
            b=z.read(name)
            if len(b)!=record['bytes'] or hashlib.sha256(b).hexdigest()!=record['sha256']:raise ValueError('GPU package member changed: '+name)
    return {'source_commit':commit,'archive':str(archive),'bytes':archive.stat().st_size,'sha256':sha256(archive),'files':len(files)+1,
        'package':str(folder),'root_cmds':['x.cmd'],'steps_each':32,'total_optimizer_steps':64,'maximum_generation_calls':504,'training_executed':False}


if __name__=='__main__':
    p=argparse.ArgumentParser()
    for name in ['out','data','plan','web','private-plan','registration']:p.add_argument('--'+name,type=Path,required=True)
    a=p.parse_args();print(json.dumps(build(a.out.resolve(),a.data.resolve(),a.plan.resolve(),a.web.resolve(),a.private_plan.resolve(),a.registration.resolve()),indent=2))
