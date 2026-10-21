"""Self-contained negative witnesses. No repository, host export or native process."""
import copy,json
import assess_final as a
import qualified_carriers as q
import remaining_carriers as v2
from raw_compare import evaluate,injective,select,compare

def rejects(fn):
    try:fn()
    except (AssertionError,ValueError,KeyError,TypeError,IndexError):return True
    return False
def run_controls():
    passed=[]
    def ok(name,value):
        assert value,name;passed.append(name)
    ok('false actual cannot satisfy true',evaluate({'v':False},{'target':['v'],'mode':'eq','expected':True})['state']=='NONPASS')
    ok('injective matching rejects duplicated expected',not injective([{'v':1}],[{'v':1},{'v':1}]))
    ok('ambiguous selector rejected',rejects(lambda:select({'v':[{'id':1},{'id':1}]},['v',{'id':1}])))
    ok('unknown reason contract rejected',rejects(lambda:compare([],{'waive_all':True},'reason_constraints')))
    ok('additional reason cannot satisfy exact empty',not compare(['EXTRA'],{'exact_set':[]},'reason_constraints'))
    output={'kind':'success','exit_code':0,'stdout':'{"value":true}','stderr':''}
    for stream in ('stdout','stderr'):output[stream+'_bytes']=len(output[stream].encode());output[stream+'_hash']=a.sha(output[stream].encode())
    ok('positive stream decodes',a.capture_streams(output)=={'value':True})
    bad=copy.deepcopy(output);bad['stdout_bytes']+=1;ok('wrong byte count rejected',rejects(lambda:a.capture_streams(bad)))
    bad=copy.deepcopy(output);bad['stdout_hash']='0'*64;ok('wrong hash rejected',rejects(lambda:a.capture_streams(bad)))
    bad=copy.deepcopy(output);bad['exit_code']=1;ok('wrong process status rejected',rejects(lambda:a.capture_streams(bad)))
    bad=copy.deepcopy(output);bad['exit_code']=False;ok('qualified boolean exit rejected',rejects(lambda:q.process(bad)))
    bad=copy.deepcopy(output);bad['stderr_bytes']=False;ok('qualified boolean count rejected',rejects(lambda:q.process(bad)))
    host={'fixture':{'artifact_sha256':'a'*64,'helper_sha256':'b'*64}}
    receipt={'before':{'artifact':'a'*64,'helper':'b'*64},'after':{'artifact':'a'*64,'helper':'b'*64}}
    a.artifact_binding(receipt,host);bad=copy.deepcopy(receipt);bad['before']['artifact']='c'*64;bad['after']['artifact']='c'*64
    ok('foreign actual artifact rejected',rejects(lambda:a.artifact_binding(bad,host)))
    template={'files':{'main.ts':'export const value=1;'},'roots':['main.ts'],'options':{},'retained':True,'qualified':False,'sdk_directory':'/sdk/lib','roles':{},'selection':{},'disabled':[]}
    request=dict(template,cwd='/test',files={'/test/main.ts':'export const value=1;'},roots=['/test/main.ts'])
    a.verify_request_template(request,template);bad=copy.deepcopy(request);bad['files']['/test/main.ts']='foreign'
    ok('foreign source bytes rejected',rejects(lambda:a.verify_request_template(bad,template)))
    bad=copy.deepcopy(request);del bad['retained'];ok('missing explicit input field rejected',rejects(lambda:a.verify_request_template(bad,template)))
    bad=copy.deepcopy(request);bad['qualified']=True;ok('foreign profile rejected',rejects(lambda:a.verify_request_template(bad,template)))
    original={'unit_id':'unit','requests':[template],'checks':[{'target':['value'],'mode':'eq','expected':True}]}
    support={'support_id':'support','source_pointer':'/0','checks':[{'target':['code'],'expected':1127}]}
    source={'id':'source','recipes':[dict(original)]}
    digest=lambda value:a.sha(json.dumps(value,sort_keys=True,ensure_ascii=True,separators=(',',':')).encode())
    frozen={'recipe_contracts':{'original':{'unit':digest(original)},'support':{'support':digest(support)},'source':{'source':[digest(original)]}}}
    contract_host={'recipes':{'recipes':[original],'support_recipes':[support]},'registry':{'rows':[source]}}
    old=a.scope_protocol;a.scope_protocol=lambda:frozen
    try:
        a.validate_recipe_contracts(contract_host)
        bad=copy.deepcopy(contract_host);bad['recipes']['recipes'][0]['checks'][0]['expected']=False
        ok('changed original expectation rejected',rejects(lambda:a.validate_recipe_contracts(bad)))
        bad=copy.deepcopy(contract_host);bad['recipes']['support_recipes'][0]['checks'][0]['expected']=1490
        ok('changed support expectation rejected',rejects(lambda:a.validate_recipe_contracts(bad)))
        bad=copy.deepcopy(contract_host);bad['registry']['rows'][0]['recipes'][0]['requests'][0]['files']['main.ts']='foreign'
        ok('changed source input contract rejected',rejects(lambda:a.validate_recipe_contracts(bad)))
    finally:a.scope_protocol=old
    host={'fixture':{'artifact_path':'/DEV/probe','sdk_path':'/DEV/sdk.json'}}
    prepared={'case_root':'/DEV/input','repository_root':'/DEV/workspace'}
    frame={'argv':['/DEV/probe','/DEV/input/ordinary-index-request.json','/DEV/sdk.json'],'cwd':'/DEV/workspace','outcome':output}
    def native_receipt(value):return [{'path':'/DEV/ordinary-index-process.json','native_c1':value['argv'][0]=='/DEV/probe','frame_id':v2.digest(value),'process_outcome_id':v2.digest(value['outcome'])}]
    ok('DEV mandatory native profile binding',v2.native_process_binding(host,prepared,{'ordinary-index-process.json':frame},native_receipt(frame),'ordinary-index')=={'value':True})
    for label,index,value in [('native-false foreign argv',0,'/foreign/program'),('foreign request argv',1,'/foreign/request'),('foreign SDK argv',2,'/foreign/sdk')]:
        bad=copy.deepcopy(frame);bad['argv'][index]=value
        ok(label+' rejected after receipt rehash',rejects(lambda bad=bad:v2.native_process_binding(host,prepared,{'ordinary-index-process.json':bad},native_receipt(bad),'ordinary-index')))
    ok('admitted changed base requires actual receipt',v2.public_base_required({'admission':{'status':'admitted'}},'@@ -1 +1 @@\n-old\n+new') and rejects(lambda:v2.public_base_binding(host,prepared,{},[],{},lambda _:{})))
    return {'kind':'PURE_POISON_CONTROLS','controls':len(passed),'passed':passed,'native_queries':0,'host_exports_required':False,'qualification_credit':0}
def main():print(json.dumps(run_controls()))
if __name__=='__main__':main()
