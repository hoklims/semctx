import argparse
import base64
import collections
import copy
import hashlib
import io
import json
import pathlib
import re
import tarfile

SOURCE = pathlib.Path(__file__).resolve().parent
ROOT = SOURCE.parents[2]
BASE = ROOT / 'docs/research/rust-ts-r0/cases'
parser = argparse.ArgumentParser()
parser.add_argument('--output', type=pathlib.Path, required=True)
output_argument = parser.parse_args().output
OUT = output_argument.parent.resolve() / output_argument.name
OUT.mkdir(parents=True, exist_ok=False)
INDEX = json.loads((BASE / 'index.json').read_text(encoding='utf-8'))
ORIGINAL_ORDINARY = {x['id']:x for x in json.loads((BASE/'sources/ordinary-cases.json').read_text(encoding='utf-8'))['cases']}
UNITS = json.loads((BASE / INDEX['scenarios']['path']).read_text(encoding='utf-8'))['execution_units']
INPUTS = {x['case_id']: x['input_specification'] for x in json.loads((BASE / INDEX['input_index']['path']).read_text(encoding='utf-8'))['qualification_records']}
OPTIONS = {'target':'ES2022','module':'ESNext','moduleResolution':'Bundler','allowJs':True,'jsx':'Preserve','skipLibCheck':True,'noEmit':True,'strict':False}

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()

def check(path, expected, mode='eq', origin=None, transform='none', observation=0):
    return {'observation':observation,'target':path,'mode':mode,'expected':expected,'expected_origin':origin,'actual_transform':transform}

def ptr(key):
    return '/assertions/' + key.replace('~', '~0').replace('/', '~1')

def first_source(files):
    paths=[p for p in files if re.search(r'\.(?:[cm]?[tj]sx?)$',p) and not re.search(r'\.d\.[cm]?ts$',p)]
    return ('main.ts' if 'main.ts' in paths else paths[0]) if paths else next(iter(files),None)

def source_files(inp):
    files=copy.deepcopy(inp.get('files', {}))
    if isinstance(inp.get('source'),str) and isinstance(inp.get('relPath'),str):
        files={inp['relPath']:inp['source']}
    if inp.get('source_text') is not None:
        files={inp['relative_path']:inp['source_text']}
    if inp.get('snapshot') in ['pathe', 'yocto-queue']:
        files={}
        for ref in INDEX['public_payloads']:
            if ref['snapshot']==inp['snapshot'] and ref['logical_path'] in inp['retained_original_files']:
                data=(BASE/ref['path']).read_bytes()
                assert hashlib.sha256(data).hexdigest()==ref['sha256']
                raw=base64.b64decode(data,validate=False)
                assert hashlib.sha256(raw).hexdigest()==ref['decoded_sha256']
                files[ref['logical_path']]=raw.decode('utf-8')
    return files

def recipe_input(inp, cid):
    gaps=[]
    files=source_files(inp)
    if not files:
        return None,['INPUT_REQUIRES_EXPLICIT_COMPONENT_OR_COUPLED_MAPPING']
    if any(isinstance(x,dict) and set(x)!={'live_files_after_capture'} for x in inp.get('setup',[])):
        gaps.append('SETUP_CAPTURE_OR_FILESYSTEM_FAULT_NOT_MAPPED')
    if 'retained_omissions' in inp or isinstance(inp.get('retained_map'),dict):
        gaps.append('CAPTURE_DISCOVERY_DISTINCTION_REQUIRES_CONSUMER_BOUNDARY')
    roots=inp.get('root_files') or inp.get('selected_root_files') or inp.get('root_paths')
    if roots is None:
        m=re.search(r'roots=\[([^\]]+)\]',str(inp.get('baseline_operation','')))
        if m:
            roots=[x.strip() for x in m.group(1).split(',')]
        else:
            roots=[p for p in files if re.search(r'\.(?:[cm]?[tj]sx?)$',p)]
    if any(not isinstance(p,str) or p.startswith('/') or '..' in p.split('/') for p in files):gaps.append('AUTHORED_ABSOLUTE_OR_ESCAPE_PATH_REQUIRES_EXPLICIT_ROOT_RECIPE')
    if not all(isinstance(p,str) and p in files for p in roots):gaps.append('EXPLICIT_ROOT_SET_NOT_MATERIALIZABLE_WITH_SUPPLIED_FILES')
    retained=inp.get('retained_snapshot', isinstance(inp.get('retained_map'),str) or 'retained_original_files' in inp)
    req={'id':cid,'files':files,'roots':roots,'options':OPTIONS,'retained':retained,'qualified':False,'sdk_directory':'/sdk/lib','roles':{},'selection':{},'disabled':[],'utf16_files':{},'raw_files':{}}
    full_analysis=any(name in str(inp.get('operation',inp.get('baseline_operation',''))) for name in ['analyzeRepository','assembleRepository','inspectRetainedQualifiedScope'])
    explicit_profile=inp.get('profile')=='qualified-static-v1/modelo-suite-static-v1' or inp.get('config',{}).get('overrides',{}).get('analysisProfile')=='modelo-suite-static-v1'
    req['qualified']=bool(full_analysis and explicit_profile)
    if req['qualified'] and not req['retained']:gaps.append('QUALIFIED_HISTORICAL_OPERATION_WITHOUT_CAPTURE_INPUTS')
    if isinstance(inp.get('discovered_files'),list):req['roles']={d['relPath']:d['role'] for d in inp['discovered_files'] if isinstance(d,dict) and 'relPath' in d and 'role' in d}
    elif full_analysis:
        req['roles']={path:'test' for path,text in files.items() if re.search(r'\.(?:[cm]?[tj]sx?)$',path) and (re.search(r'\.(?:test|spec)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$',path) or any(part in {'test','tests','__tests__'} for part in path.split('/')) or re.search(r'''from\s+["'](?:vitest|bun:test|node:test)["']''',text))}
    return req,gaps

def outline_checks(assertions, source, index):
    checks=[];claimed=[]
    for key in ['statements','statements_exact_except_digest','exportedNames','hasSyntaxErrors','directiveLines','markerLines']:
        if key in assertions:
            target=['outlines',source,'outline','statements' if key.startswith('statements') else key]
            mode='ordered_projected_eq' if key.startswith('statements') else 'eq'
            checks.append(check(target,assertions[key],mode,ptr(key)));claimed.append(key)
    return checks,claimed

