import ts from "typescript";
import { publicDigest, rawContextChecks, validatePublicUnits } from "../tools/rust-ts-r0/qualification/public-closure-20261022/public-native-context.mjs";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type Phase = { reasons: string[]; executed: boolean; unsupported: string[] };
type Observation = { beforeAnalysis: Phase; afterAnalysis: Phase; afterGraphEdgesRemoved: Phase; semanticReasons: string[] };
const prefix = "import { register } from 'opaque'; function helper() { return 1; } ";
export const ownerWitnesses = [
  ["named", "export function owner(){ return register(()=>helper()); }", "named body / relative coordinate"],
  ["named-reference", "export function owner(){ return register(()=>helper); }", "same owner, absent callback invocation"],
  ["default", "export default function(){ return register(()=>helper()); }", "anonymous default owner"],
  ["default-reference", "export default function(){ return register(()=>helper); }", "anonymous default control"],
  ["nested", "export function outer(){function owner(){return register(()=>helper());} return owner();}", "outermost-first named scope"],
  ["nested-reference", "export function outer(){function owner(){return register(()=>helper);} return owner();}", "nested scope control"],
  ["namespace", "namespace Space {export function owner(){return register(()=>helper());}}", "namespace scope"],
  ["namespace-reference", "namespace Space {export function owner(){return register(()=>helper);}}", "namespace scope control"],
  ["method", "export class Box {run(){ function owner(){return register(()=>helper());} return owner();}}", "class / method / function scope"],
  ["method-reference", "export class Box {run(){ function owner(){return register(()=>helper);} return owner();}}", "class / method scope control"],
  ["overload", "export function owner():unknown; export function owner(){return register(()=>helper());}", "bodyless signature plus implementation"],
  ["nameless", "function () { return register(()=>helper()); }", "parser-recovered empty-name declaration; no undefined-owner coverage"],
] as const;

export function ownerObservationMatches(expected: Observation, native: unknown): boolean {
  if (typeof native !== "object" || native === null) return false;
  const value = native as Record<string, unknown>;
  const ownership = value["opaqueCallbackOwnership"] as Record<string, unknown> | undefined;
  const semantic = value["semanticObservation"] as Phase | undefined;
  if (!ownership || ownership["executed"] !== true || JSON.stringify(ownership["unsupported"]) !== "[]") return false;
  if (!semantic || !Array.isArray(semantic.reasons) || !semantic.reasons.every(reason => typeof reason === "string") || semantic.executed !== true || JSON.stringify(semantic.unsupported) !== "[]") return false;
  if (JSON.stringify(semantic.reasons) !== JSON.stringify(expected.semanticReasons)) return false;
  return (["beforeAnalysis", "afterAnalysis", "afterGraphEdgesRemoved"] as const).every(key => {
    const actual = ownership[key] as Phase | undefined;
    return Array.isArray(actual?.reasons) && actual.reasons.every(reason => typeof reason === "string")
      && Array.isArray(expected[key].reasons) && actual.executed === true && JSON.stringify(actual.unsupported) === "[]"
      && JSON.stringify(actual.reasons) === JSON.stringify(expected[key].reasons);
  });
}

const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const phase = (reasons: string[]): Phase => ({ reasons, executed: true, unsupported: [] });
const save = async (path: string, value: unknown): Promise<void> => { await writeFile(path, JSON.stringify(value, null, 2) + "\n"); };

