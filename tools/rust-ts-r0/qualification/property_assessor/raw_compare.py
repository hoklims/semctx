"""Independent JSON field comparator; unsupported carriers fail as gaps."""
import json,hashlib,re
def sha(b):return hashlib.sha256(b).hexdigest()
def canonical(v):return json.dumps(v,sort_keys=True,ensure_ascii=False,separators=(',',':'))
def projected(a,e):
    if isinstance(e,dict):return isinstance(a,dict) and all((k not in a if v=={'$field_absent':True} else k in a and projected(a[k],v)) for k,v in e.items())
    if isinstance(e,list):return isinstance(a,list) and len(a)==len(e) and all(projected(x,y) for x,y in zip(a,e,strict=True))
    return type(a)==type(e) and a==e
def select(v,path):
    for step in path:
        if isinstance(step,dict):
            found=[x for x in v if projected(x,step)]
            if len(found)!=1:raise ValueError('selector not unique '+str(step))
            v=found[0]
        else:v=v[step]
    return v
def injective(a,e):
    owners={}
    def aug(i,seen):
        for j,x in enumerate(a):
            if j not in seen and projected(x,e[i]):
                seen.add(j)
                if j not in owners or aug(owners[j],seen):owners[j]=i;return True
        return False
    return all(aug(i,set()) for i in range(len(e)))
def transform(v,name):
    if name=='none':return v
    if name=='reason_prefix':
        assert all(isinstance(x,str) and ':'in x for x in v)
        return [x.split(':',1)[0] for x in v]
    if name=='configuration_diagnostic_projection':
        assert all(isinstance(x,str) for x in v)
        return [{'reason':'SOURCE_CONFIGURATION_INVALID','code':int(x.split(':',2)[1])} for x in v if x.startswith('SOURCE_CONFIGURATION_INVALID:')]
    if name.startswith('pluck:'):return [x[name[6:]] for x in v]
    if name=='statement_line_triples':return [[x[k] for k in ('startLine','endLine','leadingStartLine')] for x in v]
    if name=='native_capability_dialect_versions':
        version=v['native_compiler_version'];subjects=v['subjects'];assert subjects
        assert len({s['path'] for s in subjects})==len(subjects)
        assert all(s['selection']=='selected' and s['outcome']=='analyzed' and s['sourceFileObservation']['executed'] and s['sourceFileObservation']['unsupported']==[] and s['capabilityScope']['language'] in ('typescript','javascript') and s['capabilityScope']['dialectVersion']==version for s in subjects)
        return [version]
    if name.startswith('qualified_test_integrity_reasons:'):
        path=name.split(':',1)[1];assert len([n for n in v['nodes'] if n['kind']=='test' and n.get('filePath')==path])==1
        assert all(isinstance(a,list) and all(isinstance(x,str) for x in a) for a in v['integrityReasons'].values())
        return v['integrityReasons'].get(path,[])
    if name.startswith('opaque_ownership_graph_binding:'):
        path=name.split(':',1)[1];o=select(v,['subjects',{'path':path},'opaqueCallbackOwnership']);g=v['assembly']
        assert o['executed'] is True and o['unsupported']==[] and o['observationScope']=='native_module_configuration_graph_ownership' and o['globalAdmissionInferred'] is False
        assert o['graphBeforeEdgeRemovalId']=='sha256:'+sha(canonical(g).encode())
        assert o['graphAfterEdgeRemovalId']=='sha256:'+sha(canonical(dict(g,edges=[])).encode())
        return True
    if name.startswith('logical_'):
        def coord(id):
            n=next(n for n in v['nodes'] if n['id']==id);p=n['filePath']
            if n['kind']=='test':return {'path':p,'test_node':True}
            if n['kind']=='module':return {'path':p,'module_node':True}
            s=next(s for s in v['symbols'] if s['id']==id);return {'path':p,'symbol_path':'.'.join(s['scope']+[s['name']])}
        kinds={'logical_coverage_edges':('covers','tested_by'),'logical_import_edges':('imports',),'logical_call_edges':('calls',)}[name]
        return [{'kind':e['kind'],'from':coord(e['from']),'to':coord(e['to'])} for e in v['edges'] if e['kind'] in kinds]
    if name=='symbol_coordinates':return [[x['relPath'],'.'.join(x['scope']+[x['name']])] for x in v]
    if name=='binding_aliases':return [dict(b,importer=x['fromRelPath'],**({'target':[b['relPath'],b['symbolPath']]} if 'relPath'in b and 'symbolPath'in b else {})) for x in v for b in x.get('bindingTargets',[])]
    aliases={'symbol_aliases':{'path':'relPath'},'import_aliases':{'from':'fromRelPath','specifier':'moduleSpecifier','resolved':'resolvedRelPath'},'call_aliases':{'caller_path':'callerRelPath','caller_symbol':'callerSymbolPath','callee_path':'calleeRelPath','callee_symbol':'calleeSymbolPath'}}
    if name=='public_call_aliases':name='call_aliases'
    if name not in aliases:raise ValueError('unsupported transform '+name)
    out=[]
    for x in v:
        q=dict(x);q.update({k:x[f] for k,f in aliases[name].items() if f in x})
        if name=='call_aliases':
            for role in ('caller','callee'):
                if role+'RelPath'in x and role+'SymbolPath'in x:q[role]=[x[role+'RelPath'],x[role+'SymbolPath']]
        out.append(q)
    return out