recipes=[]
for n,u in enumerate(UNITS):
    cid=u['case_id'];uid=u['unit_id'];a=u['assertions'];inp=copy.deepcopy(INPUTS[cid]);v=u.get('variant_input_or_observation')
    r={'unit_id':uid,'case_id':cid,'frozen_unit_pointer':f'/execution_units/{n}','frozen_unit_sha256':digest(u),'surface':'raw_cli','profile_binding_rule':'ordinary native pipeline unless frozen full analysis operation explicitly uses modelo-suite-static-v1; standalone component observations retain their actual mode regardless native graph admission profile','requests':[],'checks':[],'credited_properties':[],'explicit_uncredited_properties':[],'gaps':[],'runtime_state':'NOT_EXECUTED','native_pass':False}
    if not isinstance(a,dict):
        r['gaps'].append('COUPLED_IDENTITY_OR_IMPORT_NAME_PROJECTION_REQUIRES_EXPLICIT_MAPPING');recipes.append(r);continue
    if isinstance(v,dict) and 'files' in v:inp=v
    if u['kind']=='arbitrated-E03-execution-variant' and isinstance(v,dict):inp={**inp,'files':v,'retained_snapshot':True}
    if cid.startswith('QCALL-') and isinstance(v,dict):
        if 'replace_file_bytes' in v:inp['files'][next(iter(inp['files']))]=v['replace_file_bytes']
        inp['supplied_SourceFile']=True
    variant_number=int(uid.rsplit('variant-',1)[1])-1 if '::variant-' in uid else None
    component_carrier=False
    if cid=='ORD-OUTLINE-DEFAULT-OWNERS':
        inp={'files':{inp['relPath']:v['source']},'retained_snapshot':False}
    elif cid=='ORD-OUTLINE-ENUM-NAMESPACE':
        inp={'files':{ORIGINAL_ORDINARY[cid]['input']['relPath']:v},'retained_snapshot':False}
    elif cid=='ORD-OUTLINE-EVALUATION':
        inp={'files':{'__adapter_component_carrier__.ts':v['value']},'retained_snapshot':False};component_carrier=True
    elif cid=='ORD-OUTLINE-SCRIPT-KIND':
        inp={'files':{v:inp['source']},'retained_snapshot':False}
    elif cid=='ORD-RUNTIME-NAMED-VALUE':
        inp=copy.deepcopy(INPUTS[inp['reuse_case']]);inp['files']['consumer.ts']=INPUTS[cid]['replace_consumer_source']
    request,gaps=recipe_input(inp,cid)
    if request is not None:
        request['id']=uid
        r['requests'].append(request)
    r['gaps']+=gaps
    source=(request['roots'][0] if inp.get('selected_root_files') and request and request['roots'] else first_source(request['files'])) if request else None
    if component_carrier:
        r['component_carrier']={'path':'__adapter_component_carrier__.ts','is_authored_original_path':False,'scope':'filename-independent component projection only; source bytes unchanged','review_required':False,'root_authorization':'2026-10-17T18:50:51Z source relPath recovery/synthetic path explicitly authorized'}

    recognized=set()
    def add(key,path,mode='eq',expected=None,transform='none',recipe=r,assertions=a,recognized_properties=recognized):
        recipe['checks'].append(check(path,assertions[key] if expected is None else expected,mode,ptr(key),transform));recognized_properties.add(key)
    if source:
        oc,oks=outline_checks(a,source,n);r['checks']+=oc;recognized.update(oks)
        for key,target in [('modules','modules'),('modules_exact','modules'),('imports','imports'),('imports_exact','imports'),('calls','calls'),('calls_exact','calls'),('symbols','symbols'),('symbols_exact','symbols'),('symbols_projection_exact','symbols')]:
            if key in a:add(key,['raw_extraction',target],'unordered_projected_eq',transform='symbol_aliases' if target=='symbols' else 'none')
        for key in ['symbol_projection','symbol_projection_exact']:
            if key in a:add(key,['raw_extraction','symbols'],'unordered_projected_eq' if key.endswith('_exact') else 'contains_projected',transform='symbol_aliases')
        for key in ['call_projection','calls_projection','calls_projection_exact','call_coordinates_exact','calls_contains','calls_exclude']:
            if key in a:
                mode='excludes_projected' if key=='calls_exclude' else ('unordered_projected_eq' if key.endswith('_exact') else 'contains_projected')
                add(key,['raw_extraction','calls'],mode,transform='call_aliases')
        for key in ['import_projection','imports_projection']:
            if key in a:add(key,['raw_extraction','imports'],'contains_projected',expected=a[key] if isinstance(a[key],list) else [a[key]],transform='import_aliases')
        if 'binding_target_projection' in a:add('binding_target_projection',['raw_extraction','imports'],'contains_projected',transform='binding_aliases')
        for key in ['forbidden_symbol_names','absent_extracted_symbol_names']:
            if key in a:add(key,['raw_extraction','symbols'],'excludes_projected',expected=[{'name':name} for name in a[key]])
        if 'forbidden_call_targets' in a:add('forbidden_call_targets',['raw_extraction','calls'],'excludes_projected',expected=[{'callee':value} for value in a['forbidden_call_targets']],transform='call_aliases')
        if 'links_exact' in a:add('links_exact',['outlines',source,'moduleLinks'],'ordered_projected_eq')
        if 'outline_hasSyntaxErrors' in a:add('outline_hasSyntaxErrors',['outlines',source,'outline','hasSyntaxErrors'])
        if 'javascript_parseFailed' in a:add('javascript_parseFailed',['subjects',{'path':source},'javascript','parseFailed'])
        if 'commonJsUnsupported' in a:add('commonJsUnsupported',['subjects',{'path':source},'javascript','commonJsUnsupported'])
        if 'javascript_reasons' in a:r['gaps'].append('NATIVE_COMPLETE_JAVASCRIPT_COMPONENT_OBSERVATION_NOT_EXPOSED')
        for key in ['reasons','semantic_reasons']:
            if key in a:
                field='moduleConfigurationObservations' if key=='reasons' else 'semanticObservation'
                target=['subjects',{'path':source},field]
                if key=='reasons':target+=['ordinaryWithoutSnapshot' if not request['retained'] else ('retainedWithSource' if inp.get('supplied_SourceFile') is True else 'retainedWithoutSource')]
                r['checks'].append(check(target+['executed'],True,'eq','frozen input baseline_operation requires actual component execution'))
                add(key,target+['reasons'],'reason_constraints')
                r.setdefault('pending_dto_fields',[]).append(field)
        if 'global_admission_inferred' in a:add('global_admission_inferred',['global_admission_inferred'])
        if 'source_parse_reasons_exact' in a:
            add('source_parse_reasons_exact',['subjects',{'path':source},'sourceParsingObservation','reasons'],'unordered_projected_eq')
            r['checks'].append(check(['subjects',{'path':source},'sourceParsingObservation','executed'],True,'eq','frozen parsing operation requires native observation'))
            r.setdefault('pending_dto_fields',[]).append('sourceParsingObservation')
        if 'forbidden_fabricated_specifiers' in a:
            add('forbidden_fabricated_specifiers',['outlines',source,'moduleLinks'],'excludes_projected',expected=[{'specifier':s} for s in a['forbidden_fabricated_specifiers']])
        if 'all_emitted_repository_paths' in a:
            add('all_emitted_repository_paths',['raw_extraction'],'confined_paths',expected=True)
        if cid=='ORD-OUTLINE-DEFAULT-OWNERS':
            e=a['variants'][variant_number];outline_expected={k:e[k] for k in ['kind','declaredNames','referencedNames','executesOnLoad']};outline_expected.update(a['all_statement_coordinates'])
            r['checks']+=[check(['outlines',source,'outline','statements'],[outline_expected],'ordered_projected_eq','/assertions/variants'),check(['outlines',source,'outline','exportedNames'],e['exportedNames'],'eq','/assertions/variants'),check(['outlines',source,'outline','hasSyntaxErrors'],a['all_hasSyntaxErrors'],'eq',ptr('all_hasSyntaxErrors')),check(['outlines',source,'outline','statements'],a['all_absent_statement_fields'],'all_fields_absent',ptr('all_absent_statement_fields'))]
            recognized.update(['variants','all_statement_coordinates','all_hasSyntaxErrors','all_absent_statement_fields']);r['explicit_uncredited_properties'].append({'key':'digest','basis':'frozen explicit not projected'});recognized.add('digest')
        if cid=='ORD-OUTLINE-ENUM-NAMESPACE':
            e=copy.deepcopy(a['variants'][variant_number]);e.update(dict(zip(['startLine','endLine','leadingStartLine'],a['all_coordinates'],strict=True)))
            r['checks']+=[check(['outlines',source,'outline','statements'],[e],'ordered_projected_eq',ptr('variants')),check(['outlines',source,'outline','exportedNames'],a['all_exportedNames'],'eq',ptr('all_exportedNames')),check(['outlines',source,'outline','hasSyntaxErrors'],a['all_hasSyntaxErrors'],'eq',ptr('all_hasSyntaxErrors')),check(['outlines',source,'outline','statements'],a['all_absent'],'all_fields_absent',ptr('all_absent'))]
            recognized.update(a);r['explicit_uncredited_properties'].append({'key':'digest','basis':'frozen explicit not projected'})
        if cid=='ORD-OUTLINE-EVALUATION':
            group=v['declared_group'];group_index=variant_number if group=='assignment_variants' else variant_number-len(INPUTS[cid]['assignment_variants'])
            e={'kind':a['all_kind'],'declaredNames':a['all_declaredNames'],'executesOnLoad':a['assignment_executesOnLoad' if group=='assignment_variants' else 'other_executesOnLoad'][group_index]};e.update(dict(zip(['startLine','endLine','leadingStartLine'],a['all_coordinates'],strict=True)))
            r['checks']+=[check(['outlines',source,'outline','statements'],[e],'ordered_projected_eq',ptr('assignment_executesOnLoad' if group=='assignment_variants' else 'other_executesOnLoad')),check(['outlines',source,'outline','hasSyntaxErrors'],a['all_hasSyntaxErrors'],'eq',ptr('all_hasSyntaxErrors'))];recognized.update(a)
            r['explicit_uncredited_properties'].append({'key':'projection_scope','basis':'frozen restricts projection; referencedNames/digest uncredited'})
        if cid=='ORD-OUTLINE-SCRIPT-KIND':
            chosen=a['tsx' if source.endswith('.tsx') else 'ts'];r['checks'].append(check(['outlines',source,'outline','hasSyntaxErrors'],chosen['hasSyntaxErrors'],'eq',ptr('tsx' if source.endswith('.tsx') else 'ts')))
            if 'statements_projection' in chosen:r['checks'].append(check(['outlines',source,'outline','statements'],chosen['statements_projection'],'ordered_projected_eq',ptr('tsx')+'/statements_projection'))
            recognized.update(a)
        if 'logical_unordered_projection_complete' in a:
            x=a['logical_unordered_projection_complete']
            for key,actual,transform in [('modules','modules','none'),('symbol_coordinates','symbols','symbol_coordinates'),('imports','imports','import_aliases'),('calls','calls','call_aliases')]:
                r['checks'].append(check(['raw_extraction',actual],x[key],'unordered_projected_eq',ptr('logical_unordered_projection_complete')+'/'+key,transform))
            recognized.add('logical_unordered_projection_complete')
    if source:
        for key in ['raw_calls_projection_exact','raw_declarations_projection_exact']:
            if key in a:add(key,['raw_extraction','calls' if key.startswith('raw_calls') else 'symbols'],'unordered_projected_eq')
        if 'grouped_symbol_projection_exact' in a:add('grouped_symbol_projection_exact',['assembly','symbols'],'unordered_projected_eq')
        if 'source_module_set_exact' in a:add('source_module_set_exact',['raw_extraction','modules'],'unordered_projected_eq')
        if 'utils_import_projection_exact' in a:
            add('utils_import_projection_exact',['raw_extraction','imports'],'unordered_projected_eq')
            r['checks'][-1]['actual_filter']={'fromRelPath':'src/utils.ts'}
        if 'required_retained_call_relations' in a:add('required_retained_call_relations',['raw_extraction','calls'],'contains_projected',transform='public_call_aliases')
        if 'raw_call_projection' in a:add('raw_call_projection',['raw_extraction','calls'],'contains_projected',transform='call_aliases')
        if 'binding_target_field_absences' in a:add('binding_target_field_absences',['raw_extraction','imports'],'indexed_field_absences',transform='binding_aliases')
        if 'source_reasons' in a:
            add('source_reasons',['subjects',{'path':source},'sourceParsingObservation','reasons'],'reason_constraints')
            r.setdefault('pending_dto_fields',[]).append('sourceParsingObservation')
        if 'ordinary_no_snapshot_excludes_only' in a:
            add('ordinary_no_snapshot_excludes_only',['subjects',{'path':source},'moduleConfigurationObservations','ordinaryWithoutSnapshot','reasons'],'reason_constraints',expected={'excludes':a['ordinary_no_snapshot_excludes_only']} if isinstance(a['ordinary_no_snapshot_excludes_only'],list) else a['ordinary_no_snapshot_excludes_only'])
            r.setdefault('pending_dto_fields',[]).append('moduleConfigurationObservations')
        if cid.startswith('QCALL-'):
            mode=['subjects',{'path':source},'moduleConfigurationObservations','retainedWithSource']
            r['checks']+=[check(mode+['executed'],True,'eq','frozen retained bound source operation'),check(mode+['reasons'],v['reasons'],'reason_constraints',ptr('variant_expected')+f'/{variant_number}/reasons')]
            recognized.add('variant_expected');r.setdefault('pending_dto_fields',[]).append('moduleConfigurationObservations')
    for key in ['raw_call_endpoint_fields','qualified_result_if_all_admission_prerequisites_are_supplied']:
        if key in a and isinstance(a[key],str):r['explicit_uncredited_properties'].append({'key':key,'basis':'frozen deliberately conditional/unasserted full admission/endpoint projection; native component reasons alone do not discharge it'});recognized.add(key)
    if isinstance(a.get('source_triggers'),list):r['explicit_uncredited_properties'].append({'key':'source_triggers','basis':'authored authority landmarks in immutable input, not a separate claimed runtime output'});recognized.add('source_triggers')
    for key in ['method_symbols_extracted','method_symbols_emitted','new_Node_raw_CallExpression_fact_emitted']:
        if a.get(key) is False and any(k in recognized for k in ['symbol_projection_exact','symbols_exact','raw_calls_projection_exact']):r.setdefault('entailed_properties',[]).append({'key':key,'basis':'complete exact symbol/raw-call projection already excludes additional method/constructor-call rows'});recognized.add(key)
    if 'control_existing_case' in a:r['explicit_uncredited_properties'].append({'key':'control_existing_case','basis':'frozen reference to separately allocated countercase, not a new output'});recognized.add('control_existing_case')
    for key in ['completeness','claim_scope','semantic_type_errors','unasserted_named_clause_level_typeOnly','owner_limit','other_calls_symbols_bindingTargets','declaration_role','projection_scope','source_triggers','independent_emission_fact','independent_emission_facts','typecheck_success','recovered_symbols','method_symbols_extracted','method_symbols_emitted','new_Node_raw_CallExpression_fact_emitted']:
        if key in a:
            if key in ['completeness','claim_scope','semantic_type_errors','unasserted_named_clause_level_typeOnly','owner_limit','other_calls_symbols_bindingTargets','declaration_role','projection_scope','source_triggers','typecheck_success','recovered_symbols'] and isinstance(a[key],str):
                r['explicit_uncredited_properties'].append({'key':key,'basis':'frozen prose limits/authority or deliberately unasserted property; no native success inferred'});recognized.add(key)
    if 'qualified_admission' in a and a['qualified_admission']=='UNKNOWN':
        r['explicit_uncredited_properties'].append({'key':'qualified_admission','basis':'frozen UNKNOWN, not an admission obligation credited by this projection'});recognized.add('qualified_admission')
    if cid.startswith('QRECEIPT'):
        r['surface']='private_receiver_component'
        r['guard_input_case_id']=cid
        r['guard_variant']=v
        r['requests']=[]
        r['checks']=[]
        r['gaps']=[]
        recognized.update(a)
        r['required_external_property_links']=[{'case_id':'P23-opaque-inline-call-has-graph-owner','property':'actual modeled graph ownership before any opaque callback discharge','not_inferred_from_guard':True}]
        r['proof_scope']='Controlled private receiver guards only; no producer semantic success/process attestation/admission asserted.'
    for key in a:
        if key not in recognized:r['gaps'].append('UNMAPPED_EXPECTED_PROPERTY:'+key)
    if not r['requests'] and r['surface']=='raw_cli':r['gaps'].append('NO_ACTUAL_NATIVE_INVOCATION_RECIPE')
    if not r['checks'] and r['surface']=='raw_cli':r['gaps'].append('NO_EXECUTABLE_CREDITED_COMPARATOR')
    component_completion=[]
    for c in r['checks']:
        if c['target'][-1]=='reasons' and any(x in ['semanticObservation','sourceParsingObservation','moduleConfigurationObservations'] for x in c['target'] if isinstance(x,str)):
            base=c['target'][:-1]
            for field,expected in [('executed',True),('unsupported',[])]:
                completion=check(base+[field],expected,'eq','required native mechanism completeness for credited baseline usage')
                if not any(x['target']==completion['target'] and x['mode']=='eq' and x['expected']==expected for x in r['checks']+component_completion):component_completion.append(completion)
    r['checks']+=component_completion
    for c in r['checks']:
        def absent_markers(value):
            if isinstance(value,list):return [absent_markers(x) for x in value]
            if isinstance(value,dict):return {k:({'$field_absent':True} if v=='absent' and k in ['signatureOnly','resolvedRelPath','callerSymbolPath','calleeSymbolPath','calleeRelPath'] else absent_markers(v)) for k,v in value.items()}
            return value
        c['expected']=absent_markers(c['expected'])
    r['physical_live_after_capture']={p:t for setup in inp.get('setup',[]) if isinstance(setup,dict) for p,t in setup.get('live_files_after_capture',{}).items()}
    r['credited_properties']=sorted(recognized-set(x['key'] for x in r['explicit_uncredited_properties']))
    r['gaps']=sorted(set(r['gaps']))
    r['prepared_state']='MAPPED_PENDING_DTO_AND_REVIEW' if not r['gaps'] else 'PARTIAL_OR_NOT_EXECUTABLE_EXPLICIT_GAPS'
    recipes.append(r)

