"""Verify exact evidence members and hashes; optionally read legacy Windows paths."""
import hashlib,json,zipfile
from pathlib import PurePosixPath

def verify_handoff(path,*,legacy_windows_paths=False):
 with zipfile.ZipFile(path) as bundle:
  names=bundle.namelist()
  if len(names)!=len(set(names)):raise ValueError('Duplicate ZIP members')
  manifest=json.loads(bundle.read('MANIFEST.json'));records={};normalized=0
  for original,record in manifest['files'].items():
   name=original
   if '\\' in name:
    if not legacy_windows_paths:raise ValueError('Manifest member paths must use forward slashes')
    name=name.replace('\\','/');normalized+=1
   if name in records:raise ValueError('Manifest paths collide after normalization')
   records[name]=record
  if set(names)!=set(records)|{'MANIFEST.json'}:raise ValueError('ZIP members differ from manifest')
  for name in names:
   parts=PurePosixPath(name).parts;info=bundle.getinfo(name)
   if name.startswith('/') or ':' in name or '\\' in name or '..' in parts or info.is_dir() or (info.external_attr>>16)&0o170000==0o120000:
    raise ValueError('Invalid evidence member path')
   if name=='MANIFEST.json':continue
   record=records[name]
   with bundle.open(name) as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
   if info.file_size!=record['bytes'] or digest!=record['sha256']:raise ValueError('Evidence member identity changed: '+name)
  return {'members':len(names),'all_member_sha256_passed':True,'legacy_windows_paths_normalized':normalized}
