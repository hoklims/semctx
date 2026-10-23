import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Context, Evidence, Execution, Json, Observation, Property } from "./t00-ts7-q-boundary-common";
import { isolatedEnvironment } from "./t00-ts7-q-boundary-common";

const reference = "contract-ts7.md P2 + owner decisions 2026-10-23; consumer-contracts.json finite observable rules";
const revision = "780dc512d64f40afebffa6a7028207649fb7ed1c";
const object = (value: unknown): Json => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const hash = (value: string | Uint8Array): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const property = (name: string, actual: unknown, expected: unknown, oracle = reference): Property => ({ name, actual: actual ?? null, expected, oracle, pass: isDeepStrictEqual(actual, expected) });

export function dialectProperties(observed: Json, producerId: string): Property[] {
  const subjects = array(observed.subjects).map(object);
  const paths = subjects.map(subject => subject.path);
  return [
    property("executed-compiler-version", observed.native_compiler_version, "7.1.0-dev"),
    property("executed-compiler-revision", observed.engine_revision, revision),
    property("executed-candidate-binding", observed.producer_artifact_id, producerId),
    property("analyzed-complete", observed.complete, true),
    property("capability-subjects-nonempty", subjects.length > 0, true),
    property("capability-subjects-distinct", new Set(paths).size, subjects.length),
    property("capability-paths-present", paths.every(path => typeof path === "string" && path.length > 0), true),
    property("all-subjects-native-dialect", subjects.every(subject => object(subject.capabilityScope).dialectVersion === "7.1.0-dev"), true),
    property("all-subjects-language-present", subjects.every(subject => ["typescript", "javascript"].includes(String(object(subject.capabilityScope).language))), true),
  ];
}

export function retainedSystemExecution(execution: Execution): Property {
  const rows = array(execution.value.results).map(object);
  return property("system-executed", {
    executed: execution.value.executed, exitCode: execution.exitCode, unsupported: execution.value.unsupported, reasons: execution.value.reasons,
    queries: rows.map(row => ({ executed: row.executed, unsupported: row.unsupported, refusals: row.refusals })),
  }, { executed: true, exitCode: 0, unsupported: [], reasons: [], queries: rows.map(() => ({ executed: true, unsupported: [], refusals: [] })) });
}