async function oracle(baseline: string, output: string): Promise<void> {
  if (ts.version !== "5.9.3") throw new Error("TypeScript 5.9.3 required");
  await mkdir(output, { recursive: true });
  const symbolsPath = resolve(baseline, "packages/ts-analyzer/src/ts-symbols.ts");
  const source = await readFile(symbolsPath, "utf8");
  if (sha256(source) !== "259b92fde8c66d72adb5dce767248bd8426f017c7885007f6ec6107a3b54716e") throw new Error("baseline source identity mismatch");
  const traced = resolve(output, "traced-source");
  await cp(resolve(baseline, "packages/ts-analyzer/src"), traced, { recursive: true });
  const start = source.indexOf("export function retainedFunctionOwnerCoordinate(");
  const end = source.indexOf("\nfunction resolveCallTarget(", start);
  if (start < 0 || end < 0) throw new Error("owner source boundary missing");
  const original = source.slice(start, end);
  const instrumented = original
    .replace("const name = scopeNameOf(declaration);", 'const name = globalThis.__lot3OwnerTrace("name", scopeNameOf(declaration));')
    .replace("declaration.body === undefined", 'globalThis.__lot3OwnerTrace("body", declaration.body) === undefined')
    .replace("declaration.getSourceFile().fileName", 'globalThis.__lot3OwnerTrace("source", declaration.getSourceFile().fileName)')
    .replace("symbolScopePath(enclosingScopeOf(declaration, true), name)", 'globalThis.__lot3OwnerTrace("symbolPath", symbolScopePath(enclosingScopeOf(declaration, true), name))');
  await writeFile(resolve(traced, "ts-symbols.ts"), source.slice(0, start) + instrumented + source.slice(end));
  const originalModules = {
    analyze: await import(resolve(baseline, "packages/ts-analyzer/src/analyze.ts")) as typeof import("../packages/ts-analyzer/src/analyze"),
    semantic: await import(resolve(baseline, "packages/ts-analyzer/src/semantic-dependency-diagnostics.ts")) as typeof import("../packages/ts-analyzer/src/semantic-dependency-diagnostics"),
    diagnostics: await import(resolve(baseline, "packages/ts-analyzer/src/javascript-diagnostics.ts")) as typeof import("../packages/ts-analyzer/src/javascript-diagnostics"),
  };
  const tracedModules = {
    analyze: await import(resolve(traced, "analyze.ts")) as typeof originalModules.analyze,
    semantic: await import(resolve(traced, "semantic-dependency-diagnostics.ts")) as typeof originalModules.semantic,
    diagnostics: await import(resolve(traced, "javascript-diagnostics.ts")) as typeof originalModules.diagnostics,
  };
  const core = await import(resolve(baseline, "packages/core/src/index.ts")) as typeof import("../packages/core/src/index");
  const globalTrace = globalThis as typeof globalThis & { __lot3OwnerTrace?: (site: string, value: unknown) => unknown };
  let hits: { site: string; value: unknown; semanticCaller: boolean }[] = [];
  globalTrace.__lot3OwnerTrace = (site, value) => {
    hits.push({ site, value: value === undefined ? "undefined" : typeof value === "object" ? "body-node" : value, semanticCaller: new Error().stack?.includes("inlineOwned") === true });
    return value;
  };
  const sourceIdentities = await Promise.all(["ts-symbols.ts", "analyze.ts", "javascript-diagnostics.ts", "semantic-dependency-diagnostics.ts"].map(async name => ({ path: `packages/ts-analyzer/src/${name}`, sha256: sha256(await readFile(resolve(baseline, "packages/ts-analyzer/src", name))) })));
  const units = [];
  for (const [id, authored, predicate] of ownerWitnesses) {
    const root = resolve(output, "work", id);
    const path = resolve(root, "src/owner.ts");
    const content = prefix + authored;
    const files = { "src/owner.ts": content, "package.json": '{"dependencies":{"opaque":"1.0.0"}}' };
    for (const [file, text] of Object.entries(files)) { await mkdir(dirname(resolve(root, file)), { recursive: true }); await writeFile(resolve(root, file), text); }
    const config = { ...core.createGlobSelectionConfig(root), selectionMode: "qualified-static-v1" as const, analysisProfile: "modelo-suite-static-v1" as never };
    const discovered = [{ absPath: path, relPath: "src/owner.ts", role: "source" as const, language: "typescript" as const, content }];
    const run = (modules: typeof originalModules): Observation => {
      const snapshot = new Map(Object.entries(files).map(([file, text]) => [resolve(root, file), text]));
      const before = modules.diagnostics.inspectModuleConfiguration(path, root, snapshot);
      const analysis = modules.analyze.analyzeRepository(config, discovered, snapshot);
      const after = modules.diagnostics.inspectModuleConfiguration(path, root, snapshot);
      const semantic = modules.semantic.inspectSemanticDependencies(ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true), snapshot);
      modules.semantic.registerOpaqueCallbackOwnership(snapshot, { ...analysis.graph, edges: [] }, root);
      const removed = modules.diagnostics.inspectModuleConfiguration(path, root, snapshot);
      return { beforeAnalysis: phase(before), afterAnalysis: phase(after), afterGraphEdgesRemoved: phase(removed), semanticReasons: semantic };
    };
    const expected = run(originalModules);
    hits = [];
    const observed = run(tracedModules);
    if (JSON.stringify(expected) !== JSON.stringify(observed)) throw new Error(`instrumentation changed full observable ${id}`);
    units.push({ id, predicate, files, expected, trace: hits, instrumentationPreservesFullObservable: true });
  }
  const symbols = await import(symbolsPath) as typeof import("../packages/ts-analyzer/src/ts-symbols");
  const retained = symbols.retainedCompilerSystem(new Map());
  const directory = symbols.typeScriptLibraryDirectory();
  const lib = resolve(directory, "lib.es2022.d.ts");
  const absent = resolve(directory, "lib.lot3-absent.d.ts");
  const library = { directory, defaultLibrary: lib, systemFallbackWhenNotCaptured: retained.fileExists(lib) && retained.readFile(lib) === ts.sys.readFile(lib), missingLibrary: { exists: retained.fileExists(absent), read: retained.readFile(absent) ?? null }, uncapturedNonLibrary: { exists: retained.fileExists(symbolsPath), read: retained.readFile(symbolsPath) ?? null }, nativeLibraryDirectoryObservable: false };
  await save(resolve(output, "oracle.json"), { baseline: "3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b", typescript: ts.version, sourceSha256: sha256(source), sourceIdentities, units, library });
  delete globalTrace.__lot3OwnerTrace;
}

