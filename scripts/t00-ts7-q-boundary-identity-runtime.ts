import { basename, resolve } from "node:path";
import { canonicalIdentity, identityHash, identityProperty as property } from "./t00-ts7-q-boundary-identity";
import { record, type Context, type Evidence, type Execution, type Json, type Property } from "./t00-ts7-q-boundary-common";

export function receiverAccepted(value: Json): boolean {
  return value["accepted"] === true && value["disposition"] === "Analyzed" && value["rejection"] === null;
}

const digest = (value: unknown): string => identityHash(canonicalIdentity(value));
const source = "export function identitySubject() { return 7; }\n";
const files = { "entry.ts": source };
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

function outcome(run: Execution): Json {
  return { kind: run.exitCode === 0 ? "success" : "nonzero", exit_code: run.exitCode, duration_ms: 0, stdout: run.stdout, stderr: run.stderr, stdout_bytes: Buffer.byteLength(run.stdout), stderr_bytes: Buffer.byteLength(run.stderr), stdout_hash: identityHash(run.stdout).slice(7), stderr_hash: identityHash(run.stderr).slice(7) };
}

function state(ctx: Context, request: Json, sdk: Json, run: Execution): Json {
  const sensitive = request["case_sensitive"] === true;
  const normalize = (path: string): string => sensitive ? path : path.toLowerCase();
  const project = Object.entries(record(request["files"])).map(([path, text]) => ({ location: { domain: "repository", path: normalize(path.slice(String(request["cwd"]).length + 1)) }, representation: "text", text })).sort((a, b) => canonicalIdentity(a) < canonicalIdentity(b) ? -1 : 1);
  const libraries = Object.entries(record(sdk["files"])).map(([path, text]) => ({ location: { domain: "sdk", path: normalize(basename(path)) }, text })).sort((a, b) => canonicalIdentity(a) < canonicalIdentity(b) ? -1 : 1);
  const input = { domain: "T00-logical-input-v3", project, sdk: { domain: "T00-logical-sdk-v3", version: sdk["version"], source_revision: sdk["source_revision"], library_manifest_sha256: sdk["library_manifest_sha256"], files: libraries } };
  const capture = { domain: "T00-logical-capture-v2", repository_root: "T00_REPOSITORY_ROOT", case_sensitive: sensitive, project };
  const scope = { profile: "modelo-suite-static-v1", repository_root: request["cwd"], subjects: { "entry.ts": { role: "source", selection: "selected" } }, effective_options: request["options"], retained: true, sdk_directory: request["sdk_directory"] };
  const snapshot = { domain: "T00-captured-snapshot-v2", input_manifest_id: digest(input), capture_id: digest(capture) };
  const facts = list(run.value["facts"]);
  const graph = { nodes: facts.map(record).filter(fact => fact["record"] === "node").map(fact => fact["payload"]), edges: facts.map(record).filter(fact => fact["record"] === "edge").map(fact => fact["payload"]) };
  return { artifact_path: ctx.producerArtifact.path, input, capture, snapshot, scope, facts, graph, profile: "modelo-suite-static-v1" };
}

function descriptor(original: Json, current: Json, run: Execution, requestId: string): Json {
  return { original, current, outcome: outcome(run), request_id: requestId, subjects: [{ id: "entry.ts", path: "entry.ts", utf16_length: source.length, line_count: 2 }] };
}

