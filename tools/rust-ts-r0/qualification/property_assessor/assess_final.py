"""Scratch 395+51 assessor. No native queries; report PASS flags never qualify fields.

python -B assess_final.py --manifest HOSTS.json --output ASSESSMENT.json
--require-both requires exact macos+linux manifests and still issues no R0/credit.
"""
import json,sys,argparse,subprocess,shutil,posixpath,types
from pathlib import Path
from functools import lru_cache
from collections import Counter
from raw_compare import evaluate,select,transform,canonical,sha
OUT=Path(__file__).resolve().parent
ROOT=OUT;REPO=None;CACHE=OUT/'.cache';SCOPE_MAP=OUT/'scope-map.json.gz'
import final_join
@lru_cache(None)
def read(p):return json.loads(Path(p).read_text(encoding='utf-8'))
@lru_cache(None)
def pin(p):
    p=Path(p);b=p.read_bytes();return {'path':str(p.resolve()),'sha256':sha(b),'bytes':len(b)}
def key(r):return (r['coordinate']['obligation_index'],r['coordinate']['property_index'])
def verdict(results):
    if any(r['state']=='NONPASS' for r in results):return 'NONPASS'
    return 'RELEVANT_PASS' if results and all(r['state']=='RELEVANT_PASS' for r in results) else 'GAP'
def failure(error,**fields):return {'state':'GAP','gap':str(error),**fields}
def load_pin(p):
    assert pin(p['path'])['sha256']==p['sha256'],'input pin differs '+p['path']
    return read(p['path'])
@lru_cache(None)
def projector(head):
    dest=CACHE/('frozen-projectors-'+head[:8]);dest.mkdir(parents=True,exist_ok=True)
    for name in ('public_runtime.py','public_adapter.py','directory_closure.py','public_graph_projection.cjs','ownership_adapter.py','lifecycle_adapter_29_frozen.py','full_admission_adapter.py'):
        source='tools/rust-ts-r0/qualification/supplement/'+name
        raw=frozen_git_source(head,source).encode('utf-8')
        target=dest/name
        if not target.exists():target.write_bytes(raw)
        assert target.read_bytes()==raw
    sys.path.insert(0,str(dest));import public_runtime
    return public_runtime,dest
def graph_project(raw,head):
    _,dest=projector(head);script='const fs=require("node:fs");const p=require(process.argv[1]);process.stdout.write(JSON.stringify(p.canonicalGraph(JSON.parse(fs.readFileSync(0,"utf8")))));'
    r=subprocess.run([shutil.which('node') or 'node','-e',script,str(dest/'public_graph_projection.cjs')],input=json.dumps(raw),text=True,encoding='utf-8',capture_output=True,timeout=20,check=True)
    assert not r.stderr
    return json.loads(r.stdout)
def capture_streams(outcome,allowed_codes=(0,)):
    for stream in ('stdout','stderr'):
        raw=outcome[stream].encode('utf-8')
        assert type(outcome[stream+'_bytes']) is int and outcome[stream+'_bytes']==len(raw) and outcome[stream+'_hash'].removeprefix('sha256:')==sha(raw),'capture bytes differ'
    assert type(outcome['exit_code']) is int and outcome['exit_code'] in allowed_codes,'unexpected process exit'
    assert outcome['kind']==('success' if outcome['exit_code']==0 else 'nonzero'),'process kind differs from exit'
    return json.loads(outcome['stdout']) if outcome['stdout'] else None
def artifact_binding(record,host):
    if 'before'in record:
        assert record['before']==record['after'],'artifact/request changed during process'
        b=record['before']
        producer=b.get('artifact_sha256',b.get('artifact',b.get('producer')));helper=b.get('helper_sha256',b.get('helper'))
    else:producer=record.get('producer_sha256');helper=record.get('helper_sha256')
    assert producer==host['fixture']['artifact_sha256'] and helper==host['fixture']['helper_sha256'],'foreign producer/helper capture'
