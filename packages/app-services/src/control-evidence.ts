import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { compareIds, SemctxError } from "@semantic-context/core";
import { parseObservedDiffHunks } from "@semantic-context/context-engine";
import {
  ObservedDiffHunkTransportV1Schema,
  createObservedDiffHunkV1,
  normalizeObservedDiffPath,
  sha256HashBytes,
  sha256HashCanonicalJson,
  sha256HashUtf8,
  type ObservedDiffHunkTransportV1,
  type ObservedDiffHunkV1,
  type Sha256Hash,
} from "@semantic-context/control-model";
import type { SemanticModel } from "@semantic-context/semantic-model";
import { canonicalRepositoryRoot, fingerprintSemanticNodeEvidence } from "./freshness";

export const CONTROL_OBSERVED_HUNK_INDEX_META_KEY = "control_observed_hunks_v1";

export interface PersistedObservedHunkIndexV1 {
  schemaVersion: 1;
  repositoryIdentity: string;
  workingDiffHash: Sha256Hash | null;
  hunks: readonly ObservedDiffHunkTransportV1[];
  indexHash: Sha256Hash;
}

export function createObservedHunkIndex(
  repositoryIdentity: string,
  workingDiffHash: Sha256Hash | null,
  hunks: readonly ObservedDiffHunkV1[],
): PersistedObservedHunkIndexV1 {
  const transports = canonicalHunks(hunks).map(toTransport);
  const payload = { schemaVersion: 1 as const, repositoryIdentity, workingDiffHash, hunks: transports };
  return { ...payload, indexHash: sha256HashCanonicalJson(payload) };
}