async function materialize(root: string, files: Record<string, string>): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const [relative, text] of Object.entries(files)) {
    const path = resolve(root, relative);
    if (!path.startsWith(`${root}/`)) throw new Error(`fixture path outside root: ${relative}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
}

async function fixtureEvidence(ctx: Context, label: string, files: Record<string, string>): Promise<Evidence> {
  return ctx.save(`${label}-fixture`, Object.entries(files).map(([path, text]) => ({ path, bytes: Buffer.byteLength(text), sha256: hash(text) })));
}

function finish(index: number, properties: Property[], evidence: Evidence[], complete: boolean, reason: string): Observation {
  return { index, properties, evidence, complete, reason };
}

async function identity(ctx: Context): Promise<Observation> {
  const files = { "entry.ts": "export const identitySubject: number = 7;\n" };
  const oracle = await ctx.oracle("168-compiler-version", files, { args: ["--version"] });
  const compiler = await ctx.oracle("168-compiler-execution", files);
  const observed = await ctx.run("168-capability", "", ctx.analysis(files));
  return finish(168, [
    property("independent-ts7-executable", oracle.stdout.trim(), "Version 7.1.0-dev", "pinned independent tsgo --version"),
    property("independent-ts7-fixture-compiles", compiler.exitCode, 0, "pinned independent tsgo --noEmit with pinned 115-library SDK"),
    ...dialectProperties(observed.value, `sha256:${ctx.producerSha256}`),
    property("exact-subject-denominator", array(observed.value.subjects).map(subject => object(subject).path), ["entry.ts"]),
  ], [...oracle.evidence, ...compiler.evidence, ...observed.evidence], false,
  "Executed TS7 identity and nonempty analyzed capability are exercised; the 16 cumulative IDENTITY supports and complete-baseline specimen have not all been independently replayed here.");
}

async function keys(ctx: Context, index: number): Promise<Observation> {
  const root = resolve(ctx.root, `filesystem-${index}`);
  await materialize(root, { "Source.ts": "export const key = 1;\n", "Other.ts": "export const key = 2;\n" });
  await symlink("Source.ts", resolve(root, "alias.ts"));
  const physical = await realpath(resolve(root, "Source.ts"));
  const properties: Property[] = [];
  const evidence: Evidence[] = [await ctx.save(`${index}-filesystem-oracle`, { source: physical, alias: await realpath(resolve(root, "alias.ts")), other: await realpath(resolve(root, "Other.ts")) })];
  for (const sensitive of [true, false]) {
    if (index === 136) {
      for (const [name, path, expectedPath] of [
        ["ordinary", "Source.ts", resolve(root, "Source.ts")],
        ["dot-alias", "folder/../Source.ts", resolve(root, "Source.ts")],
        ["distinct-leaf", "Other.ts", resolve(root, "Other.ts")],
        ["backslash", "folder\\Source.ts", `${root}/folder/Source.ts`],
        ["unicode-case", "İΣ.TS", resolve(root, "İΣ.TS")],
      ]) {
        const result = await ctx.run(`${index}-${name}-${sensitive}`, "--observe-primitives", { operation: "semantic_key", cwd: root, path, case_sensitive: sensitive });
        evidence.push(...result.evidence);
        properties.push(property(`${name}-${sensitive}`, result.value.key, sensitive ? expectedPath : expectedPath?.toLowerCase(), "native path.resolve + independent contract case projection"));
      }
    } else {
      for (const name of ["Source.ts", "alias.ts", "Other.ts"]) {
        const path = resolve(root, name);
        const actualPath = await realpath(path);
        const result = await ctx.run(`${index}-${name}-${sensitive}`, "--observe-primitives", { operation: "canonical_file_key", path, case_sensitive: sensitive, realpath_results: { [path]: actualPath } });
        evidence.push(...result.evidence);
        properties.push(property(`${name}-${sensitive}`, result.value.key, sensitive ? actualPath : actualPath.toLowerCase(), "node:fs realpath + finite canonical key contract"));
      }
      const missing = await ctx.run(`${index}-missing-realpath-${sensitive}`, "--observe-primitives", { operation: "canonical_file_key", path: resolve(root, "missing.ts"), case_sensitive: sensitive, realpath_results: {} });
      evidence.push(...missing.evidence);
      const lexical = resolve(root, "missing.ts");
      properties.push(property(`missing-realpath-falls-back-${sensitive}`, missing.value.key, sensitive ? lexical : lexical.toLowerCase(), "consumer-contracts.json /rows/170: realpath exceptions preserve the lexical path"));
      properties.push(property(`missing-realpath-success-${sensitive}`, missing.exitCode, 0));
    }
  }
  return finish(index, properties, evidence, false, index === 136
    ? "Finite lexical/case primitive vectors execute; the semantic-dependency owning operation and its retained-context usage pair are not independently composed in this witness."
    : "Real filesystem alias/target/distinct paths and realpath exception fallback execute; worker/direct extraction parity and selected-root component continuity are not exercised.");
}

async function retained(ctx: Context): Promise<Observation[]> {
  const root = resolve(ctx.root, "filesystem-retained");
  await materialize(root, { "src/entry.ts": "export const origin = 'live';\n", "live-only.ts": "export const transient = true;\n" });
  const retainedSource = "export const origin = 'captured';\n";
  const source = resolve(root, "src/entry.ts");
  const live = resolve(root, "live-only.ts");
  const missing = resolve(root, "missing.ts");
  const sdkFiles = object(ctx.sdk.files);
  const lib = Object.keys(sdkFiles).find(path => basename(path) === "lib.es5.d.ts");
  if (!lib || typeof sdkFiles[lib] !== "string") throw new Error("pinned SDK lacks lib.es5.d.ts");
  const sdkRoot = dirname(lib);
  const queries = [
    ["read_file", source], ["read_file", live], ["read_file", missing],
    ["file_exists", source], ["file_exists", live], ["file_exists", missing],
    ["directory_exists", resolve(root, "src")], ["directory_exists", root], ["directory_exists", resolve(root, "absent")],
    ["read_directory", root], ["read_file", lib], ["file_exists", lib], ["directory_exists", sdkRoot],
    ["read_file", `${sdkRoot}-foreign/lib.es5.d.ts`], ["file_exists", `${sdkRoot}-foreign/lib.es5.d.ts`],
    ["directory_exists", `${sdkRoot}-foreign`], ["realpath", source],
  ].map(([operation, path]) => ({ operation, path }));
  const observed = await ctx.run("216-retained-system-sdk", "--observe-system", {
    profile: "retained", root, case_sensitive: ctx.platform === "linux", files: { [source]: retainedSource }, sdk_directory: sdkRoot, queries,
  }, true);
  const rows = array(observed.value.results).map(object);
  const value = (index: number) => rows[index]?.value;
  const executed = retainedSystemExecution(observed);
  const denominator = property("query-denominator", rows.length, queries.length);
  const bindings = property("query-bindings", rows.map(row => ({ operation: row.operation, path: row.path })), queries);
  const reads = [
    property("retained-source-wins-live", value(0), retainedSource),
    property("live-only-read-hidden", rows[1]?.found, false),
    property("missing-read-absent", rows[2]?.found, false),
    property("explicit-sdk-read", value(10), sdkFiles[lib], "independent pinned TS7 SDK source bytes"),
    property("sibling-sdk-prefix-denied", rows[13]?.found, false),
  ];
  const existence = [
    property("retained-file-present", value(3), true), property("live-only-file-hidden", value(4), false),
    property("missing-file-absent", value(5), false), property("explicit-sdk-file-present", value(11), true),
    property("sibling-sdk-file-denied", value(14), false),
  ];
  const directories = [
    property("retained-parent-present", value(6), true), property("retained-root-present", value(7), true),
    property("missing-directory-absent", value(8), false), property("explicit-sdk-directory-present", value(12), true),
    property("sibling-sdk-directory-denied", value(15), false),
  ];
  const compilerFiles = { "entry.ts": retainedSource };
  const oracle = await ctx.oracle("216-retained-sdk-consumption", compilerFiles, { args: ["--listFilesOnly"] });
  const analyzed = await ctx.run("219-retained-source-leaf", "", ctx.analysis(compilerFiles));
  const assembly = object(analyzed.value.assembly);
  const evidence = [...observed.evidence, ...oracle.evidence, ...analyzed.evidence, await ctx.save("216-live-vs-retained-inputs", { source, live, liveSource: await readFile(source, "utf8"), retainedSource, sdkFile: lib, sdkSha256: hash(sdkFiles[lib] as string) })];
  const subjectPaths = array(analyzed.value.subjects).map(subject => object(subject).path);
  const independent = [property("independent-sdk-consumed", oracle.exitCode === 0 && oracle.stdout.includes("lib.es5.d.ts"), true, "independent TS7 --listFilesOnly")];
  return [
    finish(216, [executed, denominator, bindings, ...reads, ...existence, ...directories, property("retained-directory-enumeration-empty", value(9), []), ...independent], evidence, false, "Retained/live absence, empty enumeration, ancestor directories and explicit pinned SDK-only reads/existence/directories execute; cumulative P01 source extraction and public snapshot composition are not completely compared here."),
    finish(217, [executed, denominator, bindings, ...directories], evidence, true, "Retained ancestors, missing paths, explicit TS7 SDK directory and foreign-prefix negative control execute."),
    finish(218, [executed, denominator, bindings, ...existence], evidence, true, "Retained file, live-only/missing files and explicit TS7 SDK file with foreign-prefix negative control execute."),
    finish(219, [executed, denominator, bindings, ...reads, property("actual-source-subject", subjectPaths, ["entry.ts"]), property("actual-source-analysis-complete", analyzed.value.complete, true), property("actual-source-assembly-observed", Object.keys(assembly).length > 0, true), ...independent], evidence, false, "Retained versus live bytes and SDK-only content are compared; full independently expected source leaf graph and ordinary/qualified extraction composition are not replayed."),
  ];
}

const discoveryConfig = { version: 1, include: ["**/*"], exclude: [], languages: { typescript: "on", javascript: "on", python: "off", markdown: "off", sql: "off" }, migrationsDirs: [] };

async function discovery(ctx: Context): Promise<Observation[]> {
  const properties: Property[] = [];
  const evidence: Evidence[] = [];
  const vectors = [
    { name: "inside", files: { "entry.ts": "import { leaf } from './leaf'; export const value = leaf;\n", "leaf.ts": "export const leaf = 7;\n" }, expected: undefined },
    { name: "missing-inside", files: { "entry.ts": "import './missing';\n" }, expected: undefined },
    { name: "import-outside", files: { "entry.ts": "import '../outside';\n" }, expected: "IMPORT_OUTSIDE_REPOSITORY" },
    { name: "reference-outside", files: { "entry.ts": "/// <reference path='../outside.ts' />\nexport {};\n" }, expected: "REFERENCE_OUTSIDE_REPOSITORY" },
    { name: "bare", files: { "entry.ts": "import 'node:fs'; export {};\n" }, expected: undefined },
    { name: "dynamic-outside", files: { "entry.ts": "export const load = () => import('../outside');\n" }, expected: "IMPORT_OUTSIDE_REPOSITORY" },
  ];
  for (const vector of vectors) {
    const root = resolve(ctx.root, `filesystem-discovery-${vector.name}`);
    const files = vector.files as Record<string, string>;
    await materialize(root, files);
    const result = await ctx.run(`6-${vector.name}`, "--discover-repository", { repositoryRoot: root, config: discoveryConfig });
    const oracle = await ctx.oracle(`6-${vector.name}-ts7`, files, { args: ["--traceResolution"] });
    evidence.push(...result.evidence, ...oracle.evidence, await fixtureEvidence(ctx, `6-${vector.name}`, files));
    const candidate = array(result.value.candidates).map(object).find(row => row.relPath === "entry.ts");
    properties.push(property(`${vector.name}-candidate-present`, candidate !== undefined, true));
    if (vector.expected) {
      properties.push(property(`${vector.name}-confinement-reason`, candidate?.reason, vector.expected));
      properties.push(property(`${vector.name}-failed`, candidate?.analysisOutcome, "failed"));
      properties.push(property(`${vector.name}-not-returned-as-source`, array(result.value.files).some(file => object(file).relPath === "entry.ts"), false));
    } else {
      properties.push(property(`${vector.name}-confinement-accepted`, array(result.value.files).some(file => object(file).relPath === "entry.ts"), true));
    }
    if (vector.name === "inside") properties.push(property("independent-in-root-resolution", oracle.stdout.includes("leaf.ts") && oracle.stdout.includes("successfully resolved"), true, "independent TS7 --traceResolution"));
  }
  const root = resolve(ctx.root, "filesystem-discovery-source-link");
  const external = resolve(ctx.root, "filesystem-external-source.ts");
  await writeFile(external, "export const external = 1;\n");
  await materialize(root, { "inside.ts": "export const inside = 2;\n" });
  await symlink(external, resolve(root, "outside-link.ts"));
  const links = await ctx.run("169-outside-source-link", "--discover-repository", { repositoryRoot: root, config: discoveryConfig });
  evidence.push(...links.evidence, await ctx.save("169-link-oracle", { link: resolve(root, "outside-link.ts"), target: await realpath(resolve(root, "outside-link.ts")), repository: await realpath(root) }));
  const linkProperties = [property("outside-source-symlink-refused", array(links.value.candidates).map(object).some(row => row.relPath === "outside-link.ts" && row.reason === "SOURCE_LINK_OUTSIDE_REPOSITORY" && row.analysisOutcome === "failed"), true)];
  const missingRequest = ctx.analysis({ "entry.ts": "export const present = 1;\n" });
  const missing = await ctx.run("169-missing-retained-source", "", { ...missingRequest, files: {} });
  evidence.push(...missing.evidence);
  linkProperties.push(property("missing-retained-source-reports-refusal", missing.exitCode !== 0 || JSON.stringify(missing.value).includes("SOURCE_SNAPSHOT_MISSING"), true));
  return [
    finish(6, properties, evidence, false, "Direct discovery activates relative static/dynamic imports, references, bare imports and missing in-root source; resolved symlink escape and full JavaScript unresolved-alias owning diagnostics remain unexercised."),
    finish(169, [...properties, ...linkProperties], evidence, false, "Direct confinement and real outside-source link plus missing retained root are exercised; transitive captured-source traversal/cycles and the exact SOURCE_SNAPSHOT_MISSING extractor refusal remain incomplete."),
  ];
}

async function eligibility(ctx: Context): Promise<Observation> {
  const root = resolve(ctx.root, "filesystem-eligibility");
  const files = {
    ".gitignore": "dist/*\n!dist/tracked.ts\n",
    "dist/tracked.ts": "export const tracked = 1;\n",
    "dist/ignored.ts": "export const ignored = 1;\n",
    "dist/tsconfig.json": '{"extends":["./base",7,null,"package-name"],}\n',
    "dist/base.json": '{"extends":"./leaf"}\n',
    "dist/leaf.json": '{"extends":"./base"}\n',
    "dist/tsconfig.invalid.json": '{"extends":123}\n',
  };
  await materialize(root, files);
  const fixtureEnv = isolatedEnvironment(root);
  const init = Bun.spawnSync(["git", "init", "--quiet", root], { stdout: "pipe", stderr: "pipe", env: fixtureEnv });
  if (init.exitCode !== 0) throw new Error(`fixture Git init failed: ${init.stderr.toString()}`);
  const add = Bun.spawnSync(["git", "-C", root, "add", "--", "dist/tracked.ts"], { stdout: "pipe", stderr: "pipe", env: fixtureEnv });
  if (add.exitCode !== 0) throw new Error(`fixture Git add failed: ${add.stderr.toString()}`);
  const queries = ["src/ordinary.ts", "node_modules/a.ts", ".git/config", ".semctx/state.json", "dist/ignored.ts", "dist/tracked.ts", "dist/tsconfig.json", "dist/base.json", "dist/leaf.json", "dist/package.json", "dist/.gitignore", "dist/chosen.ts", "dist/excluded.ts", "dist/not-extended.json"];
  const expected = [true, false, false, false, false, true, true, true, true, true, true, true, false, false];
  const descriptor = { repositoryRoot: root, processHelper: ctx.helper, include: ["dist/chosen.ts", "dist/excluded.ts"], exclude: ["dist/excluded.ts"], queries };
  const result = await ctx.run("5-eligibility", "--observe-path-eligibility", descriptor);
  const noGit = resolve(ctx.root, "filesystem-not-git");
  await mkdir(noGit, { recursive: true });
  const negative = await ctx.run("5-git-failure", "--observe-path-eligibility", { ...descriptor, repositoryRoot: noGit });
  const oracle = await ctx.oracle("5-jsonc-extends-compiler", { "entry.ts": "export {};\n", "tsconfig.base.json": '{"compilerOptions":{"strict":true}}\n' });
  return finish(5, [
    property("eligible-finite-vector", result.value.eligible_results, expected),
    property("eligibility-established", result.value.eligibility_established, true),
    property("git-failure-no-eligibility", negative.value.eligibility_established, false),
    property("git-failure-error", object(negative.value.error).code, "IO_ERROR"),
    property("git-failure-no-results", negative.value.eligible_results, null),
    property("independent-compiler-control", oracle.exitCode, 0, "independent pinned TS7 CLI"),
  ], [...result.evidence, ...negative.evidence, ...oracle.evidence, await fixtureEvidence(ctx, "5", files)], false,
  "Git authored/ignored paths, hard exclusions, output selection, metadata JSONC/nonstrings/extends cycle and IO_ERROR control execute; full independent TS7 configuration graph observation is not available from this finite CLI control.");
}

async function imports(ctx: Context, indices: number[]): Promise<Observation[]> {
  const source = [
    "import { a } from './a';", "export { b } from '../b';", "export * from './a';",
    "import 'bare-package';", "import 'node:fs';", "const first = import('./dynamic');",
    "const computed = import('./' + 'computed');", "const template = import(`./template`);",
    "const required = require('./required');", "function nested() { return import('./nested'); }",
    "const double = import('./dynamic');", "const view = <div />;", "export { a };",
  ].join("\n");
  const expected = ["./a", "../b", "./a", "./dynamic", "./nested", "./dynamic"];
  const observed = await ctx.run("230-231-relative-specifiers", "--observe-primitives", { operation: "relative_import_specifiers", source, filename: "fixture.tsx" });
  const oracle = await ctx.oracle("230-231-ts7-parse-resolution", { "fixture.tsx": source, "a.ts": "export const a = 1;\n", "dynamic.ts": "export {};\n", "nested.ts": "export {};\n" }, { jsx: "preserve", args: ["--traceResolution"] });
  const empty = await ctx.run("230-231-no-relative-specifiers", "--observe-primitives", { operation: "relative_import_specifiers", source: "import 'node:fs'; require('./required'); import(`./template`); import(name); export {};", filename: "empty.tsx" });
  const evidence = [...observed.evidence, ...empty.evidence, ...oracle.evidence, await ctx.save("230-231-independent-contract-sequence", { source, expected, derivation: "Hand-authored exact finite sequence from the consumer literal AST rule, independent of producer output; CLI resolution does not provide AST visitation order." })];
  return indices.map(index => finish(index, [
    property("exact-relative-literal-sequence", observed.value.specifiers, expected),
    property("bare-require-computed-template-excluded", empty.value.specifiers, []),
    property("compiler-resolves-literal-module", oracle.stdout.includes("a.ts") && oracle.stdout.includes("successfully resolved"), true, "independent pinned TS7 --traceResolution"),
  ], evidence, false, "Literal imports/reexports/import(), nested traversal, duplicate order and bare/node:fs/require/computed/template negatives execute; TS7 CLI resolution is not an independent AST visitation oracle, so 230/231 cannot yet receive qualification credit."));
}

async function acquisition(ctx: Context, indices: number[]): Promise<Observation[]> {
  const implementation = {
    "bun.lock": "lock\n", "tsconfig.json": "{}\n", "tsconfig.base.json": "{}\n",
    "scripts/analyzer-identity.ts": "export {};\n", "scripts/build-plugin-runtime.ts": "export {};\n", "scripts/build-cli-package.ts": "export {};\n",
    "packages/sample/package.json": '{"name":"sample"}\n', "packages/sample/src/index.ts": "export const source = 1;\n",
    "apps/cli/package.json": '{"name":"cli"}\n', "apps/cli/src/index.ts": "export {};\n",
  };
  const sdkFiles = Object.fromEntries(Object.entries(object(ctx.sdk.files)).map(([path, text]) => [`lib/${basename(path)}`, String(text)]));
  const sdk = {
    ...sdkFiles,
    "package.json": JSON.stringify({ name: "typescript", version: "7.1.0-dev" }),
    "lib/typescript.js": "throw new Error('byte-acquisition specimen, not executable TypeScript');\n",
  };
  const properties: Property[] = [];
  const evidence: Evidence[] = [await fixtureEvidence(ctx, "229-implementation", implementation), await fixtureEvidence(ctx, "229-explicit-sdk", sdk)];
  type Vector = { name: string; error?: string; mutate?: (root: string, sdkRoot: string) => Promise<void>; missingSdk?: boolean };
  const external = resolve(ctx.root, "filesystem-acquisition-external.ts");
  await writeFile(external, "export const forbidden = 1;\n");
  const unlink = async (root: string, path: string) => rm(resolve(root, path));
  const vectors: Vector[] = [
    { name: "complete-explicit-sdk" },
    { name: "relocated-complete-sdk" },
    { name: "source-byte-change", mutate: async root => writeFile(resolve(root, "packages/sample/src/index.ts"), "export const source = 2;\n") },
    { name: "sdk-byte-change", mutate: async (_root, sdkRoot) => writeFile(resolve(sdkRoot, "lib/lib.es5.d.ts"), "export {};\n") },
    { name: "fixed-outside-link", error: "LEGACY_IDENTITY_OUTSIDE_ROOT:", mutate: async root => { await unlink(root, "tsconfig.json"); await symlink(external, resolve(root, "tsconfig.json")); } },
    { name: "source-outside-link", error: "OUTSIDE_ROOT", mutate: async root => symlink(external, resolve(root, "packages/sample/src/outside.ts")) },
    { name: "missing-package", error: "LEGACY_IDENTITY_READ_FAILED:package.json:", mutate: async (_root, sdkRoot) => unlink(sdkRoot, "package.json") },
    { name: "missing-entry", error: "LEGACY_IDENTITY_READ_FAILED:lib/typescript.js:", mutate: async (_root, sdkRoot) => unlink(sdkRoot, "lib/typescript.js") },
    { name: "malformed-package", error: "LEGACY_IDENTITY_SDK_INVALID:", mutate: async (_root, sdkRoot) => writeFile(resolve(sdkRoot, "package.json"), "{") },
    { name: "foreign-version", error: "LEGACY_IDENTITY_SDK_VERSION_MISMATCH", mutate: async (_root, sdkRoot) => writeFile(resolve(sdkRoot, "package.json"), '{"name":"typescript","version":"5.9.4"}') },
    { name: "foreign-name", error: "LEGACY_IDENTITY_SDK_VERSION_MISMATCH", mutate: async (_root, sdkRoot) => writeFile(resolve(sdkRoot, "package.json"), '{"name":"foreign","version":"7.1.0-dev"}') },
    { name: "missing-library", error: "SDK", mutate: async (_root, sdkRoot) => unlink(sdkRoot, "lib/lib.es5.d.ts") },
    { name: "library-outside-link", error: "LEGACY_IDENTITY_OUTSIDE_ROOT:", mutate: async (_root, sdkRoot) => { await unlink(sdkRoot, "lib/lib.es5.d.ts"); await symlink(external, resolve(sdkRoot, "lib/lib.es5.d.ts")); } },
    { name: "over-capture-limit", error: "LEGACY_IDENTITY_CAPTURE_LIMIT", mutate: async root => { const file = resolve(root, "packages/sample/src/large.ts"); await writeFile(file, ""); await truncate(file, 67_108_865); } },
    { name: "crlf-source", error: "Noncanonical CRLF analyzer input:", mutate: async root => writeFile(resolve(root, "packages/sample/src/index.ts"), "export {};\r\n") },
    { name: "missing-fixed-input", error: "LEGACY_IDENTITY_READ_FAILED:tsconfig.json:", mutate: async root => unlink(root, "tsconfig.json") },
    { name: "missing-sdk-root", error: "LEGACY_IDENTITY_SDK_UNAVAILABLE:", mutate: async (_root, sdkRoot) => rm(sdkRoot, { recursive: true }) },
    { name: "sdk-not-specified", missingSdk: true },
  ];
  const successful: Record<string, Json> = {};
  for (const vector of vectors) {
    const root = resolve(ctx.root, `filesystem-acquisition-${vector.name}`, "repository");
    const sdkRoot = resolve(ctx.root, `filesystem-acquisition-${vector.name}`, "sdk");
    await materialize(root, implementation);
    await materialize(sdkRoot, sdk);
    await vector.mutate?.(root, sdkRoot);
    const descriptor: Json = { operation: "baseline_analyzer_identity", repository_root: root };
    if (!vector.missingSdk) descriptor.compiler_package_root = sdkRoot;
    const observed = await ctx.run(`229-${vector.name}`, "--observe-primitives", descriptor);
    evidence.push(...observed.evidence);
    if (vector.missingSdk) {
      properties.push(property("sdk-not-specified-refused", observed.exitCode !== 0, true));
      properties.push(property("sdk-not-specified-diagnostic", observed.stderr.includes("compiler_package_root"), true));
    } else if (vector.error) {
      properties.push(property(`${vector.name}-identity-refused`, observed.value.identity_success, false));
      properties.push(property(`${vector.name}-reason`, String(observed.value.error).includes(vector.error) && (vector.name !== "missing-library" || !String(observed.value.error).includes("VERSION_MISMATCH")), true));
    } else {
      properties.push(property(`${vector.name}-identity-acquired`, observed.value.identity_success, true));
      properties.push(property(`${vector.name}-compiler-not-executed`, observed.value.compiler_executed, false));
      successful[vector.name] = object(observed.value.identity);
    }
  }
  properties.push(property("relocation-same-byte-identity", successful["complete-explicit-sdk"]?.digest !== undefined && successful["complete-explicit-sdk"]?.digest === successful["relocated-complete-sdk"]?.digest, true));
  properties.push(property("source-byte-affects-identity", successful["source-byte-change"]?.digest !== undefined && successful["source-byte-change"]?.digest !== successful["complete-explicit-sdk"]?.digest, true));
  properties.push(property("sdk-byte-affects-identity", successful["sdk-byte-change"]?.digest !== undefined && successful["sdk-byte-change"]?.digest !== successful["complete-explicit-sdk"]?.digest, true));
  evidence.push(await ctx.save("229-specimen-limitations", { acquisitionVectors: vectors.map(vector => vector.name), libraryCount: Object.keys(sdkFiles).length, sourceOfLibraries: "explicit candidate SDK; exact comparison against the independent TS7 inventory is reported separately and can fail during rehearsal", entry: "synthetic opaque non-executable byte-acquisition specimen", captureLimit: 67_108_864 }));
  return indices.map(index => finish(index, properties, evidence, false, index === 229
    ? "18 isolated native acquisition controls execute against explicit candidate library bytes; the independent TS7 inventory comparison is separate. Complete independent live identity manifest, 20 cumulative supports, exact 64-MiB acceptance boundary and authentic native-SDK package/entry composition remain unproved; synthetic entry is only a byte-acquisition specimen."
    : "Explicit TS7 SDK acquisition and missing/foreign/incomplete SDK controls execute; consumed default-library identity and native P2 library-directory replacement are not yet independently composed. Synthetic JS entry is not a TS7 runtime."));
}

export async function filesystemObservations(ctx: Context, indices: number[]): Promise<Observation[]> {
  const observations: Observation[] = [];
  for (const index of indices) {
    if ([216, 217, 218, 219].includes(index)) {
      if (!observations.some(observation => [216, 217, 218, 219].includes(observation.index))) observations.push(...(await retained(ctx)).filter(observation => indices.includes(observation.index)));
    } else if ([6, 169].includes(index)) {
      if (!observations.some(observation => [6, 169].includes(observation.index))) observations.push(...(await discovery(ctx)).filter(observation => indices.includes(observation.index)));
    } else if ([220, 229].includes(index)) {
      if (!observations.some(observation => [220, 229].includes(observation.index))) observations.push(...await acquisition(ctx, indices.filter(value => [220, 229].includes(value))));
    } else if ([230, 231].includes(index)) {
      if (!observations.some(observation => [230, 231].includes(observation.index))) observations.push(...await imports(ctx, indices.filter(value => [230, 231].includes(value))));
    } else if ([136, 170].includes(index)) observations.push(await keys(ctx, index));
    else if (index === 168) observations.push(await identity(ctx));
    else if (index === 5) observations.push(await eligibility(ctx));
  }
  return observations.sort((a, b) => a.index - b.index);
}
