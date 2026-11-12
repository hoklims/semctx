"""Bind owned native builds to their actual passed environment and frozen bytes.

This is sequential evidence acquisition, not an OS sandbox or atomic source seal.
Only whitelisted environment fields are exported; arbitrary flags/paths are hashed.
"""
import hashlib
import json
from pathlib import Path
import subprocess

SAFE = ('RUSTUP_TOOLCHAIN', 'RUST_TEST_THREADS', 'CARGO_BUILD_JOBS', 'CARGO_NET_OFFLINE',
        'GOPORT_LIB_PARSE_SNAPSHOT', 'GOPORT_LIB_SNAPSHOT', 'PYTHONDONTWRITEBYTECODE')
FINGERPRINTED = ('PATH', 'CARGO_HOME', 'RUSTUP_HOME', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS',
                 'RUSTC', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'CARGO_PROFILE_RELEASE_LTO',
                 'CARGO_PROFILE_RELEASE_OPT_LEVEL', 'CC', 'CXX', 'AR', 'CFLAGS', 'CXXFLAGS',
                 'LDFLAGS', 'MACOSX_DEPLOYMENT_TARGET', 'SDKROOT', 'DEVELOPER_DIR')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def sha(path):
    return digest(Path(path).read_bytes())


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def environment_snapshot(env):
    for name in ('GOPORT_BUILD_VERSION', 'GIT_CONFIG_GLOBAL', 'CARGO_TARGET_DIR'):
        require(name not in env, 'native build override must be absent: '+name)
    require(env.get('RUSTUP_TOOLCHAIN') == '1.95.0', 'native build toolchain differs')
    require(env.get('GOPORT_LIB_PARSE_SNAPSHOT') == env.get('GOPORT_LIB_SNAPSHOT') == '0', 'native snapshot mode differs')
    require(env.get('CARGO_NET_OFFLINE') == 'true', 'native build must remain offline')
    for name in ('RUST_TEST_THREADS', 'CARGO_BUILD_JOBS'):
        require(name not in env or (env[name].isdigit() and 0 < int(env[name]) <= 256), 'invalid numeric native build setting: '+name)
    require(env.get('PYTHONDONTWRITEBYTECODE') in (None, '0', '1'), 'invalid Python bytecode setting')
    values = {name: {'present': name in env, 'value': env.get(name)} for name in SAFE}
    fingerprints = {name: {'present': name in env, 'sha256': digest(env[name].encode()) if name in env else None}
                    for name in FINGERPRINTED}
    return {'values': values, 'fingerprints': fingerprints,
            'GOPORT_BUILD_VERSION_present': False, 'GIT_CONFIG_GLOBAL_present': False,
            'CARGO_TARGET_DIR_present': False}


def source_snapshot(repo, expected, env):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(repo), *args], env=env).decode('utf-8').strip()
    head, status = git('rev-parse', 'HEAD'), git('status', '--porcelain=v1', '--untracked-files=all')
    require(head == expected and status == '', 'native build source HEAD/status differs')
    names = git('ls-files', 'tools/gates', 'tools/rust-ts-r0', 'rust-toolchain.toml').splitlines()
    return {'head': head, 'status': status, 'files': {name: sha(repo/name) for name in names}}


def validate_snapshot(value):
    require(set(value) == {'values', 'fingerprints', 'GOPORT_BUILD_VERSION_present',
                           'GIT_CONFIG_GLOBAL_present', 'CARGO_TARGET_DIR_present'}, 'build snapshot fields differ')
    for key in ('GOPORT_BUILD_VERSION_present', 'GIT_CONFIG_GLOBAL_present', 'CARGO_TARGET_DIR_present'):
        require(value[key] is False, 'build override presence differs')
    require(set(value['values']) == set(SAFE) and set(value['fingerprints']) == set(FINGERPRINTED), 'build environment whitelist differs')
    for item in value['values'].values():
        require(set(item) == {'present', 'value'} and type(item['present']) is bool
                and (isinstance(item['value'], str) if item['present'] else item['value'] is None), 'typed build environment value differs')
    for item in value['fingerprints'].values():
        require(set(item) == {'present', 'sha256'} and type(item['present']) is bool, 'typed build environment fingerprint differs')
        require((isinstance(item['sha256'], str) and len(item['sha256']) == 64
                 and all(c in '0123456789abcdef' for c in item['sha256'])) if item['present'] else item['sha256'] is None, 'build environment fingerprint shape differs')
    values = value['values']
    require(values['RUSTUP_TOOLCHAIN']['value'] == '1.95.0'
            and values['CARGO_NET_OFFLINE']['value'] == 'true'
            and values['GOPORT_LIB_PARSE_SNAPSHOT']['value'] == values['GOPORT_LIB_SNAPSHOT']['value'] == '0', 'build environment modes differ')


