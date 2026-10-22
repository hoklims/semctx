"""Finite v2 carriers: raw bindings first, frozen consumer fields second. No queries."""
import copy,json,hashlib
from physical_system_carrier import physical_system_contract
from pathlib import Path
import qualified_carriers as q
from raw_compare import projected,transform
API=None
def configure(api):
    global API;API=api;q.configure(api)
def read(p):return API.read(str(p))
def pin(p):return API.pin(p)
def digest(v):return q.digest(v)
def require(value,message):
    if not value:raise ValueError('V2_CARRIER: '+message)
def guarded(call):
    try:return call()
    except (AssertionError,ValueError,TypeError,KeyError,IndexError,OSError,StopIteration) as error:return {'state':'GAP','gap':str(error)}

def identity_support(host,recipe,base):
    template=next(r for r in host['recipes']['recipes'] if r['unit_id']=='P01-retained-source::base')['requests'][0]
    contexts=[];refs=[]
    for name in ('before','subject','after'):
        folder=base/name;frame=read(folder/'invocation.json');q.process(frame['outcome']);request=read(folder/'request.json');sdk=read(folder/'sdk.json')
        require(len(frame['argv'])==4 and frame['argv'][1]=='--batch' and frame['argv'][2].endswith('/'+name+'/request.json') and frame['argv'][3].endswith('/'+name+'/sdk.json'),'identity batch invocation context differs')
        require(frame['argv'][0]==host['fixture']['artifact_path'],'identity batch executable differs')
        batch=json.loads(frame['outcome']['stdout']);context=dict(host,sdk=sdk);bound=q.batch_bound(batch,request,context);require(not bound['refused'],'identity batch refused')
        wanted=copy.deepcopy(template)
        if name=='subject' and recipe['support_id']=='IDENTITY::I-request-separation':wanted['id']+='-different-request'
        if name=='subject' and recipe['support_id']=='IDENTITY::I-relocation':wanted['sdk_directory']='/relocated-sdk/lib'
        API.verify_request_template(request,wanted);require(request['id']==wanted['id'],'identity request id differs')
        require({p.removeprefix(request['sdk_directory']+'/'):t for p,t in sdk['files'].items()}=={p.removeprefix(template['sdk_directory']+'/'):t for p,t in host['sdk']['files'].items()} and sdk['version']==host['sdk']['version'] and sdk['archive_sha256']==host['sdk']['archive_sha256'],'identity SDK relocation bytes differ')
        contexts.append((batch,request,bound,frame['outcome']));refs += [pin(folder/n) for n in ('invocation.json','request.json','sdk.json')]
    before,subject,after=contexts
    require(before[0]==after[0] and before[1]==after[1],'identity restored control differs')
    stable=all(before[0][k]==subject[0][k] for k in ('input_manifest_id','capture_id','snapshot_id','producer_artifact_id'))
    relocation=recipe['support_id']=='IDENTITY::I-relocation'
    relation=(before[0]['scope_id']!=subject[0]['scope_id']) if relocation else (before[0]['scope_id']==subject[0]['scope_id'] and before[0]['request_id']!=subject[0]['request_id'])
    collector=read(base/'identity-support-result.json')
    required={'stable_content_bindings':stable,'relation_satisfied':relation,'old_receiver_rejected':True,'old_receiver_rejection':'Some(IdentityMismatch)',
      'before_batch_hash':before[3]['stdout_hash'],'subject_batch_hash':subject[3]['stdout_hash'],'after_batch_hash':after[3]['stdout_hash'],
      'original_request_descriptor_id':digest(before[1]),'other_request_descriptor_id':digest(subject[1]),'original_scope_id':before[0]['scope_id'],'other_scope_id':subject[0]['scope_id'],
      **{k:before[0][k] for k in ('input_manifest_id','capture_id','snapshot_id','producer_artifact_id')},'sdk_logical_id':digest(q.logical_input(before[1],host['sdk'])['sdk']),'native_contexts':3,'global_admission_inferred':False}
    require(projected(collector,required),'identity receiver collector does not bind actual three contexts')
    return {'state':'RELEVANT_PASS' if stable and relation else 'NONPASS','actual':required,'raw_refs':refs+[pin(base/'identity-support-result.json')],
      'scope':'Actual three complete batch contexts, independently recomputed logical/capture/snapshot/scope IDs, restored control and bound receiver rejection; no graph-relocation invariance claim'}

