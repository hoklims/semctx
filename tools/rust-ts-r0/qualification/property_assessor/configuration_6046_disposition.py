"""Read-only scoped code6046 proof. Raw public MISMATCH is never rewritten.

configuration_6046_disposition(repo_root,evidence_root,report,fixture,plan)
records only the exact frozen installed-config/code6046 property. A second
valid-workspace execution is not a frozen prerequisite. Evidence root contains
public/outcomes. No PASS, qualification or blanket message waiver is issued.
"""
import hashlib
import json
import re
from pathlib import Path

MAIN = '923a03767cd5f675c66f4a35b458dcd6f38554fe3c41f90f5a83eebc7292ddc6'
AUTH = '60e3cf74c75f2733476ddfc721b54a4b7cd9e5e7dbff6745205b0eaed6d0fba5'
VECTOR = '86150950298739a48086a86e59beaea31032c2c4c25f4e2e9ce4115792cf807e'
TEST = 'affa90a74bd0b547db5da4c8fb2e88e6a3183dc570894aa0df63d007e4687393'
PREFIX = 'SOURCE_CONFIGURATION_INVALID:6046:'
CHOICES = re.compile(r"^SOURCE_CONFIGURATION_INVALID:6046:Argument for '--module' option must be: ('[a-z0-9]+'(?:, '[a-z0-9]+')*)\.$")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical_id(value):
    return 'sha256:' + sha(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8'))


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read(path, expected=None):
    path = Path(path).resolve()
    data = path.read_bytes()
    require(expected is None or sha(data) == expected, 'sealed file differs: ' + str(path))
    return json.loads(data), {'path': str(path), 'sha256': sha(data)}


def loaded(value):
    return read(value)[0] if isinstance(value, (str, Path)) else value


def one(rows, predicate):
    found = [row for row in rows if predicate(row)]
    require(len(found) == 1, 'exact scoped identity absent or duplicated')
    return found[0]


def capture(prepared, key, evidence, fixture, sdk):
    directory = evidence / 'public/outcomes' / key
    record, record_ref = read(directory / 'bridge-evidence.json')
    request, request_ref = read(directory / 'request.json')
    outcome, outcome_ref = read(directory / 'process-outcome.json')
    require(record.get('binding_verified') is True and record['outcome'] == outcome, 'native bridge binding absent/differs')
    require(outcome['kind'] == 'success' and outcome['exit_code'] == 0 and outcome['stderr'] == '', 'native process not clean success')
    for stream in ['stdout', 'stderr']:
        data = outcome[stream].encode('utf-8')
        require(outcome[stream + '_bytes'] == len(data) and outcome[stream + '_hash'] == sha(data), 'native stream hash/length differs')
    native = json.loads(outcome['stdout'])
    binding = record['binding']
    require(request == prepared['request'], 'request differs from prepared exact input')
    request_id = canonical_id(request)
    require(binding['request_descriptor_id'] == request_id == native['request_id'], 'request binding differs')
    require(binding['producer_artifact_id'] == native['producer_artifact_id'] == 'sha256:' + fixture['artifact_sha256'], 'artifact binding differs')
    require(binding['sdk_input_id'] == canonical_id(sdk), 'SDK binding differs')
    native_binding = binding['validated']['native_binding']
    require(native_binding['request_id'] == request_id and native_binding['input_manifest_id'] == native['input_manifest_id']
        and native_binding['artifact_sha256'] == fixture['artifact_sha256'], 'input manifest binding differs')
    require(binding['capture_stream_sha256'] == prepared['source_capture_stream_sha256'], 'capture stream binding differs')
    read_paths = binding['validated']['read_provenance']['read_paths']
    for probe in native['capture_probes']:
        if probe['operation'] == 'read_file' and probe.get('found') is True:
            path = probe['path']
            text = request['files'].get(path, sdk['files'].get(path))
            require(isinstance(text, str) and probe.get('content_id') == 'sha256:' + sha(text.encode('utf-8'))
                and path in read_paths, 'successful native read lacks supplied byte join')
    return native, request, record, [record_ref, request_ref, outcome_ref]


def component(native, target, prepared):
    relative = target.removeprefix(prepared['repository_root'].rstrip('/') + '/')
    subject = one(native['subjects'], lambda row: row['path'] == relative)
    result = subject['moduleConfigurationObservations']['ordinaryWithoutSnapshot']
    require(result['executed'] is True and result['unsupported'] == [], 'configuration component incomplete')
    return result['reasons']


def configuration_6046_disposition(repo_root, evidence_root, report, fixture, plan):
    answer = {'state': 'UNKNOWN', 'raw_public_mismatch_preserved': True, 'read_refs': [],
        'required_code_property_observation': None, 'message_disposition': None, 'missing': []}
    try:
        report, fixture, plan = loaded(report), loaded(fixture), loaded(plan)
        evidence = Path(evidence_root).resolve()
        cases = Path(repo_root).resolve() / 'docs/research/rust-ts-r0/cases'
        authority, authority_ref = read(cases / 'qualification/obligations.json', AUTH)
        for index in range(223, 229):
            require(authority['obligations'][index]['cumulative_properties'][1]['property'] ==
                'installed dependency emits invalid module6046 instead of workspace default', 'required property scope differs')
        frozen = cases / 'supplement-v2'
        manifest, manifest_ref = read(frozen / 'manifest-sha256.json', MAIN)
        indexed = {row['path']: row for row in manifest['files']}
        relative = 'authority/packages/ts-analyzer/test/workspace-configuration-links.test.ts'
        require(indexed[relative]['sha256'] == TEST, 'baseline assertion identity differs')
        test_path = frozen / relative
        test_bytes = test_path.read_bytes()
        require(sha(test_bytes) == TEST and b'reason.startsWith("SOURCE_CONFIGURATION_INVALID:6046")' in test_bytes,
            'exact baseline code-prefix assertion absent')
        vector, vector_ref = read(frozen / 'public-vectors/workspace-boundaries-01.json', VECTOR)
        require(indexed['public-vectors/workspace-boundaries-01.json']['sha256'] == VECTOR, 'expected vector seal differs')
        expected = vector['operations'][0]['normalizedProjection']
        require(isinstance(expected, list) and len(expected) == 1 and isinstance(expected[0], str)
            and expected[0].startswith(PREFIX), 'frozen expected projection is not singleton6046')
        fixture_sdk = Path(fixture['sdk_path'])
        sdk_path = fixture_sdk if fixture_sdk.is_file() else evidence.parent / 'sdk-input.json'
        sdk, sdk_ref = read(sdk_path, fixture['sdk_sha256'])
        row = one(report['public']['rows'], lambda item: item['id'] == 'workspace-boundaries-01')
        observed = one(row['observations'], lambda item: item['sequence'] == 1)
        require(row['state'] == 'CONSUMER_OUTPUT_MISMATCH' and observed['status'] == 'MISMATCH'
            and observed['parent'] is None, 'raw whole-message mismatch is not the exact expected state')
        require(observed['expected_ref']['sha256'] == VECTOR and observed['expected_ref']['json_pointer'] ==
            '/operations/0/normalizedProjection', 'reported frozen expectation reference differs')
        actual = observed['projection']
        require(isinstance(actual, list) and len(actual) == 1 and isinstance(actual[0], str)
            and actual[0].startswith(PREFIX) and actual != expected, 'actual reasons are not only singleton6046 text difference')
        expected_choices, actual_choices = CHOICES.fullmatch(expected[0]), CHOICES.fullmatch(actual[0])
        require(expected_choices is not None and actual_choices is not None,
            'difference is not confined to the module-choice message list')
        row_plan = one(plan['rows'], lambda item: item['id'] == 'workspace-boundaries-01')
        operation = one(row_plan['operations'], lambda item: item['sequence'] == 1 and item['parent'] is None)
        invocation = one(plan['invocations'], lambda item: item['key'] == operation['invocation_key'])
        prepared = invocation['prepared']
        require(prepared['baseline_function'] == 'inspectModuleConfiguration' and prepared['configuration_component'] ==
            'ordinaryWithoutSnapshot', 'different consumer/component selected')
        native, request, record, refs = capture(prepared, invocation['key'], evidence, fixture, sdk)
        require(component(native, prepared['target_path'], prepared) == actual, 'reported reason differs from actual native component')
        require(observed['native_invocation_id'] == record['native_invocation_id'], 'native invocation reference differs')
        installed = one(list(request['files']), lambda path: path.endswith('/node_modules/@fixture/config/tsconfig/node.json'))
        require(json.loads(request['files'][installed]) == {'compilerOptions': {'module': 'NotAModule'}}, 'installed invalid config differs')
        config_root = installed.split('/node_modules/@fixture/config/')[0]
        root_config = config_root + '/tsconfig.json'
        installed_package = config_root + '/node_modules/@fixture/config/package.json'
        require(json.loads(request['files'][root_config]) == {'extends': '@fixture/config/tsconfig/node.json'},
            'consumed root configuration resolution request differs')
        package = json.loads(request['files'][installed_package])
        require(package['exports']['./tsconfig/node.json'] == './tsconfig/node.json',
            'installed package export resolution differs')
        for path in [root_config, installed_package]:
            require(any(probe['operation'] == 'read_file' and probe.get('found') is True and probe['path'] == path
                for probe in native['capture_probes']), 'resolution closure read absent')
        require(any(probe['operation'] == 'read_file' and probe.get('found') is True and probe['path'] == installed
            for probe in native['capture_probes']), 'installed invalid config was not actually read')
        require(not any(probe['operation'] == 'read_file' and probe.get('found') is True and
            probe['path'].endswith('/tooling/config/tsconfig/node.json') for probe in native['capture_probes']),
            'workspace default was consumed instead of installed config')
        answer['read_refs'] = [authority_ref, manifest_ref, vector_ref, sdk_ref,
            {'path': str(test_path), 'sha256': TEST}, *refs]
        answer['required_code_property_observation'] = {'state': 'OBSERVED_SINGLE_CODE_6046_AND_INSTALLED_BYTE_PRECEDENCE',
            'coordinates': [{'obligation_index': i, 'property_index': 1} for i in range(223, 229)],
            'authority_pointer': '/obligations/223/cumulative_properties/1',
            'baseline_assertion_id': 'T00-DEVREF-9ae0877bed76', 'raw_result_id': 'workspace-boundaries-01', 'sequence': 1,
            'installed_config_path': installed, 'expected_full_message': expected[0], 'actual_full_message': actual[0]}
        answer['state'] = 'SCOPED_CODE_AND_PRECEDENCE_OBSERVATIONS_RECORDED'
        answer['message_disposition'] = 'additional_message_version_difference'
        answer['disposition_scope'] = {'id': 'workspace-boundaries-01', 'sequence': 1,
            'only_difference': 'module option choices within diagnostic message',
            'whole_public_match_claimed': False, 'qualification_credit': 0}
        # This separate observation is informative, never a prerequisite or proof
        # substitute for the six exact installed-dependency properties above.
        try:
            control_plan = one(plan['rows'], lambda item: item['id'] == 'workspace-boundaries-03')
            control_op = one(control_plan['operations'], lambda item: item['sequence'] == 4)
            control_inv = one(plan['invocations'], lambda item: item['key'] == control_op['invocation_key'])
            control_native, control_request, _, control_refs = capture(control_inv['prepared'], control_inv['key'], evidence, fixture, sdk)
            control_target = control_request['roots'][0]
            answer['read_refs'].extend(control_refs)
            control_relative = control_target.removeprefix(control_inv['prepared']['repository_root'].rstrip('/') + '/')
            control_subject = one(control_native['subjects'], lambda row: row['path'] == control_relative)
            answer['optional_control_observation'] = {'id': 'workspace-boundaries-03', 'sequence': 4,
                'ordinary_component': control_subject['moduleConfigurationObservations']['ordinaryWithoutSnapshot'],
                'graph_match_is_not_configuration_proof': True, 'not_required_for_this_property': True}
        except (KeyError, ValueError, TypeError, OSError, StopIteration) as error:
            answer['optional_control_observation'] = {'unavailable': str(error), 'not_required_for_this_property': True}
    except (KeyError, ValueError, TypeError, OSError, StopIteration) as error:
        answer['missing'].append(str(error))
    return answer
