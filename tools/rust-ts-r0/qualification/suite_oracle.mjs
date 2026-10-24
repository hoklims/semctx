import ts from "typescript";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";

const [baselineRoot, inputPath, outputPath, workRoot] = process.argv.slice(2);
if (!baselineRoot || !inputPath || !outputPath || !workRoot) throw new Error("expected baseline inputs output fresh-work-root");
if (ts.version !== "5.9.3") throw new Error("oracle requires TypeScript 5.9.3");
const outline = await import(resolve(baselineRoot, "packages/ts-analyzer/src/top-level-outline.ts"));
const diagnostics = await import(resolve(baselineRoot, "packages/ts-analyzer/src/javascript-diagnostics.ts"));
const semantic = await import(resolve(baselineRoot, "packages/ts-analyzer/src/semantic-dependency-diagnostics.ts"));
const symbols = await import(resolve(baselineRoot, "packages/ts-analyzer/src/ts-symbols.ts"));
const pilot = await import(resolve(baselineRoot, "scripts/pilot/baselines.ts"));
const sourceFiles = ["top-level-outline.ts", "javascript-diagnostics.ts", "semantic-dependency-diagnostics.ts", "ts-symbols.ts"];
const sourceIdentities = await Promise.all(sourceFiles.map(async name => {
  const path = resolve(baselineRoot, "packages/ts-analyzer/src", name);
  return { path: `packages/ts-analyzer/src/${name}`, sha256: createHash("sha256").update(await readFile(path)).digest("hex") };
}));
sourceIdentities.push({ path: "scripts/pilot/baselines.ts", sha256: createHash("sha256").update(await readFile(resolve(baselineRoot, "scripts/pilot/baselines.ts"))).digest("hex") });
const inputBytes = await readFile(inputPath);
const inputs = JSON.parse(inputBytes.toString());
await mkdir(workRoot);
const units = [];
for (const [index, input] of inputs.units.entries()) {
  const root = resolve(workRoot, `oracle-${index}`);
  await mkdir(root);
  const retained = new Map();
  for (const [path, text] of Object.entries(input.files)) {
    const absolute = resolve(root, path);
    if (!absolute.startsWith(root + "/")) throw new Error("oracle input leaves its root");
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, text);
    retained.set(absolute, text);
  }
  const path = resolve(root, input.path);
  const text = input.files[input.path];
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  if (input.operation === "relative") {
    units.push({ unit_id: input.id, surface: "primitive_cli", primitive_requests: [{ operation: "relative_import_specifiers", source: text, filename: input.path }], checks: [{ observation: 0, target: ["specifiers"], mode: "eq", expected: pilot.extractRelativeImportSpecifiers(text, input.path), expected_origin: "typescript-5.9.3", actual_transform: "none" }], gaps: [], independent_input_origin: input.origin, obligation_indices: input.obligation_indices });
    continue;
  }
  let expected;
  let target;
  let operation;
  if (input.operation === "extraction") {
    expected = symbols.extractTypeScript(Object.keys(input.files).filter(file => /\.(?:[cm]?[tj]sx?)$/.test(file)).map(file => resolve(root, file)), root, input.retained === false ? undefined : retained);
    target = ["raw_extraction"];
    operation = "extractTypeScript";
  } else if (input.operation === "parsing") {
    expected = diagnostics.inspectSourceParsing(path, text);
    target = ["subjects", { path: input.path }, "sourceParsingObservation", "reasons"];
    operation = "inspectSourceParsing";
  } else if (input.operation === "native_bindings") {
    expected = diagnostics.inspectNativeModuleBindings(source);
    target = ["subjects", { path: input.path }, "javascript", "native"];
    operation = "inspectNativeModuleBindings";
  } else if (input.operation === "outline_links") {
    expected = outline.outlineModuleLinks(text, input.path);
    target = ["outlines", input.path, "moduleLinks"];
    operation = "outlineModuleLinks";
  } else if (input.operation === "outline") {
    expected = outline.outlineTopLevel(text, input.path);
    target = ["outlines", input.path, "outline"];
    operation = "outlineTopLevel";
  } else if (input.operation === "javascript") {
    expected = diagnostics.inspectJavaScriptSource(path, text, root, retained).reasons;
    target = ["subjects", { path: input.path }, "javascriptObservation", "reasons"];
    operation = "inspectJavaScriptSource";
  } else if (input.operation === "configuration") {
    expected = diagnostics.inspectModuleConfiguration(path, root, retained, source);
    target = ["subjects", { path: input.path }, "moduleConfigurationObservations", "retainedWithSource", "reasons"];
    operation = "inspectModuleConfiguration";
  } else if (input.operation === "semantic") {
    expected = semantic.inspectSemanticDependencies(source, retained, path);
    target = ["subjects", { path: input.path }, "semanticObservation", "reasons"];
    operation = "inspectSemanticDependencies";
  } else throw new Error("unknown oracle operation");
  const oracleFullValue = structuredClone(expected);
  if (input.operation === "extraction") {
    expected = structuredClone(expected);
    const canonical = value => JSON.stringify(value, (_key, field) => field && !Array.isArray(field) && typeof field === "object" ? Object.fromEntries(Object.entries(field).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : field);
    for (const rows of Object.values(expected)) rows.sort((left, right) => canonical(left) < canonical(right) ? -1 : canonical(left) > canonical(right) ? 1 : 0);
  }
  if (input.operation === "outline") {
    expected = structuredClone(expected);
    for (const statement of expected.statements) delete statement.digest;
  }
  const check = { observation: 0, target, mode: "eq", expected, expected_origin: "typescript-5.9.3", actual_transform: input.operation === "outline" ? "outline_without_digest_bytes" : input.operation === "extraction" ? "baseline_raw_extraction" : "none", operation_binding: { status: "VERIFIED_SOURCE_OPERATION", target, baseline_operation: operation, authority: { baseline: "3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b", typescript: ts.version, sourceIdentities, inputSha256: createHash("sha256").update(inputBytes).digest("hex") } } };
  const checks = [check];
  if (["javascript", "configuration", "semantic", "parsing"].includes(input.operation)) {
    const prefix = target.slice(0, -1);
    for (const [field, value] of [["executed", true], ["unsupported", []]]) checks.push({ observation: 0, target: [...prefix, field], mode: "eq", expected: value, expected_origin: "typescript-5.9.3", actual_transform: "none" });
  }
  units.push({ oracle_full_value: oracleFullValue, unit_id: input.id, surface: "raw_cli", requests: [{ id: input.id, files: input.files, roots: Object.keys(input.files).filter(path => /\.(?:[cm]?[tj]sx?)$/.test(path)), options: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", allowJs: true, jsx: "Preserve", skipLibCheck: true, noEmit: true, strict: false }, retained: input.retained !== false, qualified: false, sdk_directory: "/sdk/lib", roles: {}, selection: {}, disabled: [], utf16_files: {}, raw_files: {} }], checks, gaps: [], physical_live_after_capture: {}, independent_input_origin: input.origin, obligation_indices: input.obligation_indices });
}
for (const [index, pair] of (inputs.digestPairs ?? []).entries()) {
  const before = outline.outlineTopLevel(pair.before, "main.ts");
  const after = outline.outlineTopLevel(pair.after, "main.ts");
  if (before.statements.length !== 1 || after.statements.length !== 1) throw new Error("digest pair requires exactly one statement per side");
  const prototype = units.find(unit => unit.surface === "raw_cli").requests[0];
  const requests = [pair.before, pair.after].map((source, observation) => ({ ...prototype, id: `SUITE-digest-pair-${index}-${observation}`, files: { "main.ts": source }, roots: ["main.ts"] }));
  const checks = [before, after].map((value, observation) => { const expected = structuredClone(value); for (const statement of expected.statements) delete statement.digest; return { observation, target: ["outlines", "main.ts", "outline"], mode: "eq", expected, expected_origin: "typescript-5.9.3", actual_transform: "outline_without_digest_bytes" }; });
  const relations = [{ left_observation: 0, right_observation: 1, target: ["outlines", "main.ts", "outline", "statements", 0, "digest"], transform: "none", expected_equal: before.statements[0].digest === after.statements[0].digest, origin: pair.origin }];
  units.push({ unit_id: `SUITE-digest-pair-${index}`, surface: "raw_cli", requests, checks, relations, gaps: [], physical_live_after_capture: {}, independent_input_origin: pair.origin, obligation_indices: [166], oracle_full_values: [before, after] });
}
await writeFile(outputPath, JSON.stringify({ schema_version: 1, oracle: { typescript_version: ts.version, baseline: "3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b", sourceIdentities, inputs_sha256: createHash("sha256").update(inputBytes).digest("hex") }, units }, null, 2) + "\n");
