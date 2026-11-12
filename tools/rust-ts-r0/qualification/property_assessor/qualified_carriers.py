"""Strict scratch carriers. No native execution, report-PASS fallback or qualification.

configure(api); load_original_qualified(host, recipe, ordinal=0) -> observed, evidence
load_public_lifecycle(host, row, operation) -> projection, evidence
All failed validation raises ValueError. Public full-verify remains a GAP.
"""
import ast, copy, hashlib, json, posixpath, re, subprocess
from pathlib import Path
from functools import lru_cache

API=None
def configure(api):
    global API
    API=api
def _get(name):return API[name] if isinstance(API,dict) else getattr(API,name)
def read(p):return _get('read')(str(p))
def pin(p):return _get('pin')(p)
def canonical(v):return json.dumps(v,sort_keys=True,ensure_ascii=False,separators=(',',':'))
def sha(v):return hashlib.sha256(v).hexdigest()
def digest(v):return 'sha256:'+sha(canonical(v).encode())
@lru_cache(None)
def coverage_kinds(head):
    source=_get('frozen_git_source')(head,'tools/rust-ts-r0/tests/support/receiver_context.rs')
    block=source.split('const KINDS: &[&str] = &[',1)[1].split('];',1)[0]
    return set(re.findall(r'"([^"]+)"',block))
def require(v,why):
    if not v:raise ValueError('QUALIFIED_CARRIER: '+why)
def process(value,allowed=(('success',0),)):
    require(isinstance(value,dict),'process object absent')
    for s in ('stdout','stderr'):
        require(type(value.get(s)) is str,'stream absent')
        b=value[s].encode();require(type(value.get(s+'_bytes')) is int and isinstance(value.get(s+'_hash'),str) and len(b)<=8388608 and value[s+'_bytes']==len(b) and value[s+'_hash'].removeprefix('sha256:')==sha(b),'incomplete/substituted '+s)
    require(type(value.get('exit_code')) is int and (value.get('kind'),value['exit_code']) in allowed and value['stderr']=='','process not supported complete success/refusal')
    return value
def key(path,sensitive):
    p=path.replace('\\','/');require(not p.startswith('//') and (p.startswith('/') or re.match(r'^[A-Za-z]:/',p)),'absolute confined key required')
    p=posixpath.normpath(p);return p if sensitive else p.lower()
def location(root,path,sensitive,domain):
    r=key(root,sensitive).rstrip('/');p=key(path,sensitive)
    return p,{'domain':domain,'path':p[len(r)+1:] if p.startswith(r+'/') else ''} if p==r or p.startswith(r+'/') else {'domain':'external','path':p}
def logical_input(request,sdk):
    sensitive=request['case_sensitive'];require(type(sensitive) is bool,'case mode absent');seen=set();project=[]
    for field,rep,payload in [('files','text','text'),('utf16_files','utf16','units'),('raw_files','raw','bytes')]:
        require(isinstance(request.get(field),dict),'explicit input representation absent')
        for p,v in request[field].items():
            k,loc=location(request['cwd'],p,sensitive,'repository');require(k not in seen,'duplicate canonical source');seen.add(k)
            e={'location':loc,'representation':rep}
            if field=='raw_files':e.update(bytes=v['bytes'],profile=v['profile'])
            else:e[payload]=v
            project.append(e)
    libs=[]
    for p,text in sdk['files'].items():
        k,loc=location(request['sdk_directory'],p,sensitive,'sdk');require(k not in seen,'SDK/source collision');seen.add(k);libs.append({'location':loc,'text':text})
    return {'domain':'T00-logical-input-v2','project':sorted(project,key=canonical),'sdk':{'domain':'T00-logical-sdk-v2','version':sdk['version'],'archive_sha256':sdk['archive_sha256'],'files':sorted(libs,key=canonical)}}
