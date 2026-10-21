"""Typed adapters over existing captures only; no native execution or PASS imports."""
import json,posixpath
API=None
def configure(api):
    global API;API=api
SURFACES={'workspace_system_cli','parallel_cli','retained_runtime_cli','missing_retained_test_cli','legacy_identity_cli','repository_eligibility_cli','captured_system_cli','source_confinement_cli'}
def handles(surface):return surface in SURFACES
def digest(v):return 'sha256:'+API.sha(API.canonical(v).encode())
def move(root,name):return posixpath.normpath(posixpath.join(root,name.replace('\\','/')))
def validate_reads(raw,request,host,field='capture_probes'):
    known=dict(host['sdk'].get('files',{}));known.update(request.get('files',{}))
    for probe in raw.get(field,[]):
        if probe.get('operation')!='read_file' or probe.get('found') is not True:continue
        candidates=[p for p in known if p==probe['path'] or (request.get('case_sensitive') is False and p.lower()==probe['path'].lower())]
        assert len(candidates)==1,'successful native read not uniquely bound to supplied bytes'
        assert probe['content_id']==digest_bytes(known[candidates[0]]),'successful read content differs'
def digest_bytes(text):return 'sha256:'+API.sha(text.encode('utf-8'))
def system_context(host,recipe,base,ordinal):
    name=recipe['system_contexts'][ordinal];folder=base/name
    raw,request,refs=API.read_process(folder/'process.json',host)
    assert request['profile']=='workspace' and request['queries'] and len(request['queries'])==9
    root=request['root'];vf=move(root,recipe['virtual_path']);physical=move(root,recipe['physical_path'])
    if name=='installed':physical=vf
    expected={move(root,k):v for k,v in recipe['system_files'].items()}
    if name=='installed':expected[vf]=recipe['installed_text']
    assert request['files']==expected,'workspace context file closure differs'
    outside=posixpath.dirname(root)+'/outside.json';outside_dir=posixpath.dirname(root)
    qs=[{'operation':op,'path':path} for op,path in [('file_exists',vf),('read_file',vf),('directory_exists',posixpath.dirname(vf)),('realpath',vf),('file_exists',outside),('read_file',outside),('directory_exists',outside),('realpath',outside),('directory_exists',outside_dir)]]
    assert request['queries']==qs and raw['request_descriptor_id']==digest(request) and raw['requestDescriptorId']==digest(request),'workspace request/context identity differs'
    assert raw['executed'] is True and raw['unsupported']==[] and len(raw['results'])==9
    issues=[]
    for i,(q,r) in enumerate(zip(qs,raw['results'],strict=True)):
        assert r['operation']==q['operation'] and r['path']==q['path'] and r['executed'] is True and r['unsupported']==[]
        assert r['refusals']==([] if i<4 else ['WORKSPACE_PATH_OUTSIDE_ROOT'])
        if i>=4:
            assert r['value']==(None if q['operation']=='read_file' else q['path'] if q['operation']=='realpath' else False)
            issues.append({'path':q['path'],'kind':'refusal','detail':'WORKSPACE_PATH_OUTSIDE_ROOT'})
    assert raw['workspaceIssues']==issues,'workspace issue denominator differs'
    validate_reads(raw,request,host,'probes');rs=raw['results'];text=request['files'][physical];rd=rs[1]
    assert rd['found'] is True and rd['value']==text and rd['physicalPath']==physical and rd['contentId']==digest_bytes(text)
    assert rd['contentIdEncoding']=='ts_goport_go_string_utf8' and rd['utf16Units']==list(text.encode('utf-16-le')[i]+256*text.encode('utf-16-le')[i+1] for i in range(0,len(text.encode('utf-16-le')),2))
    assert rs[5]['found'] is False and all(rs[5][k] is None for k in ('physicalPath','contentId','utf16Units'))
    assert len([p for p in raw['probes'] if p['operation']=='read_file' and p['path']==outside and p['found'] is False and p['content_id'] is None])==1
    assert (folder/'outside.json').read_text()=='T00 outside boundary control\n','outside refusal lacks actual control bytes'
    assert rs[3]['value']==physical,'workspace realpath does not identify the exact physical source'
    return {'fileExists_virtual':rs[0]['value'],'readFile_virtual':rd['value'],'directoryExists_virtual_parent':rs[2]['value'],'realpath_virtual':'NATIVE_CANONICAL_WORKSPACE_SOURCE','resolver_inputs_physical':text,
      'boundary_control':{'fileExists_outside':rs[4]['value'],'readFile_outside':{'state':'undefined'},'directoryExists_outside':rs[6]['value'],'realpath_outside':'NATIVE_OUTSIDE_INPUT','resolver_inputs_outside':{'state':'undefined'}},
      'raw_path_bindings':{'realpath_virtual':rs[3]['value'],'required_physical_source':physical,'realpath_outside':rs[7]['value'],'required_outside_path':outside}},request,refs+[API.pin(folder/'outside.json')]