AUDIT = json.loads((SOURCE/'reason-routing-audit.json').read_text(encoding='utf-8'))
COUPLED = json.loads((SOURCE/'coupled-mapping-scope.json').read_text(encoding='utf-8'))
AUDIT_BY_KEY={(x['unit_id'],x['expected_origin'],json.dumps(x['original_target'],sort_keys=True)):x for x in AUDIT['comparisons']}
COUPLED_BY_ID={x['unit_id']:x for x in COUPLED['rows']}
audit_case_inputs = [
    'qualification/scenarios.json', 'allocation/input-index.json', 'index.json',
    'sources/semantic-cases.json', 'sources/public-cases.json', 'sources/qualified-cases.json',
]
for proof in AUDIT['input_digests']:
    if proof['path'].endswith('/qualification-adapter/replay-recipes.json'):
        archive = ROOT / 'docs/research/rust-ts-r0/qualification/reproduction/qualifier-reproduction.tar.gz.b64'
        with tarfile.open(fileobj=io.BytesIO(base64.b64decode(archive.read_bytes())), mode='r:gz') as historical:
            member = historical.extractfile('session/qualification-adapter/replay-recipes.json')
            if member is None:
                raise ValueError('missing immutable predecessor recipes')
            content = member.read()
    else:
        relative = next(name for name in audit_case_inputs if proof['path'].endswith('/docs/research/rust-ts-r0/cases/' + name))
        content = (BASE / relative).read_bytes()
    if hashlib.sha256(content).hexdigest() != proof['sha256']:
        raise ValueError('historical routing audit input digest mismatch: ' + proof['path'])
