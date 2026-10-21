#!/usr/bin/env node
'use strict';
// Executes Git-pinned baseline modules through the TS/CJS loader below.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const args = process.argv.slice(2);
function option(name) { const i = args.indexOf(name); if (i < 0) throw Error(`Missing ${name}`); return args[i + 1]; }
const repo = path.resolve(option('--repo'));
const recipePath = path.resolve(option('--recipes'));
const baseline = '3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b';
const recipeSha = '1820a9fbce9772a74dd15f83842b30eb796a44fe24944f53cb80a24278d01bde';
const external = createRequire(path.join(repo, 'package.json'));
const ts = external('typescript');
if (ts.version !== '5.9.3') throw Error('TypeScript 5.9.3 required');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
function canonical(value) { if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'; if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'; return JSON.stringify(value); }
function git(file) { return cp.execFileSync('git', ['-C', repo, 'show', `${baseline}:${file}`], { maxBuffer: 16 * 1024 * 1024 }); }
const sourceHashes = {}, cache = new Map();
function load(file) {
  file = path.posix.normalize(file);
  if (cache.has(file)) return cache.get(file).exports;
  const source = git(file); sourceHashes[file] = sha(source);
  const module = { exports: {} }; cache.set(file, module);
  const localRequire = spec => {
    if (spec.startsWith('.')) return load(path.posix.join(path.posix.dirname(file), spec) + (path.posix.extname(spec) ? '' : '.ts'));
    if (spec.startsWith('@semantic-context/')) return load(`packages/${spec.slice('@semantic-context/'.length)}/src/index.ts`);
    return createRequire(path.join(repo, file))(spec);
  };
  // CJS loader compatibility only: preserve import.meta properties without modifying source bytes.
  const metadata = context => node => {
    const visit = value => ts.isMetaProperty(value) && value.keywordToken === ts.SyntaxKind.ImportKeyword
      ? ts.factory.createIdentifier('__baselineImportMeta') : ts.visitEachChild(value, visit, context);
    return ts.visitNode(node, visit);
  };
  const compiled = ts.transpileModule(source.toString('utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, transformers: { before: [metadata] } }).outputText;
  vm.runInThisContext(`(function(require,module,exports,__filename,__dirname,__baselineImportMeta){${compiled}\n})`, { filename: `baseline/${file}` })(localRequire, module, module.exports, path.join(repo, file), path.dirname(path.join(repo, file)), { dir: path.dirname(path.join(repo, file)), url: require('node:url').pathToFileURL(path.join(repo, file)).href });
  return module.exports;
}
const bytes = fs.readFileSync(recipePath);
const frozen = path.join(__dirname, 'ordinary-existing-assertions.json');
// Read only input custody fields from the prior capture, never its expected checks.
// Recipe formatting and additional checks may change; the selected inputs may not.
const inputPins = JSON.parse(fs.readFileSync(frozen, 'utf8')).assertions.map(({ unit_id, frozen_unit_pointer, frozen_unit_sha256, request_sha256 }) => ({ unit_id, frozen_unit_pointer, frozen_unit_sha256, request_sha256 }));
const recipes = JSON.parse(bytes).recipes.map(({ unit_id, requests, frozen_unit_pointer, frozen_unit_sha256 }) => ({ unit_id, requests, frozen_unit_pointer, frozen_unit_sha256 }));
const indexBytes = fs.readFileSync(path.join(repo, 'docs/research/rust-ts-r0/cases/index.json'));
if (sha(indexBytes) !== '79f2edac4b4346f787ab1163ee714fb4b706585e06b891bf3923f0de677380f1') throw Error('Frozen case index changed');
const index = JSON.parse(indexBytes);
const unitsPath = 'docs/research/rust-ts-r0/cases/' + index.scenarios.path;
const unitsBytes = fs.readFileSync(path.join(repo, unitsPath));
if (sha(unitsBytes) !== 'b17b5ea68e702a2d45c6b04ae50654a93611584ec84e60a318ac3bce9d609906') throw Error('Frozen units changed');
const units = JSON.parse(unitsBytes).execution_units;
const extractor = load('packages/ts-analyzer/src/ts-symbols.ts');
const diagnostics = load('packages/ts-analyzer/src/javascript-diagnostics.ts');
const createProgram = extractor.extractionContext.createProgram;
let programOptions = [];
extractor.extractionContext.createProgram = function (...parameters) {
  const program = Reflect.apply(createProgram, this, parameters);
  programOptions.push(program.getCompilerOptions());
  return program;
};
const ids = ['P04-small-complete-symbol-set::base', 'P07-namespace-real-owner::base', 'P21-local-sdk-shaped-callback-method::base', 'N21-actual-sdk-map-callback::base'];
const assertions = [];
for (const id of ids) {
  const matches = recipes.filter(row => row.unit_id === id);
  if (matches.length !== 1) throw Error(`Missing or duplicated input: ${id}`);
  const recipe = matches[0];
  const request = recipe.requests[0];
  const inputPin = inputPins.find(row => row.unit_id === id);
  const unitIndex = units.findIndex(row => row.unit_id === id);
  if (!inputPin || sha(canonical(request)) !== inputPin.request_sha256
    || recipe.frozen_unit_pointer !== inputPin.frozen_unit_pointer
    || recipe.frozen_unit_sha256 !== inputPin.frozen_unit_sha256
    || `/execution_units/${unitIndex}` !== inputPin.frozen_unit_pointer
    || sha(canonical(units[unitIndex])) !== inputPin.frozen_unit_sha256) throw Error(`Frozen input custody mismatch: ${id}`);
  const frozenInput = units[unitIndex].variant_input_or_observation;
  if (canonical(request.files) !== canonical(frozenInput.files)
    || canonical(request.roots) !== canonical(Object.keys(frozenInput.files))
    || request.retained !== frozenInput.retained_snapshot) throw Error(`Request differs from frozen source/root/snapshot input: ${id}`);
  programOptions = [];
  const root = path.resolve(__dirname, 'virtual-fixture');
  const inputs = new Map(Object.entries(request.files).map(([file, text]) => [path.join(root, file).replaceAll('\\', '/'), text]));
  const roots = request.roots.map(file => path.join(root, file).replaceAll('\\', '/'));
  const extraction = extractor.extractTypeScript(roots, root.replaceAll('\\', '/'), inputs);
  const checks = [];
  const add = (target, expected, mode = 'eq') => checks.push({ observation: 0, target, mode, expected, actual_transform: 'none' });
  if (id.startsWith('P04')) {
    const symbols = extraction.symbols;
    const absences = symbols.flatMap((symbol, i) => ['Shape', 'Flag'].includes(symbol.name) && !Object.hasOwn(symbol, 'jsdoc') ? [{ index: i, fields: ['jsdoc'] }] : []);
    if (absences.length !== 2) throw Error('Baseline did not produce both expected uncommented symbols');
    add(['raw_extraction', 'symbols'], symbols.map(({ name, kind, relPath, startLine, endLine }) => ({ name, kind, relPath, startLine, endLine })), 'ordered_projected_eq');
    add(['raw_extraction', 'symbols'], absences, 'indexed_field_absences');
  } else if (id.startsWith('P07')) {
    add(['raw_extraction', 'calls'], extraction.calls, 'unordered_projected_eq');
  } else {
    // Freeze actual retained as-callee control and the existing real SDK countercase.
    add(['raw_extraction', 'calls'], extraction.calls, 'unordered_projected_eq');
    const absences = extraction.calls.flatMap((call, i) => !Object.hasOwn(call, 'calleeRelPath') ? [{ index: i, fields: ['calleeRelPath'] }] : []);
    if (absences.length) add(['raw_extraction', 'calls'], absences, 'indexed_field_absences');
    const reasons = diagnostics.inspectModuleConfiguration(roots[0], root.replaceAll('\\', '/'), inputs);
    add(['subjects', { path: request.roots[0] }, 'moduleConfigurationObservations', 'retainedWithoutSource', 'reasons'], reasons);
  }
  const options = ts.convertCompilerOptionsFromJson(request.options, root);
  if (options.errors.length || !programOptions.length || programOptions.some(observed => canonical(observed) !== canonical(options.options))) throw Error(`Baseline Program options differ from frozen request: ${id}`);
  assertions.push({ unit_id: id, frozen_unit_pointer: `/execution_units/${unitIndex}`, frozen_unit_sha256: sha(canonical(units[unitIndex])), request_sha256: sha(canonical(request)), input_documents: Object.entries(request.files).map(([file, text]) => ({ path: file, sha256: sha(text) })), observed_program_options: programOptions, checks });
}
const tsRuntimePath = external.resolve('typescript');
const sdkDirectory = path.dirname(tsRuntimePath);
const sdkHashes = Object.fromEntries(fs.readdirSync(sdkDirectory).filter(name => name.startsWith('lib.') && name.endsWith('.d.ts')).sort().map(name => [name, sha(fs.readFileSync(path.join(sdkDirectory, name)))]));
const result = { schema_version: 1, status: 'BASELINE_DERIVED_EXISTING_INPUT_ASSERTIONS_NO_NATIVE_EXECUTION', baseline, typescript_version: ts.version, typescript_runtime_sha256: sha(fs.readFileSync(tsRuntimePath)), sdk_library_manifest_sha256: sha(canonical(sdkHashes)), derivation_recipe_origin_sha256: recipeSha, source_index: { path: 'docs/research/rust-ts-r0/cases/index.json', sha256: sha(indexBytes) }, units_document: { path: unitsPath, sha256: sha(unitsBytes) }, baseline_sources: Object.fromEntries(Object.entries(sourceHashes).sort()), assertions };
const output = JSON.stringify(result, null, 2) + '\n';
if (args.includes('--check')) { if (fs.readFileSync(frozen, 'utf8') !== output) throw Error('Frozen baseline derivation differs'); console.log(`PASS: ${assertions.length} existing units; ${Object.keys(sourceHashes).length} baseline source modules; TS ${ts.version}`); }
else { fs.writeFileSync(frozen, output); console.log(`Derived ${assertions.length} existing-input assertion entries`); }