def runtime_one(host,folder,template,discovered):
    raw,descriptor,refs=API.read_process(folder/'process-outcome.json',host,(0,1))
    assert descriptor['discovered_sources']==discovered,'runtime discovered inputs differ'
    API.verify_request_template(descriptor['analysis'],template)
    invocation=API.read(str(folder/'invocation.json'))
    assert invocation['sdk_sha256']==host['fixture']['sdk_sha256'] and invocation['argv'][1]=='--analyze-retained-runtime'
    outcome=API.read(str(folder/'process-outcome.json'))
    if outcome['exit_code']==1:
        assert raw is None
        error=json.loads(outcome['stderr']);assert set(error)=={'error'} and isinstance(error['error'],str) and error['error']
        return {'runtime_state':'rejected','rejects':True,'error':error['error'],'successful_runtime_result':False,'global_qualified_admission_inferred':False},descriptor,refs
    assert outcome['stderr']=='' and raw['executed'] is True
    native=raw['native_analysis'];assert native['complete'] is True and native['producer_artifact_id']=='sha256:'+host['fixture']['artifact_sha256']
    assert native['request_id']==digest(descriptor['analysis']),'runtime analysis request hash differs'
    validate_reads(native,descriptor['analysis'],host)
    return raw,descriptor,refs
def runtime(host,recipe,base):
    refs=[]
    for phase in ('healthy-before','healthy-after'):
        control,descriptor,pr=runtime_one(host,base/phase,recipe['capture_request'],recipe['consistent_discovered_sources']);refs+=pr
        assert all(API.evaluate(control,c)['state']=='RELEVANT_PASS' for c in recipe['leaf_checks']),'runtime healthy control differs'
    raw,descriptor,pr=runtime_one(host,base/'subject',recipe['capture_request'],recipe['discovered_sources']);refs+=pr
    if raw.get('runtime_state')=='rejected':return raw,descriptor,refs
    checked=[API.evaluate(raw,c) for c in recipe['leaf_checks']]
    observed=dict(raw,runtime_state='analyzed',snapshot_mismatch_error=False,retained_leaf_analysis_projection_preserved=all(c['state']=='RELEVANT_PASS' for c in checked),transient_symbol_forbidden=all(s['name']!='transient' for s in raw['native_analysis']['raw_extraction']['symbols']),global_qualified_admission_inferred=False)
    return observed,descriptor,refs
def missing_test(host,recipe,base,definition):
    private=definition.get('expected_origin','').startswith('/assertions/private_') or definition.get('target')==['observation_scope']
    if private:
        folder=base/'private/observation-000';raw,request,refs=API.read_process(folder/'process-outcome.json',host)
        assert request==recipe['private_scan_recipe']['primitive_requests'][0],'private scan descriptor differs'
        assert raw['request_descriptor_id']==digest(request)
        return raw,request,refs
    folder=base/'public';raw,descriptor,refs=API.read_process(folder/'process-outcome.json',host,request_file=folder/'retained-discovery-request.json')
    capture=dict(recipe['public_guard_recipe']['capture_request']);capture['files']={k:v for k,v in capture['files'].items() if k not in recipe['public_guard_recipe']['retained_omissions']}
    API.verify_request_template(descriptor['analysis'],capture)
    assert descriptor['discovered_sources']==recipe['public_guard_recipe']['discovered_sources']
    assert raw['request_descriptor_id']==digest(descriptor) and raw['executed'] is False and raw['unsupported']==['SOURCE_SNAPSHOT_MISMATCH: src/target.test.ts']
    return raw,descriptor,refs
