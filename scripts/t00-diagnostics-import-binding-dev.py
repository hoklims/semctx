"""Separate independent positive DEV control; not selected by the core packet.

The baseline module/helper are synthetic. TypeScript is the already-installed
public5.9.3 tool. This does not observe a qualification case or claim3e949 parity.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
base_path = Path(os.environ['DEV_BASE_TEST_FILE']).resolve()
if hashlib.sha256(base_path.read_bytes()).hexdigest() != 'a1df4c3a27522ffc7dd41c996f25be5882b478682322e14c2438e9287ce52387':
    raise RuntimeError('INCONCLUSIVE_SETUP: independent V2 base differs')
spec = importlib.util.spec_from_file_location('independent_collector_v2', base_path)
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


class DiagnosticsImportBindingWitness(base.IndependentCollectorWitnesses):
    def test_relative_and_real_typescript_imports_preserve_results_and_baseline(self):
        real_package = base.REPO / 'node_modules/typescript/package.json'
        real_typescript = (real_package.parent / 'lib/typescript.js').resolve()
        base.setup(real_typescript.is_file(), 'Existing public TypeScript runtime unavailable')
        base.setup(json.loads(real_package.read_bytes())['version'] == '5.9.3', 'Public TypeScript5.9.3 required')
        tool_before = base.digest(real_typescript)
        source_root = self.baseline / 'packages/ts-analyzer/src'
        helper = source_root / 'diagnostics-helper.ts'
        source = source_root / 'javascript-diagnostics.ts'
        sdk_wrapper = self.baseline / 'node_modules/typescript/lib/typescript.js'
        base.write(self.baseline / 'node_modules/typescript/package.json', json.dumps({
            'name': 'typescript', 'version': '5.9.3', 'type': 'module', 'main': './lib/typescript.js',
        }))
        base.write(sdk_wrapper, 'export { default } from ' + json.dumps(str(real_typescript)) + ';\n')
        base.write(helper, 'export function marker(){return "RELATIVE_HELPER_LOADED";}\n')
        source_text = (
            'import ts from "typescript";\n'
            'import { marker } from "./diagnostics-helper";\n'
            'export function inspectSourceParsing(path, content){return [marker(),ts.version,String(ts.createSourceFile(path,content,ts.ScriptTarget.Latest,true).parseDiagnostics.length)];}\n'
        )
        base.write(source, source_text)
        expected = ['RELATIVE_HELPER_LOADED', '5.9.3', '0']
        control_script = (
            'const module=await import(' + json.dumps(source.as_uri()) + ');'
            'console.log(JSON.stringify(module.inspectSourceParsing("main.ts","export const stable = 3;")));'
        )
        control = self.invoke([base.BUN, '--no-install', '--eval', control_script])
        base.setup(control.returncode == 0, 'Uninstrumented import control failed: ' + control.stderr.decode(errors='replace'))
        base.setup(json.loads(control.stdout) == expected, 'Uninstrumented original imports did not produce exact values')
        before = {p.relative_to(self.baseline): p.read_bytes() for p in self.baseline.rglob('*') if p.is_file()}
        inputs = self.root / 'import-inputs.json'
        contracts = self.root / 'import-contracts.json'
        manifest = self.root / 'import-manifest.json'
        activation = self.root / 'import-activation.json'
        work = self.root / 'import-work'
        base.save(inputs, {'obligation_indices': [9100], 'units': [{
            'id': 'DEV_IMPORTS', 'operation': 'parsing', 'path': 'main.ts',
            'files': {'main.ts': 'export const stable = 3;'},
            'origin': 'independent synthetic DEV import-binding control', 'obligation_indices': [],
        }]})
        base.save(contracts, {'rows': [{'index': 9100, 'apiSites': [{
            'line': 3, 'column': source_text.splitlines()[2].index('marker()') + 1, 'expression': 'marker',
        }]}]})
        base.save(self.root / 'source-control-binding.json', {
            'kind': 'SYNTHETIC_BASELINE_REAL_PUBLIC_TYPESCRIPT_DEV_ONLY',
            'source': {'path': str(source), 'sha256': base.digest(source)},
            'relative_helper': {'path': str(helper), 'sha256': base.digest(helper)},
            'typescript_wrapper': {'path': str(sdk_wrapper), 'sha256': base.digest(sdk_wrapper)},
            'real_typescript': {'path': str(real_typescript), 'sha256': tool_before},
            'expected': expected, 'qualification_credit': 0,
        })
        process = self.invoke([
            base.BUN, '--no-install', base.TOOLS / 'diagnostics-oracle.mjs',
            self.baseline, inputs, contracts, manifest, activation, work,
        ])
        self.assertEqual(process.returncode, 0,
            'DIAGNOSTICS_IMPORT_BINDING: isolated instrumentation did not retain original imports: ' + process.stderr.decode(errors='replace'))
        after = {p.relative_to(self.baseline): p.read_bytes() for p in self.baseline.rglob('*') if p.is_file()}
        self.assertEqual(after, before, 'DIAGNOSTICS_IMPORT_BINDING: baseline bytes changed')
        self.assertEqual(base.digest(real_typescript), tool_before, 'DIAGNOSTICS_IMPORT_BINDING: public TypeScript tool changed')
        observed_manifest = json.loads(manifest.read_bytes())
        reason_checks = [check for check in observed_manifest['units'][0]['checks'] if check['target'][-1] == 'reasons']
        self.assertEqual(len(reason_checks), 1)
        self.assertEqual(reason_checks[0]['expected'], expected, 'DIAGNOSTICS_IMPORT_BINDING: complete operation value differs')
        observed_activation = json.loads(activation.read_bytes())
        self.assertEqual(observed_activation['units'][0]['oracle_output'], expected)
        self.assertIs(observed_activation['units'][0]['instrumented_output_identical'], True)
        self.assertGreaterEqual(observed_activation['units'][0]['sites'].get('9100:0', 0), 1,
            'DIAGNOSTICS_IMPORT_BINDING: relative helper call was not instrumented')
        bindings = {row['path']: row['sha256'] for row in observed_activation['dependencyBindings']}
        self.assertEqual(bindings, {str(helper): base.digest(helper), str(sdk_wrapper): base.digest(sdk_wrapper)},
            'DIAGNOSTICS_IMPORT_BINDING: original dependency bindings differ')
        self.assertTrue((work / 'diagnostics-public-closure-instrumented.ts').is_file())


if __name__ == '__main__':
    unittest.main()
