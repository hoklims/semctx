import { mkdir, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { compareSnapshot } from "./t00-ts7-q-boundary-admission";
import type { Context, Evidence, Json, Observation, Property } from "./t00-ts7-q-boundary-common";

const contract = "consumer-contracts.json obligations 6/169/170: finite confinement, canonical identity, worker/direct and selected-root component relations; TS7 contract preserves these filesystem properties";
const object = (value: unknown): Json => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const property = (name: string, actual: unknown, expected: unknown, oracle = contract): Property => ({ name, actual: actual ?? null, expected, oracle, pass: isDeepStrictEqual(actual, expected) });

async function materialize(root: string, files: Record<string, string>): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const [relative, text] of Object.entries(files)) {
    const path = resolve(root, relative);
    if (!path.startsWith(`${root}/`)) throw Error(`live filesystem fixture outside root: ${relative}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
}

function analysis(ctx: Context, root: string, files: Record<string, string>, roots: string[], retained = true): Json {
  return ctx.analysis({}, { cwd: root, files: Object.fromEntries(Object.entries(files).map(([path, text]) => [resolve(root, path), text])), roots: roots.map(path => resolve(root, path)), retained, qualified: false });
}

export function selectedExtractionProperties(label: string, value: unknown): Property[] {
  const observed = object(value);
  return [
    property(`${label}-selected-modules`, observed.modules, ["c.ts", "a.ts"]),
    property(`${label}-selected-symbols`, array(observed.symbols).map(object).map(row => ({ relPath: row.relPath, name: row.name, kind: row.kind, scope: row.scope, exported: row.exported })), [
      { relPath: "c.ts", name: "c", kind: "function", scope: [], exported: true },
      { relPath: "a.ts", name: "a", kind: "function", scope: [], exported: true },
    ]),
    property(`${label}-selected-imports`, array(observed.imports).map(object).map(row => ({ from: row.fromRelPath, specifier: row.moduleSpecifier, names: row.names, resolved: row.resolvedRelPath })), [{ from: "a.ts", specifier: "./bridge", names: ["c"], resolved: "bridge.ts" }]),
    property(`${label}-transitive-call-target`, array(observed.calls).map(object).map(row => ({ from: row.callerRelPath, owner: row.callerSymbolPath, name: row.calleeName, target: row.calleeRelPath, symbol: row.calleeSymbolPath, line: row.line })), [{ from: "a.ts", owner: "a", name: "c", target: "c.ts", symbol: "c", line: 2 }]),
  ];
}

export function partitionProperties(label: string, value: unknown, joined: boolean): Property[] {
  const observed = object(value);
  return [
    property(`${label}-partition-executed`, observed.executed, true),
    property(`${label}-partition-supported`, observed.unsupported, []),
    property(`${label}-loaded-sources`, observed.loadedRepositorySources, ["a.ts", "bridge.ts", "c.ts"]),
    property(`${label}-selected-roots`, observed.selectedRoots, ["a.ts", "c.ts"]),
    property(`${label}-component-continuity`, observed.dependencyComponents, joined ? [["a.ts", "c.ts"]] : [["a.ts"], ["c.ts"]]),
    property(`${label}-module-edges`, observed.resolvedEdges, [
      { from: "a.ts", specifier: "./bridge", to: "bridge.ts" },
      ...(joined ? [{ from: "bridge.ts", specifier: "./c", to: "c.ts" }] : []),
    ]),
  ];
}

const discoveryConfig = { version: 2, include: ["**/*"], exclude: [], languages: { typescript: "on", javascript: "on", python: "off", markdown: "off", sql: "off" }, migrationsDirs: [] };

function traceResolves(stdout: string, specifier: string, filename: string): boolean {
  return stdout.split("\n").some(line => line.startsWith(`======== Module name '${specifier}' was successfully resolved to '`) && line.includes(`/${filename}'`));
}

export async function liveDiscoveryObservations(ctx: Context): Promise<Observation[]> {
  const evidence: Evidence[] = [];
  const discoveryProperties: Property[] = [];
  const confinementProperties: Property[] = [];
  for (const kind of ["import", "reference"] as const) {
    const root = resolve(ctx.root, `live-discovery-${kind}-symlink`);
    const outside = resolve(ctx.root, `live-discovery-${kind}-external.ts`);
    const source = kind === "import" ? "import './alias'; export {};\n" : "/// <reference path='./alias.ts' />\nexport {};\n";
    const files = { "entry.ts": source };
    await materialize(root, files);
    await writeFile(outside, "export const outside = 9;\n");
    await symlink(outside, resolve(root, "alias.ts"));
    const discovered = await ctx.run(`6-${kind}-resolved-symlink-escape`, "--discover-repository", { repositoryRoot: root, config: discoveryConfig });
    const oracle = await ctx.oracle(`6-${kind}-symlink-ts7`, { "entry.ts": source, "external.ts": "export const outside = 9;\n" }, { args: ["--traceResolution"], links: { "alias.ts": "external.ts" } });
    evidence.push(...discovered.evidence, ...oracle.evidence, await ctx.save(`6-${kind}-physical-confinement`, { root: await realpath(root), link: resolve(root, "alias.ts"), target: await realpath(resolve(root, "alias.ts")), outside }));
    const candidate = array(discovered.value.candidates).map(object).find(row => row.relPath === "entry.ts");
    const reason = kind === "import" ? "IMPORT_OUTSIDE_REPOSITORY" : "REFERENCE_OUTSIDE_REPOSITORY";
    discoveryProperties.push(
      property(`${kind}-symlink-discovery-executed`, discovered.value.executed, true),
      property(`${kind}-symlink-discovery-exit`, discovered.exitCode, 0),
      property(`${kind}-symlink-reason`, candidate?.reason, reason),
      property(`${kind}-symlink-outcome`, candidate?.analysisOutcome, "failed"),
      property(`${kind}-symlink-source-withheld`, array(discovered.value.files).map(object).some(row => row.relPath === "entry.ts"), false),
      property(`${kind}-symlink-compiler-accepts-in-root-control`, oracle.exitCode, 0, "pinned independent TS7 reads the in-root symlink target; native realpath establishes the escape in the activation fixture"),
    );
    const captured = await ctx.run(`169-${kind}-resolved-symlink-escape`, "", analysis(ctx, root, { ...files, "alias.ts": "export const outside = 9;\n" }, ["entry.ts"]));
    evidence.push(...captured.evidence);
    confinementProperties.push(...compareSnapshot(`169-${kind}-symlink`, captured, `${reason}: ${kind === "import" ? "./alias" : "./alias.ts"}`));
  }
  for (const missing of [true, false]) {
    const root = resolve(ctx.root, `live-discovery-js-alias-${missing ? "missing" : "present"}`);
    const files = { "entry.js": "import { value } from './alias/target.js'; export const result = value;\n", "target/keep.txt": "isolated alias directory\n", ...(!missing ? { "target/target.js": "export const value = 8;\n" } : {}) };
    await materialize(root, files);
    await mkdir(resolve(root, "target"), { recursive: true });
    await symlink("target", resolve(root, "alias"));
    const discovered = await ctx.run(`6-js-alias-${missing ? "missing" : "present"}`, "--discover-repository", { repositoryRoot: root, config: discoveryConfig });
    const selected = array(discovered.value.files).map(object).some(row => row.relPath === "entry.js");
    const capturedFiles = { ...files, ...(!missing ? { "alias/target.js": "export const value = 8;\n" } : {}) };
    const extracted = await ctx.run(`6-js-alias-${missing ? "missing" : "present"}-owning-diagnostic`, "", analysis(ctx, root, capturedFiles, ["entry.js"]));
    const oracle = await ctx.oracle(`6-js-alias-${missing ? "missing" : "present"}-ts7`, files, { allowJs: true, checkJs: true, args: ["--traceResolution"], links: { alias: "target" } });
    evidence.push(...discovered.evidence, ...extracted.evidence, ...oracle.evidence);
    const subject = array(extracted.value.subjects).map(object).find(row => row.path === "entry.js");
    discoveryProperties.push(
      property(`js-alias-${missing}-selected`, selected, true),
      property(`js-alias-${missing}-analysis-executed`, extracted.exitCode, 0),
      property(`js-alias-${missing}-owning-diagnostic`, array(subject?.reasons).includes("JAVASCRIPT_IMPORT_UNRESOLVED:./alias/target.js"), missing),
      property(`js-alias-${missing}-independent-resolution`, oracle.stdout.includes("error TS2307:"), missing, "independent TS7 allowJs/checkJs diagnostic, paired with contract-owned JAVASCRIPT_IMPORT_UNRESOLVED"),
    );
  }
  const graph = {
    "entry.ts": "import { leaf } from './middle';\nexport function entry() { return leaf(); }\n",
    "middle.ts": "export { leaf } from './leaf';\n",
    "leaf.ts": "import './entry';\nexport function leaf() { return 7; }\n",
  };
  for (const variant of ["cycle", "transitive-import-escape", "transitive-reference-escape"] as const) {
    const root = resolve(ctx.root, `live-captured-${variant}`);
    const files = { ...graph, ...(variant === "cycle" ? {} : { "middle.ts": variant === "transitive-import-escape" ? "import '../outside'; export { leaf } from './leaf';\n" : "/// <reference path='../outside.ts' />\nexport { leaf } from './leaf';\n" }) };
    await materialize(root, graph);
    const result = await ctx.run(`169-${variant}`, "", analysis(ctx, root, files, ["entry.ts"]));
    const oracle = await ctx.oracle(`169-${variant}-ts7`, files, { args: ["--traceResolution"] });
    evidence.push(...result.evidence, ...oracle.evidence, await ctx.save(`169-${variant}-retained-and-live`, { retained: files, live: graph, roots: ["entry.ts"] }));
    if (variant === "cycle") {
      const calls = array(object(result.value.raw_extraction).calls).map(object);
      confinementProperties.push(
        property("captured-cycle-terminates", result.exitCode, 0),
        property("captured-cycle-modules-only-requested-root", object(result.value.raw_extraction).modules, ["entry.ts"]),
        property("captured-cycle-real-call-target", calls.map(row => ({ from: row.callerRelPath, owner: row.callerSymbolPath, target: row.calleeRelPath, symbol: row.calleeSymbolPath })), [{ from: "entry.ts", owner: "entry", target: "leaf.ts", symbol: "leaf" }]),
        property("captured-cycle-independent-ts7", oracle.exitCode, 0, "independent TS7 --traceResolution and clean compilation of the transitive cyclic graph"),
        property("captured-transitive-TS7-edges", [traceResolves(oracle.stdout, "./middle", "middle.ts"), traceResolves(oracle.stdout, "./leaf", "leaf.ts"), traceResolves(oracle.stdout, "./entry", "entry.ts")], [true, true, true], "independent TS7 --traceResolution"),
      );
    } else {
      const error = variant === "transitive-import-escape" ? "IMPORT_OUTSIDE_REPOSITORY: ../outside" : "REFERENCE_OUTSIDE_REPOSITORY: ../outside.ts";
      confinementProperties.push(...compareSnapshot(variant, result, error));
    }
  }
  for (const outside of [false, true]) {
    const root = resolve(ctx.root, `live-captured-root-link-${outside ? "outside" : "inside"}`);
    const text = "export const value = 1;\n";
    await materialize(root, { "inside.ts": text });
    const target = outside ? resolve(ctx.root, "live-captured-root-link-external.ts") : resolve(root, "inside.ts");
    if (outside) await writeFile(target, text);
    const alias = resolve(root, "alias.ts");
    await symlink(target, alias);
    const result = await ctx.run(`169-direct-root-symlink-${outside ? "outside" : "inside"}`, "", analysis(ctx, root, { "alias.ts": text }, ["alias.ts"]));
    const oracle = await ctx.oracle(`169-direct-root-symlink-${outside ? "outside" : "inside"}-ts7-control`, { "entry.ts": "export { value } from './alias';\n", "inside.ts": text }, { args: ["--traceResolution"], links: { "alias.ts": "inside.ts" } });
    evidence.push(...result.evidence, ...oracle.evidence, await ctx.save(`169-direct-root-symlink-${outside ? "outside" : "inside"}-physical`, { root: await realpath(root), alias, target: await realpath(alias) }));
    confinementProperties.push(
      property(`direct-root-symlink-${outside}-independent-in-root-control`, oracle.exitCode, 0, "independent TS7 compiler executes with an actual internal source symlink; native realpath identifies activation versus confinement control"),
      property(`direct-root-symlink-${outside}-independent-source-link-consumed`, traceResolves(oracle.stdout, "./alias", "alias.ts"), true, "independent TS7 --traceResolution consumes the aliased source"),
    );
    if (outside) confinementProperties.push(...compareSnapshot("169-direct-root-symlink-outside", result, "SOURCE_LINK_OUTSIDE_REPOSITORY: alias.ts"));
    else confinementProperties.push(property("direct-root-symlink-inside-analysis", result.exitCode, 0), property("direct-root-symlink-inside-extraction", object(result.value.raw_extraction).modules, ["alias.ts"]));
  }
  const missingRoot = resolve(ctx.root, "live-captured-missing");
  await materialize(missingRoot, { "entry.ts": "export const liveOnly = 9;\n" });
  const missing = await ctx.run("169-exact-snapshot-missing-with-live-source", "", analysis(ctx, missingRoot, {}, ["entry.ts"]));
  evidence.push(...missing.evidence);
  confinementProperties.push(...compareSnapshot("169-exact-snapshot-missing", missing, "SOURCE_SNAPSHOT_MISSING: entry.ts"));
  return [
    { index: 6, complete: true, properties: discoveryProperties, evidence, reason: "Native symlink resolution escape and in-root unresolved/present JavaScript aliases compose discovery selection with actual extraction diagnostics, independent TS7 traces and native physical-path evidence." },
    { index: 169, complete: true, properties: confinementProperties, evidence, reason: "Captured transitive cyclic source traversal reaches the real callable; import/reference escape controls and exact SOURCE_SNAPSHOT_MISSING refuse before extraction, including a live file omitted from capture." },
  ];
}

export function sourceIdentityProperties(label: string, value: unknown, path: string, key: string, failedStage: string | null): Property[] {
  const observation = object(object(value).sourceIdentityObservation);
  const trace = array(observation.trace).map(object).filter(row => row.path === path);
  return [property(`${label}-native-source-owner-enabled`, observation.enabled, true),
    property(`${label}-source-identity-consumed`, trace.length > 0 && trace.every(row => row.key === key && row.failedStage === failedStage && row.injected === (failedStage !== null)), true)];
}

export async function liveCanonicalObservation(ctx: Context): Promise<Observation> {
  const evidence: Evidence[] = [], properties: Property[] = [];
  for (const joined of [true, false]) {
    const root = resolve(ctx.root, `live-canonical-${joined ? "joined" : "severed"}`);
    const files = {
      "a.ts": "import { c } from './bridge';\nexport function a() { return c(); }\n",
      "bridge.ts": joined ? "export { c } from './c';\n" : "export function c() { return 2; }\n",
      "c.ts": "export function c() { return 1; }\n",
    };
    await materialize(root, files);
    const alias = resolve(root, "a.ts");
    const canonical = alias;
    const identityKey = (path: string) => ctx.platform === "macos" ? path.toLowerCase() : path;
    evidence.push(await ctx.save(`170-${joined}-canonical-control`, { alias, canonical: await realpath(alias), authority: "Native physical source path fixed before producer execution" }));
    const direct = await ctx.run(`170-${joined}-direct`, "", analysis(ctx, root, files, ["a.ts", "c.ts"], false));
    const worker = await ctx.run(`170-${joined}-worker`, "--extract-worker", { schemaVersion: 1, jobId: `170-${joined}`, repoRoot: root, rootAbsPaths: [resolve(root, "a.ts"), resolve(root, "c.ts")], emitAbsPaths: [resolve(root, "a.ts"), resolve(root, "c.ts")] }, true);
    const oracle = await ctx.oracle(`170-${joined}-ts7`, files, { args: ["--traceResolution"] });
    evidence.push(...direct.evidence, ...worker.evidence, ...oracle.evidence);
    properties.push(
      property(`${joined}-direct-executed`, direct.exitCode, 0),
      property(`${joined}-same-complete-worker-direct-extraction`, isDeepStrictEqual(direct.value.raw_extraction, worker.value.extraction), true),
      property(`${joined}-worker-executed`, { exit: worker.exitCode, ok: worker.value.ok, started: worker.value.extraction_started, unsupported: object(worker.value.frontendCapabilityObservation).unsupported }, { exit: 0, ok: true, started: true, unsupported: [] }),
      property(`${joined}-independent-ts7-accepts`, oracle.exitCode, 0, "independent TS7 --traceResolution"),
      property(`${joined}-independent-ts7-resolved-bridge`, traceResolves(oracle.stdout, "./bridge", "bridge.ts"), true, "independent TS7 --traceResolution"),
      property(`${joined}-independent-ts7-c-edge`, traceResolves(oracle.stdout, "./c", "c.ts"), joined, "independent TS7 --traceResolution; expected graph edges follow the authored activation/control source"),
      ...partitionProperties(String(joined), direct.value.partitionObservation, joined),
    );
    properties.push(...sourceIdentityProperties(`${joined}-direct-control`, direct.value, alias, identityKey(canonical), null), ...sourceIdentityProperties(`${joined}-worker-control`, worker.value, alias, identityKey(canonical), null));
    for (const stage of ["native_realpath", "absolute"]) {
      const requests = {
        direct: analysis(ctx, root, files, ["a.ts", "c.ts"], false),
        worker: { schemaVersion: 1, jobId: `170-${joined}-${stage}`, repoRoot: root, rootAbsPaths: [alias, resolve(root, "c.ts")], emitAbsPaths: [alias, resolve(root, "c.ts")] },
      };
      for (const kind of ["direct", "worker"] as const) {
        const faulted = await ctx.run(`170-${joined}-${stage}-${kind}`, "--observe-source-identity", { kind, request: requests[kind], failures: { [alias]: stage } }, true);
        evidence.push(...faulted.evidence);
        properties.push(property(`${joined}-${stage}-${kind}-exit`, faulted.exitCode, 0), ...sourceIdentityProperties(`${joined}-${stage}-${kind}`, faulted.value, alias, identityKey(alias), stage));
        const extraction = kind === "direct" ? faulted.value.raw_extraction : faulted.value.extraction;
        properties.push(property(`${joined}-${stage}-${kind}-complete-extraction-preserved`, extraction, kind === "direct" ? direct.value.raw_extraction : worker.value.extraction));
        if (kind === "direct") properties.push(...partitionProperties(`${joined}-${stage}`, faulted.value.partitionObservation, joined));
      }
    }
    if (joined) properties.push(...selectedExtractionProperties("direct", direct.value.raw_extraction), ...selectedExtractionProperties("worker", worker.value.extraction));
    else {
      for (const [label, extraction] of [["direct", direct.value.raw_extraction], ["worker", worker.value.extraction]] as const) {
        properties.push(property(`${label}-severed-target`, array(object(extraction).calls).map(object).map(row => [row.calleeRelPath, row.calleeSymbolPath]), [["bridge.ts", "c"]]));
      }
    }
  }
  const collisionRoot = resolve(ctx.root, "170-canonical-collision");
  const collisionFiles = { "target.ts": "export function target() { return 7; }\n", "alias.ts": "export function target() { return 7; }\n", "distinct.ts": "export const distinct = 9;\n" };
  await materialize(collisionRoot, collisionFiles);
  await unlink(resolve(collisionRoot, "alias.ts"));
  await symlink(resolve(collisionRoot, "target.ts"), resolve(collisionRoot, "alias.ts"));
  const collision = await ctx.run("170-canonical-alias-target-graph", "", analysis(ctx, collisionRoot, collisionFiles, ["alias.ts", "target.ts", "distinct.ts"], false));
  evidence.push(...collision.evidence);
  properties.push(property("canonical-collision-partition", collision.value.partitionObservation, { executed: true, unsupported: [], loadedRepositorySources: ["distinct.ts", "target.ts"], selectedRoots: ["distinct.ts", "target.ts"], dependencyComponents: [["distinct.ts"], ["target.ts"]], resolvedEdges: [], observationScope: "native_loaded_repository_module_components", parallelSafetyEvaluated: false, globalAdmissionInferred: false }));
  const sourceKey = (name: string) => ctx.platform === "macos" ? resolve(collisionRoot, name).toLowerCase() : resolve(collisionRoot, name);
  properties.push(...sourceIdentityProperties("canonical-alias", collision.value, resolve(collisionRoot, "alias.ts"), sourceKey("target.ts"), null), ...sourceIdentityProperties("canonical-target", collision.value, resolve(collisionRoot, "target.ts"), sourceKey("target.ts"), null), ...sourceIdentityProperties("canonical-distinct", collision.value, resolve(collisionRoot, "distinct.ts"), sourceKey("distinct.ts"), null));
  for (const stage of ["native_realpath", "absolute"]) {
    const alias = resolve(collisionRoot, "alias.ts");
    const roots = [alias, resolve(collisionRoot, "distinct.ts")];
    const requests = {
      direct: analysis(ctx, collisionRoot, collisionFiles, ["alias.ts", "distinct.ts"], false),
      worker: { schemaVersion: 1, jobId: `canonical-alias-${stage}`, repoRoot: collisionRoot, rootAbsPaths: roots, emitAbsPaths: roots },
    };
    for (const kind of ["direct", "worker"] as const) {
      const faulted = await ctx.run(`170-canonical-alias-${stage}-${kind}`, "--observe-source-identity", { kind, request: requests[kind], failures: { [alias]: stage } }, true);
      evidence.push(...faulted.evidence);
      properties.push(property(`canonical-alias-${stage}-${kind}-owner-executed`, { exit: faulted.exitCode, completed: kind === "direct" ? faulted.value.complete : faulted.value.ok }, { exit: 0, completed: true }), ...sourceIdentityProperties(`canonical-alias-${stage}-${kind}-lexical-fallback`, faulted.value, alias, sourceKey("alias.ts"), stage));
    }
  }
  for (const disabled of [false, true]) {
    const request = { ...analysis(ctx, collisionRoot, collisionFiles, ["alias.ts", "target.ts"], false), ...(disabled ? { disabled: ["alias.ts"] } : { selection: { "alias.ts": "excluded" } }) };
    const direct = await ctx.run(`170-canonical-alias-${disabled ? "disabled" : "excluded"}`, "", request);
    evidence.push(...direct.evidence);
    properties.push(property(`canonical-alias-${disabled}-admissible-direct-module`, object(direct.value.raw_extraction).modules, ["target.ts"]));
  }
  const emitted = await ctx.run("170-canonical-alias-not-emitted", "--extract-worker", { schemaVersion: 1, jobId: "canonical-emission", repoRoot: collisionRoot, rootAbsPaths: [resolve(collisionRoot, "alias.ts"), resolve(collisionRoot, "target.ts")], emitAbsPaths: [resolve(collisionRoot, "target.ts")] }, true);
  evidence.push(...emitted.evidence);
  properties.push(property("canonical-alias-admissible-worker-module", object(emitted.value.extraction).modules, ["target.ts"]));
  return { index: 170, complete: false, properties, evidence, reason: "Native canonical identity, direct/worker parity and joined/severed components execute with independent TS7 traces. Native realpath/absolute failure injection remains diagnostic: the contract does not establish its correspondence with the optional JavaScript realpath callback or its thrown-exception branch; obligation 170 remains not_qualified pending an owner decision." };
}
