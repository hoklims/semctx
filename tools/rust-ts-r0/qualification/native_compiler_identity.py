"""Record the actual pinned upstream compiler version source, without changing it."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

REVISION = 'd1f3c0c442ab71a2fce7a01980ed892bd27b9842'
UPSTREAM_BASE_REVISION = '780dc512d64f40afebffa6a7028207649fb7ed1c'
SOURCE = 'crates/ts_goport/src/core.rs'


def record_native_compiler_source(output, env):
    if 'GOPORT_BUILD_VERSION' in env:
        raise ValueError('compiler build-time version override must be absent')
    home = Path(env.get('CARGO_HOME') or Path.home()/'.cargo')
    candidates = []
    for source in (home/'git/checkouts').glob('ts-rust-*/*/'+SOURCE):
        checkout = source.parents[3]
        command = ['git', '-C', str(checkout)]
        head = subprocess.check_output(command+['rev-parse', 'HEAD'], env=env).decode().strip()
        if head != REVISION:
            continue
        blob = subprocess.check_output(command+['rev-parse', 'HEAD:'+SOURCE], env=env).decode().strip()
        committed = subprocess.check_output(command+['show', 'HEAD:'+SOURCE], env=env)
        actual = source.read_bytes()
        if actual != committed:
            raise ValueError('cached upstream compiler source differs from its pinned Git blob')
        candidates.append((source, blob, actual))
    if len(candidates) != 1:
        raise ValueError('exactly one unchanged pinned upstream compiler source required')
    source, blob, actual = candidates[0]
    checkout = source.parents[3]
    command = ['git', '-C', str(checkout)]
    parent = subprocess.check_output(command+['rev-parse', 'HEAD^'], env=env).decode().strip()
    if parent != UPSTREAM_BASE_REVISION:
        raise ValueError('engine correction is not based on the frozen upstream source')
    patch_sources = []
    for relative in ['crates/ts_goport/src/frontend/scanner/scanner_p1.rs',
                     'crates/ts_goport/src/frontend/scanner/t00_utf16_source_tests.rs']:
        committed = subprocess.check_output(command+['show', 'HEAD:'+relative], env=env)
        data = (checkout/relative).read_bytes()
        if committed != data:
            raise ValueError('cached corrected engine source differs from its Git blob')
        patch_sources.append({'path': relative, 'git_blob': subprocess.check_output(
            command+['rev-parse', 'HEAD:'+relative], env=env).decode().strip(),
            'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
    lines = actual.decode('utf-8').splitlines()
    start = next(i for i, line in enumerate(lines) if 'pub(crate) const VERSION: &str' in line)
    version = lines[start:start+4]
    if version != ['pub(crate) const VERSION: &str = match option_env!("GOPORT_BUILD_VERSION") {',
                   '    Some(version) => version,', '    None => "7.1.0-dev",', '};']:
        raise ValueError('pinned upstream compiler version expression differs')
    output = Path(output)
    (output/'upstream-compiler-core.rs').write_bytes(actual)
    receipt = {'upstream_revision': REVISION, 'engine_source_revision': REVISION,
               'upstream_base_revision': UPSTREAM_BASE_REVISION, 'fork_patch_source_bindings': patch_sources,
               'path': SOURCE, 'cache_path': str(source),
               'git_blob': blob, 'git_blob_matches_actual_bytes': True,
               'source_sha256': hashlib.sha256(actual).hexdigest(), 'source_bytes': len(actual),
               'version_expression_first_line': start+1, 'version_expression': version,
               'GOPORT_BUILD_VERSION_present_in_build_environment': False,
               'expected_native_compiler_version': '7.1.0-dev',
               'actual_binary_version_observation_required_separately': True,
               'frozen_legacy_expected_version': '5.9.3', 'arbitration': 'T00-ARB-004',
               'qualification_credit': 0}
    (output/'native-compiler-source-identity.json').write_text(json.dumps(receipt, indent=2)+'\n', encoding='utf-8')
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    arguments = parser.parse_args()
    record_native_compiler_source(arguments.output, os.environ.copy())
