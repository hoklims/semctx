"""Run the unchanged public comparator functions only; no producer import or native query."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--document', type=pathlib.Path, required=True)
parser.add_argument('--comparator', type=pathlib.Path, required=True)
parser.add_argument('--work-dir', type=pathlib.Path, required=True)
args = parser.parse_args()
source = pathlib.Path(__file__).resolve().parent
work = args.work_dir.resolve()
work.mkdir(parents=True, exist_ok=False)
comparator_bytes = args.comparator.read_bytes()
comparator = comparator_bytes.decode('utf-8').replace('\r\n', '\n')
names = ['value_text', 'select', 'projected_eq', 'injective_matches', 'confined_coordinate', 'compare', 'validate_reason_routing', 'validate_component_checks']
functions = {}
for name in names:
    found = list(re.finditer(r'^fn ' + name + r'\b', comparator, re.MULTILINE))
    if len(found) != 1:
        raise ValueError('public comparator function is not unique: ' + name)
    start = found[0].start()
    end = comparator.find('\nfn ', start + 1)
    candidate = comparator[start:end if end >= 0 else len(comparator)]
    close = candidate.rfind('\n}')
    if close < 0:
        raise ValueError('missing standalone comparator function close: ' + name)
    functions[name] = candidate[:close + 2]
test_path = source / 'existing_semantic_reason_comparator_tests.rs'
library = '#![allow(dead_code)]\nuse serde_json::{Value,json};\nuse std::collections::BTreeSet;\n' + '\n\n'.join(functions.values()) + '\n#[cfg(test)]\n#[path = ' + json.dumps(test_path.as_posix()) + ']\nmod tests;\n'
(work / 'lib.rs').write_bytes(library.encode('utf-8'))
(work / 'Cargo.toml').write_bytes(b'''[package]
name = "t00-sdk-origin-comparator-only"
version = "0.0.0"
edition = "2024"
[lib]
path = "lib.rs"
[dependencies]
serde_json = "=1.0.151"
sha2 = "=0.10.9"
[workspace]
''')
shutil.copyfile(source / 'existing-semantic-comparator.Cargo.lock', work / 'Cargo.lock')
environment = dict(os.environ, SEMANTIC_REASON_TEST_DOCUMENT=str(args.document.resolve()))
command = ['cargo', 'test', '--locked', '--offline', '--color', 'never', '--manifest-path', str(work / 'Cargo.toml'), '--', '--nocapture']
result = subprocess.run(command, env=environment, capture_output=True, text=True, encoding='utf-8')
digest = lambda data: hashlib.sha256(data).hexdigest()
receipt = dict(command=command, exit_code=result.returncode, public_comparator_source_sha256=digest(comparator_bytes), functions={name:dict(normalized_lf_sha256=digest(body.encode('utf-8')), source='exact function text; no body edits') for name, body in functions.items()}, test_source_sha256=digest(test_path.read_bytes()), document_sha256=digest(args.document.read_bytes()), scope='Public comparator functions and TS-derived reason arrays only; no producer module, native SDK query or qualification', stdout=result.stdout, stderr=result.stderr)
(work / 'receipt.json').write_bytes((json.dumps(receipt, indent=2) + '\n').encode('utf-8'))
(work / 'stdout.txt').write_bytes(result.stdout.encode('utf-8'))
(work / 'stderr.txt').write_bytes(result.stderr.encode('utf-8'))
print(result.stdout)
print(result.stderr)
raise SystemExit(result.returncode)
