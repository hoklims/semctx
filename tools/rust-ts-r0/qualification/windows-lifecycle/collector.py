"""Prepare locked Git fixture inputs and retain supplied command observations.

The CLI only produces a dry receipt. It has no Windows transport or authority
input. The recording function is exercised using a synthetic transport.
"""

import argparse
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path, PureWindowsPath
import sys

SOURCE_HEAD = '04b83a5f394431e1dcca533889f6c02e32d02a0d'
SOURCE_TREE = 'e47e1edca82d708eccda6e2290fbdceb682bf66e'
PINS = {
    'preflight': '9e3c2579c36494d27ff9d459214e17dc1e421e64d738aec3c98548142b5bf6c2',
    'public_plan': '96ce9443c651ec2360d0112c4ff8c52502287787326fb82279706698e7a7a6fb',
    'source_snapshot': '65d8aafc04bce81ab09e9c7576fc25e765e270efc60824bc3731f88842ded2a5',
}
DISABLED = {
    'execution_authorized': False,
    'candidate_execution_authorized': False,
    'native_execution_verified': False,
    'qualification_credit': 0,
    'r0_decision': None,
}


@dataclass(frozen=True)
class CommandObservation:
    argv: tuple[str, ...]
    cwd: str
    exit_code: int
    stdout: bytes
    stderr: bytes
    timed_out: bool = False
    complete_capture: bool = True
    elapsed_milliseconds: int | None = None


def sha(data):
    return hashlib.sha256(data).hexdigest()


def byte_identity(data):
    return {'bytes': len(data), 'sha256': sha(data)}


def write_new(path, data):
    with path.open('xb') as stream:
        stream.write(data)


def write_json(path, value):
    write_new(path, (json.dumps(value, indent=2, ensure_ascii=True) + '\n').encode('utf-8'))


def load_locked(inputs):
    records = {}
    for key, expected in PINS.items():
        data = inputs[key].read_bytes()
        if sha(data) != expected:
            raise ValueError(f'{key} SHA-256 differs')
        records[key] = json.loads(data)
    preflight = records['preflight']
    for key, value in DISABLED.items():
        if preflight[key] != value:
            raise ValueError(f'preflight field differs: {key}')
    if (preflight['kind'] != 'WINDOWS_LIFECYCLE_SETUP_PLAN_DISABLED'
            or preflight['source_head'] != SOURCE_HEAD
            or records['source_snapshot']['head'] != SOURCE_HEAD
            or records['source_snapshot']['status'] != ''):
        raise ValueError('frozen source identity differs')
    root = preflight['path_budget_initial_files_only']['root']
    planned = {item['key']: item for item in records['public_plan']['invocations']
               if item['key'].startswith('lifecycle-')}
    fixtures = []
    for group in preflight['groups']:
        key = group['invocation_key']
        source = planned[key]['prepared']['physical_files']
        files = {}
        for file in group['files']:
            relative = file['input_json_key']
            data = source[relative].encode('utf-8')
            if (file['sha256'] != sha(data) or file['bytes'] != len(data)
                    or file['path'] != f"{group['workspace']}/{relative}"):
                raise ValueError(f'frozen fixture input differs: {key}/{relative}')
            files[relative] = data
        if files.keys() != source.keys():
            raise ValueError(f'frozen fixture file set differs: {key}')
        fixtures.append({
            'key': key,
            'cwd': str(PureWindowsPath(root, group['workspace'])),
            'files': files,
            'steps': group['steps'],
        })
    if len(fixtures) != 23 or len(planned) != 23 or sum(len(row['files']) for row in fixtures) != 70:
        raise ValueError('frozen fixture denominator differs')
    return fixtures


def stage_matches(fixture, observed):
    expected = {
        str(PureWindowsPath(fixture['cwd'], relative)): byte_identity(data)
        for relative, data in fixture['files'].items()
    }
    actual = {item['path']: {'bytes': item['bytes'], 'sha256': item['sha256']} for item in observed['files']}
    return (observed['fresh'] is True and observed['cwd'] == fixture['cwd']
            and len(actual) == len(observed['files']) and actual == expected)