def token_context(raw,request,host,actual,stdout_hash):
    q.raw_bound(raw,request,host);require(len(raw['subjects'])==1 and request['retained'] is True and request['qualified'] is True and len(request['roots'])==1,'token retained ownership observation profile differs')
    successful=[p['path'] for p in raw['capture_probes'] if p['operation']=='read_file' and p['found'] is True]
    require(request['roots'][0] in successful and any(p.startswith(request['sdk_directory']+'/') for p in successful),'token source/SDK successful reads absent')
    own=raw['subjects'][0]['opaqueCallbackOwnership'];graph=own['graphBeforeEdgeRemoval'];removed=own['graphAfterEdgeRemoval']
    require(own['executed'] is True and own['unsupported']==[] and own['observationScope']=='native_module_configuration_graph_ownership' and own['globalAdmissionInferred'] is False,'token native ownership incomplete')
    require(graph['nodes'] and graph['edges'] and own['graphBeforeEdgeRemovalId']==digest(graph) and own['graphAfterEdgeRemovalId']==digest(removed) and removed==dict(graph,edges=[]),'token graph/edge-removal identities differ')
    def phase(name):
        value=own[name];require(value['executed'] is True and value['unsupported']==[] and all(isinstance(r,str) for r in value['reasons']),'token phase incomplete');return value
    before=phase('beforeAnalysis');after=phase('afterAnalysis');edge_free=phase('afterGraphEdgesRemoved')
    refuses=lambda v:any('SOURCE_OPAQUE_CALLBACK_UNSUPPORTED' in r for r in v['reasons'])
    require(refuses(before) and not refuses(after) and refuses(edge_free),'token ownership contrast absent')
    require(actual['kind']=='native-bound-application-token-controls-v1' and actual['counts']=={'issuance':13,'revalidation':7,'mapIdentity':1} and actual['global_admission_inferred'] is False,'token collector kind/denominator differs')
    provenance=actual['provenance'];require(projected(provenance,{'raw_facts_id':digest(raw),'native_graph_id':digest(graph),'request_id':digest(request),'capture_root':request['cwd'],'input_manifest_id':raw['input_manifest_id'],'process_stdout_sha256':stdout_hash,'controlled_seal_over_actual_native_observation_not_index_store_attestation':True}),'token collector foreign native context')
    require(provenance['native_binding']['request_id']==digest(request) and provenance['native_binding']['input_manifest_id']==raw['input_manifest_id'] and provenance['native_binding']['artifact_sha256']==host['fixture']['artifact_sha256'],'token native binding differs')
    require(provenance['native_read_join']['state']=='JOINED_REPORTED_SUCCESSFUL_READS_ONLY' and provenance['native_read_join']['read_paths']==sorted(set(successful)) and provenance['native_read_join']['supplied_sdk_files']==len(host['sdk']['files']) and provenance['native_read_join']['all_supplied_sdk_consumed_claimed'] is False,'token read join differs')
    rows=actual['revalidation'];require(len(rows)==7 and len({r['name'] for r in rows})==7,'token revalidation duplicate/absent')
    for row in rows:
        registered=row['registered'];require(type(registered) is bool and row['actual_native_phase']==('afterAnalysis' if registered else 'beforeAnalysis') and row['configuration_observation']==(after if registered else before) and row['refusal']==refuses(row['configuration_observation']),'token revalidation fields/phase differ from actual native phase')
    return provenance