def validate_argv(repo, label, argv):
    manifests = {'helper-build': 'tools/gates/Cargo.toml', 'observer-build': 'tools/rust-ts-r0/Cargo.toml',
                 'standalone-restore': 'tools/rust-ts-r0/Cargo.toml'}
    prefixes = {
        'helper-build': ['cargo', 'build', '--locked', '--offline', '--release', '--bins', '--manifest-path'],
        'observer-build': ['cargo', 'test', '--locked', '--offline', '--release', '--features', 'qualification-observer',
                           '--test', 'qualification_replay', '--no-run', '--message-format=json', '--manifest-path'],
        'standalone-restore': ['cargo', 'build', '--locked', '--offline', '--release', '--bin', 'semctx-r0-probe', '--manifest-path'],
    }
    require(label in prefixes and argv[:-1] == prefixes[label], 'native build argv differs: '+label)
    require((repo/argv[-1]).resolve() == (repo/manifests[label]).resolve(), 'native build manifest differs')


class NativeBuildIdentity:
    def __init__(self, repo, out, env, source_head, caller):
        self.repo, self.out, self.env = Path(repo).resolve(), Path(out), env
        self.head, self.caller = source_head, Path(caller)
        self.path = self.out/'build_environment.json'
        require(not self.path.exists(), 'build environment receipt already exists')
        self.before = environment_snapshot(env)
        self.source_before = source_snapshot(self.repo, source_head, env)
        self.pins = {name: sha(self.out/name) for name in ['native-compiler-source-identity.json', 'upstream-compiler-core.rs']}
        compiler = json.loads((self.out/'native-compiler-source-identity.json').read_text(encoding='utf-8'))
        require(compiler['source_sha256'] == self.pins['upstream-compiler-core.rs']
                and compiler['GOPORT_BUILD_VERSION_present_in_build_environment'] is False, 'compiler source receipt differs')
        self.helper_sha, self.caller_sha = sha(__file__), sha(self.caller)
        self.compiler_helper = self.repo/'tools/rust-ts-r0/qualification/native_compiler_identity.py'
        self.compiler_helper_sha = sha(self.compiler_helper)
        self.records, self.artifacts = [], {}
        self.flush('before-builds')

    def check(self):
        require(environment_snapshot(self.env) == self.before, 'passed build environment changed')
        require(source_snapshot(self.repo, self.head, self.env) == self.source_before, 'build source bytes changed')
        require(sha(__file__) == self.helper_sha and sha(self.caller) == self.caller_sha, 'build orchestration helper changed')
        require(sha(self.compiler_helper) == self.compiler_helper_sha, 'compiler source identity helper changed')
        require(all(sha(self.out/name) == pin for name, pin in self.pins.items()), 'compiler source identity/core changed')
        for record in self.records:
            require(sha(record['receipt']['path']) == record['receipt']['sha256'], 'recorded native build receipt changed')
            for name in ('stdout', 'stderr'):
                require(sha(record[name]['path']) == record[name]['sha256']
                        and Path(record[name]['path']).stat().st_size == record[name]['bytes'], 'recorded native build stream changed')

    def flush(self, state, fixture=None):
        document = {'kind': 'NATIVE_BUILD_ENVIRONMENT_BINDING_V1', 'state': state, 'source_head': self.head, 'repository': str(self.repo),
                    'source_identity_sha256': self.pins['native-compiler-source-identity.json'],
                    'compiler_core_sha256': self.pins['upstream-compiler-core.rs'],
                    'build_identity_helper_sha256': self.helper_sha,
                    'source_identity_helper_sha256': self.compiler_helper_sha,
                    'source_identity_helper_path': str(self.compiler_helper),
                    'caller': {'path': str(self.caller), 'sha256': self.caller_sha},
                    'GOPORT_BUILD_VERSION_present': False, 'build_environment_before': self.before,
                    'build_environment_after': environment_snapshot(self.env),
                    'source_before': self.source_before,
                    'source_after': source_snapshot(self.repo, self.head, self.env),
                    'builds': [], 'build_commands': len(self.records),
                    'claim': 'Sequential owned-process evidence; no OS isolation or atomic-build guarantee.'}
        for record in self.records:
            kinds = [kind for kind, value in self.artifacts.items() if value['label'] == record['label']]
            for kind in kinds or [None]:
                row = dict(record)
                row.update(artifact_kind=kind, artifact_sha256=self.artifacts[kind]['sha256'] if kind else None)
                document['builds'].append(row)
        if fixture is not None:
            document['artifacts'] = self.artifacts
            for kind in self.artifacts:
                document[kind+'_sha256'] = fixture[kind+'_sha256']
        self.path.write_text(json.dumps(document, indent=2, ensure_ascii=False)+'\n', encoding='utf-8', newline='\n')
        return document

    def run(self, label, argv, executor):
        require(label not in {record['label'] for record in self.records}, 'native build retry refused')
        require(label == ['helper-build', 'observer-build', 'standalone-restore'][len(self.records)], 'native build order differs')
        validate_argv(self.repo, label, argv)
        self.check()
        result = executor(label, argv, self.env)
        self.check()
        receipt_path = self.out/(label+'.receipt.json')
        receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
        require(receipt['argv'] == argv, 'actual native build receipt argv differs')
        if 'exit_code' in receipt:
            require('exitCode' not in receipt, 'ambiguous build exit receipt')
            code, timed = receipt['exit_code'], receipt['timed_out']
        else:
            code, timed = receipt['exitCode'], receipt['timedOut']
        require(type(code) is int and code == 0 and timed is False, 'native build failed or timed out')
        streams = {name: {'path': str(self.out/(label+'.'+name)), 'sha256': sha(self.out/(label+'.'+name)),
                          'bytes': (self.out/(label+'.'+name)).stat().st_size} for name in ['stdout', 'stderr']}
        self.records.append({'label': label, 'argv': argv, 'receipt': {'path': str(receipt_path), 'sha256': sha(receipt_path)},
                             'stdout': streams['stdout'], 'stderr': streams['stderr'], 'exit_code': code,
                             'timed_out': False, 'environment_sha256': digest(canonical(self.before))})
        self.flush('builds-in-progress')
        return result

    def bind_artifact(self, kind, label, path):
        require(kind not in self.artifacts, 'native artifact rebound')
        require({'artifact': 'standalone-restore', 'qualification_observer': 'observer-build',
                 'helper': 'helper-build', 'transport_fixture': 'helper-build'}.get(kind) == label, 'native artifact/build label mismatch')
        require(label in {record['label'] for record in self.records}, 'native artifact lacks successful build')
        path = Path(path)
        if kind == 'qualification_observer':
            messages = [json.loads(line) for line in (self.out/(label+'.stdout')).read_text(encoding='utf-8').splitlines()]
            artifacts = [row['executable'] for row in messages if row.get('reason') == 'compiler-artifact'
                         and row.get('target', {}).get('name') == 'qualification_replay' and row.get('executable')]
            require(len(artifacts) == 1 and Path(artifacts[0]).resolve() == path.resolve(), 'observer not the actual Cargo artifact')
        self.artifacts[kind] = {'label': label, 'source_path': str(path), 'sha256': sha(path), 'bytes': path.stat().st_size}
        self.flush('builds-in-progress')

    def finalize(self, fixture):
        self.check()
        require({record['label'] for record in self.records} == {'helper-build', 'observer-build', 'standalone-restore'}, 'native build sequence incomplete')
        require(set(self.artifacts) == {'artifact', 'qualification_observer', 'helper', 'transport_fixture'}, 'native artifact set incomplete')
        for kind, artifact in self.artifacts.items():
            require(sha(artifact['source_path']) == artifact['sha256'], 'built artifact changed: '+kind)
            require(fixture[kind+'_sha256'] == artifact['sha256'] == sha(fixture[kind+'_path']), 'frozen artifact/build mismatch: '+kind)
        self.flush('frozen', fixture)
        return {'path': str(self.path), 'sha256': sha(self.path)}


