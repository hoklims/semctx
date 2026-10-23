import hashlib
import json
import os
import pathlib
import subprocess
import sys

def sha(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def canonical_digest(value):
    return 'sha256:' + hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def configuration_context_valid(observed, sdk):
    component = observed.get('configuration', {})
    return (observed.get('executed') is True and observed.get('unsupported') == []
            and component.get('executed') is True and component.get('unsupported') == []
            and observed.get('sdk_input_id') == canonical_digest(sdk))


def validate_oracle(oracle):
    units = oracle.get('units')
    if not isinstance(units, list) or not units:
        raise ValueError('WORKSPACE_ORACLE_INVALID: empty units')
    ids = [unit.get('id') for unit in units]
    if any(not isinstance(name, str) or not name or '/' in name or name in {'.', '..'} for name in ids) or len(set(ids)) != len(ids):
        raise ValueError('WORKSPACE_ORACLE_INVALID: duplicate or invalid unit id')
    for unit in units:
        queries, results = unit.get('queries'), unit.get('results')
        if not isinstance(queries, list) or not queries or not isinstance(results, list) or len(queries) != len(results):
            raise ValueError('WORKSPACE_ORACLE_INVALID: query/result denominator')
        for query, result in zip(queries, results, strict=True):
            if not isinstance(query, dict) or not isinstance(result, dict) or query.get('operation') not in {'file_exists', 'directory_exists', 'read_file', 'realpath'} or not isinstance(query.get('path'), str) or not query['path'].startswith('/'):
                raise ValueError('WORKSPACE_ORACLE_INVALID: query shape')
            if any(result.get(key) != query[key] for key in ['operation', 'path']) or 'value' not in result:
                raise ValueError('WORKSPACE_ORACLE_INVALID: result/query binding')


def main():
    oracle_path, freeze_path, output_directory = map(pathlib.Path, sys.argv[1:])
    oracle = json.loads(oracle_path.read_bytes())
    validate_oracle(oracle)
    output_directory.mkdir(parents=True, exist_ok=False)
    freeze = json.loads(freeze_path.read_bytes())

    for key in ['artifact', 'sdk']:
        if sha(freeze[key + '_path']) != freeze[key + '_sha256']:
            raise RuntimeError('frozen artifact mismatch: ' + key)

    reports = []
    for unit in oracle['units']:
        root = unit['root']
        request = {'profile':'workspace', 'root':root, 'case_sensitive':oracle['authority']['caseSensitive'], 'files':unit['files'], 'queries':unit['queries']}
        request_path = output_directory / (unit['id'] + '-system-request.json')
        request_path.write_text(json.dumps(request, indent=2) + '\n')
        process = subprocess.run([freeze['artifact_path'], '--observe-system', str(request_path)], capture_output=True, text=True, timeout=40, check=True)
        observed = json.loads(process.stdout)
        (output_directory / (unit['id'] + '-system-observed.json')).write_text(process.stdout)
        checks = []
        def check(name, actual, expected, *, destination=checks):
            destination.append({'name':name, 'actual':actual, 'expected':expected, 'pass':actual == expected})
        check('system-executed', observed.get('executed'), True)
        check('system-unsupported', observed.get('unsupported'), [])
        check('producer-artifact', observed.get('producer_artifact_id'), 'sha256:' + freeze['artifact_sha256'])
        check('system-request-binding', observed.get('request_descriptor_id'), 'sha256:' + hashlib.sha256(json.dumps(request, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest())
        check('query-denominator', len(observed.get('results', [])), len(unit['queries']))
        for index, expected in enumerate(unit['results']):
            actual = observed['results'][index]
            for key in ['operation', 'path', 'value']:
                check(f'query-{index}-{key}', actual.get(key), expected[key])
            check(f'query-{index}-executed', actual.get('executed'), True)
            check(f'query-{index}-unsupported', actual.get('unsupported'), [])
            if expected['operation'] == 'read_file' and expected['value'] is not None:
                digest = 'sha256:' + hashlib.sha256(expected['value'].encode()).hexdigest()
                check(f'query-{index}-contentId', actual.get('contentId'), digest)
                matching = [p for p in observed['probes'] if p.get('operation') == 'read_file' and p.get('found') is True and p.get('content_id') == digest and p.get('path') == actual.get('physicalPath')]
                check(f'query-{index}-successful-read-bound', len(matching) >= 1, True)
        if unit['id'] == 'above-repository-declaration-blocked':
            check('above-repository-no-alias', observed.get('workspaceMappings'), {})
            check('above-repository-no-successful-read', [p for p in observed['probes'] if p.get('found') is True and p.get('operation') == 'read_file' and not p.get('path', '').startswith(root + '/')], [])
            check('above-repository-oracle-inputs-contained', [p for p in unit['systemInputs'] if not p['path'].startswith(root + '/') and p['value'] is not None], [])
        if 'reasons' in unit:
            configured = {'root':root,'sdk_directory':'/sdk/lib','case_sensitive':oracle['authority']['caseSensitive'],'files':{p:t for p,t in unit['files'].items() if p.startswith(root + '/')},'directories':[], 'containing_file':root + '/src/specimen.js','specifier':'./missing'}
            configured_path = output_directory / (unit['id'] + '-configuration-request.json')
            configured_path.write_text(json.dumps(configured, indent=2) + '\n')
            environment = dict(os.environ, GOPORT_LIB_PARSE_SNAPSHOT='0', GOPORT_LIB_SNAPSHOT='0')
            process = subprocess.run([freeze['artifact_path'],'--observe-configured-resolution',str(configured_path),freeze['sdk_path']], capture_output=True,text=True,timeout=40,check=True,env=environment)
            configuration = json.loads(process.stdout)
            (output_directory / (unit['id'] + '-configuration-observed.json')).write_text(process.stdout)
            check('configured-context', configuration_context_valid(configuration, json.loads(pathlib.Path(freeze['sdk_path']).read_bytes())), True)
            check('configured-request-binding', configuration.get('request_descriptor_id'), 'sha256:' + hashlib.sha256(json.dumps(configured, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest())
            check('configured-producer', configuration.get('producer_artifact_id'), 'sha256:' + freeze['artifact_sha256'])
            target = root + ('/node_modules/@public/config/base.json' if unit['id'] == 'installed-invalid-module' else '/config/base.json')
            digest = 'sha256:' + hashlib.sha256(unit['files'][target].encode()).hexdigest()
            check('configured-owning-read-bound', any(p.get('operation') == 'read_file' and p.get('path') == target and p.get('found') is True and p.get('content_id') == digest for p in configuration['probes']), True)
            check('configured-executed',configuration.get('executed'),True)
            check('configured-reasons',configuration.get('configuration',{}).get('reasons'),unit['reasons'])
            check('configured-unsupported',configuration.get('configuration',{}).get('unsupported'),[])
        reports.append({'id':unit['id'],'pass':all(c['pass'] for c in checks),'checks':checks})
    for key in ['artifact', 'sdk']:
        if sha(freeze[key + '_path']) != freeze[key + '_sha256']:
            raise RuntimeError('frozen artifact changed: ' + key)
    summary = {'schemaVersion':1,'platform':sys.platform,'oracleSha256':sha(oracle_path),'freezeSha256':sha(freeze_path),'artifactSha256':freeze['artifact_sha256'],'sdkSha256':freeze['sdk_sha256'],'units':reports,'pass':all(r['pass'] for r in reports),'formalR0Qualified':False}
    (output_directory / 'result.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps({'pass':summary['pass'],'units':[{ 'id':u['id'],'pass':u['pass'],'failures':[c for c in u['checks'] if not c['pass']]} for u in reports]}, indent=2))


if __name__ == '__main__':
    main()