def tokens(host,coordinate):
    base=host['root']/'evidence/token-guards';plan=host.get('token_family')
    require(isinstance(plan,dict),'explicit pinned token_family host input required')
    require(plan['execution_enabled'] is True and plan['candidate_execution_authorized'] is True and host['fixture']['token_execution_enabled'] is True,'actual token family disabled')
    expected=read(API.REPO/'docs/research/rust-ts-r0/cases/supplement-token-guards-20261021/expected.json')
    require(plan['expected']==expected and plan['counts']=={'issuance':13,'revalidation':7,'map_identity':1},'token expected/input denominator differs')
    import token_inputs
    frozen_plan=token_inputs.prepare(API.REPO/'docs/research/rust-ts-r0/cases/supplement-token-guards-20261021');frozen_plan['package_root']=plan['package_root']
    normalized=dict(plan,execution_enabled=False,candidate_execution_authorized=False);require(normalized==frozen_plan,'token full frozen fixture/Program/options input differs')
    request=read(base/'request.json');API.verify_request_template(request,plan['request_template']);require(request['id']==plan['request_template']['id'],'token request ID differs')
    outcome=read(base/'process-outcome.json');q.process(outcome);raw=json.loads(outcome['stdout']);actual=read(base/'actual-token-observations.json')
    invocation=read(base/'process-invocation.json');require(invocation['native_queries']==1 and invocation['cwd']==request['cwd'] and len(invocation['argv'])==3 and invocation['argv'][0]==host['fixture']['artifact_path'] and invocation['argv'][1].endswith('/token-guards/request.json') and invocation['argv'][2]==host['fixture']['sdk_path'],'token actual invocation context differs')
    provenance=token_context(raw,request,host,actual,outcome['stdout_hash'])
    report=read(base/'token-report.json');require(report['actual']==actual and report['expected']==expected and read(host['root']/'evidence/token-results.json')==report,'token report substituted')
    require(report['native_queries']==1 and report['counts']==plan['counts'] and report['baseline_actual_program_records']==21 and report['qualified'] is False and all(report[k]==plan[k] for k in ('package_pin_sha256','manifest_sha256','expected_sha256')),'token actual frozen family/denominator differs')
    return {'state':'RELEVANT_PASS' if projected(actual,expected) else 'NONPASS','actual':actual,'expected':expected,'raw_refs':[pin(base/n) for n in ('request.json','process-outcome.json','process-invocation.json','actual-token-observations.json','token-report.json')],
      'scope':'Frozen13 issuance+7 revalidation+1 Map identity over actual bound native ownership context; controlled seals, no index-store attestation','binding':provenance,'coordinate':coordinate}