def validate_frozen_document(path, fixture, source_head):
    """Readback on the native host; exported receipts are checked independently."""
    path = Path(path)
    value = json.loads(path.read_text(encoding='utf-8'))
    require(value['kind'] == 'NATIVE_BUILD_ENVIRONMENT_BINDING_V1' and value['state'] == 'frozen', 'native build binding incomplete')
    require(value['source_head'] == value['source_before']['head'] == value['source_after']['head'] == source_head, 'build/source HEAD differs')
    require(value['source_before'] == value['source_after'] and not value['source_after']['status'], 'build source snapshot differs')
    require(value['GOPORT_BUILD_VERSION_present'] is False
            and value['build_environment_before'] == value['build_environment_after'], 'build environment snapshot differs')
    validate_snapshot(value['build_environment_before'])
    validate_snapshot(value['build_environment_after'])
    require(value['source_identity_sha256'] == sha(path.parent/'native-compiler-source-identity.json')
            and value['compiler_core_sha256'] == sha(path.parent/'upstream-compiler-core.rs')
            and value['build_identity_helper_sha256'] == sha(__file__), 'native build source/helper pins differ')
    require(sha(value['caller']['path']) == value['caller']['sha256']
            and sha(value['source_identity_helper_path']) == value['source_identity_helper_sha256'], 'native build caller/source helper differs')
    require(value['build_commands'] == 3, 'native build command count differs')
    require([row['label'] for row in value['builds']] == ['helper-build', 'helper-build', 'observer-build', 'standalone-restore'], 'native build receipt order differs')
    for kind in ['artifact', 'qualification_observer', 'helper', 'transport_fixture']:
        rows = [row for row in value['builds'] if row['artifact_kind'] == kind]
        require(len(rows) == 1 and rows[0]['artifact_sha256'] == value[kind+'_sha256'] == fixture[kind+'_sha256'], 'native build artifact binding differs')
        row = rows[0]
        require(row['label'] == {'artifact': 'standalone-restore', 'qualification_observer': 'observer-build',
                                  'helper': 'helper-build', 'transport_fixture': 'helper-build'}[kind], 'native artifact/build label differs')
        validate_argv(Path(value['repository']), row['label'], row['argv'])
        require(row['environment_sha256'] == digest(canonical(value['build_environment_before'])), 'native command environment hash differs')
        receipt_path = Path(row['receipt']['path'])
        require(sha(receipt_path) == row['receipt']['sha256'], 'native command receipt bytes differ')
        receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
        code = receipt.get('exit_code', receipt.get('exitCode'))
        require(not ('exit_code' in receipt and 'exitCode' in receipt), 'ambiguous native build receipt')
        require(receipt['argv'] == row['argv'] and type(code) is int and code == 0
                and receipt.get('timed_out', receipt.get('timedOut')) is False, 'native command receipt failed')
        for stream in ['stdout', 'stderr']:
            require(sha(row[stream]['path']) == row[stream]['sha256']
                    and Path(row[stream]['path']).stat().st_size == row[stream]['bytes'], 'native command stream bytes differ')
        require(sha(fixture[kind+'_path']) == rows[0]['artifact_sha256'], 'frozen native artifact bytes differ')
    return value