def read_process(path,host,allowed_codes=(0,),request_file=None):
    path=Path(path);record=read(str(path));outcome=record.get('outcome',record);raw=capture_streams(outcome,allowed_codes)
    folder=path.parent;refs=[pin(path)]
    if 'before'in record:artifact_binding(record,host)
    elif (folder/'artifact-observation.json').is_file():artifact_binding(read(str(folder/'artifact-observation.json')),host);refs.append(pin(folder/'artifact-observation.json'))
    elif (folder/'invocation.json').is_file():
        invocation=read(str(folder/'invocation.json'));artifact_binding(invocation,host);refs.append(pin(folder/'invocation.json'))
        assert invocation['outcome_id']=='sha256:'+sha(canonical(outcome).encode()),'invocation outcome identity differs'
    elif (folder/'process-invocation.json').is_file():
        invocation=read(str(folder/'process-invocation.json'));artifact_binding(invocation,host);refs.append(pin(folder/'process-invocation.json'))
    else:raise ValueError('complete process artifact receipt absent')
    request_file=Path(request_file) if request_file else next((folder/n for n in ('request.json','descriptor.json','system-request.json','retained-discovery-request.json','analysis-request.json') if (folder/n).is_file()),None)
    request=read(str(request_file)) if request_file else None
    if request_file:
        refs.append(pin(request_file))
        if 'before'in record and 'request'in record['before']:assert record['before']['request']==pin(request_file)['sha256'],'captured request bytes differ'
        if (folder/'process-invocation.json').is_file():
            invocation=read(str(folder/'process-invocation.json'))
            if 'request_sha256'in invocation.get('before',{}):assert invocation['before']['request_sha256']==pin(request_file)['sha256'],'invoked exact request bytes differ'
        if (folder/'invocation.json').is_file():
            invocation=read(str(folder/'invocation.json'))
            if 'request_sha256'in invocation:assert invocation['request_sha256']==pin(request_file)['sha256'],'invoked request bytes differ'
    if isinstance(raw,dict) and 'producer_artifact_id'in raw:assert raw['producer_artifact_id']=='sha256:'+host['fixture']['artifact_sha256'],'raw producer differs'
    return raw,request,refs
def parsed_outcome(path,host):
    o=read(str(path))
    for stream in ('stdout','stderr'):
        b=o[stream].encode();assert o[stream+'_bytes']==len(b) and o[stream+'_hash'].removeprefix('sha256:')==sha(b),'capture bytes differ'
    assert o['kind']=='success' and o['exit_code']==0,'process is not successful; refused-result carrier requires independent adapter'
    raw=json.loads(o['stdout']);folder=path.parent
    art=read(str(folder/'artifact-observation.json'))
    assert art['before']==art['after'],'artifact changed during process'
    for tag in ('artifact','helper'):
        assert art['before'].get(tag+'_sha256',art['before'].get(tag,art['before'].get('producer') if tag=='artifact' else None))==host['fixture'][tag+'_sha256'],'foreign frozen artifact'
    refs=[pin(path),pin(folder/'artifact-observation.json')]
    if isinstance(raw,dict) and 'producer_artifact_id' in raw:
        assert raw['producer_artifact_id']=='sha256:'+host['fixture']['artifact_sha256'],'native producer id differs'
    request_file=next((folder/n for n in ('request.json','descriptor.json','system-request.json','retained-discovery-request.json','analysis-request.json') if (folder/n).is_file()),None)
    if request_file:
        request=read(str(request_file));refs.append(pin(request_file))
        rid='sha256:'+sha(canonical(request).encode())
        if 'request_id'in raw:assert raw['request_id']==rid,'request hash differs'
        if 'request_descriptor_id'in raw:assert raw['request_descriptor_id']==rid,'descriptor hash differs'
        known=dict(host['sdk'].get('files',{}));known.update(request.get('files',{}))
        for p in raw.get('capture_probes',[]):
            if p.get('operation')=='read_file' and p.get('found') is True:
                assert p['path'] in known and p['content_id']=='sha256:'+sha(known[p['path']].encode()),'successful read has no exact supplied byte binding'
        binding_file=folder/'verified-input-binding.json'
        if binding_file.is_file():
            binding=read(str(binding_file));refs.append(pin(binding_file))
            assert binding['request_id']==raw['request_id'] and binding['input_manifest_id']==raw['input_manifest_id'] and binding['artifact_sha256']==host['fixture']['artifact_sha256'],'input receipt differs from raw actual'
    else:request=None
    return raw,request,refs
def raw_original(host,unit,definition):
    i=host['unit_indices'][unit];base=host['root']/'original-evidence'/f'unit-{i:03d}'
    obs=definition.get('observation',0)
    recipe=host['recipes']['recipes'][i]
    if recipe['surface'] in ('qualified_flow_cli','ambiguous_exports_cli'):
        import qualified_carriers as q;q.configure(adapter_api());observed,evidence=q.load_original_qualified(host,recipe,obs)
        return observed,None,evidence['raw_refs']
    import nonqualified_carriers as nq;nq.configure(adapter_api())
    if nq.handles(recipe['surface']):return nq.load_original(host,recipe,i,definition)
    folders=[base/f'observation-{obs:03d}',base]
    for folder in folders:
        p=folder/'process-outcome.json'
        if p.is_file():
            raw,request,refs=parsed_outcome(p,host)
            templates=host['recipes']['recipes'][i].get('requests',[])
            if request is not None and obs<len(templates) and 'files'in request:
                verify_request_template(request,templates[obs],recipe=recipe)
            return raw,request,refs
    raise ValueError('exact original process carrier absent '+unit+' observation '+str(obs))