def compiler(host):
    binding=host.get('native_compiler_identity');require(isinstance(binding,dict),'explicit native_compiler_identity source/core/build_environment pins required')
    source=API.load_pin(binding['receipt']);core=Path(binding['core']['path']).read_bytes();require(API.sha(core)==binding['core']['sha256']==source['source_sha256'] and len(core)==source['source_bytes'],'compiler core actual bytes differ')
    require(hashlib.sha1(b'blob '+str(len(core)).encode()+b'\0'+core).hexdigest()==source['git_blob'],'compiler core Git blob differs')
    require(source['engine_source_revision']=='d1f3c0c442ab71a2fce7a01980ed892bd27b9842' and source['upstream_base_revision']=='780dc512d64f40afebffa6a7028207649fb7ed1c','compiler fork/base differs')
    expression=['pub(crate) const VERSION: &str = match option_env!("GOPORT_BUILD_VERSION") {','    Some(version) => version,','    None => "7.1.0-dev",','};']
    require(core.decode().splitlines()[source['version_expression_first_line']-1:source['version_expression_first_line']+3]==expression and source['version_expression']==expression and source['GOPORT_BUILD_VERSION_present_in_build_environment'] is False,'compiler version source/override differs')
    env=API.load_pin(binding['build_environment']);require(env['source_head']==host['source_head'] and env['GOPORT_BUILD_VERSION_present'] is False and env['source_identity_sha256']==binding['receipt']['sha256'] and env['artifact_sha256']==host['fixture']['artifact_sha256'],'compiler build environment/source/artifact join absent')
    require(env['kind']=='NATIVE_BUILD_ENVIRONMENT_BINDING_V1' and env['state']=='frozen' and env['build_commands']==3,'compiler owning build record incomplete')
    require(env['source_before']==env['source_after'] and env['source_before']['head']==host['source_head'] and env['source_before']['status']=='','compiler build source bytes changed')
    for path,expected in API.frozen_source_pins.items():
        require(env['source_before']['files'].get(path)==expected['sha256'],'compiler build source bytes differ from pre-query protocol: '+path)
    require(env['build_environment_before']==env['build_environment_after'] and env['build_environment_before']['GOPORT_BUILD_VERSION_present'] is False,'compiler environment changed or override present')
    require(env['compiler_core_sha256']==binding['core']['sha256'] and env['qualification_observer_sha256']==host['fixture']['qualification_observer_sha256'] and env['helper_sha256']==host['fixture']['helper_sha256'],'compiler build core/observer/helper join differs')
    helper_source=API.frozen_git_source(host['source_head'],'tools/rust-ts-r0/qualification/native_build_identity.py');require(q.sha(helper_source.encode())==env['build_identity_helper_sha256'],'compiler build identity helper differs from pre-query source')
    envhash=q.sha(q.canonical(env['build_environment_before']).encode());kinds=set()
    for build in env['builds']:
        require(build['environment_sha256']==envhash,'compiler build environment hash differs')
        reference=build['receipt'];path=host['root']/reference['path'].replace('\\','/').rsplit('/',1)[-1];require(pin(path)['sha256']==reference['sha256'],'compiler build receipt differs');receipt=read(path)
        exit_code=receipt.get('exitCode',receipt.get('exit_code'));require(type(exit_code) is int and exit_code==0 and receipt.get('timedOut',receipt.get('timed_out')) is False and receipt['argv']==build['argv'],'compiler build command failed or differs')
        for stream in ('stdout','stderr'):
            reference=build[stream];path=host['root']/reference['path'].replace('\\','/').rsplit('/',1)[-1];require(pin(path)['sha256']==reference['sha256'] and pin(path)['bytes']==reference['bytes'],'compiler build raw output differs')
        kind=build['artifact_kind'];require(kind in ('artifact','qualification_observer','helper','transport_fixture'),'compiler foreign build kind')
        prefixes={'helper-build':['cargo','build','--locked','--offline','--release','--bins','--manifest-path'],
          'observer-build':['cargo','test','--locked','--offline','--release','--features','qualification-observer','--test','qualification_replay','--no-run','--message-format=json','--manifest-path'],
          'standalone-restore':['cargo','build','--locked','--offline','--release','--bin','semctx-r0-probe','--manifest-path']}
        label={'artifact':'standalone-restore','qualification_observer':'observer-build','helper':'helper-build','transport_fixture':'helper-build'}[kind]
        require(build['label']==label and build['argv'][:-1]==prefixes[label],'compiler owning Cargo command differs')
        suffix='tools/gates/Cargo.toml' if label=='helper-build' else 'tools/rust-ts-r0/Cargo.toml';require(build['argv'][-1].replace('\\','/').endswith(suffix),'compiler owning Cargo manifest differs')
        require(kind not in kinds and build['artifact_sha256']==host['fixture'][kind+'_sha256'],'compiler build artifact differs/duplicates');kinds.add(kind)
    require({'artifact','qualification_observer','helper','transport_fixture'}==kinds,'compiler owning build/observer/helper receipts missing')
    unit='ORD-DIALECT-CAPABILITY::base';raw,request,refs=API.raw_original(host,unit,{'observation':0});q.raw_bound(raw,request,host)
    require(raw['engine_revision']==source['engine_source_revision'] and raw['engine_upstream_revision']==source['upstream_base_revision'],'actual compiler fork identity differs')
    observed=raw['native_compiler_version'];require(observed=='7.1.0-dev' and raw['sdk_version']=='5.9.3','actual binary compiler or independent SDK version differs')
    dialects=transform(raw,'native_capability_dialect_versions');require(dialects==[observed],'every actual TypeScript/JavaScript capability scope must use independently observed engine version')
    return {'state':'RELEVANT_PASS','actual_native_compiler_version':observed,'capability_dialect_versions':dialects,'frozen_legacy_version_preserved':'5.9.3','arbitration':'T00-ARB-004','raw_refs':refs+list(binding.values()),'scope':'Independent actual native7.1 source/build environment identity and each emitted capability scope; frozen5.9.3 raw preserved separately'}