def reads(raw,request,host,batch=False):
    known={**host['sdk']['files'],**request['files']};probes=raw['input_observations' if batch else 'capture_probes'];require(isinstance(probes,list) and probes,'read inventory absent')
    for p in probes:
        require(type(p.get('found')) is bool,'read found is not bool')
        if batch:require(p.get('context')=='captured-filesystem','foreign probe context')
        require(p['operation'] in ['captured_cwd','case_sensitive','configuration_discovery_file_exists','read_file','file_exists','directory_exists','directory_entries','realpath','stat'],'foreign capture operation')
        if p['operation']=='captured_cwd':require(p['found'] is True and key(p['path'],request['case_sensitive'])==key(request['cwd'],request['case_sensitive']),'captured cwd differs')
        if p['operation']=='case_sensitive':require(p['found']==request['case_sensitive'] and p['path']=='','captured case differs')
        if p['operation']=='read_file' and p['found']:
            require(p['path'] in known and p['content_id']=='sha256:'+sha(known[p['path']].encode()),'read bytes not bound to actual project/SDK')
    return len([p for p in probes if p['operation']=='read_file' and p['found']])
def raw_bound(raw,request,host):
    require(raw.get('producer_artifact_id')=='sha256:'+host['fixture']['artifact_sha256'],'foreign artifact')
    require(raw.get('request')==request['id'] and raw.get('request_id')==digest(request),'foreign request')
    require(raw.get('input_manifest_id')==digest(logical_input(request,host['sdk'])),'foreign logical input')
    require(raw.get('complete') is True and raw.get('global_admission_inferred') is False,'incomplete/global raw')
    reads(raw,request,host)
def batch_bound(batch,request,host):
    inp=logical_input(request,host['sdk']);iid=digest(inp)
    cid=digest({'domain':'T00-logical-capture-v2','repository_root':'T00_REPOSITORY_ROOT','case_sensitive':request['case_sensitive'],'project':inp['project']})
    sid=digest({'domain':'T00-captured-snapshot-v2','input_manifest_id':iid,'capture_id':cid})
    subjects={}
    for p in request['roots']:
        if p.endswith(('.d.ts','.d.mts','.d.cts')):continue
        _,loc=location(request['cwd'],p,request['case_sensitive'],'repository');require(loc['domain']=='repository','outside root')
        rel=loc['path'];require(rel not in subjects,'duplicate root');subjects[rel]={'role':request['roles'].get(rel,'source'),'selection':request['selection'].get(rel,'selected')}
    scope={'profile':'modelo-suite-static-v1' if request['qualified'] else 'ordinary','repository_root':request['cwd'],'sdk_directory':request['sdk_directory'],'retained':request['retained'],'effective_options':request['options'],'subjects':subjects}
    if request['disabled']:scope['disabled']=request['disabled']
    ids={'input_manifest_id':iid,'capture_id':cid,'snapshot_id':sid,'scope_id':digest(scope),'producer_artifact_id':'sha256:'+host['fixture']['artifact_sha256'],'case_id':request['id'],'request_id':request['id'],'profile':scope['profile']}
    require(all(batch.get(k)==v for k,v in ids.items()) and batch.get('complete') is True and batch.get('schema_version')==1,'batch identity/profile/completeness mismatch')
    facts=batch['facts'];nodes=[f['payload'] for f in facts if f['record']=='node'];edges=[f['payload'] for f in facts if f['record']=='edge']
    require(batch['facts_id']==digest(facts) and batch['graph_id']==digest({'nodes':nodes,'edges':edges}),'batch collector facts/graph substituted')
    reports=batch['subjects'];require(len({r['subject_id'] for r in reports})==len(reports) and {r['subject_id'] for r in reports}==set(subjects),'batch subject denominator differs')
    diagnostics=batch['diagnostics'];require(all(d['subject_id'] in subjects for d in diagnostics),'foreign diagnostic subject')
    refused=False
    for r in reports:
        wanted=subjects[r['subject_id']];require(r['selection']==wanted['selection'],'subject selection changed')
        if r['selection']=='excluded':require(r.get('outcome') is None and r['coverage']==[],'excluded outcome claims proof');continue
        if r['outcome']=='analyzed':
            require(len(r['coverage'])==len(coverage_kinds(host['source_head'])) and {c['fact_kind'] for c in r['coverage']}==coverage_kinds(host['source_head']) and all(c['complete'] is True and c['negative_evidence_eligible']==bool(request['retained'] and request['qualified']) for c in r['coverage']),'analyzed coverage incomplete/duplicate')
            expected_kind='test' if wanted['role']=='test' else 'module'
            require(sum(f['record']=='node' and f['subject_id']==r['subject_id'] and f['payload'].get('filePath')==r['subject_id'] and f['payload']['kind']==expected_kind for f in facts)==1,'analyzed subject actual module node missing/duplicate')
        else:
            require(r['outcome'] in ['failed','unsupported','unknown','disabled'] and r['coverage']==[] and any(d['subject_id']==r['subject_id'] for d in diagnostics),'unjustified refusal');refused=True
    require(batch['terminal']==('refused' if refused else 'complete'),'batch terminal contradicts outcomes');reads(batch,request,host,True)
    return {'refused':refused,'batch_id':digest(batch),'nodes':nodes,'edges':edges,**ids}