def verify_request_template(request,template,recipe=None):
    if template.get('raw_files') or template.get('utf16_files'):raise ValueError('EXACT_RAW_OR_UTF16_REQUEST_TEMPLATE_ADAPTER_PENDING')
    cwd=request['cwd'];expected={posixpath.normpath(posixpath.join(cwd,k.replace('\\','/'))):v for k,v in template['files'].items()}
    if recipe and recipe.get('setup_mapping')=='Exact frozen sibling retained bytes in a separate input envelope; direct sibling paths only, exclusive creation, included in captured request and independent input binding.':
        cases=read(str(REPO/'docs/research/rust-ts-r0/cases/sources/semantic-cases.json'))['cases'];frozen=next(c for c in cases if c['id']==recipe['case_id'])
        for setup in frozen['input']['setup']:
            for name,text in setup['outside_root_retained_files'].items():expected[posixpath.normpath(posixpath.join(cwd,name))]=text
    assert request['files']==expected,'actual request source byte closure differs from frozen recipe'
    assert request['roots']==[posixpath.normpath(posixpath.join(cwd,k.replace('\\','/'))) for k in template['roots']],'actual roots differ from frozen recipe'
    for field in ('options','retained','qualified','sdk_directory','roles','selection','disabled'):
        if field in template:
            assert field in request,'actual request missing explicit frozen field '+field
            assert request[field]==template[field],'actual request field differs from frozen recipe '+field
def adapter_api():
    return types.SimpleNamespace(read=read,pin=pin,load_pin=load_pin,raw_original=raw_original,read_process=read_process,capture_streams=capture_streams,artifact_binding=artifact_binding,parsed_outcome=parsed_outcome,canonical=canonical,sha=sha,select=select,verify_request_template=verify_request_template,projector=projector,frozen_git_source=frozen_git_source,frozen_source_pins=scope_protocol()['verifier_git_sources'],evaluate=evaluate,REPO=REPO,ROOT=ROOT)
def original_check(host,unit,definition):
    try:
        if 'left_observation' in definition:
            a,_,ar=raw_original(host,unit,{'observation':definition['left_observation']});b,_,br=raw_original(host,unit,{'observation':definition['right_observation']})
            av=transform(select(a,definition['target']),definition.get('transform','none'));bv=transform(select(b,definition['target']),definition.get('transform','none'))
            if definition.get('first_only'):av=av[0];bv=bv[0]
            actual=([x==y for x,y in zip(av,bv,strict=True)] if isinstance(definition['expected_equal'],list) else av==bv)
            return {'state':'RELEVANT_PASS' if actual==definition['expected_equal'] else 'NONPASS','actual_relation':actual,'expected_relation':definition['expected_equal'],'raw_refs':ar+br}
        raw,request,refs=raw_original(host,unit,definition)
        result=evaluate(raw,definition);result['raw_refs']=refs
        result['unit_id']=unit;result['definition']=definition
        return result
    except (AssertionError,ValueError,TypeError,KeyError,IndexError,OSError) as e:return failure(e,unit_id=unit,definition=definition)
def source_check(host,s):
    try:
        next(r for r in host['source']['rows'] if r['id']==s['id'])
        origin=s['expected_origin'];registry=next(r for r in host['registry']['rows'] if r['id']==s['id'])
        matches=[]
        for ri,recipe in enumerate(registry['recipes']):
            if recipe.get('surface')=='source_scope_cli' and recipe.get('expected_scope_ref')==origin:
                import qualified_carriers as q;q.configure(adapter_api());base=host['root']/'evidence'/s['id'].replace('::','__')/f'observation-{ri:03d}'
                actual,evidence=q.load_source_scope(host,recipe,base)
                expected=final_join.supplemental.pointer(read(str(REPO/'docs/research/rust-ts-r0/cases/supplement-v2'/origin['path'])),origin['pointer'])
                matches.append({'state':'RELEVANT_PASS' if actual==expected else 'NONPASS','actual':actual,'expected':expected,'raw_refs':evidence['raw_refs'],'typed_binding':evidence,'definition':{'expected_origin':origin}})
            if recipe.get('surface')=='snapshot_boundary_cli' and recipe.get('expected_error_ref')==origin:
                import nonqualified_carriers as nq;nq.configure(adapter_api());base=host['root']/'evidence'/s['id'].replace('::','__')/f'observation-{ri:03d}'
                matches.append(nq.snapshot_boundary(host,recipe,base))
            for c in recipe.get('checks',[]):
                o=c.get('expected_origin')
                if (isinstance(o,dict) and o.get('sha256')==origin['sha256'] and (o.get('pointer')==origin['pointer'] or o.get('pointer','').startswith(origin['pointer']+'/'))) or not isinstance(o,dict):
                    folder=host['root']/'evidence'/s['id'].replace('::','__')/f'observation-{ri:03d}'
                    raw,request,refs=parsed_outcome(folder/'process-outcome.json',host)
                    templates=recipe.get('requests',[])
                    if request is not None and templates and 'files'in request:verify_request_template(request,templates[0])
                    result=evaluate(raw,c);result.update(raw_refs=refs,definition=c,selection=s)
                    matches.append(result)
        assert any(isinstance(m['definition'].get('expected_origin'),dict) for m in matches),'exact supplemental expected field is absent'
        return {'state':verdict(matches),'comparisons':matches,'selection':s,'scope':'exact selected field or its complete descendant comparisons plus execution/completeness guards'}
    except (AssertionError,ValueError,TypeError,KeyError,IndexError,OSError,StopIteration) as e:return failure(e,selection=s)
