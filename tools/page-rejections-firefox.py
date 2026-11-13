"""Observe production extension errors/replies via three test-XPI-only hooks."""
import argparse
import datetime
import gzip
import hashlib
import importlib.util
import json
import re
from pathlib import Path
import sys
import time
import zipfile

W=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(W/'tools'))
from mt_public_firefox import public_firefox
spec=importlib.util.spec_from_file_location('page_controls',W/'tools/page-controls-firefox.py')
qa=importlib.util.module_from_spec(spec);spec.loader.exec_module(qa)
sha=lambda b:hashlib.sha256(b).hexdigest()
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--firefox',required=True,type=Path)
parser.add_argument('--geckodriver',required=True,type=Path)
parser.add_argument('--output',required=True,type=Path)
args=parser.parse_args()
out=args.output.resolve();out.mkdir(parents=True,exist_ok=False)
text=(W/'dist/content.js').read_text()
pending='this.#pending.push({ request, resolve, reject });'
failure='this.#failures.set(root, error instanceof Error ? error.message : String(error));'
assert text.count(pending)==text.count(failure)==1 and text.rstrip().endswith('})();')
observed=text.replace(pending,"""
const observation={request:{html:request.html,sourceLanguage:request.sourceLanguage,targetLanguage:request.targetLanguage,terminology:request.terminology,context:request.context},started:performance.now()};
globalThis.__pageLingoV22.calls.push(observation);
this.#pending.push({request,resolve:html=>{observation.output=html;observation.finished=performance.now();resolve(html);},reject:error=>{observation.error=String(error);observation.finished=performance.now();reject(error);}});
""",1).replace(failure,failure+"""
try {
 const segment=serializeRichSegment(root,{fixedTextSlots:true});
 globalThis.__pageLingoV22.failures.push({error:String(error),tag:root.tagName,source_html:root.outerHTML,source_text:root.textContent,wire_html:segment.html,slots:segment.textSlots?.map(s=>({id:s.id,source:s.source,writePolicy:s.writePolicy}))});
} catch(captureError) {globalThis.__pageLingoV22.failures.push({error:String(error),capture_error:String(captureError)});}
""",1)
observed="""
globalThis.__pageLingoV22={calls:[],failures:[]};
browser.runtime.onMessage.addListener(message=>{
 if(message.type==='qa-v22-reset'){globalThis.__pageLingoV22={calls:[],failures:[]};return Promise.resolve({ok:true});}
 if(message.type==='qa-v22-state')return Promise.resolve({...globalThis.__pageLingoV22});
});
"""+observed
xpi=out/'observed.xpi'
with zipfile.ZipFile(xpi,'w',zipfile.ZIP_DEFLATED,compresslevel=1) as z:
 for f in sorted((W/'dist').rglob('*')):
  if not f.is_file():continue
  name=str(f.relative_to(W/'dist'))
  if name=='content.js':z.writestr(name,observed)
  elif name=='manifest.json':
   m=json.loads(f.read_text());m['browser_specific_settings']['gecko']['data_collection_permissions']={'required':['websiteContent','authenticationInfo'],'optional':[]};z.writestr(name,json.dumps(m))
  else:z.write(f,name)