UNITS_BY_ID={x['unit_id']:x for x in UNITS}
def remove_gap(recipe,key):
    recipe['gaps']=[g for g in recipe['gaps'] if g!='UNMAPPED_EXPECTED_PROPERTY:'+key]
def operation_binding(target, operation, authority):
    return {'status':'VERIFIED_SOURCE_OPERATION','target':target,'baseline_operation':operation,'authority':authority}
def add_bound_check(recipe,path,expected,mode,origin,operation,authority,transform='none',observation=0):
    c=check(path,expected,mode,origin,transform,observation)
    if path[-1]=='reasons':c['operation_binding']=operation_binding(path,operation,authority)
    recipe['checks'].append(c)
def graph_coordinate(value):
    return {'path':value[0],'test_node':True} if value[1] in ['test','test-node'] else {'path':value[0],'symbol_path':value[1]}
def graph_relation(value):
    return {'kind':value['kind'],'from':graph_coordinate(value['from']),'to':graph_coordinate(value['to'])}
for r in recipes:
    u=UNITS_BY_ID[r['unit_id']];a=u['assertions'];cid=r['case_id']; inp=INPUTS[cid]
    r['reason_routing_review']='ALL_REASON_CHECKS_REQUIRE_SOURCE_OPERATION_BINDING'
    for c in r['checks']:
        if c['target'][-1]!='reasons':continue
        row=AUDIT_BY_KEY.get((r['unit_id'],c['expected_origin'],json.dumps(c['target'],sort_keys=True)))
        if row is None:
            r['gaps'].append('REASON_OPERATION_NOT_IN_INDEPENDENT_AUDIT');continue
        if row['action']=='API_GAP':
            subject='render.jsx' if cid=='V2-J03-retained-jsx-source-reason-prefix' else c['target'][1]['path']
            target=['subjects',{'path':subject},'javascriptObservation','reasons']
            r.setdefault('required_native_api',[]).append('complete javascriptObservation from native inspectJavaScriptSource; pending pass2 freeze')
        else:target=row['verified_target']
        c['target']=target
        c['operation_binding']=operation_binding(target,row['resolved_operation'],{'audit_path':'reason-routing-audit.json','unit_id':row['unit_id'],'expected_origin':row['expected_origin'],'source_case':row['source_case'],'coordinates':row['authority']})
        if c['expected_origin']=='/assertions/ordinary_no_snapshot_excludes_only' and isinstance(c['expected'],str):c['expected']={'excludes':[c['expected']]}
    r['checks']=[c for c in r['checks'] if not (c['target'][-1] in ['executed','unsupported'] and any(k in ['semanticObservation','sourceParsingObservation','moduleConfigurationObservations'] for k in c['target'] if isinstance(k,str)))]
    for c in r['checks']:
        if c['expected_origin']=='/assertions/commonJsUnsupported':c['target'].insert(-1,'native')
        if c['expected_origin']=='/assertions/javascript_parseFailed':
            c['target']=['subjects',c['target'][1],'javascriptObservation','parseFailed'];r.setdefault('required_native_api',[]).append('complete javascriptObservation.parseFailed; pending pass2 freeze')
    if not isinstance(a,dict):
        row=COUPLED_BY_ID.get(r['unit_id'])
        if row and cid=='ORD-IMPORT-NAME-PROJECTIONS':
            request,errors=recipe_input(row['exact_input'],r['unit_id']);assert request is not None and not errors
            request['retained']=row['mode']!='historical-no-snapshot'
            r['requests']=[request];r['checks']=[check(['raw_extraction','imports',{'fromRelPath':'src/specimen.ts','moduleSpecifier':'./mod'},'names'],row['frozen_expected_projection'],'eq','/assertions')]
            r['gaps']=[];r['mapping_authority']=row;r['physical_live_after_capture']={};r['prepared_state']='MAPPED_REQUIRES_PASS2_DTO_FREEZE_AND_REVIEW'
        continue
    request=r['requests'][0] if r['requests'] else None
    source=first_source(request['files']) if request else None
    if 'javascript_reasons' in a and source:
        add_bound_check(r,['subjects',{'path':source},'javascriptObservation','reasons'],a['javascript_reasons'],'reason_constraints',ptr('javascript_reasons'),'inspectJavaScriptSource',{'frozen_unit_pointer':r['frozen_unit_pointer']})
        r['gaps']=[g for g in r['gaps'] if g!='NATIVE_COMPLETE_JAVASCRIPT_COMPONENT_OBSERVATION_NOT_EXPOSED'];remove_gap(r,'javascript_reasons');r.setdefault('required_native_api',[]).append('complete javascriptObservation; pending pass2 freeze')
    if 'node_projection' in a:
        r['checks'].append(check(['assembly','nodes'],a['node_projection'],'prefix_count',ptr('node_projection')));remove_gap(r,'node_projection')
    if 'absent_node_ids' in a:
        r['checks'].append(check(['assembly','nodes'],a['absent_node_ids'],'excludes_projected',ptr('absent_node_ids'),'pluck:id'));remove_gap(r,'absent_node_ids')
    if 'calls_targeting_prefix' in a:
        c=check(['assembly','edges'],a['calls_targeting_prefix'],'unordered_projected_eq',ptr('calls_targeting_prefix'));c['actual_filter']={'kind':'calls'};c['actual_filter_prefix']={'to':a['node_projection']['prefix']};r['checks'].append(c);remove_gap(r,'calls_targeting_prefix')
    for key in ['coverage_edges_exact','coverage_contains','graph_relations_contains']:
        if key in a and isinstance(a[key],list) and all(isinstance(x,dict) and all(k in x for k in ['kind','from','to']) for x in a[key]):
            r['checks'].append(check(['assembly'],[graph_relation(x) for x in a[key]],'unordered_projected_eq' if key.endswith('exact') else 'contains_projected',ptr(key),'logical_coverage_edges'));remove_gap(r,key)
    if 'forbidden_coverage_targets' in a:
        expected=[{end:graph_coordinate(x)} for x in a['forbidden_coverage_targets'] for end in ['from','to']]
        r['checks'].append(check(['assembly'],expected,'excludes_projected',ptr('forbidden_coverage_targets'),'logical_coverage_edges'));remove_gap(r,'forbidden_coverage_targets')
    if 'actual_import_module' in a:
        x=a['actual_import_module'];source_kind='test_node' if r['requests'][0]['roles'].get(x[0])=='test' else 'module_node';r['checks'].append(check(['assembly'],[{'kind':'imports','from':{'path':x[0],source_kind:True},'to':{'path':x[1],'module_node':True}}],'contains_projected',ptr('actual_import_module'),'logical_import_edges'));remove_gap(r,'actual_import_module')
    if 'forbidden_extraction_calls' in a:
        r['checks'].append(check(['raw_extraction','calls'],a['forbidden_extraction_calls'],'excludes_projected',ptr('forbidden_extraction_calls'),'call_aliases'));remove_gap(r,'forbidden_extraction_calls')
    if a.get('declaration_file_emitted_as_module') is False:
        paths=[x for x in request['files'] if '.d.' in x];r['checks'].append(check(['raw_extraction','modules'],paths,'excludes_projected',ptr('declaration_file_emitted_as_module')));remove_gap(r,'declaration_file_emitted_as_module')
    for key in ['classification_must_not_be_reported_complete','completed_analysis_claim']:
        if key in a:
            r['checks'].append(check(['subjects',{'path':source},'outcome'],'analyzed','neq',ptr(key)));remove_gap(r,key)
            r.setdefault('projection_notes',[]).append('Transport complete is not successful analysis; native known non-analyzed subject outcome controls recovery claim.')
    if cid=='ORD-FUNCTION-VARIABLE-PAIR':
        expected=a['positive_variant_symbols_matching_main_value' if r['unit_id'].endswith('01') else 'counter_variant_symbols_matching_main_value']
        c=check(['raw_extraction','symbols'],expected,'unordered_projected_eq',ptr('positive_variant_symbols_matching_main_value' if r['unit_id'].endswith('01') else 'counter_variant_symbols_matching_main_value'));c['actual_filter']={'relPath':'main.ts','name':'value'};r['checks'].append(c)
        for key in a:remove_gap(r,key)
    if cid in ['ORD-OUTLINE-COMMENT-CONTROLS','ORD-OUTLINE-PRIVATE-DIGEST']:
        path=inp.get('relPath','__adapter_private_digest__.ts')
        r['requests']=[];r['checks']=[]
        for i,phase in enumerate(['before','after']):
            request,errors=recipe_input({'files':{path:inp[phase]},'retained_snapshot':False},r['unit_id']+'::'+phase);assert not errors;r['requests'].append(request)
            if cid=='ORD-OUTLINE-COMMENT-CONTROLS':
                for key,expected in a[phase].items():r['checks'].append(check(['outlines',path,'outline',key],expected,'eq',ptr(phase)+'/'+key,observation=i))
                r['checks'].append(check(['outlines',path,'outline','statements'],a['both_statement_line_triples'],'eq',ptr('both_statement_line_triples'),'statement_line_triples',i))
                r['checks'].append(check(['outlines',path,'outline','hasSyntaxErrors'],a['both_hasSyntaxErrors'],'eq',ptr('both_hasSyntaxErrors'),observation=i))
        r['relations']=[{'left_observation':0,'right_observation':1,'target':['outlines',path,'outline','statements'],'transform':'pluck:digest','expected_equal':a['same_statement_digest_pairs'] if cid=='ORD-OUTLINE-COMMENT-CONTROLS' else a['first_statement_digest_equal'],'origin':ptr('same_statement_digest_pairs' if cid=='ORD-OUTLINE-COMMENT-CONTROLS' else 'first_statement_digest_equal')}]
        if cid=='ORD-OUTLINE-PRIVATE-DIGEST':r['relations'][0]['first_only']=True;r['checks'].append(check(['outlines',path,'outline','hasSyntaxErrors'],False,'eq','exact valid source component precondition'));r['synthetic_path_scope']='filename-independent private digest component; original unspecified path not claimed'
        r['gaps']=[]
    if r['unit_id'] in ['P09-outline-logical-set::digest-relation-01','P09-outline-logical-set::digest-relation-02']:
        row=COUPLED_BY_ID[r['unit_id']];before=row['exact_before_input'];after=copy.deepcopy(before);path=next(iter(after['files']))
        old,new=('value = 1;','value = -1;') if r['unit_id'].endswith('02') else ('/** Keys. */','/** Digest comment changed. */')
        assert after['files'][path].count(old)==1
        after['files'][path]=after['files'][path].replace(old,new)
        r['requests']=[recipe_input(x,r['unit_id']+'::'+phase)[0] for x,phase in [(before,'before'),(after,'after')]];r['checks']=[];r['gaps']=[]
        r['relations']=[{'left_observation':0,'right_observation':1,'target':['outlines',path,'outline','statements'],'transform':'pluck:digest','expected_equal':a['equal'],'origin':'/assertions/equal'}];r['mapping_authority']=row
        r['instantiated_mutation']={'path':path,'replaced':old,'replacement':new,'after_utf8_sha256':hashlib.sha256(after['files'][path].encode()).hexdigest(),'scope':'Deterministic instantiation of the frozen edit description; not an originally frozen exact after source or expected digest.'}
    r['gaps']=[g for g in r['gaps'] if not (g=='NO_EXECUTABLE_CREDITED_COMPARATOR' and (r['checks'] or r.get('relations'))) and not(g=='NO_ACTUAL_NATIVE_INVOCATION_RECIPE' and r['requests']) and not(g=='INPUT_REQUIRES_EXPLICIT_COMPONENT_OR_COUPLED_MAPPING' and cid.startswith('ORD-OUTLINE-') and r['requests'])]
    completion=[]
    for c in r['checks']:
        if c['target'][-1]=='reasons':
            for field,expected in [('executed',True),('unsupported',[])]:completion.append(check(c['target'][:-1]+[field],expected,'eq','actual complete native component for verified source operation',observation=c.get('observation',0)))
    r['checks']+=completion
    r['gaps']=sorted(set(r['gaps']));r['prepared_state']='MAPPED_REQUIRES_PASS2_DTO_FREEZE_AND_REVIEW' if not r['gaps'] else 'PARTIAL_OR_NOT_EXECUTABLE_EXPLICIT_GAPS'