def addendum_check(host,s):
    try:
        row=next(r for r in host['addenda']['rows'] if r['id']==s['id']);results=[]
        assert row['expected_ref']['sha256']==s['expected_origin']['sha256'],'frozen addendum origin differs'
        for ri,recipe in enumerate(row['recipes']):
            base=host['root']/'evidence/addenda'/s['id'].replace('::','__');folder=base/f'observation-{ri:03d}'
            if len(row['recipes'])==1 and not (folder/'process-outcome.json').is_file():folder=base
            raw,request,refs=parsed_outcome(folder/'process-outcome.json',host)
            verify_request_template(request,recipe['requests'][0])
            for check in recipe['checks']:
                result=evaluate(raw,check);result.update(raw_refs=refs,definition=check);results.append(result)
        assert results
        return {'state':verdict(results),'comparisons':results,'selection':s,'scope':'exact frozen addendum recipe fields and complete request/SDK reads'}
    except (AssertionError,ValueError,TypeError,KeyError,IndexError,OSError,StopIteration) as e:return failure(e,selection=s)
def digest_pair_check(host,s):
    ds=[d for d in host['dispositions']['additional_digest'] if d['id'] in ('source::'+s['id']+'-before','source::'+s['id']+'-after')]
    if len(ds)!=2:return failure('STRICT_DIGEST_PAIR_RAW_DISPOSITION_ABSENT',selection=s)
    actuals={d.get('required_relation_checked_from_actual_raw') for d in ds}
    return {'state':'RELEVANT_PASS' if actuals=={s['expected_relation']} else 'NONPASS','actual_relation':sorted(actuals),'expected_relation':s['expected_relation'],
      'strict_dispositions':ds,'selection':s,'scope':'required equal/different relation only; additional exact hex raw MISMATCH retained; does not dispose166:2'}
def focused_n12(host,focused):
    try:
        folder=host['root']/'original-evidence/unit-043';raw,request,refs=parsed_outcome(folder/'process-outcome.json',host)
        recipe=host['recipes']['recipes'][host['unit_indices']['N12-unselected-intermediate-connects::base']]
        verify_request_template(request,recipe['requests'][0])
        oracle=read(str(OUT/focused['baseline_oracle']));actual=raw['partitionObservation']
        assert actual['executed'] is True and actual['unsupported']==[] and actual['observationScope']=='native_loaded_repository_module_components'
        expected_edges=[{'from':v['file'],'specifier':s['literal'],'to':str((Path(v['file']).parent/s['literal']).with_suffix('.ts')).replace('\\','/')} for v in oracle['visitor'] for s in v['specifiers']]
        ok=(actual['dependencyComponents']==oracle['dependencyComponents'] and sorted(actual['loadedRepositorySources'])==sorted(oracle['sourceFiles']) and sorted(actual['resolvedEdges'],key=canonical)==sorted(expected_edges,key=canonical))
        return {'state':'RELEVANT_PASS' if ok else 'NONPASS','raw_refs':refs,'baseline_oracle_ref':pin(OUT/focused['baseline_oracle']),'actual':actual,'expected_components':oracle['dependencyComponents'],'expected_literal_edges':expected_edges,'scope':'literal static imports present on exact frozen N12 only; P10 outline is additional context only'}
    except (AssertionError,ValueError,TypeError,KeyError,IndexError,OSError) as e:return failure(e)
