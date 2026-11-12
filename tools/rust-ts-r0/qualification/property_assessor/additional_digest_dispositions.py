"""Read-only exact digest-byte dispositions. Never changes a raw result or credit.

API: additional_digest_dispositions(repo_root, source_evidence_root, report, fixture)
accepts report/fixture mappings or JSON paths and returns only ten narrowly bound
additional_noncontract dispositions. Missing or malformed evidence fails closed.
"""
import hashlib
import json
import re
from pathlib import Path

MAIN_SEAL = '923a03767cd5f675c66f4a35b458dcd6f38554fe3c41f90f5a83eebc7292ddc6'
EXPECTED_SEAL = '0b9a4f67814e857654aa9c0aa75a275b4007bfe055ba6f87c4a1e937238212f2'
AUTHORITY_SEALS = {
    'qualification/obligations.json': '60e3cf74c75f2733476ddfc721b54a4b7cd9e5e7dbff6745205b0eaed6d0fba5',
    'sources/outline-cases.json': '27364ac7cda5fc8843370999d9726e612f4e8aec8b25f19ab23b924faa86a3e9',
    'sources/ordinary-cases.json': '191713cc12484489a743d007aac7f36306b8724cfdc038dba745a0245adaa52e',
}
PAIRS = ('digest-operator', 'digest-keyword-flags', 'digest-type-keyword', 'digest-raw-template', 'digest-trivia')
IDS = {name + suffix for name in PAIRS for suffix in ('-before', '-after')}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read(path, seal=None):
    path = Path(path).resolve()
    raw = path.read_bytes()
    require(seal is None or digest(raw) == seal, 'sealed document bytes differ: ' + str(path))
    return json.loads(raw), {'path': str(path), 'sha256': digest(raw)}


def value_at(value, pointer):
    for token in pointer[1:].split('/') if pointer else []:
        value = value[int(token)] if isinstance(value, list) else value[token]
    return value


def diff(left, right, at=''):
    if type(left) is not type(right):
        return [at]
    if isinstance(left, dict):
        return [at + '/' + key for key in left.keys() ^ right.keys()] + [
            path for key in left.keys() & right.keys() for path in diff(left[key], right[key], at + '/' + key)]
    if isinstance(left, list):
        if len(left) != len(right):
            return [at]
        return [path for i, (a, b) in enumerate(zip(left, right, strict=True)) for path in diff(a, b, at + '/' + str(i))]
    return [] if left == right else [at]


def unique(rows):
    indexed = {}
    for i, row in enumerate(rows):
        require(row['id'] not in indexed, 'duplicated digest/report identity')
        indexed[row['id']] = (i, row)
    return indexed