export function parseObservedHunkIndex(value: string | undefined): PersistedObservedHunkIndexV1 | null {
  if (value === undefined || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value) as Partial<PersistedObservedHunkIndexV1>;
    if (
      parsed.schemaVersion !== 1
      || typeof parsed.repositoryIdentity !== "string"
      || parsed.repositoryIdentity.length === 0
      || !Array.isArray(parsed.hunks)
      || typeof parsed.indexHash !== "string"
      || (parsed.workingDiffHash !== null && typeof parsed.workingDiffHash !== "string")
    ) throw new Error("invalid observed hunk index");
    const hunks = parsed.hunks.map((hunk) =>
      ObservedDiffHunkTransportV1Schema.parse(hunk) as ObservedDiffHunkTransportV1
    );
    const payload = {
      schemaVersion: 1 as const,
      repositoryIdentity: parsed.repositoryIdentity,
      workingDiffHash: parsed.workingDiffHash ?? null,
      hunks,
    };
    if (sha256HashCanonicalJson(payload) !== parsed.indexHash) {
      throw new Error("observed hunk index hash mismatch");
    }
    // Recreate every identity from the decoded bytes; transport validation alone is not authority.
    const decoded = hunks.map(fromTransport);
    if (canonicalHunks(decoded).length !== decoded.length) throw new Error("duplicate observed hunk");
    return { ...payload, indexHash: parsed.indexHash as Sha256Hash };
  } catch (error) {
    throw new SemctxError("STORE_ERROR", "invalid persisted control observed hunk index", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function observedHunksFromIndex(index: PersistedObservedHunkIndexV1): ObservedDiffHunkV1[] {
  return index.hunks.map(fromTransport);
}

export function materializeReferencedObservedHunks(
  root: string,
  repositoryIdentity: string,
  semanticModel: SemanticModel,
  currentHunks: readonly ObservedDiffHunkV1[],
): ObservedDiffHunkV1[] {
  const expected = new Map<string, Set<Sha256Hash>>();
  for (const relation of semanticModel.refinementRelations ?? []) {
    const endpointIds = [relation.source, relation.target]
      .filter((endpoint) => endpoint.kind === "observed_diff_hunk")
      .map((endpoint) => endpoint.kind === "observed_diff_hunk" ? endpoint.coordinateDigest : null)
      .filter((identity): identity is Sha256Hash => identity !== null);
    for (const reference of relation.evidenceRefs) {
      if (reference.kind !== "observed_diff_hunk") continue;
      const digest = `sha256:${reference.digest.value}` as Sha256Hash;
      if (!endpointIds.includes(digest)) continue;
      const identities = expected.get(reference.locator) ?? new Set<Sha256Hash>();
      identities.add(digest);
      expected.set(reference.locator, identities);
    }
  }
  const byIdentity = new Map(currentHunks.map((hunk) => [hunk.identity, hunk]));
  for (const [locator, identities] of [...expected].sort(([left], [right]) => compareIds(left, right))) {
    const missing = new Set([...identities].filter((identity) => !byIdentity.has(identity)));
    if (missing.size === 0) continue;
    const bytes = readSafeRepositoryFile(root, locator);
    if (bytes === null) continue;
    let hunks: ObservedDiffHunkV1[];
    try {
      hunks = parseObservedDiffHunks({ repositoryIdentity, diffBytes: bytes });
    } catch {
      continue;
    }
    for (const hunk of hunks) {
      if (missing.has(hunk.identity)) byIdentity.set(hunk.identity, hunk);
    }
  }
  return canonicalHunks([...byIdentity.values()]);
}

export function resolveVerifiedRelationEvidence(
  root: string,
  semanticModel: SemanticModel,
  observedHunks: readonly ObservedDiffHunkV1[],
  headCommit: string | null,
): Sha256Hash[] {
  const verified = new Set<Sha256Hash>();
  const hunkIds = new Set(observedHunks.map((hunk) => hunk.identity));
  const nodes = new Map(semanticModel.nodes.map((node) => [node.id, node]));
  for (const relation of semanticModel.refinementRelations ?? []) {
    for (const reference of relation.evidenceRefs) {
      const expected = `sha256:${reference.digest.value}` as Sha256Hash;
      if (reference.kind === "observed_diff_hunk") {
        if (hunkIds.has(expected)) verified.add(expected);
        continue;
      }
      if (reference.kind === "semantic_node") {
        const node = nodes.get(reference.locator);
        if (node !== undefined && fingerprintSemanticNodeEvidence(node) === expected) verified.add(expected);
        continue;
      }
      if (reference.kind === "commit") {
        if (
          headCommit !== null
          && (reference.locator === headCommit || reference.locator === `git:${headCommit}`)
          && sha256HashUtf8(headCommit) === expected
        ) verified.add(expected);
        continue;
      }
      const bytes = readSafeRepositoryFile(root, reference.locator);
      if (bytes !== null && sha256HashBytes(bytes) === expected) verified.add(expected);
    }
  }
  return [...verified].sort(compareIds);
}

function readSafeRepositoryFile(root: string, locator: string): Uint8Array | null {
  let normalized: string;
  try {
    normalized = normalizeObservedDiffPath(locator);
  } catch {
    return null;
  }
  const repositoryRoot = canonicalRepositoryRoot(root);
  const absolute = resolve(repositoryRoot, normalized);
  if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isFile()) return null;
  const real = realpathSync.native(absolute);
  const rel = relative(repositoryRoot, real).replace(/\\/g, "/");
  if (rel === ".." || rel.startsWith("../")) return null;
  return new Uint8Array(readFileSync(real));
}

function toTransport(hunk: ObservedDiffHunkV1): ObservedDiffHunkTransportV1 {
  return {
    ...hunk,
    rawHunkBytes: { encoding: "base64", value: Buffer.from(hunk.rawHunkBytes).toString("base64") },
  };
}

function fromTransport(transport: ObservedDiffHunkTransportV1): ObservedDiffHunkV1 {
  const bytes = Buffer.from(transport.rawHunkBytes.value, "base64");
  if (bytes.toString("base64") !== transport.rawHunkBytes.value) throw new Error("non-canonical base64");
  const recreated = createObservedDiffHunkV1({ ...transport, rawHunkBytes: new Uint8Array(bytes) });
  if (recreated.identity !== transport.identity) throw new Error("observed hunk identity mismatch");
  return recreated;
}

function canonicalHunks(hunks: readonly ObservedDiffHunkV1[]): ObservedDiffHunkV1[] {
  const byId = new Map<Sha256Hash, ObservedDiffHunkV1>();
  for (const hunk of hunks) {
    if (byId.has(hunk.identity)) throw new Error("duplicate observed hunk");
    byId.set(hunk.identity, hunk);
  }
  return [...byId.values()].sort((left, right) => compareIds(left.identity, right.identity));
}
