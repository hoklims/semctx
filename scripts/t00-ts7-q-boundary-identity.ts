import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { asset, checkAsset, isolatedEnvironment, record, type Context, type Evidence, type Execution, type Json, type Observation, type Property } from "./t00-ts7-q-boundary-common";
import { identityRuntimeObservations } from "./t00-ts7-q-boundary-identity-runtime";

const revision = "780dc512d64f40afebffa6a7028207649fb7ed1c";
const authority = "contract-ts7.md P2 and consumer-contracts.json observable predicate; independent Node SHA256 and native TS7 oracle";
type Files = Record<string, Uint8Array>;
export const identityHash = (bytes: string | Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export const identityProperty = (name: string, actual: unknown, expected: unknown): Property => ({ name, actual: actual ?? null, expected, oracle: authority, pass: isDeepStrictEqual(actual, expected) });

export function canonicalIdentity(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalIdentity).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const ordered = Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
    return `{${Object.keys(ordered).map(key => `${JSON.stringify(key)}:${canonicalIdentity(ordered[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined || typeof value === "number" && !Number.isFinite(value)) throw Error("identity input is not JSON");
  return serialized;
}

export function nativeManifest(implementation: Files, sdk: Files): { identity: Json; compiler_inputs: Json } {
  const entry = sdk["lib/tsgo"], packageBytes = sdk["package.json"];
  if (!entry || !packageBytes) throw Error("native manifest requires explicit package and runtime bytes");
  const libraries = [{ path: "../package.json", digest: identityHash(packageBytes) }, ...Object.keys(sdk).filter(path => /^lib\/lib.*\.d\.ts$/.test(path)).sort().map(path => ({ path: basename(path), digest: identityHash(sdk[path]!) }))];
  const compiler_inputs = { entry: identityHash(entry), libraries };
  const files = Object.keys(implementation).sort().map(path => ({ path, digest: identityHash(implementation[path]!) }));
  const compiler = { version: "7.1.0-dev", sourceRevision: revision, digest: identityHash(JSON.stringify(compiler_inputs)) };
  const manifest = { schemaVersion: 2, files, compiler };
  return { identity: { ...manifest, digest: identityHash(JSON.stringify(manifest)) }, compiler_inputs };
}

const fixture = (): Files => Object.fromEntries(Object.entries({
  "bun.lock": "lock\n", "tsconfig.json": "{}\n", "tsconfig.base.json": "{}\n",
  "scripts/analyzer-identity.ts": "export {};\n", "scripts/build-plugin-runtime.ts": "export {};\n", "scripts/build-cli-package.ts": "export {};\n",
  "packages/sample/package.json": '{"name":"sample"}\n', "packages/sample/src/index.ts": "export const source = 1;\n",
  "apps/cli/package.json": '{"name":"cli"}\n', "apps/cli/src/index.ts": "export {};\n",
}).map(([path, value]) => [path, Buffer.from(value)]));

async function materialize(root: string, files: Files): Promise<void> {
  for (const [path, bytes] of Object.entries(files)) {
    const target = resolve(root, path);
    if (!target.startsWith(root + "/")) throw Error("identity fixture escapes root");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
}

async function liveImplementation(root: string): Promise<Files> {
  const paths = ["bun.lock", "tsconfig.json", "tsconfig.base.json", "scripts/analyzer-identity.ts", "scripts/build-plugin-runtime.ts", "scripts/build-cli-package.ts", "apps/cli/package.json"];
  const sources = async (directory: string): Promise<void> => {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await sources(path);
      else if (entry.isFile() && /\.(ts|js|mjs)$/.test(path) && path !== "packages/app-services/src/analyzer-identity-generated.ts") paths.push(path);
    }
  };
  for (const entry of await readdir(resolve(root, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    paths.push(`packages/${entry.name}/package.json`);
    await sources(`packages/${entry.name}/src`);
  }
  await sources("apps/cli/src");
  const files: Files = {};
  for (const path of paths.sort()) files[path] = await readFile(resolve(root, path));
  return files;
}

async function upstreamSdk(ctx: Context): Promise<Files> {
  await checkAsset(ctx.oracleArtifact);
  const files: Files = {
    "package.json": Buffer.from(JSON.stringify({ name: "ts_goport", version: "7.1.0-dev", sourceRevision: revision })),
    "lib/tsgo": await readFile(ctx.oracleArtifact.path),
  };
  for (const name of (await readdir(dirname(ctx.oracleArtifact.path))).filter(name => /^lib.*\.d\.ts$/.test(name)).sort()) files[`lib/${name}`] = await readFile(resolve(dirname(ctx.oracleArtifact.path), name));
  if (Object.keys(files).length !== 117) throw Error("native identity oracle requires runtime, package and 115 upstream libraries");
  return files;
}

async function packagedCompiler(ctx: Context, sdkRoot: string, label: string): Promise<Execution> {
  const directory = resolve(ctx.root, `identity-package-compiler-${label}`);
  await mkdir(directory, { recursive: true });
  const source = resolve(directory, "entry.ts");
  await writeFile(source, "export const value: Array<number> = [1];\n");
  const runtime = resolve(sdkRoot, "lib/tsgo");
  await chmod(runtime, 0o755);
  const runtimeEvidence = await asset(runtime);
  if (runtimeEvidence.sha256 !== ctx.oracleArtifact.sha256 || runtimeEvidence.bytes !== ctx.oracleArtifact.bytes) throw Error("packaged runtime is not pinned TS7 binary");
  const argv = [runtime, "--target", "ES2022", "--module", "ESNext", "--skipLibCheck", "--noEmit", "--pretty", "false", "--listFiles", source];
  const child = Bun.spawn(argv, { cwd: directory, env: { ...isolatedEnvironment(ctx.root), GOPORT_LIB_PARSE_SNAPSHOT: "0", GOPORT_LIB_SNAPSHOT: "0", GOPORT_BUILD_VERSION: undefined }, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await checkAsset(runtimeEvidence);
  return { exitCode, stdout, stderr, value: {}, evidence: [runtimeEvidence, await asset(source), await ctx.save(`identity-package-${label}`, { argv, exitCode, stdout, stderr, signalCode: child.signalCode })] };
}

export function missingEs5LibraryRefused(execution: Pick<Execution, "exitCode" | "stdout" | "stderr">, sdkRoot: string): boolean {
  const lines = execution.stdout.split(/\r?\n/);
  const libraries = lines.filter(line => /(?:^|\/)lib[^/]*\.d\.ts$/.test(line));
  return execution.exitCode === 2 && execution.stderr === ""
    && lines.some(line => /^error TS2318: Cannot find global type '[A-Za-z]+'\.$/.test(line))
    && libraries.includes(resolve(sdkRoot, "lib/lib.es2022.full.d.ts"))
    && libraries.every(path => dirname(path) === resolve(sdkRoot, "lib") && basename(path) !== "lib.es5.d.ts");
}

async function acquisition(ctx: Context): Promise<{ properties: Property[]; evidence: Evidence[] }> {
  const sdk = await upstreamSdk(ctx);
  const live = await liveImplementation(resolve(import.meta.dir, ".."));
  const properties: Property[] = [];
  const evidence: Evidence[] = [ctx.oracleArtifact, await ctx.save("identity-live-oracle-manifest", nativeManifest(live, sdk))];
  const basic = fixture();
  const capturedBytes = Object.values({ ...Object.fromEntries(Object.entries(basic).map(([path, bytes]) => [`implementation/${path}`, bytes])), ...sdk }).reduce((sum, bytes) => sum + bytes.byteLength, 0);
  if (capturedBytes >= 67_108_864) throw Error("native identity baseline already exceeds the P2 capture limit");
  const external = resolve(ctx.root, "identity-external.ts");
  await writeFile(external, "export const forbidden = 1;\n");
  type Vector = { name: string; implementation?: Files; sdk?: Files; error?: string; omittedSdk?: boolean; mutate?: (root: string, sdkRoot: string) => Promise<void> };
  const vectors: Vector[] = [
    { name: "complete-explicit-sdk" },
    { name: "relocated-complete-sdk" },
    { name: "complete-baseline-specimen", implementation: live },
    { name: "source-byte-change", implementation: { ...basic, "packages/sample/src/index.ts": Buffer.from("export const source = 2;\n") } },
    { name: "sdk-byte-change", sdk: { ...sdk, "lib/lib.es5.d.ts": Buffer.concat([sdk["lib/lib.es5.d.ts"]!, Buffer.from("\n")]) } },
    { name: "runtime-byte-change", sdk: { ...sdk, "lib/tsgo": Buffer.concat([sdk["lib/tsgo"]!, Buffer.from("\n")]) } },
    { name: "exact-64-MiB", implementation: { ...basic, "packages/sample/src/large.ts": Buffer.alloc(67_108_864 - capturedBytes) } },
    { name: "64-MiB-plus-one", implementation: { ...basic, "packages/sample/src/large.ts": Buffer.alloc(67_108_865 - capturedBytes) }, error: "NATIVE_IDENTITY_CAPTURE_LIMIT" },
    { name: "fixed-outside-link", error: "NATIVE_IDENTITY_OUTSIDE_ROOT:", mutate: async root => { await rm(resolve(root, "tsconfig.json")); await symlink(external, resolve(root, "tsconfig.json")); } },
    { name: "source-outside-link", error: "NATIVE_IDENTITY_OUTSIDE_ROOT:", mutate: async root => { await symlink(external, resolve(root, "packages/sample/src/outside.ts")); } },
    { name: "library-outside-link", error: "NATIVE_IDENTITY_OUTSIDE_ROOT:", mutate: async (_root, sdkRoot) => { await rm(resolve(sdkRoot, "lib/lib.es5.d.ts")); await symlink(external, resolve(sdkRoot, "lib/lib.es5.d.ts")); } },
    { name: "entry-outside-link", error: "NATIVE_IDENTITY_OUTSIDE_ROOT:", mutate: async (_root, sdkRoot) => { await rm(resolve(sdkRoot, "lib/tsgo")); await symlink(external, resolve(sdkRoot, "lib/tsgo")); } },
    { name: "missing-package", error: "NATIVE_IDENTITY_READ_FAILED:package.json:", mutate: async (_root, sdkRoot) => { await rm(resolve(sdkRoot, "package.json")); } },
    { name: "missing-entry", error: "NATIVE_IDENTITY_READ_FAILED:lib/tsgo:", mutate: async (_root, sdkRoot) => { await rm(resolve(sdkRoot, "lib/tsgo")); } },
    { name: "missing-library", error: "NATIVE_IDENTITY_SDK_INVENTORY_MISMATCH:", mutate: async (_root, sdkRoot) => { await rm(resolve(sdkRoot, "lib/lib.es5.d.ts")); } },
    { name: "extra-library", error: "NATIVE_IDENTITY_SDK_INVENTORY_MISMATCH:", sdk: { ...sdk, "lib/lib.foreign.d.ts": Buffer.from("export {};\n") } },
    { name: "malformed-package", error: "NATIVE_IDENTITY_SDK_INVALID:", sdk: { ...sdk, "package.json": Buffer.from("{") } },
    { name: "foreign-version", error: "NATIVE_IDENTITY_SDK_VERSION_MISMATCH", sdk: { ...sdk, "package.json": Buffer.from(JSON.stringify({ name: "ts_goport", version: "5.9.3", sourceRevision: revision })) } },
    { name: "foreign-name", error: "NATIVE_IDENTITY_SDK_VERSION_MISMATCH", sdk: { ...sdk, "package.json": Buffer.from(JSON.stringify({ name: "typescript", version: "7.1.0-dev", sourceRevision: revision })) } },
    { name: "foreign-revision", error: "NATIVE_IDENTITY_SDK_VERSION_MISMATCH", sdk: { ...sdk, "package.json": Buffer.from(JSON.stringify({ name: "ts_goport", version: "7.1.0-dev", sourceRevision: "foreign" })) } },
    { name: "crlf-source", error: "Noncanonical CRLF analyzer input:", implementation: { ...basic, "packages/sample/src/index.ts": Buffer.from("export {};\r\n") } },
    { name: "missing-fixed-input", error: "NATIVE_IDENTITY_READ_FAILED:tsconfig.json:", mutate: async root => { await rm(resolve(root, "tsconfig.json")); } },
    { name: "missing-sdk-root", error: "NATIVE_IDENTITY_SDK_UNAVAILABLE:", mutate: async (_root, sdkRoot) => { await rm(sdkRoot, { recursive: true }); } },
    { name: "sdk-not-specified", omittedSdk: true },
  ];
  const successful: Record<string, Json> = {};
  for (const vector of vectors) {
    const root = resolve(ctx.root, `identity-${vector.name}`, "repository"), sdkRoot = resolve(ctx.root, `identity-${vector.name}`, "sdk");
    const implementation = vector.implementation ?? basic, sdkFiles = vector.sdk ?? sdk;
    await materialize(root, implementation);
    await materialize(sdkRoot, sdkFiles);
    await vector.mutate?.(root, sdkRoot);
    const descriptor: Json = { operation: "native_analyzer_identity", repository_root: root, ...(!vector.omittedSdk ? { compiler_package_root: sdkRoot } : {}) };
    const observed = await ctx.run(`identity-${vector.name}`, "--observe-primitives", descriptor);
    evidence.push(...observed.evidence);
    if (vector.omittedSdk) {
      properties.push(identityProperty("sdk-not-specified-refused", { exitCode: observed.exitCode, field: observed.stderr.includes("compiler_package_root") }, { exitCode: 1, field: true }));
    } else if (vector.error) {
      properties.push(identityProperty(`${vector.name}-refused`, { exitCode: observed.exitCode, acquired: observed.value.identity_success, reason: String(observed.value.error).startsWith(vector.error), identity: observed.value.identity ?? null }, { exitCode: 0, acquired: false, reason: true, identity: null }));
    } else {
      const expected = nativeManifest(implementation, sdkFiles);
      evidence.push(await ctx.save(`identity-${vector.name}-independent-expected`, expected));
      properties.push(identityProperty(`${vector.name}-acquired`, { exitCode: observed.exitCode, acquired: observed.value.identity_success, executed: observed.value.compiler_executed, authenticated: observed.value.sdk_payload_authenticated, scope: observed.value.identity_scope }, { exitCode: 0, acquired: true, executed: false, authenticated: false, scope: "ts7_native_implementation_and_compiler_bytes" }));
      properties.push(identityProperty(`${vector.name}-full-manifest`, observed.value.identity, expected.identity));
      properties.push(identityProperty(`${vector.name}-compiler-inputs`, observed.value.compiler_inputs, expected.compiler_inputs));
      successful[vector.name] = observed.value.identity ? record(observed.value.identity) : {};
    }
    if (vector.name === "complete-explicit-sdk") {
      const compiled = await packagedCompiler(ctx, sdkRoot, "complete");
      evidence.push(...compiled.evidence);
      const lines = compiled.stdout.split(/\r?\n/);
      properties.push(identityProperty("authentic-native-package-executes", { exitCode: compiled.exitCode, stderr: compiled.stderr }, { exitCode: 0, stderr: "" }));
      properties.push(identityProperty("native-package-default-library-directory", lines.includes(resolve(sdkRoot, "lib/lib.es2022.full.d.ts")) && lines.includes(resolve(sdkRoot, "lib/lib.es5.d.ts")), true));
      properties.push(identityProperty("native-package-read-library-confinement", lines.filter(line => /lib.*\.d\.ts$/.test(line)).every(line => line.startsWith(sdkRoot + "/lib/")), true));
    }
    if (vector.name === "missing-library") {
      const compiled = await packagedCompiler(ctx, sdkRoot, "missing-library");
      evidence.push(...compiled.evidence);
      properties.push(identityProperty("native-package-missing-library-no-fallback", missingEs5LibraryRefused(compiled, sdkRoot), true));
    }
  }
  properties.push(identityProperty("IDENTITY::complete-baseline-specimen", successful["complete-baseline-specimen"], nativeManifest(live, sdk).identity));
  properties.push(identityProperty("live-specimen-is-full-implementation", Object.keys(live).length > Object.keys(basic).length, true));
  properties.push(identityProperty("relocation-same-byte-identity", successful["complete-explicit-sdk"]?.digest !== undefined && successful["complete-explicit-sdk"]?.digest === successful["relocated-complete-sdk"]?.digest, true));
  for (const name of ["source-byte-change", "sdk-byte-change", "runtime-byte-change"]) properties.push(identityProperty(`${name}-changes-identity`, successful[name]?.digest !== undefined && successful[name]?.digest !== successful["complete-explicit-sdk"]?.digest, true));
  evidence.push(await ctx.save("identity-p2-capture-boundaries", { captureLimit: 67_108_864, baselineBytes: capturedBytes, acceptedBytes: 67_108_864, refusedBytes: 67_108_865, liveImplementationFiles: Object.keys(live).length, entry: "Pinned upstream native TS7 executable; default libraries adjacent in lib/", sourceSelection: "Six fixed inputs and recursive package/CLI ts/js/mjs files, excluding generated identity, as adopted consumer predicate" }));
  return { properties, evidence };
}

export function identitySupportVectors(sdk: Files): { bases: Record<string, Json>; mutations: { id: string; record: string; value: Json }[] } {
  const capture = { repositoryIdentity: "fixture:repo-A", logicalRoot: "/fixture", files: [{ path: "entry.ts", bytesHex: Buffer.from("export function leaf() { return 1; }\n").toString("hex") }], directories: [{ path: ".", members: ["entry.ts"] }], absentFiles: ["tsconfig.json"], links: [], caseSensitive: true };
  const producer = { artifactDigest: identityHash("fixture producer A"), implementationRevision: "fixture-only-revision-1", toolchain: "Rust1.95.0", identityRole: "fixed-vector-not-selected-producer" };
  const sdkValue = { package: "ts_goport", version: "7.1.0-dev", sourceRevision: revision, files: Object.keys(sdk).filter(path => /^lib\/lib.*\.d\.ts$/.test(path)).sort().map(path => ({ path, bytes: sdk[path]!.byteLength, sha256: identityHash(sdk[path]!).slice(7) })) };
  const inputRequest = { requestIdentity: "fixture:request-A", snapshotDigest: identityHash(canonicalIdentity(capture)), producerDigest: identityHash(canonicalIdentity(producer)), sdkDigest: identityHash(canonicalIdentity(sdkValue)), selected: ["entry.ts"], discovered: ["entry.ts"], profile: "ordinary-no-snapshot", configurationVersion: "fixture:t00-private-1", effectiveOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", allowJs: true, jsx: "Preserve", skipLibCheck: true, noEmit: true, strict: false } };
  return {
    bases: { capture, producer, sdk: sdkValue, inputRequest },
    mutations: [
      { id: "I-source-byte", record: "capture", value: { ...capture, files: [{ ...capture.files[0], bytesHex: capture.files[0]!.bytesHex + "20" }] } },
      { id: "I-config-absence", record: "capture", value: { ...capture, absentFiles: [] } },
      { id: "I-directory-members", record: "capture", value: { ...capture, directories: [{ path: ".", members: ["entry.ts", "other.ts"] }] } },
      { id: "I-case-semantics", record: "capture", value: { ...capture, caseSensitive: false } },
      { id: "I-repository-binding", record: "capture", value: { ...capture, repositoryIdentity: "fixture:repo-B" } },
      { id: "I-artifact-byte", record: "producer", value: { ...producer, artifactDigest: identityHash("fixture producer B") } },
      { id: "I-producer-revision", record: "producer", value: { ...producer, implementationRevision: "fixture-only-revision-2" } },
      { id: "I-sdk-byte", record: "sdk", value: { ...sdkValue, files: sdkValue.files.map((file, index) => index === 0 ? { ...file, sha256: "0".repeat(64) } : file) } },
      { id: "I-request-id", record: "inputRequest", value: { ...inputRequest, requestIdentity: "fixture:request-B" } },
      { id: "I-scope-selection", record: "inputRequest", value: { ...inputRequest, selected: [] } },
      { id: "I-options", record: "inputRequest", value: { ...inputRequest, effectiveOptions: { ...inputRequest.effectiveOptions, module: "NodeNext" } } },
    ],
  };
}

export function identityReceiverDescriptor(artifact: Evidence, records: Record<string, Json>, currentRecords = records): Json {
  const graph = { nodes: [], edges: [] };
  const original = { artifact_path: artifact.path, input: records, capture: {}, snapshot: {}, scope: {}, facts: [], graph, profile: "identity-fixed-vector" };
  const current = { ...original, input: currentRecords };
  const emptyDigest = identityHash("{}");
  const batch = { schema_version: 1, case_id: "fixed-vector", request_id: "fixed-vector", snapshot_id: emptyDigest, scope_id: emptyDigest, profile: original.profile, producer_artifact_id: `sha256:${artifact.sha256}`, input_manifest_id: identityHash(canonicalIdentity(records)), capture_id: emptyDigest, facts_id: identityHash("[]"), graph_id: identityHash(canonicalIdentity(graph)), complete: true, terminal: "complete", subjects: [], facts: [], diagnostics: [], input_observations: [] };
  const stdout = canonicalIdentity(batch);
  return { original, current, request_id: "fixed-vector", subjects: [], outcome: { kind: "success", exit_code: 0, duration_ms: 0, stdout, stderr: "", stdout_bytes: Buffer.byteLength(stdout), stderr_bytes: 0, stdout_hash: identityHash(stdout).slice(7), stderr_hash: identityHash("").slice(7) } };
}

export function identityMutationSummary(id: string, properties: Property[]): Property {
  const required = ["activation.canonical", "control.canonical", "digest-relation", "fixed-vector-receiver-control", "fixed-vector-receiver-mutation", "fixed-vector-receiver-restored"].map(suffix => `IDENTITY::${id}.${suffix}`);
  const complete = required.every(name => {
    const matching = properties.filter(property => property.name === name);
    return matching.length === 1 && matching[0]!.pass;
  });
  return identityProperty(`IDENTITY::${id}`, complete, true);
}

async function canonicalSupports(ctx: Context): Promise<{ properties: Property[]; evidence: Evidence[]; complete: boolean }> {
  const { bases, mutations } = identitySupportVectors(await upstreamSdk(ctx));
  const evidence: Evidence[] = [await ctx.save("identity-independent-support-vectors", { bases, mutations, authority: "Finite IDENTITY record/mutation predicates from frozen support.json; fresh TS7 SDK115 payload manifests, no historical expected digest reuse", receiverScope: "Real receiver observes independently authored fixed-vector envelopes with empty subjects/facts. Every record is explicitly bound within input_manifest; these envelopes claim neither native capture metadata nor compiler consumption. Live batch and consumed-library witnesses run separately." })];
  const properties: Property[] = [];
  const observe = async (name: string, value: Json): Promise<string | undefined> => {
    const canonical = canonicalIdentity(value), expected = identityHash(canonical);
    const result = await ctx.run(`identity-support-${name}`, "--observe-primitives", { operation: "canonical_json", value });
    evidence.push(...result.evidence);
    properties.push(identityProperty(`${name}.canonical`, { exitCode: result.exitCode, executed: result.value.executed, canonical: result.value.canonical_json, digest: result.value.canonical_descriptor_sha256 }, { exitCode: 0, executed: true, canonical, digest: expected }));
    return typeof result.value.canonical_descriptor_sha256 === "string" ? result.value.canonical_descriptor_sha256 : undefined;
  };
  const baseDigests: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(bases)) {
    const before = await observe(`IDENTITY::base-${name}.activation`, value);
    const control = await observe(`IDENTITY::base-${name}.control`, Object.fromEntries(Object.entries(value).reverse()));
    properties.push(identityProperty(`IDENTITY::base-${name}`, before !== undefined && before === control, true));
    baseDigests[name] = before;
  }
  for (const mutation of mutations) {
    const changed = await observe(`IDENTITY::${mutation.id}.activation`, mutation.value);
    const restored = await observe(`IDENTITY::${mutation.id}.control`, bases[mutation.record]!);
    properties.push(identityProperty(`IDENTITY::${mutation.id}.digest-relation`, changed !== undefined && restored !== undefined && changed !== restored && restored === baseDigests[mutation.record], true));
  }
  if (ctx.identityReceiver) {
    const receive = async (name: string, current: Record<string, Json>, accepted: boolean): Promise<void> => {
      const result = await ctx.receiveIdentity(name, identityReceiverDescriptor(ctx.producerArtifact, bases, current));
      evidence.push(...result.evidence);
      properties.push(identityProperty(name, { exitCode: result.exitCode, value: result.value }, { exitCode: 0, value: accepted ? { accepted: true, disposition: "Analyzed", rejection: null } : { accepted: false, disposition: null, rejection: "IdentityMismatch" } }));
    };
    for (const mutation of mutations) {
      await receive(`IDENTITY::${mutation.id}.fixed-vector-receiver-control`, bases, true);
      await receive(`IDENTITY::${mutation.id}.fixed-vector-receiver-mutation`, { ...bases, [mutation.record]: mutation.value }, false);
      await receive(`IDENTITY::${mutation.id}.fixed-vector-receiver-restored`, bases, true);
    }
  }
  for (const mutation of mutations) properties.push(identityMutationSummary(mutation.id, properties));
  return { properties, evidence, complete: ctx.identityReceiver !== undefined };
}

export async function identityObservations(ctx: Context, indices: number[]): Promise<Observation[]> {
  const acquired = await acquisition(ctx);
  const supports = await canonicalSupports(ctx);
  const runtime = await identityRuntimeObservations(ctx);
  const files = { "entry.ts": "export const identitySubject: number = 7;\n" };
  const oracle = await ctx.oracle("identity-compiler-version", files, { args: ["--version"] });
  const analyzed = await ctx.run("identity-capability", "", ctx.analysis(files));
  const subjects = Array.isArray(analyzed.value.subjects) ? analyzed.value.subjects.map(record) : [];
  const dialect = [
    identityProperty("independent-ts7-executable", { exitCode: oracle.exitCode, stdout: oracle.stdout.trim() }, { exitCode: 0, stdout: "Version 7.1.0-dev" }),
    identityProperty("analyzed-compiler-identity", { exitCode: analyzed.exitCode, complete: analyzed.value.complete, version: analyzed.value.native_compiler_version, revision: analyzed.value.engine_revision, producer: analyzed.value.producer_artifact_id }, { exitCode: 0, complete: true, version: "7.1.0-dev", revision, producer: `sha256:${ctx.producerSha256}` }),
    identityProperty("actual-subject-dialect", subjects.map(subject => ({ path: subject.path, dialect: record(subject.capabilityScope).dialectVersion, language: record(subject.capabilityScope).language })), [{ path: "entry.ts", dialect: "7.1.0-dev", language: "typescript" }]),
  ];
  const allProperties = [...acquired.properties, ...supports.properties, ...runtime.properties, ...dialect];
  const evidence = [...acquired.evidence, ...supports.evidence, ...runtime.evidence, ...oracle.evidence, ...analyzed.evidence];
  const complete = supports.complete && runtime.complete;
  return indices.map(index => ({ index, properties: allProperties, evidence, complete, reason: complete ? "Independent live manifests cover the complete adopted implementation-input set, native runtime and SDK115. Exact P2 capture boundaries, finite identity vectors with explicit fixed-vector receiver binding, authentic default-library package execution and separate live receiver activation/control witnesses executed. Qualification still requires every comparison and both platforms on the frozen candidate." : "Acquisition, independent identity vectors and authentic native SDK composition executed; required fixed-vector or live receiver support closure remains incomplete." }));
}
