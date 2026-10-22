"""Typed ordinary physical System input joins. No frozen expected bytes are inputs."""
from raw_compare import canonical,sha

def require(value,reason):
    if not value:raise ValueError('PHYSICAL_SYSTEM_INPUT: '+reason)
def digest(value):return 'sha256:'+sha(canonical(value).encode())
def physical_system_contract(request,observed,before,after,paths,root,case_sensitive,artifact_sha256):
    require(isinstance(paths,list) and 1<=len(paths)<=4096 and all(isinstance(p,str) for p in paths) and len(paths)==len(set(paths)),'actual System query count/path denominator differs')
    for relative in paths:
        require(relative and '\\' not in relative and ':' not in relative and not relative.startswith('/') and all(p and p not in ('.','..','.git','.semctx') for p in relative.split('/')),'queried source escapes ordinary workspace')
    require(type(case_sensitive) is bool and isinstance(root,str) and root and '\\' not in root,'actual ordinary workspace context missing')
    require(set(request)=={'profile','root','case_sensitive','files','utf16_files','raw_files','sdk_directory','queries'},'ordinary System request shape differs')
    require(request['profile']=='workspace' and request['root']==root and request['case_sensitive'] is case_sensitive and request['sdk_directory'] is None and request['utf16_files']=={} and request['raw_files']=={},'ordinary capture relabelled as retained/SDK or source encoding differs')
    require(request['queries']==[{'operation':'read_file','path':root+'/'+p} for p in paths],'actual System query inventory differs')
    require(isinstance(request['files'],dict) and all(isinstance(k,str) and isinstance(v,str) for k,v in request['files'].items()),'actual physical files map absent')
    request_id=digest(request)
    for capsule in (before,after):
        require(capsule['kind']=='ordinary-physical-system-input-v1' and capsule['context']=='ordinary_workspace_only' and capsule['request_descriptor_id']==request_id and capsule['retained_map_modified'] is False,'physical capture context/request identity differs')
    require(after['matched_before'] is True and before['pins']==after['pins'],'before/after physical pins are not stable')
    pins=before['pins'];require(isinstance(pins,list) and len(pins)==len(paths) and [p['relative'] for p in pins]==paths,'physical pin denominator/order differs')
    actual_files={};present=set()
    for pin in pins:
        path=root+'/'+pin['relative'];require(pin['path']==path and type(pin['present']) is bool,'physical pin path/presence differs')
        require(path not in present,'physical source repeated');present.add(path)
        if pin['present']:
            text=request['files'].get(path);require(isinstance(text,str),'present physical pin missing actual request bytes');data=text.encode('utf-8')
            require(type(pin['bytes']) is int and pin['bytes']==len(data) and pin['content_sha256']=='sha256:'+sha(data),'actual physical request bytes/hash differ from acquisition pin');actual_files[path]=text
        else:require(pin['bytes'] is None and pin['content_sha256'] is None and path not in request['files'],'absent physical pin claims bytes')
    require(request['files']==actual_files,'physical map has unpinned extra source bytes')
    require(observed['executed'] is True and observed['unsupported']==[] and observed['reasons']==[] and observed['workspaceIssues']==[],'actual ordinary System component is incomplete or reports unsupported/refused context')
    require(observed['status']=='development_observation_not_qualification','actual ordinary System component status shape differs')
    mappings=observed['workspaceMappings'];require(isinstance(mappings,dict) and all(isinstance(k,str) and isinstance(v,str) for k,v in mappings.items()),'actual ordinary System mappings shape differs')
    require(observed['request_descriptor_id']==request_id and observed['producer_artifact_id']=='sha256:'+artifact_sha256,'actual System response request/artifact differs')
    results=observed['results'];require(isinstance(results,list) and len(results)==len(paths) and len({r['path'] for r in results})==len(results),'actual System result denominator differs')
    by_path={r['path']:r for r in results};require(set(by_path)=={p['path'] for p in pins},'actual System result path differs')
    for pin in pins:
        result=by_path[pin['path']];require(result['operation']=='read_file' and result['executed'] is True and result['unsupported']==[] and result['refusals']==[] and type(result['found']) is bool and result['found'] is pin['present'],'actual System read state differs from physical acquisition')
        if pin['present']:
            require(result['value']==actual_files[pin['path']] and result['contentId']==pin['content_sha256'] and result['physicalPath']==pin['path'],'actual System read bytes/physical identity differ')
        else:require(result['value'] is None and result['contentId'] is None and result['physicalPath'] is None,'absent System read invents bytes')
    return {'request_descriptor_id':request_id,'pins':pins,'actual_physical_source_count':len(actual_files),'retained_map_modified':False,'sdk_consumed_claimed':False,'workspace_mappings_used_for_acceptance':False,'bounded_sequential_not_atomic':True}
