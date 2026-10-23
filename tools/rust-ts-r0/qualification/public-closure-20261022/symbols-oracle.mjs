import ts from "typescript";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const [baselineRoot, inputsPath, outputPath, workRoot] = process.argv.slice(2);
if (!baselineRoot || !inputsPath || !outputPath || !workRoot) throw new Error("expected baseline inputs output fresh-work-root");
if (ts.version !== "5.9.3") throw new Error("requires TypeScript 5.9.3");
await mkdir(workRoot);
await symlink(resolve(baselineRoot, "node_modules"), resolve(workRoot, "node_modules"));
const repository = resolve(import.meta.dir, "../../../..");
const contracts = JSON.parse(await readFile(resolve(repository, "docs/research/rust-ts-r0/qualification/suite-20261022/consumer-contracts.json"), "utf8"));
const selected = new Set([159, 177, 178, 179, 180, 197, 198, 199, 200, 201, 202, 203, 204, 205, 209, 210, 211, 212, 213]);
const sourceRoot = resolve(baselineRoot, "packages/ts-analyzer/src");
const tracedRoot = resolve(workRoot, "traced-source");
await cp(sourceRoot, tracedRoot, { recursive: true });
const traceTargets = new Map();
for (const name of ["ts-symbols.ts", "top-level-outline.ts"]) {
  const sourcePath = resolve(sourceRoot, name);
  const sourceText = await readFile(sourcePath, "utf8");
  const source = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true);
  const targets = new Map();
  for (const row of contracts.rows.filter(row => selected.has(row.index) && row.source.path.endsWith("/" + name))) {
    row.source.apiSites.forEach((site, siteIndex) => {
      const start = source.getPositionOfLineAndCharacter(site.line - 1, site.column - 1);
      const end = source.getPositionOfLineAndCharacter(site.end_line - 1, site.end_column - 1);
      let found;
      const visit = node => {
        if (node.getStart(source) === start && node.getEnd() === end) found = node;
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (!found) throw new Error(`site not found ${row.index}:${siteIndex}`);
      if (ts.isCallExpression(found.parent) && found.parent.expression === found) found = found.parent;
      const key = `${found.getStart(source)}:${found.getEnd()}`;
      const id = `${row.index}:${siteIndex}`;
      targets.set(key, [...(targets.get(key) ?? []), id]);
      traceTargets.set(id, { index: row.index, siteIndex, site, matchedSource: sourceText.slice(found.getStart(source), found.getEnd()) });
    });
  }
  const transformed = ts.transform(source, [context => {
    const visit = node => {
      let result = ts.visitEachChild(node, visit, context);
      for (const id of targets.get(`${node.getStart(source)}:${node.getEnd()}`) ?? []) {
        result = context.factory.createCallExpression(context.factory.createPropertyAccessExpression(context.factory.createIdentifier("globalThis"), "__publicSymbolsTrace"), undefined, [context.factory.createStringLiteral(id), result]);
      }
      return result;
    };
    return node => ts.visitNode(node, visit);
  }]);
  await writeFile(resolve(tracedRoot, name), "globalThis.__publicSymbolsTrace ??= (_id, value) => value;\n" + ts.createPrinter().printFile(transformed.transformed[0]));
  transformed.dispose();
}
const generation = spawnSync(process.execPath, ["--tsconfig-override", resolve(baselineRoot, "tsconfig.json"), resolve(repository, "tools/rust-ts-r0/qualification/suite_oracle.mjs"), baselineRoot, inputsPath, outputPath, resolve(workRoot, "oracle")], { encoding: "utf8" });
if (generation.status !== 0) throw new Error(generation.stderr || generation.stdout);
const manifest = JSON.parse(await readFile(outputPath, "utf8"));
const inputs = JSON.parse(await readFile(inputsPath, "utf8"));
for (const [index, input] of inputs.units.entries()) {
  if (input.operation === "outline") {
    const unit = manifest.units[index];
    unit.checks.push({ observation: 0, target: ["outlines", input.path, "outline", "hasSyntaxErrors"], mode: "eq", expected: unit.oracle_full_value.hasSyntaxErrors, expected_origin: "typescript-5.9.3", actual_transform: "none" });
  }
}
const tracedSymbols = await import(resolve(tracedRoot, "ts-symbols.ts"));
const tracedOutline = await import(resolve(tracedRoot, "top-level-outline.ts"));
const traces = [];
const originalSymbols = await import(resolve(sourceRoot, "ts-symbols.ts"));
const canonical = value => JSON.stringify(value, (_key, field) => field && !Array.isArray(field) && typeof field === "object" ? Object.fromEntries(Object.entries(field).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : field);
for (const [index, input] of inputs.units.entries()) {
  const root = resolve(workRoot, "oracle", `oracle-${index}`);
  const hits = new Map();
  globalThis.__publicSymbolsTrace = (id, value) => {
    const summary = value === undefined ? "undefined" : value === null ? "null" : typeof value === "object" ? Array.isArray(value) ? `array:${value.length}` : `object:${value.kind ?? "other"}` : typeof value === "function" ? "function" : `${typeof value}:${String(value)}`;
    const values = hits.get(id) ?? new Set();
    values.add(summary);
    hits.set(id, values);
    return value;
  };
  const retained = new Map(Object.entries(input.files).map(([path, text]) => [resolve(root, path), text]));
  const actual = input.operation === "outline" ? tracedOutline.outlineTopLevel(input.files[input.path], input.path) : tracedSymbols.extractTypeScript(Object.keys(input.files).filter(path => /\.(?:[cm]?[tj]sx?)$/.test(path)).map(path => resolve(root, path)), root, input.retained === false ? undefined : retained);
  const expected = manifest.units[index].oracle_full_value;
  if (canonical(actual) !== canonical(expected)) throw new Error(`instrumentation changed owning output: ${input.id}`);
  traces.push({ unit_id: input.id, uninstrumentedOutputEqual: true, sites: Object.fromEntries([...hits].map(([id, values]) => [id, [...values].sort()])) });
}
const parallelInputs = JSON.parse(await readFile(resolve(repository, "docs/research/rust-ts-r0/qualification/public-closure-20261022/symbolsparallel-inputs.json"), "utf8"));
const parallelUnits = [];
for (const [index, input] of parallelInputs.units.entries()) {
  const root = resolve(workRoot, `parallel-${index}`);
  await mkdir(root);
  for (const [path, text] of Object.entries(input.files)) await writeFile(resolve(root, path), text);
  const roots = input.roots.map(path => resolve(root, path));
  const expected = await originalSymbols.extractTypeScriptParallel(roots, root, input.workers);
  const hits = new Map();
  globalThis.__publicSymbolsTrace = (id, value) => { const values = hits.get(id) ?? new Set(); values.add(value === undefined ? "undefined" : typeof value === "object" ? Array.isArray(value) ? `array:${value.length}` : "object" : `${typeof value}:${String(value)}`); hits.set(id, values); return value; };
  const actual = await tracedSymbols.extractTypeScriptParallel(roots, root, input.workers);
  if (canonical(actual) !== canonical(expected)) throw new Error(`parallel instrumentation changed output: ${input.unit_id}`);
  traces.push({ unit_id: input.unit_id, uninstrumentedOutputEqual: true, sites: Object.fromEntries([...hits].map(([id, values]) => [id, [...values].sort()])) });
  parallelUnits.push({ ...input, expected, expected_origin: "typescript-5.9.3", baseline: "3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b" });
}
await writeFile(resolve(workRoot, "parallel-oracle.json"), JSON.stringify({ schemaVersion: 1, sourceIdentities: manifest.oracle.sourceIdentities, units: parallelUnits }, null, 2) + "\n");
delete globalThis.__publicSymbolsTrace;
const sourceIdentities = manifest.oracle.sourceIdentities;
const traceArtifact = { schemaVersion: 1, sourceIdentities, instrumentation: "AST expression wrappers in a disposable copy; call receivers preserved; every complete owning output equals the independent uninstrumented baseline", targets: Object.fromEntries(traceTargets), units: traces };
await writeFile(resolve(workRoot, "site-traces.json"), JSON.stringify(traceArtifact, null, 2) + "\n");
const traceBytes = await readFile(resolve(workRoot, "site-traces.json"));
manifest.oracle.activation_trace_sha256 = createHash("sha256").update(traceBytes).digest("hex");
await writeFile(outputPath, JSON.stringify(manifest, null, 2) + "\n");
process.stdout.write(JSON.stringify({ units: manifest.units.length, siteTargets: traceTargets.size, traceSha256: manifest.oracle.activation_trace_sha256 }) + "\n");