def template(request,recipe):
    require(len(recipe['requests'])==1,'one request required');_get('verify_request_template')(request,recipe['requests'][0])
    require(request['id']==recipe['requests'][0]['id'],'foreign frozen request id')
def load_original_qualified(host,recipe,ordinal=0):
    require(ordinal==0,'only observation zero supported');require(bool(host.get('identity')),'host epoch not validated')
    i=host['unit_indices'][recipe['unit_id']];folder=host['root']/'original-evidence'/f'unit-{i:03d}';refs=[]
    if recipe['surface']=='ambiguous_exports_cli':
        raw,request,rrefs=_get('parsed_outcome')(folder/'raw/process-outcome.json',host);refs+=rrefs;template(request,recipe);raw_bound(raw,request,host)
        capture=read(folder/'batch-process.json');process(capture['outcome']);require(capture['before']==capture['after'] and capture['before'][:3]==[host['fixture'][k] for k in ('artifact_sha256','helper_sha256','sdk_sha256')] and capture['before'][3]==pin(folder/'raw/request.json')['sha256'],'batch artifact/input changed')
        batch=json.loads(capture['outcome']['stdout']);bound=batch_bound(batch,request,host)
        require({'nodes':bound['nodes'],'edges':bound['edges']}=={'nodes':raw['assembly']['nodes'],'edges':raw['assembly']['edges']},'raw/batch graph mismatch')
        consumer=read(folder/'result.json')['consumer'];require(consumer['batch_id']==bound['batch_id'] and consumer['global_admission_inferred'] is False,'actual Rust receiver receipt absent/foreign')
        codes={d['code'] for d in batch['diagnostics']};expected=set(recipe['expected_ambiguity_reasons']);require((not expected and not bound['refused']) or expected<=codes and bound['refused'],'arbitrated ambiguity reason absent')
        expected_receipt={'qualified_admission_refused':bound['refused'],'consumer_disposition':'controlled_refusal' if bound['refused'] else 'analyzed','private_graph_ownership':not bound['refused']}
        require(all(consumer[k]==v for k,v in expected_receipt.items()),'Rust receiver disposition/ownership contradiction')
        refs += [pin(folder/'batch-process.json'),pin(folder/'result.json')]
        return dict(raw,**expected_receipt),{'raw_refs':refs,'binding':bound,'scope':'actual ambiguity receiver receipt joined to raw and batch graph; no application token proof'}
    require(recipe['surface']=='qualified_flow_cli' and not recipe.get('public_flow_kind'),'unsupported original qualified subtype')
    request=read(folder/'index-request.json');template(request,recipe);index=read(folder/'index-invocation.json');process(index['outcome']);batch=json.loads(index['outcome']['stdout']);batch_bound(batch,request,host)
    descriptor=read(folder/'verify-descriptor.json');verify=read(folder/'verify-invocation.json');outcome=process(verify['outcome'],(('success',0),('nonzero',3)));report=json.loads(outcome['stdout'])
    require(verify['descriptor_sha256']==pin(folder/'verify-descriptor.json')['sha256'] and verify['producer_sha256']==host['fixture']['artifact_sha256'],'verify descriptor/artifact substituted')
    require(descriptor['index']['analysis']==request and descriptor['index']['outcome']==index['outcome'] and descriptor['include']==recipe['include'] and descriptor['exclude']==recipe['exclude'],'descriptor index/selection differs')
    head=read(folder/'index-head.json');process(head['outcome']);require(head['outcome']['stdout'].strip()==descriptor['index']['baseCommit'],'actual Git HEAD differs')
    require(report['request_descriptor_id']==digest(descriptor) and report['sdk_input_id']==digest(host['sdk']) and report['producer_artifact_id']=='sha256:'+host['fixture']['artifact_sha256'] and report['indexed_extraction_received'] is True and report['global_admission_inferred'] is False,'qualified verification foreign/incomplete')
    raw_bound(report['selected_analysis'],request,host);broad=copy.deepcopy(request);broad['roots']=sorted(p for p in request['files'] if p.endswith(('.ts','.tsx','.mts','.cts','.js','.jsx','.mjs','.cjs')));raw_bound(report['broad_analysis'],broad,host)
    subject=report['selected_analysis']['subjects'][0];config=subject['moduleConfigurationObservations']['retainedWithSource'];require(config['executed'] is True and config['unsupported']==[] and config['reasons']==[] and report['inherited_configuration']['executed'] is True and report['inherited_configuration']['consumed']==subject['configurationConsumed'],'selected inherited configuration incomplete')
    require(all(request['cwd']+'/'+n in subject['configurationConsumed'] for n in ('tsconfig.json','base.json')),'inherited config not actually read')
    for name in ('head_git_outcome','changed_git_outcome'):process(report[name])
    admission=report['analysisAdmission']['status'];require((admission,outcome['exit_code']) in [('admitted',0),('rejected',3)] and (admission!='rejected' or report['verdict']=='BLOCK'),'CLI admission/exit contradiction')
    refs=[pin(folder/n) for n in ['index-request.json','index-invocation.json','index-head.json','verify-descriptor.json','verify-invocation.json']]
    observed={'analysisAdmission_status':admission,'verdict':report['verdict'],'public_cli_exit':outcome['exit_code'],'coverage':report['analysisAdmission']['changeCoverage']['files'],'native_report_id':digest(report)}
    return observed,{'raw_refs':refs,'request_id':digest(request),'sdk_input_id':digest(host['sdk']),'scope':'original bounded qualified CLI working-tree counterpart; not public assembled runVerify'}

