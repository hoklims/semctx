import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
const [baseline, inputsPath, outputPath, workRoot] = process.argv.slice(2);
const ts = (await import(resolve(baseline, 'node_modules/typescript/lib/typescript.js'))).default;
const wsPath = resolve(baseline, 'packages/ts-analyzer/src/workspace-links.ts');
const diagnosticPath = resolve(baseline, 'packages/ts-analyzer/src/javascript-diagnostics.ts');
const ws = await import(wsPath);
const diagnostic = await import(diagnosticPath);
if (ts.version !== '5.9.3') throw new Error('TypeScript 5.9.3 required');
const hash = value => createHash('sha256').update(value).digest('hex');
const inputBytes = await readFile(inputsPath);
const inputs = JSON.parse(inputBytes);
await mkdir(workRoot);
const units = [];
for (const unit of inputs.units) {
  const world = resolve(workRoot, unit.id);
  const root = resolve(world, unit.root);
  const files = {};
  for (const [relative, text] of Object.entries(unit.files)) {
    const path = resolve(world, relative);
    if (!path.startsWith(world + '/')) throw new Error('outside fixture world');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    files[path] = text;
  }
  const resolver = ws.createWorkspaceLinkResolver();
  const system = ws.workspaceLinkedSystem(ts.sys, root, resolver);
  const queries = unit.queries.map(query => ({ ...query, path: resolve(world, query.path) }));
  const results = queries.map(query => ({ ...query, value: query.operation === 'read_file' ? system.readFile(query.path) ?? null : query.operation === 'file_exists' ? system.fileExists(query.path) : query.operation === 'directory_exists' ? system.directoryExists(query.path) : system.realpath(query.path) }));
  const systemInputs = [...resolver.inputs].map(([path, text]) => ({path, value:text ?? null}));
  const configResolver = ws.createWorkspaceLinkResolver();
  const reasons = unit.configuration ? diagnostic.inspectModuleConfiguration(resolve(root, 'src/specimen.js'), root, undefined, undefined, configResolver) : undefined;
  units.push({id:unit.id, root, files, queries, results, systemInputs, ...(reasons ? {reasons, configurationInputs:[...configResolver.inputs].map(([path,text])=>({path,value:text ?? null}))}: {})});
}
await writeFile(outputPath, JSON.stringify({ authority:{typescript:ts.version,caseSensitive:ts.sys.useCaseSensitiveFileNames, workspaceSourceSha256:hash(await readFile(wsPath)), diagnosticSourceSha256:hash(await readFile(diagnosticPath)), inputsSha256:hash(inputBytes)}, units },null,2)+'\n');