def public_check(host,s,op):
    try:
        row=next(r for r in host['public']['rows'] if r['id']==s['id']);o=next(o for o in row['observations'] if o['sequence']==op['sequence'])
        planrow=next(r for r in host['plan']['rows'] if r['id']==s['id']);operation=next(o for o in planrow['operations'] if o['sequence']==op['sequence'])
        if operation.get('lifecycle_selector'):
            if operation['prepared_projection']['public_flow_kind']=='public-verify':
                import remaining_carriers as v2;v2.configure(adapter_api());actual,evidence=v2.public_verify(host,planrow,operation)
            else:
                import qualified_carriers as q;q.configure(adapter_api());actual,evidence=q.load_public_lifecycle(host,planrow,operation)
            expected=final_join.supplemental.pointer(read(str(REPO/'docs/research/rust-ts-r0/cases/supplement-v2'/op['expected_origin']['path'])),op['expected_origin']['pointer'])
            return {'state':'RELEVANT_PASS' if actual==expected else 'NONPASS','actual':actual,'expected':expected,'raw_report_projection':o.get('projection'),'raw_report_state_preserved':o['status'],'raw_refs':evidence['raw_refs'],'typed_binding':evidence,'selection':s,'operation':op}
        if 'projection'not in o:return failure(o.get('gap','raw projection unavailable'),selection=s,operation=op)
        invocation=next(x for x in host['plan']['invocations'] if x['key']==operation['invocation_key'])
        folder=host['root']/'evidence/public/outcomes'/invocation['key']
        raw,request,refs=parsed_outcome(folder/'process-outcome.json',host)
        bridge=read(str(folder/'bridge-evidence.json'));assert bridge['outcome']==read(str(folder/'process-outcome.json')),'bridge outcome differs'
        assert request==invocation['prepared']['request'],'actual public request differs from prepared closure'
        assert bridge['native_invocation_id']==o['native_invocation_id'],'reported invocation id differs'
        expected=final_join.supplemental.pointer(read(str(REPO/'docs/research/rust-ts-r0/cases/supplement-v2'/op['expected_origin']['path'])),op['expected_origin']['pointer'])
        if operation.get('lifecycle_selector'):raise ValueError('SPECIALIZED_LIFECYCLE_PROJECTOR_PENDING')
        binding=bridge['binding']
        if 'rust_public_consumer_receipt'in binding:
            raw=dict(raw,_rust_public_consumer_receipt=binding['rust_public_consumer_receipt'],_rust_public_consumer_context={'consumer_artifact_id':binding['consumer_artifact_id'],'sdk_input_id':binding['sdk_input_id']})
        if invocation.get('auxiliaries'):
            ad=host['root']/'evidence/public/outcomes'/invocation['auxiliaries'][0]['key'];aux,_,arefs=parsed_outcome(ad/'process-outcome.json',host);refs+=arefs;raw={'analysis':raw,'parallel':aux}
        api,projector_dir=projector(host['source_head'])
        if 'ownership_selector'in operation:
            import ownership_adapter as owner
            one=dict(operation['prepared_projection'],operations=[operation['ownership_selector']])
            actual=owner.project_ownership(one,raw)[str(operation['sequence'])]['projection']
        else:actual=api.project_operation(operation['prepared_projection'],raw,graph_projector=lambda v:graph_project(v,host['source_head']))
        state='RELEVANT_PASS' if actual==expected else 'NONPASS'
        scoped=None
        if s['id']=='namespace-owners-02' and op['sequence']==72:
            get=lambda v:next(i for i in v['imports'] if i['fromRelPath']=='leaf.test.js' and i['moduleSpecifier']=='./barrel.mjs')
            assert get(actual)==get(expected);state='RELEVANT_PASS';scoped='191:1 exact namespace bindingTarget/name owner fields; modules ordering raw difference retained'
        if s['id']=='opaque-ownership-06' and op['sequence']==45:
            assert {k:v for k,v in actual.items() if k!='modules'}=={k:v for k,v in expected.items() if k!='modules'} and sorted(actual['modules'])==sorted(expected['modules'])
            state='RELEVANT_PASS';scoped='opaque owner consumers use graph coordinates/relations, not extraction module ordering; raw difference retained'
        if s['id']=='mixed-fallback-01' and op['sequence']==39:
            assert actual['parallelism']==expected['parallelism'];state='RELEVANT_PASS';scoped='192:1 exact parallelism fields only; nested extraction differences raw retained'
        if s['id']=='workspace-boundaries-01' and op['sequence']==1:
            disposition=host['dispositions']['configuration_6046']
            if disposition.get('message_disposition')=='additional_message_version_difference':state='RELEVANT_PASS';scoped='singleton6046+installed-byte precedence strict raw disposition'
        if s['id']=='reference-confinement-01' and op['sequence']==1:
            required=lambda v:[c for c in v['candidates'] if c['relPath'] in ('src/legacy.ts','src/referenced.ts')]
            assert required(actual)==required(expected);state='RELEVANT_PASS';scoped='6:0/169:2 exact TS import/reference escaping candidate dispositions; unrelated document language field raw mismatch retained'
        return {'state':state,'actual':actual,'expected':expected,'raw_report_projection':o['projection'],'raw_report_state_preserved':o['status'],'scoped_disposition':scoped,
          'raw_refs':refs+[pin(folder/'bridge-evidence.json')],'selection':s,'operation':op,'projector_refs':[pin(projector_dir/n) for n in ('public_runtime.py','public_adapter.py','directory_closure.py') ]}
    except (AssertionError,ValueError,TypeError,KeyError,IndexError,OSError,StopIteration) as e:return failure(e,selection=s,operation=op)

