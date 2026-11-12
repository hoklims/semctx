"""Independent synthetic DEV witness; source only until ROOT selects execution."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import unittest

BASELINE = '3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b'
SOURCE_PINS = {
    'packages/ts-analyzer/src/top-level-outline.ts': '2d75f2a99e91aec60ef7baea52e2a62b53c492eed7976c39570dbd6a396b8647',
    'packages/ts-analyzer/src/javascript-diagnostics.ts': '24df500bd622310e0522f7d2ea13082d484e58ece753b102027853622d4ed097',
    'packages/ts-analyzer/src/semantic-dependency-diagnostics.ts': 'a13d3a244e75495592075379f2aa7c524f4c0157755459a8640240ea960ab782',
    'packages/ts-analyzer/src/ts-symbols.ts': '259b92fde8c66d72adb5dce767248bd8426f017c7885007f6ec6107a3b54716e',
    'scripts/pilot/baselines.ts': 'c0f8b36efeda070078416261282fed97e70d635c142f55c7a30df6150b73adb9',
}


def setup(condition, message):
    if not condition:
        raise RuntimeError('INCONCLUSIVE_SETUP: ' + message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class SuiteProducerSourceBinding(unittest.TestCase):
    def test_foreign_sources_refused_before_import_or_output(self):
        root = Path(os.environ['DEV_EVIDENCE_ROOT'])
        setup(root.is_absolute() and root.is_dir() and root == root.resolve(), 'Exact owned evidence parent required')
        root = root / 'suite-producer-source-binding'
        setup(not root.exists() and not root.is_symlink(), 'Fresh witness directory required')
        root.mkdir()
        bun = os.environ['DEV_BUN']
        collector = Path(os.environ['DEV_SUITE_COLLECTOR']).resolve()
        typescript = Path(os.environ['DEV_PUBLIC_TYPESCRIPT']).resolve()
        setup(collector.is_file() and typescript.is_file(), 'Existing collector and public TypeScript runtime required')
        before = {str(path): digest(path) for path in (collector, typescript)}
        baseline = root / 'synthetic-baseline'
        baseline.mkdir()
        (baseline / 'package.json').write_text('{"type":"module"}', encoding='utf-8')
        control_marks, collector_marks = root / 'control-imports', root / 'collector-imports'
        control_marks.mkdir()
        collector_marks.mkdir()
        paths, fake_pins, marker_values = [], {}, {}
        for index, (relative, trusted) in enumerate(SOURCE_PINS.items()):
            path = baseline / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            marker_values[f'{index:02}.marker'] = f'ARBITRARY_MODULE_LOADED_{index}'
            source = ('import {writeFileSync} from "node:fs";import {join} from "node:path";'
                'writeFileSync(join(process.env.DEV_SUITE_IMPORT_MARKERS,' + json.dumps(f'{index:02}.marker') + '),'
                + json.dumps(marker_values[f'{index:02}.marker']) + ',{flag:"wx"});export const syntheticOnly=true;\n')
            path.write_text(source, encoding='utf-8')
            fake_pins[relative] = digest(path)
            setup(fake_pins[relative] != trusted, 'Synthetic bytes unexpectedly equal the trusted source')
            paths.append(path.as_uri())
        inputs = root / 'inputs.json'
        inputs.write_text('{"units":[],"digestPairs":[]}', encoding='utf-8')
        output, work = root / 'manifest.json', root / 'producer-work'

        def invoke(label, argv, marker_root):
            environment = os.environ.copy()
            environment['DEV_SUITE_IMPORT_MARKERS'] = str(marker_root)
            try:
                result = subprocess.run(argv, cwd=root, env=environment, capture_output=True, timeout=15)
            except (OSError, subprocess.TimeoutExpired) as error:
                (root / (label + '.stdout.raw')).write_bytes(getattr(error, 'stdout', None) or b'')
                (root / (label + '.stderr.raw')).write_bytes(getattr(error, 'stderr', None) or b'')
                (root / (label + '.receipt.json')).write_text(json.dumps({'argv': argv, 'exit_code': None, 'setup_error': type(error).__name__}), encoding='utf-8')
                raise RuntimeError('INCONCLUSIVE_SETUP: bounded Bun invocation failed') from error
            (root / (label + '.stdout.raw')).write_bytes(result.stdout)
            (root / (label + '.stderr.raw')).write_bytes(result.stderr)
            (root / (label + '.receipt.json')).write_text(json.dumps({'argv': argv, 'exit_code': result.returncode,
                'collector_and_public_typescript_before': before, 'source_pins': fake_pins}), encoding='utf-8')
            return result

        def markers(folder):
            return {path.name: path.read_text(encoding='utf-8') for path in folder.iterdir() if path.is_file()}

        control = ('const ts=(await import(' + json.dumps(typescript.as_uri()) + ')).default;'
            'if(Bun.version!=="1.4.3"||ts.version!=="5.9.3")throw Error("PUBLIC_TOOL_VERSION_MISMATCH");'
            'for(const path of ' + json.dumps(paths) + ')await import(path);console.log("DEV_FIVE_IMPORTS_TS_5_9_3");')
        result = invoke('control', [bun, '--no-install', '--eval', control], control_marks)
        setup(result.returncode == 0 and result.stdout.strip() == b'DEV_FIVE_IMPORTS_TS_5_9_3', 'Five-module/public TypeScript control failed')
        setup(markers(control_marks) == marker_values, 'Control did not load all five synthetic modules')
        result = invoke('collector', [bun, '--no-install', str(collector), str(baseline), str(inputs), str(output), str(work)], collector_marks)
        if result.returncode == 0:
            setup(markers(collector_marks) == marker_values and output.is_file(), 'Successful collector did not reach the challenged branch')
            manifest = json.loads(output.read_bytes())
            setup(manifest['oracle']['baseline'] == BASELINE and manifest['oracle']['typescript_version'] == '5.9.3', 'Claimed baseline branch differs')
            setup({row['path']: row['sha256'] for row in manifest['oracle']['sourceIdentities']} == fake_pins, 'Collector did not label the supplied arbitrary bytes')
            setup(manifest['units'] == [], 'Unexpected case evaluation occurred')
        else:
            setup(b'SOURCE_BASELINE_IDENTITY_MISMATCH' in result.stderr, 'Unrelated collector error is not identity rejection')
        setup(all(digest(Path(path)) == pin for path, pin in before.items()), 'Collector or public TypeScript changed during witness')
        self.assertNotEqual(result.returncode, 0, 'TARGET_RED: arbitrary source bytes were labelled as the trusted baseline')
        self.assertEqual(markers(collector_marks), {}, 'TARGET_RED: identity rejection occurred after module import side effects')
        self.assertFalse(output.exists(), 'TARGET_RED: rejected foreign source emitted an oracle manifest')


if __name__ == '__main__':
    unittest.main()