for r in recipes:
    if r['case_id']=='SEM-KEY-LEXICAL-NATIVE-CASE-PAIR':
        unit=UNITS_BY_ID[r['unit_id']];variant=unit['variant_input_or_observation'];a=unit['assertions']
        r['surface']='primitive_cli';r['requests']=[];r['primitive_requests']=[];r['checks']=[];r['relations']=[];r['gaps']=[]
        for sensitive in [True,False]:
            for side in ['left','right']:r['primitive_requests'].append({'operation':'semantic_key','cwd':'NATIVE_ROOT','path':variant[side],'case_sensitive':sensitive})
            expected=a['keys_equal'] if 'keys_equal' in a else a['case_sensitive_true_keys_equal' if sensitive else 'case_sensitive_false_keys_equal']
            r['relations'].append({'left_observation':0 if sensitive else 2,'right_observation':1 if sensitive else 3,'target':['key'],'transform':'none','expected_equal':expected,'origin':'/assertions/keys_equal' if 'keys_equal' in a else '/assertions/case_sensitive_'+str(sensitive).lower()+'_keys_equal'})
        r['required_native_api']=['native --observe-primitives semantic_key; lexical native case context, not canonical-realpath helper'];r['prepared_state']='MAPPED_REQUIRES_PASS2_DTO_FREEZE_AND_REVIEW'

for r in recipes:
    cid=r['case_id'];unit=UNITS_BY_ID[r['unit_id']]
    if cid=='ORD-WORKER-REQUEST-REFUSAL':
        r.update({'surface':'worker_cli','worker_request':unit['variant_input_or_observation'],'physical_files':{},'controlled_request_refusal':True,'requests':[],'checks':[check([],unit['assertions']['response_exact_each'],'ordered_projected_eq','/assertions/response_exact_each'),check(['extraction_started'],False,'eq','/assertions/extraction_started')],'gaps':[],'required_native_api':['--extract-worker FILE.json SDK.json; request guard before SDK/compiler, exact request/artifact response binding'],'proof_scope':'Actual native malformed worker request refusal before extraction, no useful compiler facts or absence of all OS reads inferred.','prepared_state':'MAPPED_REQUIRES_PASS2_DTO_FREEZE_AND_REVIEW'})
    elif cid in ['ORD-WORKER-EMIT-SUBSET','P13-worker-preserves-facts']:
        physical=INPUTS['P13-worker-preserves-facts']['files']
        roots=INPUTS[cid].get('request_root_set',list(physical));emit=INPUTS[cid].get('emit_set',roots)
        direct=copy.deepcopy(r) if cid=='P13-worker-preserves-facts' else None
        if direct:direct['gaps']=[];direct['relations']=[]
        r.update({'surface':'worker_cli','worker_request':{'schemaVersion':1,'jobId':INPUTS[cid].get('jobId',r['unit_id']),'repoRoot':'NATIVE_ROOT','rootAbsPaths':['ROOT/'+p for p in roots],'emitAbsPaths':['ROOT/'+p for p in emit],'tsconfigPathMapping':False},'physical_files':physical,'controlled_request_refusal':False,'requests':[],'checks':[],'gaps':[],'required_native_api':['--extract-worker real native extraction+emit subset; bound request/artifact/SDK; actual raw repository read hashes and compiler probes; native capability completeness'],'prepared_state':'MAPPED_REQUIRES_PASS2_DTO_FREEZE_AND_REVIEW'})
        if direct:
            r['direct_recipe']=direct
            for c in direct['checks']:
                c=copy.deepcopy(c)
                if c['target'][0]=='raw_extraction':c['target'][0]='extraction';r['checks'].append(c)
            r['proof_scope']='Actual native direct and worker outputs compared by complete logical module/symbol/import/call sets, with independent frozen projections; no parallel-caller or atomic capture claim.'
        else:
            expected=unit['assertions']['response_projection'];r['checks'].append(check([],{'schemaVersion':expected['schemaVersion'],'jobId':expected['jobId'],'ok':expected['ok']},'ordered_projected_eq','/assertions/response_projection'))
            for key in ['modules','imports','calls']:r['checks'].append(check(['extraction',key],expected['extraction'][key],'unordered_projected_eq','/assertions/response_projection/extraction/'+key))
            r['checks'].append(check(['extraction','symbols'],expected['extraction']['symbols_projection'],'unordered_projected_eq','/assertions/response_projection/extraction/symbols_projection'))
            r['checks'].append(check(['extraction','modules'],unit['assertions']['forbidden_emitted_paths'],'excludes_projected','/assertions/forbidden_emitted_paths'))
            r['proof_scope']='Actual native worker output is restricted by native emit subset; no observer-side filtering creates the product.'