def parallel(host,recipe,base,ordinal):
    direct,request,drefs=API.parsed_outcome(base/'direct/process-outcome.json',host)
    API.verify_request_template(request,recipe['direct_recipe']['requests'][0])
    raw,descriptor,refs=API.read_process(base/f'controller-{ordinal:01d}/process-outcome.json',host)
    count=recipe['parallel_worker_counts'][ordinal];assert descriptor=={'repoRoot':request['cwd'],'rootAbsPaths':request['roots'],'workers':count}
    assert raw['request_descriptor_id']==digest(descriptor) and raw['sdk_input_id']==digest(host['sdk']) and raw['executed'] is True and raw['unsupported']==[]
    assert raw['parallelism']==({'requested':1,'used':1,'mode':'single'} if count==1 else {'requested':2,'used':2,'mode':'parallel'})
    if count==1:
        one={'schemaVersion':1,'jobId':'parallel-single','repoRoot':request['cwd'],'rootAbsPaths':request['roots'],'emitAbsPaths':request['roots']}
        assert raw['jobs']==[] and raw['singleRequest']==one and raw['singleObservation']['ok'] is True and raw['singleObservation']['extraction']==raw['extraction']
        validate_reads({'capture_probes':raw['singleObservation'].get('compiler_probes',[])},request,host)
    else:
        assert len(raw['jobs'])==2 and raw['helperArtifactId']=='sha256:'+host['fixture']['helper_sha256']
        pre=raw['preflight'];assert pre['noLib'] is True and pre['types']==[] and pre['safe'] is True and pre['unsafeReason'] is None
        assert pre['moduleComponents']['executed'] is True and pre['moduleComponents']['unsupported']==[]
        validate_reads({'capture_probes':pre['compiler_probes']},request,host)
        pids=set();emitted=[];merged={k:[] for k in ('modules','symbols','imports','calls')}
        declarations=[r for r in request['roots'] if r.endswith('.d.ts')]
        for i,job in enumerate(raw['jobs']):
            emit=job['request']['emitAbsPaths'];assert emit
            expected={'schemaVersion':1,'jobId':f'typescript-chunk-{i+1}-of-2','repoRoot':request['cwd'],'rootAbsPaths':emit+declarations,'emitAbsPaths':emit}
            assert job['request']==expected and job['responseAccepted'] is True and job['transportError'] is None
            response=API.capture_streams(job['outcome']);assert response['ok'] is True and response['jobId']==expected['jobId'] and response['producer_artifact_id']=='sha256:'+host['fixture']['artifact_sha256']
            assert response['producer_process_id']!=raw['producer_process_id'] and response['producer_process_id'] not in pids;pids.add(response['producer_process_id'])
            assert response['request_descriptor_id']==digest(expected) and response['sdk_input_id']==digest(host['sdk'])
            validate_reads({'capture_probes':response.get('compiler_probes',[])},request,host)
            emitted+=emit
            for k in merged:merged[k]+=response['extraction'][k]
        assert sorted(emitted)==sorted(r for r in request['roots'] if r not in declarations),'parallel roots not exact partition'
        for k in merged:assert sorted(merged[k],key=API.canonical)==sorted(raw['extraction'][k],key=API.canonical),'parallel merge differs from actual child fields'
    assert raw['extraction']==direct['raw_extraction'],'parallel extraction differs from direct control'
    return dict(raw,extraction_equals_single_thread_baseline=True),descriptor,drefs+refs