@lru_cache(None)
def _discovery_projector(head):
    repo=Path(_get('REPO'));path='tools/rust-ts-r0/qualification/supplement/lifecycle_adapter_29_frozen.py'
    code=subprocess.check_output(['git','-C',str(repo),'show',head+':'+path]).decode();tree=ast.parse(code)
    fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='project_qualified_discovery');source=ast.get_source_segment(code,fn)
    runtime,_=_get('projector')(head);env={'Gap':ValueError,'normalize':runtime.normalize};exec(compile(source,path,'exec'),env)
    return env['project_qualified_discovery'],{'git_object':head+':'+path,'sha256':sha(code.encode())}
def load_public_lifecycle(host,row,operation):
    require(operation.get('lifecycle_selector') is True,'not a lifecycle operation');key_=operation['invocation_key'];matches=[i for i in host['plan']['invocations'] if i['key']==key_];require(len(matches)==1,'ambiguous lifecycle invocation')
    invocation=matches[0];prepared=invocation['prepared'];kind=prepared['public_flow_kind'];out=host['root']/'evidence/public/outcomes'/key_;folder=host['root']/'evidence/public/invocations'/key_/'input'
    # Deliberately not infer a positive from report projection or partial failed full-flow carrier.
    require(kind!='public-verify','actual full public runVerify requires complete supported final consumer capture; current failed run remains GAP')
    bridge=read(out/'bridge-evidence.json');observed=read(folder/'public-lifecycle-observations.json');consumer=read(out/'consumer-result.json')
    require(bridge['lifecycle_observed']==observed==consumer['observed'] and consumer['global_admission_inferred'] is False and consumer['invocation_group_id']==key_.removeprefix('lifecycle-'),'bridge/Rust lifecycle collector substituted')
    binding=bridge['binding'];require(binding['producer_artifact_id']=='sha256:'+host['fixture']['artifact_sha256'] and binding['sdk_input_id']==digest(host['sdk']) and binding['capture_stream_sha256']==prepared['source_capture_stream_sha256'] and binding['source_recipe_id']==digest(prepared),'lifecycle recipe/artifact/SDK/capture mismatch')
    refs=[pin(out/'bridge-evidence.json'),pin(out/'consumer-result.json'),pin(folder/'public-lifecycle-observations.json')]
    receipts=binding['actual_process_receipts'];require(receipts and len({x['path'] for x in receipts})==len(receipts),'actual process receipt inventory absent/duplicate')
    frames={}
    for receipt in receipts:
        path=folder/receipt['path'].rsplit('/',1)[-1];frame=read(path);require(receipt['frame_id']==digest(frame) and receipt['process_outcome_id']==digest(frame['outcome']),'actual process frame receipt differs');process(frame['outcome']);frames[path.name]=json.loads(frame['outcome']['stdout']) if receipt['native_c1'] else frame['outcome'];refs.append(pin(path))
    require(observed.get('global_admission_inferred') is False,'global admission claim')
    if kind=='index-store':
        request=read(folder/'analysis-request.json');template(request,prepared);batch=frames['index-process.json'];bound=batch_bound(batch,request,host)
        require(observed['index_batch']==batch and observed['request_descriptor']==request and read(folder/'transient-index.json')==batch and observed['index_batch_id']==digest(batch),'actual index store/readback differs')
        receipt=observed['batch_binding_receipt'];require(receipt['batch_id']==digest(batch) and receipt['input_manifest_id']==bound['input_manifest_id'] and receipt['state']=='BOUND_COMPLETE_INDEX_BATCH' and receipt['admissible_index_store'] is True and not bound['refused'],'actual complete index receipt absent')
        require(observed['index_store_written'] is True and observed['index_store_readback_equal'] is True and observed['git_head'],'actual store write not observed')
        refs += [pin(folder/n) for n in ('analysis-request.json','transient-index.json','native-index-binding-receipt.json')];return {'statefulSetupObserved':True},{'raw_refs':refs,'binding':bound,'scope':'ordinary structural index store/readback only'}
    if kind=='retained-scope':
        request=read(folder/'analysis-request.json');template(request,prepared);raw=frames['index-process.json'];raw_bound(raw,request,host);require(observed['raw_scope']==raw,'scope raw frame differs')
        ast_receipt=observed['scope_ast_receipt'];unsigned={k:v for k,v in ast_receipt.items() if k!='ast_receipt_id'}
        require(ast_receipt['kind']=='rust-consumer-native-ast-v1' and ast_receipt['ast_receipt_id']==digest(unsigned) and ast_receipt['request_descriptor_id']==digest(request) and ast_receipt['input_manifest_id']==raw['input_manifest_id'] and ast_receipt['consumer_artifact_id']=='sha256:'+host['fixture']['public_consumer_artifact_sha256'],'scope AST Rust receipt foreign')
        broad=frames['scope-broad-process.json'];query=read(folder/'scope-broad-discovery.json');require(broad['request_descriptor_id']==digest(query) and broad['producer_artifact_id']=='sha256:'+host['fixture']['artifact_sha256'] and observed['scope_broad_discovery']==broad,'scope broad collector differs')
        runtime,_=_get('projector')(host['source_head']);projection=observed['rust_scope_projection'];require(isinstance(projection,dict) and set(projection)=={'links','reasons','externalModuleSpecifiers','unresolvedImports'},'scope Rust projection shape absent')
        refs += [pin(folder/n) for n in ('analysis-request.json','scope-broad-discovery.json')];return runtime.normalize(projection,prepared),{'raw_refs':refs,'scope':'actual Rust scope AST/collector projection; no full admission inferred','ast_receipt_id':ast_receipt['ast_receipt_id']}
    require(kind=='qualified-discovery','unsupported lifecycle subtype')
    for field,name,qname in [('ordinary_discovery','ordinary-discovery-process.json','ordinary-discovery.json'),('eligibility','eligibility-process.json','eligibility.json'),('system','system-process.json','system.json')]:
        raw=frames[name];query=read(folder/qname);require(raw['request_descriptor_id']==digest(query) and raw['producer_artifact_id']=='sha256:'+host['fixture']['artifact_sha256'] and observed[field]==raw,'discovery/System raw collector differs');refs.append(pin(folder/qname))
    projector,source=_discovery_projector(host['source_head']);return projector(prepared,observed),{'raw_refs':refs,'projector_source':source,'scope':'qualified discovery Git eligibility plus actual System reads only'}