for r in recipes:
    if r['case_id']=='N13-malformed-worker-evidence':
        inp=INPUTS[r['case_id']];u=UNITS_BY_ID[r['unit_id']];base=copy.deepcopy(inp['baseline_valid_observation_template']);job='n13-control';base['jobId']=job
        bad=copy.deepcopy(base);variant=u['variant_input_or_observation']['id']
        if variant=='N13a-missing-collection':del bad['extraction']['calls']
        elif variant=='N13b-foreign-job':bad['jobId']='n13-foreign-job'
        elif variant=='N13c-noncanonical-path':bad['extraction']['imports'][0]['resolvedRelPath']='src/../dep.ts'
        else:raise AssertionError('unknown frozen N13 mutation')
        request={'schemaVersion':1,'jobId':job,'repoRoot':'NATIVE_ROOT','rootAbsPaths':['ROOT/'+p for p in inp['root_paths']],'emitAbsPaths':['ROOT/'+p for p in base['extraction']['modules']],'tsconfigPathMapping':False}
        r.update({'surface':'worker_consumer_cli','consumer_descriptors':[{'request':request,'response':base},{'request':request,'response':bad}],'requests':[],'checks':[check(['valid'],True,'eq','otherwise-valid frozen observation control',observation=0),check(['accepted'],True,'eq','otherwise-valid frozen observation control',observation=0),check(['worker_failed'],False,'eq','otherwise-valid useful response control',observation=0),check(['valid'],False,'eq','/assertions/baseline_error_matches',observation=1),check(['accepted'],False,'eq','/assertions/analysis_success',observation=1),check(['error'],u['assertions']['baseline_error_matches'],'contains_text','/assertions/baseline_error_matches',observation=1)],'gaps':[],'required_native_api':['--consume-worker FILE.json; actual raw codec schema/path/emit/job checks; descriptor+artifact binding'],'proof_scope':'Actual native consumer rejection with positive frozen valid control. No producer facts synthesized as useful success and no direct fallback after rejection.','forbidden_promotions_binding':'Negative native accepted=false plus exact malformed DTO error class, while unchanged positive carrier is accepted.','prepared_state':'MAPPED_REQUIRES_PASS2_DTO_FREEZE_AND_REVIEW'})

for r in recipes:
    if r['case_id']=='ORD-RETAINED-SYSTEM':
        inp=INPUTS[r['case_id']];unit=UNITS_BY_ID[r['unit_id']]
        snapshot={p.removeprefix('R/'):text for p,text in inp['snapshot'].items()}
        queries=[]
        for query in inp['queries']:
            name,arg=query[:-1].split('(',1);operation={'readFile':'read_file','fileExists':'file_exists','directoryExists':'directory_exists','readDirectory':'read_directory'}[name]
            queries.append({'operation':operation,'path':arg.removeprefix('R/') if arg!='R' else '.'})
        checks=[]
        for index,expected in enumerate(unit['assertions']['results']):
            target=['results',index]
            if isinstance(expected,dict) and expected.get('state')=='undefined':
                checks.extend([check(target+['found'],False,'eq','/assertions/results/'+str(index)),check(target+['value'],None,'eq','/assertions/results/'+str(index))])
            else:
                checks.append(check(target+['value'],expected,'eq','/assertions/results/'+str(index)))
                if queries[index]['operation']=='read_file':checks.append(check(target+['found'],True,'eq','/assertions/results/'+str(index)))
        r.update({'surface':'captured_system_cli','system_profile':'retained','system_files':snapshot,'system_queries':queries,'system_live_after_capture':{p.removeprefix('R/'):text for p,text in inp['live_files'].items()},'requests':[],'checks':checks,'gaps':[],'proof_scope':'Actual retained System queries with physical changed/live-only files present after immutable request capture. readDirectory[] is historical retained profile, distinct from native_get_accessible_entries. No SDK fallback, cache implementation identity, global OS-read absence or graph admission claimed.','prepared_state':'MAPPED_REQUIRES_PASS2_DTO_FREEZE_AND_REVIEW'})

for recipe in recipes:
    assertions = UNITS_BY_ID[recipe['unit_id']]['assertions']
    if not isinstance(assertions, dict) or not recipe['requests']:
        continue
    source = first_source(recipe['requests'][0]['files'])
    if 'external_module' in assertions:
        recipe['checks'].append(check(['subjects', {'path':source}, 'sourceFileObservation', 'external_module'], assertions['external_module'], 'eq', ptr('external_module')))
        remove_gap(recipe, 'external_module')
        recipe['credited_properties'].append('external_module')
    if recipe['case_id'] == 'N21-actual-sdk-map-callback':
        variant = copy.deepcopy(recipe['requests'][0])
        javascript_path = str(pathlib.PurePosixPath(source).with_suffix('.js'))
        variant['id'] += '::javascript-component'
        variant['files'] = {javascript_path if name == source else name:text for name,text in variant['files'].items()}
        variant['roots'] = [javascript_path if name == source else name for name in variant['roots']]
        recipe['requests'].append(variant)
        add_bound_check(recipe, ['subjects', {'path':javascript_path}, 'javascriptObservation', 'reasons'], [assertions['javascript_variant_contains']], 'contains_projected', ptr('javascript_variant_contains'), 'inspectJavaScriptSource on the prescribed JavaScript variant', {'frozen_unit_pointer':recipe['frozen_unit_pointer']}, observation=1)
        remove_gap(recipe, 'javascript_variant_contains')
        recipe['credited_properties'].append('javascript_variant_contains')
    emission_key = next((key for key in ['independent_emission_fact', 'independent_emission_facts'] if key in assertions), None)
    if emission_key:
        if emission_key == 'independent_emission_fact':
            source = assertions['forbidden_extraction_calls'][0]['caller'][0]
        runtime = ['subjects', {'path':source}, 'runtimeConfiguration']
        observation = runtime + ['emission', 'observation']
        recipe['checks'].extend([
            check(runtime + ['unsupported'], [], 'eq', 'independent native emission mechanism must be supported'),
            check(runtime + ['emission', 'state'], 'observed', 'eq', ptr(emission_key)),
        ])
        if emission_key == 'independent_emission_fact':
            expected_call = 'h("div", null)'
            if expected_call not in assertions[emission_key]:
                raise ValueError('unsupported frozen classic emission fact')
            recipe['checks'].extend([
                check(observation + ['classic_factory'], True, 'eq', ptr(emission_key)),
                check(observation + ['output_text'], expected_call, 'contains_text', ptr(emission_key)),
            ])
        else:
            for fact in assertions[emission_key]:
                if fact == 'an import from tslib':
                    recipe['checks'].append(check(observation + ['imports_tslib', 'Ok'], True, 'eq', ptr(emission_key)))
                elif fact in ['__awaiter', '__generator']:
                    recipe['checks'].append(check(observation + ['output_text'], fact, 'contains_text', ptr(emission_key)))
                else:
                    raise ValueError('unsupported frozen helper emission fact: ' + str(fact))
        remove_gap(recipe, emission_key)
        recipe['credited_properties'].append(emission_key)
    if recipe['case_id'] == 'V2-F01-empty-config-no-input-diagnostic':
        target = ['subjects', {'path':source}, 'moduleConfigurationObservations', 'retainedWithoutSource', 'reasons']
        add_bound_check(recipe, target, assertions['configuration_reason_projection_exact'], 'unordered_projected_eq', ptr('configuration_reason_projection_exact'), 'inspectModuleConfiguration on exact retained source/config input', {'frozen_unit_pointer':recipe['frozen_unit_pointer']})
        remove_gap(recipe, 'configuration_reason_projection_exact')
        recipe['credited_properties'].append('configuration_reason_projection_exact')
    if recipe['case_id'] == 'V2-C03-object-literal-caller-unmodeled':
        for projection in recipe['checks']:
            if projection['expected_origin'] == ptr('raw_call_projection'):
                projection['expected'] = copy.deepcopy(projection['expected'])
                for call in projection['expected']:
                    if call.get('callerSymbolPath') == 'absent':
                        call['callerSymbolPath'] = {'$field_absent':True}
                projection['notation_interpretation'] = 'Frozen callerSymbolPath absent denotes omitted field, not the literal string; baseline ts-symbols.ts573-587 and native optional field serialization.'
        recipe['checks'].append(check(['assembly', 'integrityReasons', source], [assertions['qualified_reason_contains']], 'contains_projected', ptr('qualified_reason_contains')))
        edges = check(['assembly', 'edges'], assertions['guessed_call_edges_from_object_member'], 'unordered_projected_eq', ptr('guessed_call_edges_from_object_member'))
        edges['actual_filter'] = {'kind':'calls'}
        recipe['checks'].append(edges)
        for key in ['qualified_reason_contains', 'guessed_call_edges_from_object_member']:
            remove_gap(recipe, key)
            recipe['credited_properties'].append(key)
    if recipe['case_id'] == 'V2-F02-outside-inherited-config':
        setup = INPUTS[recipe['case_id']]['setup']
        if len(setup) != 1 or set(setup[0]) != {'outside_root_retained_files'}:
            raise ValueError('outside configuration requires the exact frozen sibling setup')
        recipe['requests'][0]['outside_root_retained_files'] = copy.deepcopy(setup[0]['outside_root_retained_files'])
        recipe['gaps'] = [gap for gap in recipe['gaps'] if gap != 'SETUP_CAPTURE_OR_FILESYSTEM_FAULT_NOT_MAPPED']
        recipe['setup_mapping'] = 'Exact frozen sibling retained bytes in a separate input envelope; direct sibling paths only, exclusive creation, included in captured request and independent input binding.'
    if recipe['checks'] or recipe.get('relations'):
        recipe['gaps'] = [gap for gap in recipe['gaps'] if gap != 'NO_EXECUTABLE_CREDITED_COMPARATOR']

