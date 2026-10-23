import { expect, test } from "bun:test";
import { canonicalIdentity, identityHash, identityMutationSummary, identityReceiverDescriptor, identitySupportVectors, missingEs5LibraryRefused, nativeManifest } from "./t00-ts7-q-boundary-identity";

test("independent identity canonicalization sorts nested keys while preserving array order", () => {
  expect(canonicalIdentity({ z: [{ beta: 2, alpha: 1 }, 0], a: "é" })).toBe('{"a":"é","z":[{"alpha":1,"beta":2},0]}');
  expect(canonicalIdentity({ "10": "ten", "2": "two", "01": "one", "𐀀": 1, "\ue000": 2 })).toBe('{"2":"two","10":"ten","01":"one","𐀀":1,"":2}');
});

test("native identity hashes exact implementation, package, runtime and library bytes in contract order", () => {
  const sdk = { "lib/lib.a.d.ts": Buffer.from("c"), "lib/tsgo": Buffer.from("b"), "package.json": Buffer.from("{}") };
  const observed = nativeManifest({ "a.ts": Buffer.from("a") }, sdk);
  expect(observed.identity.digest).toBe("sha256:a5b7c575d049516b315cf23a2822f92318e98b47f374421e3a860d6fc4f1a4d9");
  expect(observed.identity.compiler).toEqual({ version: "7.1.0-dev", sourceRevision: "780dc512d64f40afebffa6a7028207649fb7ed1c", digest: "sha256:46777bfd4bb763e2a4fb29e9f0b9a00af129d8e51803c3b98877b49900d77896" });
  expect(nativeManifest({ "a.ts": Buffer.from("A") }, sdk).identity.digest).not.toBe(observed.identity.digest);
  for (const path of Object.keys(sdk)) expect(nativeManifest({ "a.ts": Buffer.from("a") }, { ...sdk, [path]: Buffer.from("changed") }).identity.digest).not.toBe(observed.identity.digest);
  expect(() => nativeManifest({}, { "package.json": Buffer.from("{}") })).toThrow("explicit package and runtime bytes");
  expect(() => nativeManifest({}, { "lib/tsgo": Buffer.from("b") })).toThrow("explicit package and runtime bytes");
});

test("finite identity mutations activate a changed digest without mutating their restored control", () => {
  const sdk = { "lib/lib.a.d.ts": Buffer.from("c"), "lib/tsgo": Buffer.from("b"), "package.json": Buffer.from("{}") };
  const { bases, mutations } = identitySupportVectors(sdk);
  expect(Object.keys(bases)).toEqual(["capture", "producer", "sdk", "inputRequest"]);
  expect(new Set(mutations.map(value => value.id)).size).toBe(11);
  for (const mutation of mutations) expect(identityHash(canonicalIdentity(mutation.value))).not.toBe(identityHash(canonicalIdentity(bases[mutation.record])));
  expect(bases.capture?.absentFiles).toEqual(["tsconfig.json"]);
  expect(bases.inputRequest?.selected).toEqual(["entry.ts"]);
  expect(() => canonicalIdentity(undefined)).toThrow("not JSON");
  expect(() => canonicalIdentity({ invalid: Infinity })).toThrow("not JSON");
});

test("fixed-vector receiver envelopes bind the exact mutated record without claiming native subjects", () => {
  const artifact = { path: "/candidate", bytes: 1, sha256: "a".repeat(64) };
  const records = { producer: { implementationRevision: "first", artifactDigest: "unchanged" }, capture: { absentFiles: ["tsconfig.json"] } };
  const current = { ...records, producer: { ...records.producer, implementationRevision: "second" } };
  const descriptor = identityReceiverDescriptor(artifact, records, current);
  const original = descriptor.original as Record<string, unknown>, changed = descriptor.current as Record<string, unknown>;
  expect(original.input).toEqual(records);
  expect(changed.input).toEqual(current);
  expect(original.artifact_path).toBe(changed.artifact_path);
  expect(original.capture).toEqual({});
  expect(original.scope).toEqual({});
  expect(descriptor.subjects).toEqual([]);
  const outcome = descriptor.outcome as Record<string, unknown>;
  const batch = JSON.parse(String(outcome.stdout));
  expect(batch.subjects).toEqual([]);
  expect(batch.facts).toEqual([]);
  expect(batch.profile).toBe("identity-fixed-vector");
  expect(batch.producer_artifact_id).toBe("sha256:" + "a".repeat(64));
  expect(batch.input_manifest_id).not.toBe(identityHash(canonicalIdentity(current)));
});

test("identity support summaries require canonical comparisons and every fixed-vector receiver witness", () => {
  const id = "I-source-byte";
  const properties = ["activation.canonical", "control.canonical", "digest-relation", "fixed-vector-receiver-control", "fixed-vector-receiver-mutation", "fixed-vector-receiver-restored"].map(suffix => ({ name: `IDENTITY::${id}.${suffix}`, pass: true, actual: true, expected: true, oracle: "test fixture" }));
  expect(identityMutationSummary(id, properties).pass).toBe(true);
  expect(identityMutationSummary(id, []).pass).toBe(false);
  expect(identityMutationSummary(id, properties.filter(property => !property.name.includes("receiver"))).pass).toBe(false);
  for (const omitted of properties) expect(identityMutationSummary(id, properties.filter(property => property !== omitted)).pass).toBe(false);
  for (const failed of properties) expect(identityMutationSummary(id, properties.map(property => property === failed ? { ...property, pass: false } : property)).pass).toBe(false);
  expect(identityMutationSummary(id, [...properties, properties[0]!]).pass).toBe(false);
  expect(identityMutationSummary(id, [...properties, { ...properties[0]!, name: "unrelated", pass: false }]).pass).toBe(true);
  expect(identityMutationSummary(id, properties).name).toBe("IDENTITY::I-source-byte");
});

test("native missing-library control requires TS7 global-type refusal and confined consumed libraries", () => {
  const sdkRoot = "/fixture/sdk";
  const diagnostic = "error TS2318: Cannot find global type 'Object'.\n";
  const libraries = "/fixture/sdk/lib/lib.es2022.d.ts\n/fixture/sdk/lib/lib.es2022.full.d.ts\n";
  const execution = { exitCode: 2, stderr: "", stdout: diagnostic + libraries + "/fixture/entry.ts\n" };
  expect(missingEs5LibraryRefused(execution, sdkRoot)).toBe(true);
  for (const altered of [
    { ...execution, exitCode: 0 },
    { ...execution, exitCode: 1 },
    { ...execution, stdout: "" },
    { ...execution, stdout: diagnostic },
    { ...execution, stdout: libraries },
    { ...execution, stdout: execution.stdout + "/foreign/lib/lib.es2015.d.ts\n" },
    { ...execution, stdout: execution.stdout + "/fixture/sdk/lib/lib.es5.d.ts\n" },
    { ...execution, stdout: execution.stdout + "/fixture/sdk/lib/../foreign/lib.es2015.d.ts\n" },
    { ...execution, stderr: "execution failed" },
  ]) expect(missingEs5LibraryRefused(altered, sdkRoot)).toBe(false);
});