def legacy_one(host,recipe,base,ordinal):
    raw,request,refs=API.read_process(base/f'observation-{ordinal}-process.json',host,request_file=base/f'observation-{ordinal}-request.json')
    assert request['operation']=='baseline_analyzer_identity' and raw['identity_scope']=='baseline_3e94997f_implementation_and_compiler_bytes' and raw['compiler_executed'] is False
    assert request['repository_root'].endswith(f'/implementation-{ordinal}') and request['compiler_package_root'].endswith(f'/compiler-{ordinal}')
    binding=API.read(str(base/'input-binding.json'));assert binding['sha256']==host['fixture']['legacy_identity_inputs_sha256'] and binding['baseline_revision']==recipe['baseline_revision']
    assert raw['executed'] is True and raw['global_admission_inferred'] is False
    complete=host.get('legacy_inputs');assert complete is not None,'full pinned legacy identity inputs unavailable'
    assert raw['request_descriptor_id']==digest(request)
    implementation={k:v['text'].encode() for k,v in complete['implementation_files'].items()};compiler={k:v['text'].encode() for k,v in complete['compiler_files'].items()}
    implementation.update({k:v.encode() for k,v in recipe.get('identity_additional_files',{}).items()})
    if ordinal==1 and recipe['legacy_identity_mode'] in ('source-byte','sdk-byte'):
        domain=implementation if recipe['legacy_identity_mode']=='source-byte' else compiler
        mutation=complete['source_mutation' if recipe['legacy_identity_mode']=='source-byte' else 'sdk_mutation'];data=bytearray(domain[mutation['path']]);assert data[mutation['offset']]==mutation['before'];data[mutation['offset']]=mutation['after'];domain[mutation['path']]=bytes(data)
    assert raw['reads'],'legacy identity supplied no observed byte reads'
    for observed in raw['reads']:
        source=(implementation if observed['domain']=='implementation' else compiler if observed['domain']=='compiler' else {})
        assert observed['path'] in source,'legacy read not in exact bound inputs'
        data=source[observed['path']];assert observed['bytes']==len(data) and observed['digest']=='sha256:'+API.sha(data),'legacy observed read bytes differ'
    return raw,request,refs+[API.pin(base/'input-binding.json'),host['legacy_inputs_ref']]
def legacy(host,recipe,base,ordinal):
    if recipe['legacy_identity_mode']=='crlf-refusal':return legacy_one(host,recipe,base,ordinal)
    left,lr,lrefs=legacy_one(host,recipe,base,0);right,rr,rrefs=legacy_one(host,recipe,base,1)
    expected=host['legacy_inputs']['expected'];mode=recipe['legacy_identity_mode']
    assert left['identity_success'] is True and right['identity_success'] is True
    assert left['identity']==recipe['baseline_expected_identity']==expected['baseline']
    target=expected[{'relocation':'baseline','source-byte':'source_changed','sdk-byte':'sdk_changed'}[mode]]
    relation=(right['identity']==target and ((left['identity']==right['identity']) if mode=='relocation' else left['identity']!=right['identity']))
    return {'relation_satisfied':relation,'actual_identities':[left['identity'],right['identity']],'identity_scope':'baseline_3e94997f_implementation_and_compiler_bytes'},None,lrefs+rrefs
def eligibility(host,recipe,base,ordinal):
    folder=base/f'context-{ordinal}';raw,request,refs=API.read_process(folder/'process.json',host)
    assert request['include']==recipe['include'] and request['exclude']==recipe['exclude'] and request['queries']==recipe['eligibility_queries']
    assert request['processHelper']==host['fixture']['helper_path'] and raw['producer_artifact_id']=='sha256:'+host['fixture']['artifact_sha256']
    assert raw['executed'] is True and raw['unsupported']==[] and raw['global_admission_inferred'] is False
    if ordinal==0:assert raw['git_outcome']['kind']=='success' and raw['git_outcome']['exit_code']==0 and raw['eligibility_established'] is True
    else:assert raw['eligibility_established'] is False and raw['error']=={'code':'IO_ERROR','message':'qualified discovery could not establish Git source eligibility'}
    return raw,request,refs