@lru_cache(None)
def scope_protocol():
    import gzip
    raw=SCOPE_MAP.read_bytes();data=json.loads(gzip.decompress(raw) if SCOPE_MAP.suffix=='.gz' else raw)
    assert data['counts']=={'properties':395,'supports':51,'rows':446}
    authority=REPO/data['authority']['repo_relative_path'];assert pin(authority)['sha256']==data['authority']['sha256'],'frozen obligations differ'
    for path,digest in data['frozen_case_files'].items():assert pin(REPO/path)['sha256']==digest,'frozen case bytes differ: '+path
    catalog=data['check_definitions']
    def expand(v):
        if isinstance(v,list):return [expand(x) for x in v]
        if isinstance(v,dict):
            if set(v)=={'$check'}:
                definition=catalog[v['$check']];assert sha(json.dumps(definition,sort_keys=True,ensure_ascii=True,separators=(',',':')).encode())==v['$check'];return definition
            return {k:expand(x) for k,x in v.items()}
        return v
    return expand(data)
def frozen_git_source(head,path):
    expected=scope_protocol()['verifier_git_sources'][path]['sha256']
    raw=subprocess.run(['git','show',head+':'+path],cwd=REPO,capture_output=True,check=True).stdout
    assert sha(raw)==expected,'candidate verifier source differs from pre-outcome evaluation protocol: '+path
    return raw.decode('utf-8')

def validate_recipe_contracts(host):
    def body(value):
        if isinstance(value,list):return [body(v) for v in value]
        if isinstance(value,dict):return {k:body(v) for k,v in value.items() if k!='manifest_sha256' and not (k=='expected_error' and value.get('surface')=='snapshot_boundary_cli')}
        return value
    digest=lambda value:sha(json.dumps(body(value),sort_keys=True,ensure_ascii=True,separators=(',',':')).encode())
    pins=scope_protocol()['recipe_contracts']
    for family,recipes in (('original',host['recipes']['recipes']),('support',host['recipes']['support_recipes'])):
        field='unit_id' if family=='original' else 'support_id'
        actual={r[field]:digest(r) for r in recipes};assert actual==pins[family],'frozen '+family+' recipe inputs/checks differ'
    registry={r['id']:r for r in host['registry']['rows']}
    for identity,expected in pins['source'].items():
        assert [digest(r) for r in registry[identity]['recipes']]==expected,'frozen source recipe inputs/checks differ: '+identity

def scopes():
    return {key(r):{k:v for k,v in r.items() if k!='coordinate'} for r in scope_protocol()['scope_rows']}
def load_host(name,manifest,head):
    docs,identity=final_join.validate_host_epoch(manifest,head,name)
    root=Path(manifest['raw_root']);host={'root':root,'fixture':docs['supplement.fixture'],'sdk':load_pin(manifest['artifact_files']['sdk']),
      'recipes':docs['original.recipes'],'report':docs['original.report'],'registry':docs['supplement.registry'],'plan':docs['supplement.plan'],
      'source':read(str(root/'evidence/source-results.json')),'public':read(str(root/'evidence/public/public-report.json')),'addenda':docs['supplement.addenda']}
    validate_recipe_contracts(host)
    host['source_head']=head;host['unit_indices']={r['unit_id']:i for i,r in enumerate(host['recipes']['recipes'])}
    if 'token_family' in manifest:
        assert manifest['token_family']['sha256']==host['fixture']['token_family_sha256'],'actual token family differs from frozen fixture'
        host['token_family']=load_pin(manifest['token_family']);host['token_family_ref']=manifest['token_family']
    if 'native_compiler_identity' in manifest:host['native_compiler_identity']=manifest['native_compiler_identity']
    legacy_pin=manifest.get('legacy_identity_inputs')
    if legacy_pin is None:
        candidate=Path(manifest['artifact_files']['sdk']['path']).parent/Path(docs['supplement.fixture']['legacy_identity_inputs_path']).name
        if candidate.is_file():legacy_pin=pin(candidate)
    if legacy_pin is not None:
        assert legacy_pin['sha256']==docs['supplement.fixture']['legacy_identity_inputs_sha256'],'legacy export differs from actual freeze'
        host['legacy_inputs']=load_pin(legacy_pin);host['legacy_inputs_ref']=legacy_pin
    host['identity']=identity;host['dispositions']=final_join.scoped_dispositions(REPO/'docs/research/rust-ts-r0/cases',manifest,docs)
    return host