def exact(a,e):
    if type(a)!=type(e):return False
    if isinstance(e,dict):return a.keys()==e.keys() and all(exact(a[k],v) for k,v in e.items())
    if isinstance(e,list):return len(a)==len(e) and all(exact(x,y) for x,y in zip(a,e,strict=True))
    return a==e
def compare(a,e,m):
    if m=='eq':return exact(a,e)
    if m=='neq':return a!=e
    if m=='contains_text':return e in a
    if m=='ordered_projected_eq':return projected(a,e)
    if m=='unordered_projected_eq':return len(a)==len(e) and injective(a,e)
    if m=='contains_projected':return injective(a,e)
    if m=='excludes_projected':return not any(projected(x,y) for x in a for y in e)
    if m=='prefix_count':return sum(x['id'].startswith(e['prefix']) for x in a)==e['count']
    if m=='indexed_field_absences':return all(all(k not in a[x['index']] for k in x['fields']) for x in e)
    if m=='all_fields_absent':return all(all(k not in x for k in e) for x in a)
    if m=='reason_constraints':
        assert isinstance(a,list) and all(isinstance(x,str) for x in a)
        assert set(e)<= {'contains','excludes','contains_prefix','exact_set','global_admission_inferred'}
        assert e.get('global_admission_inferred',False) is False
        return (all(x in a for x in e.get('contains',[]) or []) and all(x not in a for x in e.get('excludes',[]) or []) and all(any(x.startswith(p) for x in a) for p in e.get('contains_prefix',[]) or []) and (e.get('exact_set') is None or (set(a)==set(e['exact_set']) and len(set(a))==len(a))))
    if m=='confined_paths':
        def good(v):
            if isinstance(v,list):return all(good(x) for x in v)
            if isinstance(v,dict):return all((isinstance(x,str) and not x.startswith(('/','\\')) and '..' not in re.split(r'[/\\]',x) and not re.match(r'^.:',x)) if k in ('relPath','fromRelPath','resolvedRelPath','callerRelPath','calleeRelPath') else good(x) for k,x in v.items())
            return True
        return e is True and good(a)
    raise ValueError('unsupported mode '+m)
def evaluate(raw,definition):
    actual=select(raw,definition['target'])
    if 'actual_filter'in definition:actual=[x for x in actual if all(x.get(k)==v for k,v in definition['actual_filter'].items())]
    if 'actual_filter_prefix'in definition:actual=[x for x in actual if all(x.get(k,'').startswith(v) for k,v in definition['actual_filter_prefix'].items())]
    actual=transform(actual,definition.get('actual_transform','none'))
    return {'state':'RELEVANT_PASS' if compare(actual,definition['expected'],definition['mode']) else 'NONPASS','actual':actual,'expected':definition['expected']}
