// Research adapter: fresh parser, then old-tree incremental reparse in one process.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {performance} from 'node:perf_hooks';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const {Parser, Language} = await import(pathToFileURL(config.runtime).href);
await Parser.init({locateFile: () => config.wasm});
const parser = new Parser();
parser.setLanguage(await Language.load(config.grammar));
const hash = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const records = [];
let cold = 0;
let incremental = 0;

function inspect(tree) {
  if (tree.rootNode.hasError) throw new Error('native tree contains syntax errors');
  const symbols = [];
  function visit(node) {
    if (node.type === 'function_item') {
      const name = node.childForFieldName('name');
      if (name) symbols.push({name: name.text, startIndex: node.startIndex, endIndex: node.endIndex});
    }
    for (const child of node.namedChildren) visit(child);
  }
  visit(tree.rootNode);
  return {symbols, ast: tree.rootNode.toString()};
}

try {
  for (const file of config.files) {
    const source = fs.readFileSync(path.join(config.workspace, file), 'utf8');
    const started = performance.now();
    const tree = parser.parse(source);
    cold += performance.now() - started;
    const before = inspect(tree);
    records.push({file, source, tree, before});
  }
  const output = [];
  for (const record of records) {
    const {file, source, tree, before} = record;
    const edited = file === config.target;
    const afterSource = source + (edited ? config.append : '');
    if (edited) {
      const end = tree.rootNode.endPosition;
      const lines = config.append.split('\n');
      tree.edit({
        startIndex: source.length, oldEndIndex: source.length, newEndIndex: afterSource.length,
        startPosition: end, oldEndPosition: end,
        newEndPosition: {row: end.row + lines.length - 1,
          column: lines.length === 1 ? end.column + lines[0].length : lines.at(-1).length},
      });
    }
    const started = performance.now();
    const next = parser.parse(afterSource, tree);
    incremental += performance.now() - started;
    try {
      output.push({file, beforeSha256: hash(source), afterSha256: hash(afterSource),
        before, after: inspect(next)});
    } finally { next.delete(); }
  }
  process.stdout.write(JSON.stringify({engine: 'T', files: output,
    timingsMs: {coldParse: cold, incrementalParse: incremental}}));
} finally {
  for (const {tree} of records) tree.delete();
  parser.delete();
}
