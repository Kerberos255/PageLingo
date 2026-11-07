import hashlib,importlib.util,json,unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('scope_native',ROOT/'tools/mt-sentence-native.py')
native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)

def plan():
 request={'messages':[{'role':'user','content':'Frozen scope test'}],'grammar':'root ::= "A" | "X"','max_tokens':8}
 return {'protocol':'scope-choice-evaluation-v1','evaluation_only':True,'optimizer_inputs_approved':False,
  'jobs':[{'case_id':'scope','variant':'control','kind':'scope_choice','request':request,
   'request_sha256':hashlib.sha256(json.dumps(request,ensure_ascii=False,separators=(',',':')).encode()).hexdigest(),'allowed_ids':['A','X'],'expected_id':'A'}]}

class ScopeNativeGuard(unittest.TestCase):
 def test_frozen_scope_plan_is_accepted_without_loading_weights(self):
  native.validate_plan_protocol(plan())
 def test_changed_request_or_optimizer_approval_is_rejected(self):
  value=plan();value['jobs'][0]['request']['messages'][0]['content']='Changed target';self.assertRaises(ValueError,native.validate_plan_protocol,value)
  value=plan();value['optimizer_inputs_approved']=True;self.assertRaises(ValueError,native.validate_plan_protocol,value)
 def test_unknown_and_empty_transport_are_rejected(self):
  self.assertRaises(ValueError,native.validate_plan_protocol,{'protocol':'unknown','jobs':[{}]})
  value=plan();value['jobs']=[];self.assertRaises(ValueError,native.validate_plan_protocol,value)

if __name__=='__main__':unittest.main()