def run(manifest):
    baseline={'rows':scope_protocol()['baseline_rows']};scope=scopes();rows=[]
    hosts={name:load_host(name,m,manifest['expected_source_head']) for name,m in manifest['hosts'].items()}
    for original in baseline['rows']:
        r={'kind':original['kind'],'qualified':False,'qualification_credit':0,'hosts':{}}
        if r['kind']=='property':
            coord=key(original);sc=scope[coord];review=sc['review'];r.update(coordinate=original['coordinate'],property=original['property'],consumer=original['consumer'],scope=sc)
            checks=list(original['selected_original_and_corrected_comparisons']);sels=list(original['source_addenda_digest_selections'])
            if coord==(4,0):checks=[{'unit_id':u['unit_id'],'definition':{k:v for k,v in c.items() if k!='recipe_pointer'}} for u in sc['focused']['union'] for c in u['checks']]
            if coord==(188,1):checks=[]
            if 'adopted_existing_countercheck'in review:checks.append({'unit_id':review['adopted_existing_countercheck']['unit_id'],'definition':review['adopted_existing_countercheck']['definition']})
            extra=review.get('adopted_existing_source_selections',[])
            for name,host in hosts.items():
                results=[original_check(host,c['unit_id'],c['definition']) for c in checks]
                for g in sels:
                    for s in g['selections']:
                        if s['family']=='source':results.append(source_check(host,s))
                        elif s['family']=='public':results.extend(public_check(host,s,o) for o in s['operations'])
                        elif s['family']=='digest_pair':results.append(digest_pair_check(host,s))
                        elif s['family']=='addendum':results.append(addendum_check(host,s))
                        else:results.append(failure('EXACT_'+s['family'].upper()+'_RAW_CARRIER_ADAPTER_PENDING',selection=s))
                results.extend(source_check(host,s) for s in extra)
                if coord in ((232,1),(234,1),(238,1)):
                    import remaining_carriers as v2;v2.configure(adapter_api());results.append(v2.guarded(lambda host=host,coord=coord:v2.tokens(host,coord)))
                if coord==(188,1):results.append(focused_n12(host,sc['focused']))
                if coord==(168,0):
                    import remaining_carriers as v2;v2.configure(adapter_api());results.append(v2.guarded(lambda host=host:v2.compiler(host)))
                state=verdict(results)
                if coord==(168,0):
                    # The version difference is the explicit ARB004 independent identity scope.
                    identity=results[-1];state=identity['state']
                entry={'state':state,'comparisons':results,'scoped_dispositions':host['dispositions'],'qualification_credit':0}
                if coord==(168,0):entry['compiler_identity_disposition']='ARB004 actual engine identity and every emitted capability scope must independently join native source/build/artifact; original5.9.3 comparisons remain raw NONPASS'
                if coord in ((12,0),(13,0),(14,0)):
                    required=[x for x in results if x.get('definition',{}).get('expected')!='__generator']
                    raw,_,refs=raw_original(host,'N17c-importhelpers-es5-actual-emission::base',{'observation':0})
                    runtime=select(raw,['subjects',{'path':'main.ts'},'runtimeConfiguration']);emission=runtime['emission'];observed=emission['observation']
                    product_ok=(runtime['unsupported']==[] and emission['state']=='observed' and observed['helpers_visible_at_source_file'] is True and bool(observed['non_scoped_helpers']) and observed['imports_tslib']=={'Ok':True} and runtime['reasons']==['SOURCE_CONFIGURATION_HELPERS_UNSUPPORTED'])
                    entry['N17c_product_source_scope']={'required_consumer_fields_state':verdict(required),'baseline':'3e94997f:packages/ts-analyzer/src/javascript-diagnostics.ts:430-440',
                      'actual_consumption':'non-scoped helper metadata AND preProcessFile(emitted.outputText).importedFiles contains tslib',
                      'raw_required_fields_independently_verified':product_ok,'raw_refs':refs,'additional_raw_emission_marker':'__generator','raw_nonpass_preserved':True,'arbitration':'T00-ARB-003; no automatic qualification'}
                    if product_ok and verdict(required)=='RELEVANT_PASS':entry['state']='RELEVANT_PASS';entry['raw_selected_state_before_scope']='NONPASS'
                r['hosts'][name]=entry
        else:
            sid=original['support_id'];r.update(support_id=sid)
            for name,host in hosts.items():
                matching=[i for i,s in enumerate(host['recipes']['support_recipes']) if s['support_id']==sid]
                if not matching:
                    try:
                        import nonqualified_carriers as nq;nq.configure(adapter_api());sp=REPO/'docs/research/rust-ts-r0/cases/qualification/support.json'
                        reference=nq.reference_support(read(str(sp)),sid,pin(sp));r['hosts'][name]={'state':reference['state'],'comparisons':[reference]}
                    except (AssertionError,ValueError,TypeError,KeyError,IndexError,OSError,StopIteration) as e:r['hosts'][name]={'state':'GAP','comparisons':[failure(e,support_id=sid)]}
                    continue
                i=matching[0];recipe=host['recipes']['support_recipes'][i];results=[]
                source_ordinal=int(recipe['source_pointer'].rsplit('/',1)[1]);base=host['root']/'original-evidence'/f'support-{source_ordinal:03d}'
                if recipe.get('surface')=='identity_support_cli':
                    try:
                        import nonqualified_carriers as nq;nq.configure(adapter_api());identity_result=nq.actual_identity_support(host,recipe,base)
                        r['hosts'][name]={'state':identity_result['state'],'comparisons':[identity_result]}
                    except (AssertionError,ValueError,TypeError,KeyError,IndexError,OSError,StopIteration) as e:r['hosts'][name]={'state':'GAP','comparisons':[failure(e,support_id=sid)]}
                    continue
                for c in recipe.get('checks',[]):
                    try:
                        folder=base/f"observation-{c.get('observation',0):03d}"
                        if not (folder/'process-outcome.json').is_file() and recipe.get('surface')=='raw_cli':folder=base
                        raw,request,refs=parsed_outcome(folder/'process-outcome.json',host)
                        if recipe.get('surface')=='raw_cli':verify_request_template(request,recipe['requests'][c.get('observation',0)])
                        v=evaluate(raw,c);v.update(definition=c,raw_refs=refs);results.append(v)
                    except (AssertionError,ValueError,TypeError,KeyError,IndexError,OSError) as e:results.append(failure(e,definition=c))
                if not results:results=[failure('SPECIALIZED_SUPPORT_RELATION_ADAPTER_PENDING')]
                support_result=base/'result.json'
                r['hosts'][name]={'state':verdict(results),'comparisons':results,'raw_support_ref':pin(support_result) if support_result.is_file() else None}
        rows.append(r)
    return {'kind':'DETERMINISTIC_CURRENT_FIELD_ASSESSMENT','candidate_head':manifest['expected_source_head'],'rows':rows,
      'counts':{name:dict(Counter(r['hosts'][name]['state'] for r in rows)) for name in hosts},
      'host_bindings':{n:h['identity'] for n,h in hosts.items()},'qualified':False,'qualification_credit':0,'R0_decision':None,
      'limits':['Independent raw field checks; incomplete carrier/projection adapters are explicit GAP, never supplied report PASS credit.','No Linux query performed; absence from manifest is missing proof.','Source-scoped additional discrepancies retained separately; no blanket waiver or whole product pass.']}