export async function identityRuntimeObservations(ctx: Context): Promise<{ properties: Property[]; evidence: Evidence[]; complete: boolean }> {
  const properties: Property[] = [], evidence: Evidence[] = [];
  if (!ctx.identityReceiver) return { properties, evidence, complete: false };
  const request = ctx.analysis(files, { id: "identity-runtime" });
  const base = await ctx.run("identity-runtime-base", "--batch", request, true);
  evidence.push(...base.evidence);
  properties.push(property("identity-runtime.batch-executed", base.exitCode, 0));
  const original = state(ctx, request, ctx.sdk, base);
  for (const [field, expected] of Object.entries({ input_manifest_id: digest(original["input"]), capture_id: digest(original["capture"]), snapshot_id: digest(original["snapshot"]), scope_id: digest(original["scope"]), producer_artifact_id: `sha256:${ctx.producerSha256}` })) properties.push(property(`identity-runtime.independent-${field}`, base.value[field], expected));
  const receive = async (label: string, current: Json, run = base, requestId = String(request["id"]), expected = original): Promise<Execution> => {
    const result = await ctx.receiveIdentity(label, descriptor(expected, current, run, requestId));
    evidence.push(...result.evidence);
    return result;
  };
  const control = await receive("identity-receiver-control", original);
  for (const kind of ["I-relocation", "I-request-separation"] as const) {
    const nextRoot = kind === "I-relocation" ? resolve(ctx.root, "relocated") : ctx.root;
    const nextRequest = { ...request, id: kind === "I-request-separation" ? "identity-other-request" : request["id"], cwd: nextRoot, roots: [resolve(nextRoot, "entry.ts")], files: { [resolve(nextRoot, "entry.ts")]: source } };
    const next = await ctx.run(`identity-${kind}`, "--batch", nextRequest, true);
    evidence.push(...next.evidence);
    const nextState = state(ctx, nextRequest, ctx.sdk, next);
    const own = await receive(`identity-${kind}-own`, nextState, next, String(nextRequest.id), nextState);
    const stale = await receive(`identity-${kind}-stale`, nextState, next);
    const stable = ["input_manifest_id", "capture_id", "snapshot_id", "producer_artifact_id"].every(field => base.value[field] === next.value[field]);
    const relation = kind === "I-relocation" ? base.value["scope_id"] !== next.value["scope_id"] : base.value["request_id"] !== next.value["request_id"] && base.value["scope_id"] === next.value["scope_id"];
    const restored = await receive(`identity-${kind}-restored`, original);
    properties.push(property(`IDENTITY::${kind}`, next.exitCode === 0 && receiverAccepted(control.value) && receiverAccepted(own.value) && stale.value["rejection"] === "IdentityMismatch" && stable && relation && receiverAccepted(restored.value), true));
  }
  const discovered = [{ relPath: "entry.ts", content: source }];
  const retained = await ctx.run("identity-retained-control", "--analyze-retained-runtime", { analysis: request, discovered_sources: discovered }, true);
  const mismatch = await ctx.run("identity-retained-mismatch", "--analyze-retained-runtime", { analysis: request, discovered_sources: [{ relPath: "entry.ts", content: source + " " }] }, true);
  const restored = await ctx.run("identity-retained-restored", "--analyze-retained-runtime", { analysis: request, discovered_sources: discovered }, true);
  evidence.push(...retained.evidence, ...mismatch.evidence, ...restored.evidence);
  let mismatchError: unknown;
  try { mismatchError = record(JSON.parse(mismatch.stderr))["error"]; } catch { mismatchError = mismatch.stderr; }
  const capturePassed = retained.exitCode === 0 && retained.value["snapshot_guard_passed"] === true && mismatch.exitCode === 1 && mismatch.stdout === "" && mismatchError === "SOURCE_SNAPSHOT_MISMATCH: entry.ts" && restored.exitCode === 0 && restored.value["snapshot_guard_passed"] === true;
  properties.push(property("IDENTITY::I-capture-mismatch", capturePassed, true));
  const native = await ctx.run("identity-consumed-libraries", "", request, true);
  const oracle = await ctx.oracle("identity-consumed-libraries", files, { args: ["--listFiles"] });
  evidence.push(...native.evidence, ...oracle.evidence);
  const reads = list(native.value["capture_probes"]).map(record).filter(probe => probe["operation"] === "read_file" && probe["found"] === true && String(probe["path"]).startsWith("/sdk/lib/"));
  const consumed = reads.map(probe => basename(String(probe["path"])));
  const joined = reads.length > 0 && reads.every(probe => { const text = record(ctx.sdk["files"])[String(probe["path"])]; return typeof text === "string" && probe["content_id"] === identityHash(text); });
  properties.push(property("identity-sdk.successful-reads-joined-to-bytes", joined, true));
  const compilerLibraries = oracle.stdout.split(/\r?\n/).map(line => basename(line.trim())).filter(name => /^lib.*\.d\.ts$/.test(name));
  const unique = (values: string[]): string[] => [...new Set(values)].sort();
  properties.push(property("identity-sdk.consumed-library-set", unique(consumed), unique(compilerLibraries)));
  properties.push(property("IDENTITY::I-sdk-supplied-vs-consumed", capturePassed && joined && native.exitCode === 0 && oracle.exitCode === 0 && consumed.includes("lib.es2022.full.d.ts") && compilerLibraries.length > 0 && canonicalIdentity(unique(consumed)) === canonicalIdentity(unique(compilerLibraries)), true));
  evidence.push(await ctx.save("identity-runtime-proof-scope", { identityExpectations: "Authored source, supplied SDK, request and P2 logical relocation contract; independent SHA256", receiverPayload: "Facts and graph are passed through only as opaque received payload to exercise identity refusal; no graph/extraction correctness inferred", allSuppliedLibrariesConsumed: false, compilerLibraries, consumed: unique(consumed) }));
  return { properties, evidence, complete: true };
}
