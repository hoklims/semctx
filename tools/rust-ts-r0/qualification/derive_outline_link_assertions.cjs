#!/usr/bin/env node
// New authorized assertions, derived from unchanged baseline code and existing inputs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');

const root = path.resolve(__dirname, '../../..');
const baseline = '3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b';
const sourcePath = 'packages/ts-analyzer/src/top-level-outline.ts';
const authorityPath = 'docs/research/rust-ts-r0/resumption/owner-execution-and-custody-20261020.json';
const units = ['OL-M06', 'OL-M07', 'OL-M13', 'OL-M14', 'OL-M21', 'OL-M23', 'OL-M24', 'OL-M25'];
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, (_, child) =>
  child && typeof child === 'object' && !Array.isArray(child)
    ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child);

function derive(recipesPath) {
  const ts = Module.createRequire(path.join(root, 'package.json'))('typescript');
  if (ts.version !== '5.9.3') throw new Error('Oracle requires local TypeScript 5.9.3');
  const source = execFileSync('git', ['-C', root, 'show', `${baseline}:${sourcePath}`]);
  const sourceGitBlobSha = execFileSync('git', ['-C', root, 'rev-parse', `${baseline}:${sourcePath}`],
    { encoding: 'utf8' }).trim();
  const code = ts.transpileModule(source.toString('utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const observer = new Module(path.join(__dirname, 'baseline-outline-observer.cjs'));
  observer.require = name => {
    if (name === 'typescript') return ts;
    if (name === 'node:crypto') return crypto;
    throw new Error(`Unexpected baseline dependency: ${name}`);
  };
  observer._compile(code, observer.id);
  const cases = path.join(root, 'docs/research/rust-ts-r0/cases');
  const frozenDocuments = {
    scenarios: { path: 'qualification/scenarios.json', sha256: 'b17b5ea68e702a2d45c6b04ae50654a93611584ec84e60a318ac3bce9d609906' },
    inputs: { path: 'allocation/input-index.json', sha256: '2b661e61877daf5a4ce14ab76a3ce31f0703f288b01b0853cbc3a8b448c0cded' },
  };
  const frozen = Object.fromEntries(Object.entries(frozenDocuments).map(([key, reference]) => {
    const bytes = fs.readFileSync(path.join(cases, reference.path));
    if (sha256(bytes) !== reference.sha256) throw new Error(`Frozen document changed: ${reference.path}`);
    return [key, JSON.parse(bytes)];
  }));
  const recipes = JSON.parse(fs.readFileSync(recipesPath, 'utf8')).recipes;
  const assertions = units.map(id => {
    const rows = recipes.filter(row => row.unit_id === `${id}::base`);
    if (rows.length !== 1 || rows[0].requests.length !== 1) throw new Error(`Missing exact recipe: ${id}`);
    const recipe = rows[0];
    const filename = 'src/specimen.ts';
    const text = recipe.requests[0].files[filename];
    if (typeof text !== 'string') throw new Error(`Missing existing source: ${id}`);
    const frozenIndex = frozen.scenarios.execution_units.findIndex(unit => unit.unit_id === recipe.unit_id);
    const unit = frozen.scenarios.execution_units[frozenIndex];
    const input = frozen.inputs.qualification_records.find(row => row.case_id === id).input_specification;
    if (!unit || recipe.frozen_unit_pointer !== `/execution_units/${frozenIndex}`
        || recipe.frozen_unit_sha256 !== sha256(Buffer.from(canonical(unit)))
        || filename !== input.relative_path || text !== input.source_text
        || sha256(Buffer.from(text)) !== input.source_sha256) {
      throw new Error(`Recipe differs from frozen existing input: ${id}`);
    }
    const links = observer.exports.outlineModuleLinks(text, filename);
    return {
      unit_id: recipe.unit_id, frozen_unit_pointer: recipe.frozen_unit_pointer,
      frozen_unit_sha256: recipe.frozen_unit_sha256, source_path: filename,
      input_source_sha256: sha256(Buffer.from(text)), module_links: links,
      indexed_field_absences: links.flatMap((link, index) =>
        Object.hasOwn(link, 'whole') ? [] : [{ index, fields: ['whole'] }]),
    };
  });
  return {
    schema_version: 1, status: 'DERIVED_ASSERTIONS_EXISTING_INPUTS_ONLY_NOT_QUALIFICATION',
    authority: `${authorityPath}#/assertionDecision`,
    provenance: 'New assertions authorized on existing frozen inputs; original frozen assertions are unchanged.',
    obligations: [
      { index: 156, property: 2, field: 'moduleLinks.whole' },
      { index: 158, property: 1, field: 'moduleLinks.whole' },
    ],
    oracle: { baseline, source_path: sourcePath, source_git_blob_sha: sourceGitBlobSha,
      source_sha256: sha256(source), typescript: ts.version },
    frozen_documents: frozenDocuments,
    assertions,
  };
}

try {
  const options = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index];
    if (!['--recipes', '--output', '--check'].includes(flag) || options[flag] || !process.argv[index + 1]) {
      throw new Error('Usage: --recipes path (--output newfile | --check file)');
    }
    options[flag] = process.argv[index + 1];
  }
  if (!options['--recipes'] || Boolean(options['--output']) === Boolean(options['--check'])) {
    throw new Error('Usage: --recipes path (--output newfile | --check file)');
  }
  const derived = derive(options['--recipes']);
  if (options['--check']) {
    const stored = JSON.parse(fs.readFileSync(options['--check'], 'utf8'));
    if (canonical(stored) !== canonical(derived)) throw new Error('Derived outline link assertions differ from baseline observation');
    console.log('PASS: derived outline link assertions match baseline observation');
  } else {
    fs.writeFileSync(options['--output'], JSON.stringify(derived, null, 2) + '\n', { flag: 'wx' });
    console.log(`Derived ${derived.assertions.length} existing-input assertions`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