def poison_controls(host):
    """Actual captured carriers with one changed field each; no invented positive.
    Returns evidence without writing the captured inputs.
    """
    results=[]
    def reject(name,call):
        try:call()
        except (ValueError,AssertionError,KeyError):results.append({'name':name,'rejected':True});return
        raise ValueError('poison accepted '+name)
    for unit in ('P19-qualified-inherited-esnext-bundler::base','V3-E03-ambiguous-stars-arbitrated-refusal::E03-a-then-b'):
        recipe=host['recipes']['recipes'][host['unit_indices'][unit]];observed,evidence=load_original_qualified(host,recipe)
        bad=copy.deepcopy(recipe);bad['requests'][0]['files'][next(iter(bad['requests'][0]['files']))]+='\n// poison'
        reject(unit+':frozen-input',lambda bad=bad:load_original_qualified(host,bad))
    i=host['unit_indices']['P19-qualified-inherited-esnext-bundler::base'];v=read(host['root']/'original-evidence'/f'unit-{i:03d}'/'verify-invocation.json')['outcome'];bad=copy.deepcopy(v);bad['stdout_bytes']+=1;reject('qualified:truncated-stream',lambda:process(bad,(('success',0),('nonzero',3))))
    bad=copy.deepcopy(v);bad['kind']='nonzero';bad['exit_code']=3;require(json.loads(bad['stdout'])['analysisAdmission']['status']=='admitted','poison source changed');reject('qualified:exit-admission',lambda:require((json.loads(bad['stdout'])['analysisAdmission']['status'],bad['exit_code']) in [('admitted',0),('rejected',3)],'admission mismatch'))
    for row in host['plan']['rows']:
        op=next((o for o in row['operations'] if o.get('lifecycle_selector') and o['prepared_projection']['public_flow_kind']=='index-store'),None)
        if op:
            load_public_lifecycle(host,row,op);badhost=dict(host,fixture=dict(host['fixture'],artifact_sha256='0'*64));reject('lifecycle:index-foreign-artifact',lambda badhost=badhost,row=row,op=op:load_public_lifecycle(badhost,row,op));break
    for row in host['plan']['rows']:
        op=next((o for o in row['operations'] if o.get('lifecycle_selector') and o['prepared_projection']['public_flow_kind']=='retained-scope'),None)
        if op:
            load_public_lifecycle(host,row,op);badhost=dict(host,fixture=dict(host['fixture'],public_consumer_artifact_sha256='0'*64));reject('lifecycle:scope-foreign-Rust-consumer',lambda badhost=badhost,row=row,op=op:load_public_lifecycle(badhost,row,op));break
    return {'kind':'ACTUAL_CARRIER_POISON_CONTROLS','controls':results,'native_queries':0,'qualified':False}