def current_manifest():
    raise ValueError('explicit host manifest required; no host is inferred')
def main():
    global REPO,ROOT,CACHE,SCOPE_MAP
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--repo',type=Path,required=True);p.add_argument('--manifest',type=Path,required=True);p.add_argument('--scope-map',type=Path,default=OUT/'scope-map.json.gz');p.add_argument('--protocol-sha256');p.add_argument('--output',type=Path,required=True);p.add_argument('--cache-dir',type=Path);p.add_argument('--require-both',action='store_true');args=p.parse_args()
    REPO=args.repo.resolve();ROOT=REPO;SCOPE_MAP=args.scope_map.resolve();CACHE=(args.cache_dir or args.output.parent/'.assessor-cache').resolve()
    manifest=read(str(args.manifest.resolve()));base=args.manifest.resolve().parent
    expected_protocol=args.protocol_sha256 or manifest.get('evaluation_protocol_sha256')
    assert isinstance(expected_protocol,str) and len(expected_protocol)==64 and pin(SCOPE_MAP)['sha256']==expected_protocol,'independent pre-outcome protocol pin absent or differs'
    def paths(v):
        if isinstance(v,list):return [paths(x) for x in v]
        if isinstance(v,dict):return {k:(str((base/val).resolve()) if k in ('path','raw_root','evidence_root') and isinstance(val,str) and not Path(val).is_absolute() else paths(val)) for k,val in v.items()}
        return v
    manifest=paths(manifest)
    if args.require_both:assert set(manifest['hosts'])=={'macos','linux'},'both exact native host manifests required'
    assert len(manifest['expected_source_head'])==40 and all(c in '0123456789abcdef' for c in manifest['expected_source_head'])
    for path in scope_protocol()['verifier_git_sources']:frozen_git_source(manifest['expected_source_head'],path)
    result=run(manifest);result['evaluation_protocol_ref']=pin(SCOPE_MAP);result['assessor_source_refs']=[pin(p) for p in sorted(OUT.iterdir()) if p.is_file() and p.suffix in ('.py','.json')]
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(result,ensure_ascii=True,indent=2),encoding='utf-8');print(json.dumps(result['counts']))
if __name__=='__main__':main()
