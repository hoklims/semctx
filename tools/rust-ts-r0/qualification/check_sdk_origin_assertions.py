"""Compile only the comparator helper and execute bounded TS-derived DTO tests offline."""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--evidence', type=pathlib.Path, required=True)
parser.add_argument('--work-dir', type=pathlib.Path, required=True)
args = parser.parse_args()
source = pathlib.Path(__file__).resolve().parent
work = args.work_dir.resolve()
work.mkdir(parents=True, exist_ok=False)
(work / 'Cargo.toml').write_text('''[package]
name = "t00-sdk-origin-comparator-only"
version = "0.0.0"
edition = "2024"
[lib]
path = "lib.rs"
[dependencies]
serde_json = "=1.0.151"
sha2 = "=0.10.9"
[workspace]
''', encoding='utf-8')
(work / 'lib.rs').write_text('#[path = ' + json.dumps((source / 'sdk_origin_assertions.rs').as_posix()) + ']\npub mod sdk_origin_assertions;\n#[cfg(test)]\n#[path = ' + json.dumps((source / 'sdk_origin_assertions_tests.rs').as_posix()) + ']\nmod sdk_origin_assertions_tests;\n', encoding='utf-8')
evidence = args.evidence.resolve()
shutil.copyfile(source / 'sdk-origin-comparator.Cargo.lock', work / 'Cargo.lock')
environment = dict(os.environ, SDK_ORIGIN_TEST_BUNDLE=str(evidence))
command = ['cargo', 'test', '--locked', '--offline', '--color', 'never', '--manifest-path', str(work / 'Cargo.toml'), '--', '--nocapture']
result = subprocess.run(command, env=environment, capture_output=True, text=True)
(work / 'stdout.txt').write_text(result.stdout, encoding='utf-8')
(work / 'stderr.txt').write_text(result.stderr, encoding='utf-8')
receipt = dict(command=command, exit_code=result.returncode, scope='Only standalone comparator helper; no native producer imported or executed; TS-derived DTO adapter is not native proof', evidence_sha256=hashlib.sha256(evidence.read_bytes()).hexdigest(), source_files=[dict(path=name, sha256=hashlib.sha256((source / name).read_bytes()).hexdigest()) for name in ['sdk_origin_assertions.rs', 'sdk_origin_assertions_tests.rs']], stdout=result.stdout, stderr=result.stderr)
(work / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
print(result.stdout)
print(result.stderr)
raise SystemExit(result.returncode)