async function native(manifestPath: string, binary: string, sdk: string, output: string, sensitive: boolean): Promise<void> {
  await mkdir(output, { recursive: true });
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { units: { id: string; files: Record<string, string>; expected: Observation }[] };
  validatePublicUnits(manifest);
  if (manifest.units.length !== ownerWitnesses.length || ownerWitnesses.some(([id]) => !manifest.units.some(unit => unit.id === id))) throw new Error("incomplete witness set");
  const binarySha256 = sha256(await readFile(binary));
  const expectedBinary = process.platform === "darwin" ? "78d6a5b50c99bedce983f474bf11d03177ee45260112d19f47debcadf96cc9f1" : "8c7b56064812bdf4d17a1ee95b9d6e66fded896928a9a6e7172880cc318782ea";
  if (binarySha256 !== expectedBinary) throw new Error("frozen producer identity mismatch");
  const sdkBytes = await readFile(sdk);
  if (sha256(sdkBytes) !== "f57257876a383d13839a94adefb42b3d40bad2e93489a0f1a5ab29f045f139e5") throw new Error("frozen SDK identity mismatch");
  const sdkInput = JSON.parse(sdkBytes.toString()) as Record<string, unknown>;
  const units = [];
  for (const unit of manifest.units) {
    const request = { id: `lot3-owner-${unit.id}`, cwd: "/repo", sdk_directory: "/sdk/lib", case_sensitive: sensitive, roots: ["/repo/src/owner.ts"], files: Object.fromEntries(Object.entries(unit.files).map(([path, text]) => ["/repo/" + path, text])), options: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", allowJs: true, jsx: "Preserve", skipLibCheck: true, noEmit: true, strict: false }, retained: true, qualified: true, roles: {}, selection: {}, disabled: [], utf16_files: {}, raw_files: {} };
    const requestPath = resolve(output, unit.id + ".request.json");
    await save(requestPath, request);
    const child = spawnSync(binary, [requestPath, sdk], { encoding: "utf8", timeout: 30000, env: { ...process.env, GOPORT_LIB_PARSE_SNAPSHOT: "0", GOPORT_LIB_SNAPSHOT: "0" } });
    await writeFile(resolve(output, unit.id + ".stdout.json"), child.stdout ?? "");
    await writeFile(resolve(output, unit.id + ".stderr.txt"), child.stderr ?? "");
    const observed = child.status === 0 ? JSON.parse(child.stdout) as { subjects?: { path: string }[] } : undefined;
    const subject = observed?.subjects?.find(subject => subject.path === "src/owner.ts");
    const bindings = observed ? { ...rawContextChecks(observed, request, sdkInput), producerArtifactIdentity: (observed as Record<string, unknown>)["producer_artifact_id"] === `sha256:${expectedBinary}` } : { execution: false };
    units.push({ id: unit.id, bindings, pass: child.status === 0 && Object.values(bindings).every(value => value === true) && ownerObservationMatches(unit.expected, subject), exit: child.status, signal: child.signal, expected: unit.expected, actual: subject });
  }
  await save(resolve(output, "report.json"), { binarySha256: sha256(await readFile(binary)), sdkSha256: sha256(await readFile(sdk)), platform: process.platform, arch: process.arch, units, passed: units.filter(unit => unit.pass).length, total: units.length });
  const queries = [
    { operation: "directory_exists", path: "/sdk/lib" },
    { operation: "file_exists", path: "/sdk/lib/lib.es2022.d.ts" },
    { operation: "read_file", path: "/sdk/lib/lib.es2022.d.ts" },
  ];
  const library = [];
  for (const variant of ["present", "directory-without-sdk", "absent"] as const) {
    const request = { profile: "retained", root: "/repo", case_sensitive: sensitive, files: {}, sdk_directory: variant === "absent" ? null : "/sdk/lib", queries };
    const requestPath = resolve(output, `library-${variant}.request.json`);
    await save(requestPath, request);
    const child = spawnSync(binary, ["--observe-system", requestPath, ...(variant === "present" ? [sdk] : [])], { encoding: "utf8", timeout: 30000 });
    await writeFile(resolve(output, `library-${variant}.stdout.json`), child.stdout ?? "");
    await writeFile(resolve(output, `library-${variant}.stderr.txt`), child.stderr ?? "");
    const observed = child.status === 0 ? JSON.parse(child.stdout) as Record<string, unknown> : {};
    library.push({ variant, exit: child.status, signal: child.signal, requestIdentity: observed["request_descriptor_id"] === publicDigest(request), sdkIdentity: variant !== "present" || observed["sdk_input_id"] === publicDigest(sdkInput), observed });
  }
  await save(resolve(output, "library-partial.json"), { claimedEquivalentLibraryDirectoryHelper: false, library });
}

if (import.meta.main) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "oracle" && args.length === 2) await oracle(resolve(args[0]!), resolve(args[1]!));
  else if (mode === "native" && args.length === 5) await native(resolve(args[0]!), resolve(args[1]!), resolve(args[2]!), resolve(args[3]!), args[4] === "true");
  else throw new Error("expected oracle BASELINE OUTPUT | native ORACLE BINARY SDK OUTPUT CASE_SENSITIVE");
}
