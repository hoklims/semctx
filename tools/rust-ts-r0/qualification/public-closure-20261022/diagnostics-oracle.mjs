import ts from "typescript";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";

const [baselineRoot, inputPath, contractsPath, outputPath, evidencePath, workRoot] = process.argv.slice(2);
if (!workRoot || ts.version !== "5.9.3") throw new Error("expected baseline inputs contracts manifest activation fresh-work-root with TypeScript 5.9.3");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const inputBytes = await readFile(inputPath);
const inputs = JSON.parse(inputBytes);
const contracts = JSON.parse(await readFile(contractsPath, "utf8"));
const selected = contracts.rows.filter(row => inputs.obligation_indices.includes(row.index));
const sourcePath = resolve(baselineRoot, "packages/ts-analyzer/src/javascript-diagnostics.ts");
const sourceBytes = await readFile(sourcePath);
const text = sourceBytes.toString();
const parsed = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const nodes = [];
const visit = node => { nodes.push(node); ts.forEachChild(node, visit); };
visit(parsed);
const ranges = new Map();
const sites = [];
for (const row of selected) for (const [ordinal, site] of row.apiSites.entries()) {
  const id = `${row.index}:${ordinal}`;
  const start = parsed.getPositionOfLineAndCharacter(site.line - 1, site.column - 1);
  let node = nodes.find(node => node.getStart(parsed) === start && node.getText(parsed) === site.expression);
  if (!node) throw new Error(`site not located ${id}: ${site.expression}`);
  if (ts.isCallExpression(node.parent) && node.parent.expression === node) node = node.parent;
  const key = `${node.getStart(parsed)}:${node.end}`;
  if (!ranges.has(key)) ranges.set(key, { start: node.getStart(parsed), end: node.end, ids: [] });
  ranges.get(key).ids.push(id);
  sites.push({ id, index: row.index, expression: site.expression, line: site.line, column: site.column });
}
const edits = new Map();
const add = (at, value) => edits.set(at, (edits.get(at) ?? "") + value);
const sortedRanges = [...ranges.values()].sort((a, b) => a.start - b.start || b.end - a.end);
for (const range of sortedRanges) {
  add(range.start, `globalThis.__publicDiagnosticsTrace(${JSON.stringify(range.ids)},(`);
  add(range.end, "))");
}
let instrumentedText = text;
for (const [at, value] of [...edits.entries()].sort(([a], [b]) => b - a)) instrumentedText = instrumentedText.slice(0, at) + value + instrumentedText.slice(at);
const instrumentedPath = resolve(dirname(sourcePath), "diagnostics-public-closure-instrumented.ts");
await writeFile(instrumentedPath, instrumentedText);
const baseline = await import(sourcePath);
const instrumented = await import(instrumentedPath);
await mkdir(workRoot);
const units = [];
const activations = [];
for (const [ordinal, input] of inputs.units.entries()) {
  const root = resolve(workRoot, `oracle-${ordinal}`);
  await mkdir(root);
  const retained = new Map();
  for (const [path, content] of Object.entries(input.files)) {
    const absolute = resolve(root, path);
    if (!absolute.startsWith(root + "/")) throw new Error("input leaves root");
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
    retained.set(absolute, content);
  }
  const path = resolve(root, input.path);
  const content = input.files[input.path];
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const observedSites = new Map();
  const values = new Map();
  const summarize = value => value === undefined ? { kind: "undefined" } : value === null || ["string", "number", "boolean"].includes(typeof value) ? value : Array.isArray(value) ? { kind: "array", length: value.length } : typeof value === "function" ? { kind: "function" } : { kind: typeof value, ...(typeof value.kind === "number" ? { syntaxKind: value.kind } : {}), ...(typeof value.fileName === "string" ? { fileName: value.fileName.startsWith(root + "/") ? value.fileName.slice(root.length + 1) : value.fileName } : {}) };
  globalThis.__publicDiagnosticsTrace = (ids, value) => { for (const id of ids) { observedSites.set(id, (observedSites.get(id) ?? 0) + 1); if (!values.has(id)) values.set(id, new Set()); values.get(id).add(JSON.stringify(summarize(value))); } return value; };
  const invoke = module => {
    if (input.operation === "javascript") return module.inspectJavaScriptSource(path, content, root, input.retained === false ? undefined : retained);
    if (input.operation === "parsing") return module.inspectSourceParsing(path, content);
    if (input.operation === "configuration") return module.inspectModuleConfiguration(path, root, input.mode === "ordinaryWithoutSnapshot" ? undefined : retained, input.mode === "retainedWithSource" ? source : undefined);
    throw new Error("unknown operation");
  };
  const expected = invoke(baseline);
  const traced = invoke(instrumented);
  if (JSON.stringify(expected) !== JSON.stringify(traced)) throw new Error(`instrumentation changed output ${input.id}`);
  const prefix = ["subjects", { path: input.path }, input.operation === "javascript" ? "javascriptObservation" : input.operation === "parsing" ? "sourceParsingObservation" : "moduleConfigurationObservations"];
  if (input.operation === "configuration") prefix.push(input.mode);
  const fields = input.operation === "javascript" ? Object.entries(expected) : [["reasons", expected]];
  const checks = [...fields, ["executed", true], ["unsupported", []]].map(([field, value]) => ({ observation: 0, target: [...prefix, field], mode: "eq", expected: value, expected_origin: "typescript-5.9.3", actual_transform: "none", operation_binding: { status: "VERIFIED_SOURCE_OPERATION", target: [...prefix, field], baseline_operation: input.operation === "javascript" ? "inspectJavaScriptSource" : input.operation === "parsing" ? "inspectSourceParsing" : "inspectModuleConfiguration", authority: { baseline: "3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b", typescript: ts.version, sourceSha256: sha256(sourceBytes), inputSha256: sha256(inputBytes) } } }));
  units.push({ unit_id: input.id, surface: "raw_cli", requests: [{ id: input.id, files: input.files, roots: Object.keys(input.files).filter(path => /\.(?:[cm]?[tj]sx?)$/.test(path)), options: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", allowJs: true, jsx: "Preserve", skipLibCheck: true, noEmit: true, strict: false }, retained: input.retained !== false, qualified: false, sdk_directory: "/sdk/lib", roles: {}, selection: {}, disabled: [], utf16_files: {}, raw_files: {} }], checks, gaps: [], physical_live_after_capture: {}, independent_input_origin: input.origin, obligation_indices: input.obligation_indices });
  activations.push({ unit_id: input.id, operation: input.operation, mode: input.mode, sites: Object.fromEntries([...observedSites].sort()), values: Object.fromEntries([...values].map(([id, values]) => [id, [...values].map(value => JSON.parse(value))])), oracle_output: expected, instrumented_output_identical: true });
}
const identity = { baseline: "3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b", typescript_version: ts.version, source_sha256: sha256(sourceBytes), input_sha256: sha256(inputBytes), instrumented_sha256: sha256(instrumentedText), case_sensitive: ts.sys.useCaseSensitiveFileNames };
await writeFile(outputPath, JSON.stringify({ schema_version: 1, oracle: identity, units }, null, 2) + "\n");
await writeFile(evidencePath, JSON.stringify({ schemaVersion: 1, authority: identity, instrumentation: "Record and return each exact original expression value (or complete call result when the expression is its callee); all original bytes including JSDoc and pragmas retained. Complete outputs must equal the uninstrumented operation.", sites: sites.map(site => ({ ...site, activating_units: activations.filter(unit => unit.sites[site.id]).map(unit => unit.unit_id) })), units: activations }, null, 2) + "\n");