def additional_digest_dispositions(repo_root, source_evidence_root, report, fixture):
    cases = Path(repo_root).resolve() / 'docs/research/rust-ts-r0/cases'
    evidence = Path(source_evidence_root).resolve()
    report = read(report)[0] if isinstance(report, (str, Path)) else report
    fixture = read(fixture)[0] if isinstance(fixture, (str, Path)) else fixture
    authority = {}
    authority_refs = []
    for relative, seal in AUTHORITY_SEALS.items():
        authority[relative], reference = read(cases / relative, seal)
        authority_refs.append(reference)
    clause = authority['qualification/obligations.json']['obligations'][166]
    require(clause['additional_combination_classification']['classification'] ==
        'ADDITIONAL_UNCREDITED_OBSERVABLE_CONTRACT_SCOPE', 'exact digest bytes are not classified additional')
    require(clause['execution_unit_ids'] == ['ORD-OUTLINE-PRIVATE-DIGEST::base'], 'private identifier witness identity differs')
    require(authority['sources/ordinary-cases.json']['cases'][5]['id'] == 'ORD-OUTLINE-PRIVATE-DIGEST', 'private witness source differs')
    require(authority['sources/ordinary-cases.json']['cases'][5]['expected_projection']['exact_digest_bytes'] ==
        'not specified', 'private witness exact digest contract differs')
    require('excluded' in authority['sources/outline-cases.json']['cases'][0]['projection_contract']['digest'], 'outline digest exclusion absent')
    frozen = cases / 'supplement-v2'
    manifest, manifest_ref = read(frozen / 'manifest-sha256.json', MAIN_SEAL)
    member = next(row for row in manifest['files'] if row['path'] == 'expected-additional-observables.json')
    require(member['sha256'] == EXPECTED_SEAL, 'frozen digest expectation seal differs')
    expected, expected_ref = read(frozen / member['path'], EXPECTED_SEAL)
    baselines = {row['id']: (i, row) for i, row in enumerate(expected['results']) if row['id'] in IDS}
    require(set(baselines) == IDS, 'ten frozen digest input IDs differ')
    rows = unique(report['rows'])
    actual = {}
    dispositions = []
    for name in sorted(IDS):
        row_index, row = rows['source::' + name]
        require(row['state'] == 'RAW_NONPASS_PRESERVED' and row.get('gaps') == [], 'raw digest result is not exact preserved NONPASS')
        index, baseline = baselines[name]
        checks = row['mapped_results'][0]['checks']
        require(len(checks) == 1 and checks[0]['target'] == ['outlines', 'main.ts', 'outline']
            and checks[0]['result']['state'] == 'MISMATCH', 'raw digest check shape differs')
        origin = checks[0]['expected_origin']
        require(origin['manifest_sha256'] == MAIN_SEAL and origin['sha256'] == EXPECTED_SEAL
            and origin['path'] == 'expected-additional-observables.json'
            and origin['pointer'] == f'/results/{index}/outline', 'raw digest expectation reference differs')
        directory = evidence / ('source__' + name) / 'observation-000'
        capture, capture_ref = read(directory / 'process-outcome.json')
        request, request_ref = read(directory / 'request.json')
        binding, binding_ref = read(directory / 'verified-input-binding.json')
        require(capture['kind'] == 'success' and capture['exit_code'] == 0 and capture['stderr'] == '', 'native process not clean success')
        for stream in ('stdout', 'stderr'):
            raw = capture[stream].encode('utf-8')
            require(capture[stream + '_bytes'] == len(raw) and capture[stream + '_hash'] == digest(raw), 'native stream hash/length differs')
        native = json.loads(capture['stdout'])
        request_id = 'sha256:' + digest(json.dumps(request, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8'))
        require(request_id == binding['request_id'] == native['request_id'], 'native request binding differs')
        require(native['input_manifest_id'] == binding['input_manifest_id'], 'native input binding differs')
        require(binding['artifact_sha256'] == fixture['artifact_sha256'] and native['producer_artifact_id'] ==
            'sha256:' + fixture['artifact_sha256'], 'native artifact binding differs')
        require(request['id'] == 'supplement-source-' + name and len(request['files']) == 1 and
            list(request['files'].values()) == [baseline['source']], 'native request source bytes differ')
        outline = native['outlines']['main.ts']['outline']
        changed = sorted(diff(outline, baseline['outline']))
        require(changed and all(re.fullmatch(r'/statements/\d+/digest', path) for path in changed),
            'non-digest outline field differs')
        for path in changed:
            require(re.fullmatch('[0-9a-f]+', value_at(outline, path)) is not None and
                re.fullmatch('[0-9a-f]+', value_at(baseline['outline'], path)) is not None, 'digest value is not hexadecimal')
        actual[name] = outline['statements'][0]['digest']
        dispositions.append({'id': 'source::' + name, 'disposition': 'additional_noncontract',
            'raw_state_preserved': 'RAW_NONPASS_PRESERVED', 'raw_check_state_preserved': 'MISMATCH',
            'different_paths': changed, 'report_pointer': f'/rows/{row_index}',
            'expected_pointer': f'/results/{index}/outline',
            'read_refs': [capture_ref, request_ref, binding_ref, expected_ref, manifest_ref, *authority_refs],
            'authority_pointer': '/obligations/166/additional_combination_classification',
            'does_not_dispose_private_identifier_property_166_2': True})
    pairs = unique(report['digest_pairs'])
    expected_pairs = unique(expected['digestPairs'])
    require(set(pairs) == set(expected_pairs) == set(PAIRS), 'five exact digest relation IDs differ')
    for name in PAIRS:
        pair_index, pair = pairs[name]
        expected_index, wanted = expected_pairs[name]
        before, after = actual[name + '-before'], actual[name + '-after']
        relation = 'equal' if before == after else 'different'
        require(pair['pass'] is True and pair['actual_before'] == before and pair['actual_after'] == after
            and pair['actual_relation'] == relation == wanted['relation'], 'required digest relation differs')
        origin = pair['expected_ref']
        require(origin['manifest_sha256'] == MAIN_SEAL and origin['sha256'] == EXPECTED_SEAL and
            origin['path'] == 'expected-additional-observables.json' and
            origin['pointer'] == f'/digestPairs/{expected_index}/relation', 'digest relation origin differs')
        for disposition in dispositions:
            if disposition['id'] in ('source::' + name + '-before', 'source::' + name + '-after'):
                disposition['required_relation_report_pointer'] = f'/digest_pairs/{pair_index}'
                disposition['required_relation_checked_from_actual_raw'] = relation
    require(len(dispositions) == 10, 'ten dispositions required')
    return dispositions