def load_original(host,recipe,index,definition):
    base=host['root']/'original-evidence'/f'unit-{index:03d}';ordinal=definition.get('observation',0);surface=recipe['surface']
    if surface=='workspace_system_cli':return system_context(host,recipe,base,ordinal)
    if surface=='parallel_cli':return parallel(host,recipe,base,ordinal)
    if surface=='retained_runtime_cli':return runtime(host,recipe,base)
    if surface=='missing_retained_test_cli':return missing_test(host,recipe,base,definition)
    if surface=='legacy_identity_cli':return legacy(host,recipe,base,ordinal)
    if surface=='repository_eligibility_cli':return eligibility(host,recipe,base,ordinal)
    if surface=='source_confinement_cli':
        raw,request,refs=API.read_process(base/'process-outcome.json',host,(1,));API.verify_request_template(request,recipe['requests'][0]);assert raw is None
        outcome=API.read(str(base/'process-outcome.json'));error=json.loads(outcome['stderr']);assert set(error)=={'error'} and isinstance(error['error'],str) and error['error'].startswith(('IMPORT_OUTSIDE_REPOSITORY:','REFERENCE_OUTSIDE_REPOSITORY:','SOURCE_LINK_OUTSIDE_REPOSITORY:'))
        return {'error':error['error'],'analysis_success':False,'outside_content_imported':False,'proof_scope':'actual rejected Result and no successful fact payload; not an OS read attestation'},request,refs
    if surface=='captured_system_cli':
        raw,request,refs=API.read_process(base/'process-outcome.json',host,request_file=base/'system-request.json')
        assert request['profile']==recipe['system_profile'] and request['files']=={move(request['root'],k):v for k,v in recipe['system_files'].items()}
        assert raw['request_descriptor_id']==digest(request) and raw['executed'] is True and raw['unsupported']==[];validate_reads(raw,request,host,'probes')
        return raw,request,refs
    raise ValueError('nonqualified surface unsupported '+surface)
def reference_support(supports,sid,source_ref):
    row=next(s for s in supports['support_units'] if s['support_id']==sid);p=row['payload']
    if sid.startswith('PRIMITIVE::'):
        v=p['projection'];actual='sha256:'+API.sha(bytes.fromhex(v['bytes_hex']));expected=v['expected_sha256']
    elif sid.startswith('IDENTITY::base-'):
        assert API.canonical(p['value'])==p['canonical_json'],'reference canonical JSON differs'
        actual=digest(p['value']);expected=p['expected_digest']
    elif sid.startswith('IDENTITY::I-') and 'mutated_record'in p:
        base=next(s['payload'] for s in supports['support_units'] if s['pointer']=='/records/'+p['record'])
        actual=digest(p['mutated_record']);expected=p['expected_digest'];assert actual!=base['expected_digest'],'reference mutation did not separate identity'
    else:raise ValueError('specialized actual identity relation carrier not handled')
    return {'state':'RELEVANT_PASS' if actual==expected else 'NONPASS','actual':actual,'expected':expected,'source_ref':source_ref,
      'proof_scope':'FROZEN_REFERENCE_TRANSFORMATION_ONLY; not actual compiler consumption, producer identity or receiver rejection proof','qualified':False}