binding={'production_content_sha256':sha(text.encode()),'observed_content_sha256':sha(observed.encode()),'background_sha256':sha((W/'dist/background.js').read_bytes()),'hooks':['Pending request settlement observation','Root exception observation after original failure bookkeeping','Test-only read/reset message listener'],'observer_hooks_modify_production_files':False}
(out/'observation-binding.json').write_text(json.dumps(binding,indent=2)+'\n')
result={'protocol':'installed-extension-root-rejection-diagnostic-v22','started_at':datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat(),'observation_binding':binding,'rows':[],'external_api_calls':0}
save=lambda:qa.write_json(out/'result.json',result)
try:
 with public_firefox(args.firefox,args.geckodriver,out/'geckodriver.log',system_access=True,load_images=True) as d:
  result['browser_version']=d.capabilities['browserVersion'];assert d.install_addon(str(xpi),temporary=True)==qa.ADDON_ID
  with d.context(d.CONTEXT_CHROME):mapping=json.loads(d.execute_script("return Services.prefs.getStringPref('extensions.webextensions.uuids');"))
  url='moz-extension://'+mapping[qa.ADDON_ID];d.get(url+'/settings.html');ext=d.current_window_handle
  settings={'displayMode':'translation','targetLanguage':'zh-Hans','autoTranslateEnabled':False,'builtinGlossaryEnabled':False,'glossaryCollections':[],'neverTranslateSites':[],'alwaysTranslateSites':[],'neverTranslateLanguages':[],'alwaysTranslateLanguages':[],'modelUpdatePolicy':'manual','activeTranslationEngineId':'firefox-local','translationEngines':[]}
  qa.async_value(d,'await browser.storage.local.set(arguments[0]);return true;',settings)
  d.execute_script("window.__warm=null;browser.runtime.sendMessage({type:'translate-html',request:{html:'Hello',sourceLanguage:'en',targetLanguage:'zh-Hans'}}).then(v=>window.__warm=v,e=>window.__warm={error:String(e)});")
  start=time.perf_counter()
  while True:
   value=d.execute_script('return window.__warm;')
   if value is not None:break
   assert time.perf_counter()-start<180,'model initialization timeout';time.sleep(.3)
  assert value.get('ok'),value
  result['model_assets']=qa.async_value(d,"const cache=await caches.open('pagelingo-models-v3');return await Promise.all((await cache.keys()).map(async r=>({url:r.url,sha256:(await cache.match(r)).headers.get('x-pagelingo-sha256')})));")
  d.switch_to.new_window('tab');page=d.current_window_handle
  for site in ['https://www.w3.org/WAI/ARIA/apg/patterns/accordion/','https://docs.python.org/3/library/sqlite3.html']:
   for width in [500,1440]:
    print(json.dumps({'start':site,'width':width}),flush=True)
    d.switch_to.window(page);d.set_window_size(width,1000);d.get(site)
    start=time.perf_counter()
    while not d.execute_script("return document.readyState==='complete';"):
     assert time.perf_counter()-start<30;time.sleep(.1)
    stem=('w3c' if 'w3.org' in site else 'sqlite')+'-'+str(width)
    (out/(stem+'-before.html.gz')).write_bytes(gzip.compress(d.page_source.encode(),mtime=0))
    d.execute_script(qa.SNAPSHOT,'body');d.save_screenshot(str(out/(stem+'-before.png')))
    d.switch_to.window(ext);d.get(url+'/popup.html');tab=qa.activate_page(d,ext,site)
    qa.async_value(d,"return await browser.tabs.sendMessage(arguments[0],{type:'qa-v22-reset'},{frameId:0});",tab)
    d.execute_script("document.getElementById('source-language').value='en';")
    status,wall=qa.click_popup(d,'translate',deadline=300)
    detail=qa.async_value(d,"return await browser.tabs.sendMessage(arguments[0],{type:'qa-v22-state'},{frameId:0});",tab)
    assert isinstance(detail,dict),'Test listener must answer explicitly'
    match=re.fullmatch(r'已翻译 (\d+) 个段落(?:；(\d+) 个未完成，已保留原文)?',status);assert match,status
    detail.update(translatedCount=int(match.group(1)),failedCount=int(match.group(2) or 0))
    d.switch_to.window(page);d.execute_async_script('const done=arguments[arguments.length-1];requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)));');time.sleep(.5)
    checks=d.execute_script('return window.__e2eSnapshot.check();');checks['text']=checks['text'][:1500]
    d.save_screenshot(str(out/(stem+'-after.png')))
    qa.activate_page(d,ext,site);restore,_=qa.click_popup(d,'restore');assert restore=='已恢复原文'
    d.switch_to.window(page);checks.update(d.execute_script('return window.__e2eSnapshot.restored();'))
    row={'url':site,'width':width,'status':status,'wall_s_instrumented':wall,'checks':checks,**detail};result['rows'].append(row);save()
    assert detail['failedCount']==len(detail['failures']),(detail['failedCount'],len(detail['failures']))
    assert not any(f.get('capture_error') for f in detail['failures'])
    for key in ['original_structure_unchanged','ancestor_structure_unchanged','code_unchanged','link_targets_and_handlers_unchanged','nonnavigation_listeners_preserved','restored_exact','restored_source_text_nodes']:assert checks[key],(site,width,key)
    assert not checks['horizontal_overflow']
    print(json.dumps({'done':site,'width':width,'translated':detail['translatedCount'],'failed':detail['failedCount'],'calls':len(detail['calls'])}),flush=True)
  result['completed']=True;save()
finally:save()