def public_plan_contract(host,row,operation,prepared,case_sensitive):
    key=operation['invocation_key']
    require(prepared['adapter']=='full_admission_adapter' and prepared['public_flow_kind']=='public-verify','full public working-tree plan required')
    require(type(case_sensitive) is bool,'full public measured case mode absent')
    API.projector(host['source_head']);import full_admission_adapter
    rebuilt=full_admission_adapter.prepare_full_admission(API.REPO/'docs/research/rust-ts-r0/cases/supplement-v2',row['id'],operation['sequence'],prepared['case_root'],prepared['requests'][0]['sdk_directory'],case_sensitive)
    for request in rebuilt['requests']:request['id']='supplement-'+key
    for field in ('index_snapshot_template','qualified_selected_template','qualified_broad_template','index_epoch_files','current_epoch_files','index_epoch_sequence','selected_discovery_config','broad_discovery_config','configured_rules','git_after_index','invocation_group_id'):
        require(rebuilt[field]==prepared[field],'full public frozen input differs: '+field)
    return rebuilt

def native_process_binding(host,prepared,frames,receipts,name,mode=None,sdk=True):
    filename=name+'-process.json';frame=frames[filename]
    matches=[r for r in receipts if r['path'].replace('\\','/').rsplit('/',1)[-1]==filename]
    require(len(matches)==1 and matches[0]['native_c1'] is True,'mandatory native profile was not run by actual C1: '+name)
    receipt=matches[0];require(receipt['frame_id']==digest(frame) and receipt['process_outcome_id']==digest(frame['outcome']),'mandatory native process receipt differs: '+name);q.process(frame['outcome'])
    expected=[host['fixture']['artifact_path']]+([mode] if mode else [])+[prepared['case_root']+'/'+name+'-request.json']+([host['fixture']['sdk_path']] if sdk else [])
    require(frame['argv']==expected and frame['cwd']==prepared['repository_root'],'mandatory native artifact/request/SDK argv differs: '+name)
    return json.loads(frame['outcome']['stdout'])

def public_base_binding(host,prepared,frames,receipts,evidence,read_document):
    require(isinstance(evidence.get('base_request'),dict) and isinstance(evidence.get('base_native'),dict),'actual immutable base request/observation absent')
    raw=native_process_binding(host,prepared,frames,receipts,'base-native');request=read_document('base-native-request.json')
    require(raw==evidence['base_native'] and request==evidence['base_request'],'actual immutable base process/request substituted')
    tree=frames['base-tree-process.json'];require(tree['argv']==['git','ls-tree','-r','--name-only','-z','HEAD'] and tree['cwd']==prepared['repository_root'],'immutable base tree Git invocation differs');q.process(tree['outcome'])
    listing=tree['outcome']['stdout'];require(not listing or listing.endswith('\0'),'immutable base HEAD tree capture truncated');paths=[p for p in listing.split('\0') if p];require(len(paths)==len(set(paths)),'duplicate immutable base tree path')
    files={}
    for path in paths:
        require(not Path(path).is_absolute() and '..' not in path.split('/') and '\\' not in path,'unsafe immutable base tree path')
        if any(p in ('.git','.semctx','node_modules') for p in path.split('/')):continue
        frame=frames['base-file-'+str(len(files))+'-process.json'];require(frame['argv']==['git','show','HEAD:'+path] and frame['cwd']==prepared['repository_root'],'immutable base Git file invocation differs');q.process(frame['outcome']);files[path]=frame['outcome']['stdout']
    wanted=copy.deepcopy(prepared['qualified_broad_template']);wanted.update(qualified=False,files=files,roots=[p for p in wanted['roots'] if p in files],id='public-verify:actual-head-base')
    API.verify_request_template(request,wanted);require(request['id']==wanted['id'],'immutable base request identity differs');q.raw_bound(raw,request,host)
    return {'base_files':files,'base_input_manifest_id':raw['input_manifest_id'],'base_request_id':digest(request)}