def rejection(step, cwd, observation):
    if observation.cwd != cwd:
        return 'CWD_DIFFERS'
    if (not observation.argv or observation.argv[1:] != tuple(step['argv'][1:])
            or not PureWindowsPath(observation.argv[0]).is_absolute()
            or PureWindowsPath(observation.argv[0]).name.casefold() != 'git.exe'):
        return 'ARGV_DIFFERS'
    if observation.timed_out is not False or observation.complete_capture is not True:
        return 'CAPTURE_INCOMPLETE'
    if type(observation.exit_code) is not int or observation.exit_code != 0:
        return 'COMMAND_FAILED'
    if step['id'].startswith('git-fixture-'):
        expected = step.get('expected_stdout_stripped')
        stdout_ok = observation.stdout == b'' if expected is None else observation.stdout.strip() == expected.encode()
        if not stdout_ok or observation.stderr:
            return 'LOCAL_CONFIG_DIFFERS'
    return None


def collect_fixture(fixture, output, transport):
    """Record an injected transport; the CLI never calls this function."""
    output.mkdir()
    stage = transport.stage(fixture['cwd'], fixture['files'].copy())
    write_json(output / 'workspace.json', stage)
    receipt = {
        'kind': 'WINDOWS_GIT_LIFECYCLE_COMMAND_CAPTURE',
        'key': fixture['key'],
        'planned_cwd': fixture['cwd'],
        'observation_origin': 'supplied_transport',
        'steps': [],
        **DISABLED,
    }
    if not stage_matches(fixture, stage):
        receipt.update(status='REFUSED', failed_step='materialize_initial_files',
                       reason='WORKSPACE_DIFFERS')
    else:
        receipt['status'] = 'CAPTURED'
        for step in fixture['steps'][1:]:
            label = step['id']
            observation = transport.run(label, tuple(step['argv']), fixture['cwd'])
            write_new(output / f'{label}.stdout', observation.stdout)
            write_new(output / f'{label}.stderr', observation.stderr)
            command = {
                'id': label,
                'planned_argv': step['argv'],
                'argv': list(observation.argv),
                'cwd': observation.cwd,
                'exit_code': observation.exit_code,
                'timed_out': observation.timed_out,
                'complete_capture': observation.complete_capture,
                'elapsed_milliseconds': observation.elapsed_milliseconds,
                'stdout': byte_identity(observation.stdout),
                'stderr': byte_identity(observation.stderr),
            }
            failure = rejection(step, fixture['cwd'], observation)
            command['refusal_reason'] = failure
            write_json(output / f'{label}.json', command)
            receipt['steps'].append(command)
            if failure:
                receipt.update(status='REFUSED', failed_step=label, reason=failure)
                break
    write_json(output / 'capture.json', receipt)
    return receipt


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute-native', action='store_true')
    for key in ('preflight', 'public-plan', 'source-snapshot', 'output'):
        parser.add_argument('--' + key, type=Path)
    args = parser.parse_args(argv)
    if args.execute_native:
        print('NATIVE_LIFECYCLE_DISABLED', file=sys.stderr)
        return 2
    inputs = {key: getattr(args, key) for key in PINS}
    if not all(inputs.values()) or args.output is None:
        parser.error('dry mode requires --preflight, --public-plan, --source-snapshot and --output')
    try:
        fixtures = load_locked(inputs)
        write_json(args.output, {
            'kind': 'WINDOWS_LIFECYCLE_COLLECTOR_DRY_RECEIPT',
            'source_head': SOURCE_HEAD,
            'source_tree': SOURCE_TREE,
            'input_bindings': {
                key: {'path': str(inputs[key].resolve()), 'sha256': digest} for key, digest in PINS.items()
            },
            'invocations': [{'key': row['key'], 'planned_cwd': row['cwd'],
                             'steps': [step['id'] for step in row['steps']],
                             'file_count': len(row['files'])} for row in fixtures],
            'git_commands_executed': 0,
            'native_queries_performed': 0,
            **DISABLED,
        })
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
