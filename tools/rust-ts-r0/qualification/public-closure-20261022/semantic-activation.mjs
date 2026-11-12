import ts from "typescript";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [baselineRoot, contractsPath, inputsPath, reportPath, workRoot] = process.argv.slice(2);
if (!workRoot || ts.version !== "5.9.3") throw new Error("expected baseline contracts inputs report fresh-work-root with TypeScript 5.9.3");
const sourcePath = resolve(baselineRoot, "packages/ts-analyzer/src/semantic-dependency-diagnostics.ts");
const sourceText = await readFile(sourcePath, "utf8");
const contracts = JSON.parse(await readFile(contractsPath, "utf8")).rows.filter(row => row.apiSites.every(site => site.path.endsWith("semantic-dependency-diagnostics.ts")));
const source = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const siteNodes = new Map();
for (const row of contracts) for (const [index, site] of row.apiSites.entries()) {
  const start = source.getPositionOfLineAndCharacter(site.line - 1, site.column - 1);
  const end = source.getPositionOfLineAndCharacter(site.end_line - 1, site.end_column - 1);
  const key = `${start}:${end}`;
  const values = siteNodes.get(key) ?? [];
  values.push(`${row.index}:${index}`);
  siteNodes.set(key, values);
}
const found = new Set();
const transformer = context => root => {
  const visit = node => {
    const key = `${node.getStart(source)}:${node.end}`;
    const direct = siteNodes.get(key) ?? [];
    const method = ts.isCallExpression(node) ? siteNodes.get(`${node.expression.getStart(source)}:${node.expression.end}`) ?? [] : [];
    const deferred = node.parent !== undefined && ts.isCallExpression(node.parent) && node.parent.expression === node;
    let result = ts.visitEachChild(node, visit, context);
    for (const id of [...method, ...(deferred ? [] : direct)]) {
      found.add(id);
      result = ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier("globalThis"), "__semctxTrace"), undefined, [ts.factory.createStringLiteral(id), result]);
    }
    return result;
  };
  return ts.visitNode(root, visit);
};
let instrumented = ts.createPrinter().printFile(ts.transform(source, [transformer]).transformed[0]);
instrumented = instrumented.replace('from "typescript"', `from ${JSON.stringify(resolve(baselineRoot, "node_modules/typescript/lib/typescript.js"))}`)
  .replace('from "./ts-symbols"', `from ${JSON.stringify(resolve(baselineRoot, "packages/ts-analyzer/src/ts-symbols.ts"))}`)
  .replace('from "./javascript-diagnostics"', `from ${JSON.stringify(resolve(baselineRoot, "packages/ts-analyzer/src/javascript-diagnostics.ts"))}`);
const missing = contracts.flatMap(row => row.apiSites.map((site, index) => ({ id: `${row.index}:${index}`, site }))).filter(item => !found.has(item.id));
if (missing.length) throw new Error(`unmapped API sites: ${JSON.stringify(missing)}`);
await mkdir(workRoot);
const instrumentedPath = resolve(workRoot, "instrumented-semantic.ts");
await writeFile(instrumentedPath, instrumented);
let hits;
globalThis.__semctxTrace = (id, value) => {
  const category = value === undefined ? "undefined" : value === null ? "null" : typeof value === "object" ? Array.isArray(value) ? `array:${value.length}` : typeof value.kind === "number" ? `node:${ts.SyntaxKind[value.kind]}` : typeof value.flags === "number" ? `flags:${value.flags}` : "object" : typeof value === "function" ? "function" : JSON.stringify(value);
  const entry = hits[id] ?? { count: 0, outcomes: [] };
  entry.count += 1;
  if (!entry.outcomes.includes(category)) entry.outcomes.push(category);
  hits[id] = entry;
  return value;
};
const observed = await import(instrumentedPath);
const original = await import(sourcePath);
const inputs = JSON.parse(await readFile(inputsPath, "utf8"));
const units = [];
for (const [index, input] of inputs.units.entries()) {
  if (input.operation !== "semantic") continue;
  const root = resolve(workRoot, `input-${index}`);
  await mkdir(root);
  const retained = new Map();
  for (const [path, text] of Object.entries(input.files)) {
    const absolute = resolve(root, path);
    if (!absolute.startsWith(root + "/")) throw new Error("input leaves root");
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, text);
    retained.set(absolute, text);
  }
  const path = resolve(root, input.path);
  const bound = ts.createSourceFile(path, input.files[input.path], ts.ScriptTarget.Latest, true);
  const expected = original.inspectSemanticDependencies(bound, retained, path);
  hits = {};
  const actual = observed.inspectSemanticDependencies(bound, retained, path);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`instrumentation changed observable ${input.id}`);
  units.push({ id: input.id, expected, unchangedByInstrumentation: true, sites: hits });
}
const rows = contracts.map(row => {
  const sites = row.apiSites.map((site, index) => {
    const id = `${row.index}:${index}`;
    const witnesses = units.filter(unit => unit.sites[id]).map(unit => ({ id: unit.id, ...unit.sites[id] }));
    return { id, ...site, witnesses };
  });
  return { index: row.index, consumer: row.consumer, sites, sitesTotal: sites.length, sitesActivated: sites.filter(site => site.witnesses.length > 0).length };
});
await writeFile(reportPath, JSON.stringify({ baselineCommit: "3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b", typescript: ts.version, sourceSha256: createHash("sha256").update(sourceText).digest("hex"), inputsSha256: createHash("sha256").update(await readFile(inputsPath)).digest("hex"), mechanism: "Expression result identity wrapper, method calls wrapped as whole calls to preserve receivers; exact source site positions; original full reason equality checked for every input", units, rows }, null, 2) + "\n");