def actual_identity_support(host,recipe,base):
    sid=recipe['support_id']
    if sid in ('IDENTITY::I-relocation','IDENTITY::I-request-separation'):
        import remaining_carriers as v2;v2.configure(API);return v2.identity_support(host,recipe,base)
    if sid=='IDENTITY::complete-baseline-specimen':
        prerequisite=next(r for r in host['recipes']['recipes'] if r['unit_id']=='P25-byte-identity-relocation::identity-relation-01')
        assert prerequisite['baseline_expected_identity']=={k:recipe['frozen_identity_projection'][k] for k in ('schemaVersion','files','compiler','digest')}
        raw,request,refs=legacy(host,prerequisite,base/'baseline',0)
        return {'state':'RELEVANT_PASS' if raw['relation_satisfied'] else 'NONPASS','actual':raw,'raw_refs':refs,'proof_scope':'actual complete3e implementation/compiler bytes and relocated identity; no SDK semantic consumer credit'}
    if sid in ('IDENTITY::I-capture-mismatch','IDENTITY::I-sdk-supplied-vs-consumed'):
        positive=next(r for r in host['recipes']['recipes'] if r['unit_id']=='P01-retained-source::plane-a-runtime-consistent')
        negative=next(r for r in host['recipes']['recipes'] if r['unit_id']=='N01-snapshot-metadata-mismatch::plane-a-runtime-mismatch')
        yes,_,yr=runtime(host,positive,base/'retained');no,_,nr=runtime(host,negative,base/'mismatch')
        assert yes['runtime_state']=='analyzed' and yes['retained_leaf_analysis_projection_preserved'] is True and no['runtime_state']=='rejected' and no['error']=='SOURCE_SNAPSHOT_MISMATCH: entry.ts'
        refs=yr+nr;data={'retained_runtime_state':yes['runtime_state'],'mismatch_error':no['error'],'all_supplied_sdk_consumed_claimed':False}
        if sid=='IDENTITY::I-sdk-supplied-vs-consumed':
            native,req,pr=API.parsed_outcome(base/'native-reads/process-outcome.json',host);refs+=pr
            template=next(r for r in host['recipes']['recipes'] if r['unit_id']=='P01-retained-source::base')['requests'][0];API.verify_request_template(req,template)
            validate_reads(native,req,host);paths=[p['path'] for p in native['capture_probes'] if p['operation']=='read_file' and p.get('found') is True]
            assert '/sdk/lib/lib.es2022.full.d.ts'in paths,'default library actual read not observed'
            data['actual_sdk_read_paths']=[p for p in paths if p.startswith('/sdk/lib/')]
        return {'state':'RELEVANT_PASS','actual':data,'raw_refs':refs,'proof_scope':'actual retained runtime/mismatch and named successful SDK byte reads only; no all-supplied or atomic capture claim'}
    raise ValueError('actual identity receiver/batch typed adapter pending '+sid)
def snapshot_boundary(host,recipe,base):
    absent,ar,arefs=API.read_process(base/'absent-capture/process-outcome.json',host,(1,))
    valid,vr,vrefs=API.parsed_outcome(base/'valid-capture/process-outcome.json',host)
    wanted=dict(recipe['template'],qualified=True,retained=True);API.verify_request_template(vr,wanted)
    API.verify_request_template(ar,dict(wanted,retained=False))
    assert vr['cwd']==ar['cwd'] and valid['complete'] is True and valid['request_id']==digest(vr)
    validate_reads(valid,vr,host);assert absent is None
    outcome=API.read(str(base/'absent-capture/process-outcome.json'));error=json.loads(outcome['stderr'])
    assert set(error)=={'error'} and error['error'].split(':',1)[0]==recipe['expected_error_code']
    expected=recipe['expected_nodes'];actual=valid['assembly']['nodes'];assert len(expected)==len(actual)
    assert sorted([{k:v for k,v in x.items() if k in ('kind','name','filePath')} for x in actual],key=API.canonical)==sorted(expected,key=API.canonical),'valid snapshot node projection differs'
    origin=recipe['expected_error_ref'];source=API.REPO/'docs/research/rust-ts-r0/cases/supplement-v2'/origin['path'];assert API.pin(source)['sha256']==origin['sha256']
    expected=json.loads(source.read_text(encoding='utf-8'))
    for k in origin['pointer'].strip('/').split('/'):expected=expected[int(k)] if isinstance(expected,list) else expected[k]
    return {'state':'RELEVANT_PASS' if error['error']==expected else 'NONPASS','required_code_guard_observed':True,'valid_capture_nodes_match':True,
      'actual_error':error['error'],'expected_full_error':expected,'expected_error_code':recipe['expected_error_code'],'expected_full_error_ref':origin,
      'source_note':'Exact full frozen baseline error is required; historical code-only stderr remains a real NONPASS. No message waiver.',
      'raw_refs':arefs+vrefs,'definition':{'expected_origin':recipe['expected_error_ref']}}