SUPPORTS=json.loads((BASE/INDEX['supports']['path']).read_text(encoding='utf-8'))['support_units']
support_plans=[]
def code_units(text):
    raw=text.encode('utf-16-le','surrogatepass');return [int.from_bytes(raw[i:i+2],'little') for i in range(0,len(raw),2)]
for index,support in enumerate(SUPPORTS):
    sid=support['support_id'];p=support['payload']
    row={'support_id':sid,'source_pointer':'/support_units/'+str(index),'source_canonical_sha256':support['sha256_canonical_json'],'status':'EXPLICIT_GAP','native_queries':0,'pass':False,'expected_unchanged':True}
    if sid.startswith('ENC::'):
        mode=p['mode'];v=p['vector'];checks=[]
        if mode=='raw-boundary':
            request={'operation':'utf16','units':code_units(v['text']),'offsets_utf16':sorted([x['utf16'] for x in v['scalar_boundaries']]+v['unrepresentable_scalar_boundary_utf16'])}
            checks.append(check(['decoded_utf16_units'],code_units(v['text']),'eq','/payload/vector/text'))
            for bound in v['scalar_boundaries']:
                target=['boundaries_sdk',{'offset_utf16':bound['utf16']}]
                for field,expected in [('scalar_boundary',True),('sdk_port_offset',bound['utf8']),('sdk_roundtrip_utf16',bound['utf16'])]:checks.append(check(target+[field],expected,'eq','/payload/vector/scalar_boundaries'))
            for offset in v['unrepresentable_scalar_boundary_utf16']:checks.append(check(['boundaries_sdk',{'offset_utf16':offset},'scalar_boundary'],False,'eq','/payload/vector/unrepresentable_scalar_boundary_utf16'))
            gaps=[]
        else:
            text=v.get(mode+'_decoded_text',v.get('expected_ordinary_decoded_text') if mode=='ordinary' else None)
            units=code_units(text) if text is not None else v.get('expected_ordinary_UTF16_code_units') if mode=='ordinary' else None
            coords=v.get(mode+'_coordinates')
            offsets=sorted(set([0,len(units)]+[n for key,value in (coords or {}).items() if key.endswith('_utf16') and isinstance(value,list) for n in value])) if units is not None else []
            request={'operation':'decode','bytes':list(bytes.fromhex(v['raw_hex'])),'profile':'compiler_system' if mode=='ordinary' else 'retained_utf8','offsets_utf16':offsets,'filename':'entry.ts'}
            if units is not None:checks.append(check(['decoded_utf16_units'],units,'eq','/payload/vector/'+(mode+'_decoded_text' if mode+'_decoded_text' in v else 'expected_ordinary_decoded_text' if text is not None else 'expected_ordinary_UTF16_code_units')))
            checks.append(check(['raw_bytes_sha256'],v.get('raw_sha256','sha256:'+hashlib.sha256(bytes.fromhex(v['raw_hex'])).hexdigest()),'eq','/payload/vector/raw_hex'))
            codes=v.get(mode+'_syntax_errors',v.get(mode+'_syntax_error_codes'))
            row['frozen_parser_codes']=codes;row['frozen_coordinate_projection']=coords
            gaps=['NATIVE_PARSER_DTO_MAPPING_PENDING_FIELDS_NOT_INVENTED']
            if coords:row['coordinate_scope']='Actual declaration/name spans and source lines required, not just arithmetic at authored landmark offsets.'
        row.update({'status':'MAPPED_PRIMITIVE_PENDING_PARSER_DTO_REVIEW' if mode!='raw-boundary' else 'MAPPED_PRIMITIVE_SCALAR_BOUNDARIES_PENDING_FREEZE','primitive_requests':[request],'checks':checks,'relations':[],'gaps':gaps,'required_native_api':['--observe-primitives FILE.json exact descriptor/artifact binding; native parse_source_file when filename is supplied'],'proof_scope':'Published decoding/UTF16/parser primitive support only. No graph admission, full analyzer identity, capture acquisition coherence or all SDK consumed asserted.'})
    elif sid.startswith('DIAG::'):
        row['gaps']=['NATIVE_CONFIGURATION_DIAGNOSTICS_DTO_NOT_EXPOSED'] if p['id']!='D-source-parse' else ['NATIVE_PARSER_DTO_MAPPING_PENDING_FIELDS_NOT_INVENTED']
        row['frozen_diagnostic_projection']=p;row['required_native_api']='actual config parser code/spans (filter18003 per baseline) or source parser code/span, without deriving code from human wording'
    elif sid in ['IDENTITY::I-relocation','IDENTITY::I-sdk-supplied-vs-consumed','IDENTITY::I-request-separation','IDENTITY::I-capture-mismatch','IDENTITY::complete-baseline-specimen']:
        row['gaps']=['ACTUAL_IDENTITY_CONSUMER_ACQUISITION_OR_BASELINE_REPLAY_NOT_REPLACED_BY_DESCRIPTOR_HASH']
        row['frozen_identity_projection']=p;row['proof_scope']='Private receiver guards and metadata digest primitives are separate. Historical complete baseline specimen does not equal selected native identity.'
    else:row.update({'status':'EXISTING_FIXED_NATIVE_IDENTITY_PRIMITIVE_MAPPING','gaps':[]})
    support_plans.append(row)