def public_base_required(projection,diff):
    removes=False
    for line in diff.splitlines():
        if not line.startswith('@@ '):continue
        parts=line.split();require(len(parts)>=3 and parts[1].startswith('-') and parts[2].startswith('+'),'malformed actual Git hunk')
        old=parts[1][1:].split(',');require(len(old) in (1,2) and all(p.isdigit() for p in old),'malformed actual Git old hunk');removes |= (int(old[1]) if len(old)==2 else 1)>0
    return projection['admission']['status']=='admitted' and removes

def public_verify(host,row,operation):
    key=operation['invocation_key'];invocation=next(x for x in host['plan']['invocations'] if x['key']==key);prepared=invocation['prepared']
    folder=host['root']/'evidence/public/invocations'/key/'input';out=host['root']/'evidence/public/outcomes'/key
    case_sensitive=read(folder/'ordinary-index-request.json')['case_sensitive'];public_plan_contract(host,row,operation,prepared,case_sensitive)
    collector=read(out/'consumer-result.json');bridge=read(out/'bridge-evidence.json');observed=collector['observed'];binding=bridge['binding']
    require(bridge['lifecycle_observed']==observed and binding['source_recipe_id']==digest(prepared) and binding['producer_artifact_id']=='sha256:'+host['fixture']['artifact_sha256'] and binding['sdk_input_id']==digest(host['sdk']) and binding['capture_stream_sha256']==prepared['source_capture_stream_sha256'],'full public collector binding differs')
    require(observed['consumer_kind']=='t00-public-working-tree-admission-v1' and observed['source_baseline']=='3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b' and observed['consumer_artifact_sha256']==host['fixture']['public_consumer_artifact_sha256'],'full public consumer identity differs')
    require(binding['consumer_artifact_sha256']==observed['consumer_artifact_sha256'] and observed['repository_root']==prepared['repository_root'],'full public actual repository/consumer differs')
    evidence=read(folder/'working-tree-actual-evidence.json');projection=read(folder/'working-tree-rust-projection.json');require(projection==observed['portable_projection'],'full public Rust projection substituted')
    require(evidence['sdk_descriptor']==host['sdk'] and evidence['probe_artifact_sha256']==host['fixture']['artifact_sha256'] and evidence['collector_provenance']['consumer_artifact_sha256']==host['fixture']['public_consumer_artifact_sha256'],'full public source/artifact context differs')
    receipts=binding['actual_process_receipts'];require(receipts and len({r['path'] for r in receipts})==len(receipts),'full public receipts absent/duplicate');frames={};refs=[pin(out/n) for n in ('consumer-result.json','bridge-evidence.json')]
    for receipt in receipts:
        p=folder/receipt['path'].rsplit('/',1)[-1];frame=read(p);q.process(frame['outcome']);require(receipt['frame_id']==digest(frame) and receipt['process_outcome_id']==digest(frame['outcome']),'full public process receipt substituted')
        require(frame['cwd']==observed['repository_root'] and type(receipt['native_c1']) is bool and receipt['native_c1']==(frame['argv'][0]==host['fixture']['artifact_path']),'full public process context/artifact differs');frames[p.name]=frame;refs.append(pin(p))
    for name,field,template in [('ordinary-index','ordinary_index','index_snapshot_template'),('qualified-selected','qualified_selected','qualified_selected_template'),('qualified-broad','qualified_broad','qualified_broad_template')]:
        request=read(folder/(name+'-request.json'));wanted=dict(prepared[template],id='public-verify:'+name);API.verify_request_template(request,wanted);require(request['id']==wanted['id'],'full public profile request ID differs')
        raw=native_process_binding(host,prepared,frames,receipts,name);require(raw==evidence[field] and request==evidence[field+'_request'],'full public facts/request differ');q.raw_bound(raw,request,host);refs.append(pin(folder/(name+'-request.json')))
    batch=native_process_binding(host,prepared,frames,receipts,'ordinary-batch','--batch');batch_request=read(folder/'ordinary-batch-request.json');require(batch_request==evidence['ordinary_index_request'],'full public batch request differs from ordinary index');q.batch_bound(batch,batch_request,host)
    require(batch==evidence['ordinary_batch']==evidence['index_store_written_batch']==evidence['index_store_readback_batch']==read(folder/'actual-transient-index.json'),'full public batch store/readback differs')
    require(evidence['ordinary_graph']==evidence['ordinary_index']['assembly']==read(folder/'actual-transient-graph.json'),'full public actual graph readback differs')
    if public_base_required(projection,evidence['actual_git_diff']) or 'base_request' in evidence or 'base_native' in evidence:
        public_base_binding(host,prepared,frames,receipts,evidence,lambda name:read(folder/name));refs.append(pin(folder/'base-native-request.json'))
    require(prepared['index_epoch_files']==prepared['current_epoch_files'] and evidence['workspace_unambiguous'] is True and evidence['check_changed'] is False,'full public frozen physical epochs differ')
    seal=evidence['freshness_seal'];require(seal['repositoryGraphHash']==digest(evidence['ordinary_graph']) and seal['indexedRepositoryGraphHash']==seal['repositoryGraphHash'] and seal['analysisInputHash']==digest(prepared['current_epoch_files']) and seal['indexedAnalysisInputHash']==digest(prepared['index_epoch_files']),'full public freshness graph/input identities differ')
    for stem,field in [('tracked-diff','actual_git_diff'),('tracked-paths','changed_paths'),('cached-paths','git_cached_paths')]:
        frame=frames[stem+'-process.json'];require(frame['argv'][0]=='git','full public Git executable differs');text=frame['outcome']['stdout']
        if field!='actual_git_diff':require(not text or text.endswith('\0'),'full public Git paths truncated');text=[p for p in text.split('\0') if p]
        require(text==evidence[field],'full public actual Git observation differs')
    def domain(name,value):return 'sha256:'+q.sha(('semctx:'+name+':v1\0').encode()+q.canonical(value).encode())
    for phase,status in [('index_git','index-status'),('current_git','current-status')]:
        actual=evidence['collector_provenance'][phase];stdout=frames[status+'-process.json']['outcome']['stdout'];require(stdout.endswith('\0'),'full public Git status truncated')
        records=[r for r in stdout.split('\0') if r and not r.startswith('# ') and not any(r.endswith(' '+p) for p in ('.semctx/semctx.db','.semctx/semctx.db-shm','.semctx/semctx.db-wal','.semctx/semctx.db-journal'))]
        require([r['record'] for r in actual['entries']]==sorted(records) and actual['working_hash']==domain('working-diff',{'entries':actual['entries']}),'full public freshness Git status/hash differs')
        require('# branch.oid '+actual['head'] in stdout.split('\0'),'full public actual Git HEAD differs')
    require(seal['headAtCapture']==evidence['collector_provenance']['current_git']['head'] and seal['indexedHeadCommit']==evidence['collector_provenance']['index_git']['head'] and seal['workingDiffHash']==evidence['collector_provenance']['current_git']['working_hash'] and seal['indexedWorkingDiffHash']==evidence['collector_provenance']['index_git']['working_hash'],'full public freshness seal not bound to actual Git epochs')
    ast=evidence['scope_ast_receipt'];unsigned={k:v for k,v in ast.items() if k!='ast_receipt_id'};require(ast['ast_receipt_id']==digest(unsigned) and ast['consumer_artifact_id']=='sha256:'+host['fixture']['public_consumer_artifact_sha256'] and ast['input_manifest_id']==evidence['qualified_broad']['input_manifest_id'],'full public AST source binding differs')
    def discovery(name,config):
        raws={}
        for suffix in ('discovery','eligibility','system'):
            stem=name+'-'+suffix;request=read(folder/(stem+'-request.json'));mode={'discovery':'--discover-repository','eligibility':'--observe-path-eligibility','system':'--observe-system'}[suffix];raw=native_process_binding(host,prepared,frames,receipts,stem,mode,False);require(raw==read(folder/(stem+'-observed.json')) and raw['request_descriptor_id']==digest(request) and raw['producer_artifact_id']=='sha256:'+host['fixture']['artifact_sha256'],'full public discovery frame/request differs');raws[suffix]=(raw,request);refs.extend([pin(folder/(stem+'-request.json')),pin(folder/(stem+'-observed.json'))])
        ordinary,query=raws['discovery'];eligibility,eq=raws['eligibility'];system,sq=raws['system'];paths=[c['relPath'] for c in ordinary['candidates']]
        require(query=={'repositoryRoot':observed['repository_root'],'config':config} and ordinary['executed'] is True and ordinary['unsupported']==[] and len(paths)==len(set(paths)),'full public discovery config/denominator differs')
        require(eq['repositoryRoot']==observed['repository_root'] and eq['include']==config['include'] and eq['exclude']==config['exclude'] and eq['queries']==paths and eligibility['queries']==paths and eligibility['eligibility_established'] is True and len(eligibility['eligible_results'])==len(paths),'full public eligibility config/denominator differs')
        before_path=folder/(name+'-system-physical-capture-before.json');after_path=folder/(name+'-system-physical-capture-after.json')
        physical_system_contract(sq,system,read(before_path),read(after_path),paths,observed['repository_root'],evidence['ordinary_index_request']['case_sensitive'],host['fixture']['artifact_sha256'])
        refs.extend([pin(before_path),pin(after_path)])
        candidates=[];files=[]
        for c,eligible in zip(ordinary['candidates'],eligibility['eligible_results'],strict=True):
            c=copy.deepcopy(c);path=c['relPath'];matches=[r for r in system['results'] if r['path']==observed['repository_root']+'/'+path];require(len(matches)==1 and type(eligible) is bool,'full public physical read/eligibility ambiguous');r=matches[0]
            require(r['found'] is True and r['unsupported']==[] and r['refusals']==[] and r['value']==prepared['current_epoch_files'][path],'full public actual physical bytes differ')
            if not eligible:c.update(selectionDecision='excluded',analysisOutcome='not_applicable',reason='IGNORED_GENERATED_OUTPUT')
            else:
                selected=[f for f in ordinary['files'] if f['relPath']==path]
                if selected:require(len(selected)==1 and selected[0]['content']==prepared['current_epoch_files'][path],'full public selected bytes differ');files.extend(selected)
            candidates.append(c)
        result={'executed':True,'unsupported':[],'candidates':candidates,'files':files,'ordinary_request_id':ordinary['request_descriptor_id'],'eligibility_request_id':eligibility['request_descriptor_id'],'physical_read_request_id':system['request_descriptor_id']}
        require(result==read(folder/(name+'-composed-discovery.json')),'full public composed discovery differs');return result
    selected=discovery('selected',prepared['selected_discovery_config']);discovery('broad',prepared['broad_discovery_config']);current=discovery('current-selected',prepared['selected_discovery_config'])
    require(selected==evidence['selected_discovery'] and [{'path':c['relPath'],'selectionDecision':c['selectionDecision'],'reason':c['reason']} for c in current['candidates']]==evidence['current_candidates'],'full public selection carrier differs')
    refs += [pin(folder/n) for n in ('working-tree-actual-evidence.json','working-tree-rust-projection.json','actual-transient-index.json','actual-transient-graph.json')]
    return projection,{'raw_refs':refs,'binding':binding,'scope':'Actual pinned Rust working-tree consumer DTO joined to ordinary/qualified selected/broad profiles, complete native process frames, stored batch/graph, frozen physical epochs and AST receipt; no PASS-label use'}