def load_source_scope(host,recipe,base):
    """Existing source_scope_cli observation: actual Rust retained-scope DTO.

    No .checks or report-PASS prerequisite. Caller compares only pinned
    recipe.expected_scope, keeping malformed/missing captures as GAP.
    """
    require(recipe.get('surface')=='source_scope_cli' and recipe.get('public_flow_kind')=='retained-scope','not an existing source scope carrier')
    require(bool(host.get('identity')),'host epoch not validated');folder=Path(base)
    require(folder.is_relative_to(host['root']),'source scope carrier outside actual host root')
    request=read(folder/'analysis-request.json');template(request,recipe)
    require(request['retained'] is True,'source scope requires actual retained context')
    frame=read(folder/'index-process.json');process(frame['outcome']);raw=json.loads(frame['outcome']['stdout']);raw_bound(raw,request,host)
    require(frame['argv'][0]==host['fixture']['artifact_path'],'source scope native argv artifact differs')
    allowed_units={'source::reference-unretained','source::reference-retained','source::reference-outside','source::optional-opaque','source::excluded-parse','source::excluded-computed','source::excluded-unresolved'}
    allow_unborn=(recipe.get('allow_unborn_head') is True and recipe.get('source_scope_origin')=='923a03767cd5f675c66f4a35b458dcd6f38554fe3c41f90f5a83eebc7292ddc6' and recipe.get('git_setup')==[['git','init','-q']] and recipe.get('git_after_current')==[] and recipe.get('unit_id') in allowed_units)
    require(allow_unborn,'source scope wrapper is outside its exact frozen seven inputs')
    # The source_scope_replay.rs wrapper supplies this internal flag; it is not
    # an immutable registry field and does not change its request or expected DTO.
    component=recipe['unit_id']=='source::reference-outside'
    require(('--observe-source-components' in frame['argv'])==component,'source component mode differs from recipe')
    if component:require(recipe['unit_id']=='source::reference-outside' and raw['status']=='source_root_component_observation_not_qualification','unsupported component mode boundary')
    observed=read(folder/'public-lifecycle-observations.json')
    require(observed['raw_scope']==raw and observed['request_descriptor']==request and observed['global_admission_inferred'] is False and observed['repository_root']==request['cwd'],'source scope raw collector differs')
    ast_receipt=observed['scope_ast_receipt'];unsigned={k:v for k,v in ast_receipt.items() if k!='ast_receipt_id'}
    require(ast_receipt['kind']=='rust-consumer-native-ast-v1' and ast_receipt['ast_receipt_id']==digest(unsigned) and ast_receipt['request_descriptor_id']==digest(request) and ast_receipt['input_manifest_id']==raw['input_manifest_id'],'source scope AST request/input/hash differs')
    require(ast_receipt['consumer_artifact_id']=='sha256:'+host['fixture']['public_consumer_artifact_sha256'] and ast_receipt['sdk_input_id']==digest(host['sdk']) and ast_receipt['global_admission_inferred'] is False and ast_receipt['semantic_program_substituted'] is False,'source scope Rust/SDK provenance differs')
    sources=ast_receipt['sources'];require(len({s['path'] for s in sources})==len(sources),'duplicate scope AST source')
    for source in sources:
        actual=request['files'].get(request['cwd']+'/'+source['path']);require(type(actual) is str and source['source_sha256']=='sha256:'+sha(actual.encode()),'scope AST actual source bytes differ')
    query=read(folder/'scope-broad-discovery.json');expected_query=copy.deepcopy(recipe['broad_discovery_request']);expected_query['repositoryRoot']=request['cwd'];require(query==expected_query,'source scope broad input differs')
    broad_frame=read(folder/'scope-broad-process.json');process(broad_frame['outcome']);broad=json.loads(broad_frame['outcome']['stdout'])
    require(broad['request_descriptor_id']==digest(query) and broad['producer_artifact_id']=='sha256:'+host['fixture']['artifact_sha256'] and observed['scope_broad_discovery']==broad,'source scope broad collector/identity differs')
    head_frame=read(folder/'git-head.json');head=head_frame['outcome']
    if head['kind']=='nonzero':
        require(allow_unborn,'unborn source scope HEAD not authorized');process(head,(('nonzero',1),));require(head['stdout']=='' and observed['git_head']=='','unborn HEAD is not an empty absence')
    else:process(head);require(head['stdout'].strip()==observed['git_head'],'scope HEAD collector differs')
    for n in range(len(recipe['git_setup'])):process(read(folder/f'git-setup-{n}.json')['outcome'])
    projection=observed['rust_scope_projection'];require(isinstance(projection,dict) and set(projection)=={'links','reasons','externalModuleSpecifiers','unresolvedImports'},'actual source Rust scope DTO absent')
    require(all(type(x) is str for x in projection['reasons']+projection['externalModuleSpecifiers']),'scope reason/external type differs')
    refs=[pin(folder/n) for n in ('analysis-request.json','index-process.json','public-lifecycle-observations.json','scope-broad-discovery.json','scope-broad-process.json','git-head.json')]
    return projection,{'raw_refs':refs,'request_id':digest(request),'input_manifest_id':raw['input_manifest_id'],'ast_receipt_id':ast_receipt['ast_receipt_id'],'scope':'actual Rust retained-scope projection on existing source fixture; no full public admission or qualification'}