for row in support_plans:
    if row['support_id'].startswith('ENC::') and row.get('primitive_requests') and row['primitive_requests'][0]['operation']=='decode':
        target=['source_parsing_observation']
        row['checks'] += [check(target+['executed'],True,'eq','native parse_source_file completeness'),check(target+['unsupported'],[],'eq','native parser must cover frozen primitive')]
        codes=row['frozen_parser_codes']
        if codes is not None:
            row['checks'].append(check(target+['diagnostics'],codes,'unordered_projected_eq','/payload/vector/mode_syntax_error_codes','pluck:code'))
            row['checks'].append(check(target+['has_syntax_errors'],bool(codes),'eq','/payload/vector/mode_syntax_error_codes'))
        coords=row['frozen_coordinate_projection']
        if coords:
            declaration=target+['declarations',{'kind':'FunctionDeclaration'}]
            for field,value in [('start_utf16',coords['declaration_utf16'][0]),('end_utf16',coords['declaration_utf16'][1]),('start_line',coords['startLine']-1),('end_line',coords['endLine']-1)]:row['checks'].append(check(declaration+[field],value,'eq','/payload/vector/mode_coordinates'))
            for field,value in [('start_utf16',coords['name_utf16'][0]),('end_utf16',coords['name_utf16'][1])]:row['checks'].append(check(declaration+['name',field],value,'eq','/payload/vector/mode_coordinates'))
            for label,utf16,utf8 in [('declaration',coords['declaration_utf16'],coords['declaration_utf8_of_decoded_text']),('name',coords['name_utf16'],coords['name_utf8_of_decoded_text'])]:
                for position,offset in enumerate(utf16):
                    base=['boundaries_sdk',{'offset_utf16':offset}]
                    row['checks'].append(check(base+['sdk_port_offset'],utf8[position],'eq','/payload/vector/mode_coordinates/'+label+'_utf8_of_decoded_text'))
                    row['checks'].append(check(base+['sdk_roundtrip_utf16'],offset,'eq','/payload/vector/mode_coordinates/'+label+'_utf16'))
                    row['checks'].append(check(base+['scalar_boundary'],True,'eq','/payload/vector/mode_coordinates/'+label+'_utf16'))
            row['checks'].append(check(['boundaries_sdk',{'offset_utf16':coords['total_utf16']},'sdk_port_offset'],coords['total_utf8_of_decoded_text'],'eq','/payload/vector/mode_coordinates/total_utf8_of_decoded_text'))
            row['coordinate_scope']='Actual SDK getStart(skiptrivia) declaration/name spans,0based native lines compared to authored1based lines, and SDK PositionMap at authored landmarks; recovered source never promoted to analyzed facts.'
        row['gaps']=[] if codes is not None else ['FROZEN_PARSER_EXPECTATION_ABSENT_NOT_INVENTED']
        row['status']='MAPPED_NATIVE_DECODE_PARSER_PENDING_PASS2_FREEZE_AND_REVIEW'
    if row['support_id'].startswith('DIAG::'):
        p=row['frozen_diagnostic_projection'];sid=row['support_id'];source=p.get('file','entry.ts')
        files={source:p['text']} if p['id']=='D-source-parse' else {source:'export function leaf() { return 1; }','tsconfig.json':p['text']}
        request,errors=recipe_input({'files':files,'retained_snapshot':True},sid);assert not errors
        row.update({'surface':'raw_cli','requests':[request],'checks':[],'physical_live_after_capture':{},'relations':[],'gaps':[],'status':'MAPPED_NATIVE_DIAGNOSTIC_COMPONENT_PENDING_PASS2_FREEZE_AND_REVIEW'})
        if p['id']=='D-source-parse':
            for component,prefix in [('sourceParsingObservation','SOURCE_PARSE_ERROR'),('javascriptObservation','JAVASCRIPT_PARSE_ERROR')]:
                target=['subjects',{'path':source},component]
                add_bound_check(row,target+['reasons'],[prefix],'unordered_projected_eq','/payload/exact_source_projection' if component=='sourceParsingObservation' else '/payload/exact_javascript_projection','inspectSourceParsing' if component=='sourceParsingObservation' else 'inspectJavaScriptSource',p['source_authority'],'reason_prefix')
                for field,value in [('executed',True),('unsupported',[])]:row['checks'].append(check(target+[field],value,'eq','actual native named component completeness'))
            row['checks'].append(check(['subjects',{'path':source},'sourceParsingObservation','diagnostics'],[{'code':1134,'start_utf16':p['diagnostic_span_utf16']['start'],'end_utf16':p['diagnostic_span_utf16']['start']+p['diagnostic_span_utf16']['length']}],'unordered_projected_eq','/payload/diagnostic_span_utf16'))
            row['checks'].append(check(['subjects',{'path':source},'javascriptObservation','parseFailed'],p['parseFailed'],'eq','/payload/parseFailed'))
            row['proof_scope']='Actual source/complete-JavaScript parsing code/span/reason projections; no successful analysis or graph admission inferred.'
        else:
            target=['subjects',{'path':source},'moduleConfigurationObservations','retainedWithoutSource']
            add_bound_check(row,target+['reasons'],p['exact_observable_projection'],'unordered_projected_eq','/payload/exact_observable_projection','inspectModuleConfiguration configuration-diagnostic projection only',p['authority'],'configuration_diagnostic_projection')
            for field,value in [('executed',True),('unsupported',[])]:row['checks'].append(check(target+[field],value,'eq','actual native module-configuration component completeness'))
            row['proof_scope']='Only emitted SOURCE_CONFIGURATION_INVALID reason/code projection; native18003 must already be absent. Other configuration/source policy reasons and admission are not inferred.'
            row['diagnostic_projection_transport']='SOURCE_CONFIGURATION_INVALID:<u32 code>:<raw wording>, exact native format from src/configuration.rs; raw wording preserved in Outcome, excluded by frozen policy.'

def complete_component_fields(recipe):
    additions=[]
    components=['semanticObservation','sourceParsingObservation','moduleConfigurationObservations','javascriptObservation','sourceFileObservation']
    for c in recipe.get('checks',[]):
        target=c['target'];indices=[i for i,x in enumerate(target) if isinstance(x,str) and x in components]
        if not indices or target[-1] in ['executed','unsupported']:continue
        index=indices[0];end=index+1+(1 if target[index]=='moduleConfigurationObservations' else 0)
        observation=c.get('observation',0)
        for field,expected in [('executed',True),('unsupported',[])]:
            path=target[:end]+[field]
            if not any(x['target']==path and x.get('expected')==expected and x.get('mode')=='eq' and x.get('observation',0)==observation for x in recipe.get('checks',[])+additions):
                additions.append(check(path,expected,'eq','actual named component completeness',observation=observation))
    recipe.setdefault('checks',[]).extend(additions)
for recipe in recipes:
    complete_component_fields(recipe)
    recipe['prepared_state']='MAPPED_REQUIRES_PASS2_DTO_FREEZE_AND_REVIEW' if not recipe['gaps'] else 'PARTIAL_OR_NOT_EXECUTABLE_EXPLICIT_GAPS'
    if recipe.get('direct_recipe'):complete_component_fields(recipe['direct_recipe'])
for support_plan in support_plans:
    if support_plan.get('surface')=='raw_cli':complete_component_fields(support_plan)

(OUT/'support-mapping-plan.json').write_text(json.dumps({'status':'PREQUERY_ONLY','support_denominator':51,'support_plans':support_plans,'qualification_queries':0},ensure_ascii=True,indent=2)+'\n',encoding='utf-8')

payload={'schema_version':1,'status':'PREPARATION_ONLY_NEVER_EXECUTED','source_index_sha256':hashlib.sha256((BASE/'index.json').read_bytes()).hexdigest(),'immutable_sources':{k:INDEX[k] for k in ['scenarios','supports','obligation_map','input_index','allocation']},'records':268,'unit_denominator':354,'support_denominator':51,'native_queries':0,'recipes':recipes,'support_recipes':[x for x in support_plans if x.get('primitive_requests') or x.get('surface')=='raw_cli']}
path=OUT/'replay-recipes.json';path.write_text(json.dumps(payload,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
summary={'status':'STATIC_PREPARATION_NO_QUERY_NO_PASS','recipes_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'units':len(recipes),'with_request':sum(bool(r['requests']) for r in recipes),'with_checks':sum(bool(r['checks']) for r in recipes),'without_known_gaps_pending_DTO_review':sum(not r['gaps'] for r in recipes),'gap_counts':dict(collections.Counter(g for r in recipes for g in r['gaps'])),'unit_gap_map':{r['unit_id']:r['gaps'] for r in recipes if r['gaps']},'pending_dto_counts':dict(collections.Counter(f for r in recipes for f in r.get('pending_dto_fields',[])))}
(OUT/'preparation-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({k:v for k,v in summary.items() if k not in ['unit_gap_map','gap_counts']},indent=2))
