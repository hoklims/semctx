"""Exact submitted-file epoch validators, extracted before final native outcomes."""
import hashlib,json,importlib.util,types
from pathlib import Path
def sha(v):return hashlib.sha256(v).hexdigest()
def read(path,expected=None):
    p=Path(path).resolve();b=p.read_bytes()
    if expected is not None and sha(b)!=expected:raise ValueError('pinned input differs: '+str(p))
    return json.loads(b),{'document':str(p),'sha256':sha(b),'bytes':len(b)}
def pointer(v,path):
    for k in path.strip('/').split('/') if path else []:
        k=k.replace('~1','/').replace('~0','~');v=v[int(k)] if isinstance(v,list) else v[k]
    return v
supplemental=types.SimpleNamespace(sha=sha,read=read,pointer=pointer)
def require(condition, message):
    if not condition:
        raise ValueError(message)

def read_pin(pin):
    require(isinstance(pin, dict) and isinstance(pin.get('sha256'), str), 'input requires explicit path/hash pin')
    return supplemental.read(pin['path'], pin['sha256'])

def validate_host_epoch(host, expected_head, platform):
    """Completeness/consistency checks, not authentication of arbitrary receipts."""
    documents = {}
    references = {}
    for phase, fields in [('original', ['report', 'freeze', 'recipes']),
                          ('supplement', ['report', 'fixture', 'registry', 'addenda', 'plan']),
                          ('source', ['before', 'after'])]:
        for field in fields:
            name = phase + '.' + field
            documents[name], references[name] = read_pin(host[phase][field])
    before, after = documents['source.before'], documents['source.after']
    require(before.get('head') == after.get('head') == expected_head, 'source epoch differs from final requested HEAD')
    require(before.get('status') == after.get('status') == '', 'source snapshot is dirty')
    require(before == after, 'source files or snapshot metadata changed across native campaign')
    freeze, fixture = documents['original.freeze'], documents['supplement.fixture']
    require(freeze['source_head'] == fixture['source_head'] == expected_head, 'fixture source epoch differs')
    require(str(freeze['platform']).casefold() == platform, 'original native platform differs')
    require(fixture['platform'] == platform, 'supplement native platform differs')
    require(freeze['optimized_frozen'] is True and fixture['optimized_frozen'] is True, 'actual optimized freeze missing')
    for key in ['artifact_sha256', 'helper_sha256', 'sdk_sha256']:
        require(freeze[key] == fixture[key], 'original and supplement use different actual bytes: ' + key)
    for key in ['artifact_sha256', 'helper_sha256']:
        require(documents['original.report'][key] == freeze[key], 'original report artifact binding differs')
    require(references['original.recipes']['sha256'] == freeze['recipes_sha256'], 'original frozen recipe bytes differ')
    require(len(documents['original.report']['units']) == 354 and len(documents['original.report']['supports']) == 51,
        'original354/51 denominator differs')
    receipts = host.get('build_receipts', [])
    require(receipts, 'actual source/build command receipts missing')
    for pin in receipts:
        receipt, reference = read_pin(pin)
        code = receipt.get('exitCode')
        require(type(code) is int and code == 0 and receipt.get('timedOut') is False, 'required native build command failed/missing exit')
        references['build.' + str(len(references))] = reference
    byte_joins = []
    for key in ['artifact', 'helper', 'sdk', 'qualification_observer']:
        pin = host['artifact_files'][key]
        raw = Path(pin['path']).read_bytes()
        require(supplemental.sha(raw) == pin['sha256'] == fixture[key + '_sha256'], 'actual artifact byte join differs: ' + key)
        byte_joins.append({'kind': key, **pin, 'bytes': len(raw)})
    return documents, {'source_head': expected_head, 'platform': platform, 'references': references,
        'actual_artifact_byte_joins': byte_joins, 'receipt_authentication_claimed': False,
        'scope': 'Exact submitted files and consistent actual source/build receipts; no hardware attestation.'}

def scoped_dispositions(cases, host, documents):
    repo = Path(cases).resolve().parents[3]
    evidence = Path(host['supplement']['evidence_root'])
    result = {'additional_digest': [], 'configuration_6046': {'state': 'UNKNOWN'}, 'module_refs': []}
    for name, function in [('additional_digest_dispositions', 'additional_digest_dispositions'),
                           ('configuration_6046_disposition', 'configuration_6046_disposition')]:
        path = Path(__file__).resolve().parent / (name + '.py')
        before = path.read_bytes()
        spec = importlib.util.spec_from_file_location('final_join_' + name, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        args = [repo, evidence, documents['supplement.report'], documents['supplement.fixture']]
        if name == 'configuration_6046_disposition':
            args.append(documents['supplement.plan'])
        try:
            value = getattr(module, function)(*args)
            result['additional_digest' if name == 'additional_digest_dispositions' else 'configuration_6046'] = value
        except (ValueError, KeyError, TypeError, OSError) as error:
            result[name + '_unproven'] = str(error)
        require(path.read_bytes() == before, 'scope disposition code changed during import')
        result['module_refs'].append({'path': str(path), 'sha256': supplemental.sha(before)})
    return result
