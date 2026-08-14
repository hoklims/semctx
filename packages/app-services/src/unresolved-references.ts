import { digestCanonical, type UnresolvedReference } from "@semantic-context/plane-a-internal";
import { edgeId, type RepositoryEdge } from "@semantic-context/core";
import {
  CONTROL_INDEX_SNAPSHOT_META_KEY,
  PLANE_A_INDEX_SNAPSHOT_META_KEY,
  fingerprintPlaneAIndexSnapshot,
  parseIndexedControlSnapshot,
} from "./freshness";

/** Store metadata key holding the index's own record of authored references it could not resolve. */
export const UNRESOLVED_REFERENCE_INDEX_META_KEY = "plane_a_unresolved_reference_index_v1";

/**
 * An authored cross-reference naming a target the indexed repository does not contain, recorded
 * with the index that observed it.
 *
 * Persisted rather than printed once: the gap belongs to the indexed state, so every later reader
 * of that state must be able to see it. `indexHash` fingerprints `references` alone, so the record
 * is comparable across processes without re-deriving the graph.
 */
export interface PersistedUnresolvedReferenceIndexV1 {
  schemaVersion: 1;
  kind: "plane_a_unresolved_reference_index";
  indexHash: string;
  references: UnresolvedReference[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Deterministic for a given set of references: ordered by edge identity, hashed canonically. */
export function createUnresolvedReferenceIndex(
  references: readonly UnresolvedReference[],
): PersistedUnresolvedReferenceIndexV1 {
  const ordered = [...references].sort((left, right) => compareText(left.edgeId, right.edgeId));
  return {
    schemaVersion: 1,
    kind: "plane_a_unresolved_reference_index",
    indexHash: digestCanonical(ordered),
    references: ordered,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isUnresolvedReference(value: unknown): value is UnresolvedReference {
  if (
    !isRecord(value)
    || !isNonEmptyString(value["edgeId"])
    || !isNonEmptyString(value["kind"])
    || !isNonEmptyString(value["from"])
    || !isNonEmptyString(value["to"])
    // The absent endpoint is the target by construction; a record claiming otherwise describes a
    // state the assembler treats as fatal and could never have produced.
    || value["missing"] !== value["to"]
  ) {
    return false;
  }
  return edgeId(value["kind"] as RepositoryEdge["kind"], value["from"], value["to"])
    === value["edgeId"];
}

/**
 * Read a persisted record back. `undefined` covers both an index that predates this record and one
 * whose record does not parse: neither proves anything about the repository, and a caller must name
 * the gap rather than read absence as "no unresolved reference".
 */
export function parseUnresolvedReferenceIndex(
  raw: string | undefined,
): PersistedUnresolvedReferenceIndexV1 | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value)
      || value["schemaVersion"] !== 1
      || value["kind"] !== "plane_a_unresolved_reference_index"
      || !isNonEmptyString(value["indexHash"])
      || !Array.isArray(value["references"])
      || !value["references"].every(isUnresolvedReference)
    ) {
      return undefined;
    }
    const parsed = value as unknown as PersistedUnresolvedReferenceIndexV1;
    // A record whose hash does not cover its own contents is not a record of anything.
    return createUnresolvedReferenceIndex(parsed.references).indexHash === parsed.indexHash
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why the persisted record could not be tied back to the index that claims to have produced it.
 * A self-consistent record proves only that whoever wrote it could also compute its hash, so every
 * link of the chain — record, Plane-A snapshot, sealed control snapshot — is named separately.
 */
export type UnresolvedReferenceBindingReason =
  | "REGISTRY_ABSENT"
  | "REGISTRY_INVALID"
  | "SNAPSHOT_ABSENT"
  | "SNAPSHOT_INVALID"
  | "REGISTRY_NOT_IN_SNAPSHOT"
  | "CONTROL_SNAPSHOT_ABSENT"
  | "CONTROL_SNAPSHOT_INVALID"
  | "SNAPSHOT_UNAUTHORIZED";

export type UnresolvedReferenceBinding =
  | { status: "bound"; references: readonly UnresolvedReference[] }
  | { status: "unbound"; reason: UnresolvedReferenceBindingReason };

function unbound(reason: UnresolvedReferenceBindingReason): UnresolvedReferenceBinding {
  return { status: "unbound", reason };
}

/**
 * Resolve the persisted record against the sealed authority of the index, not merely against its
 * own hash. Swapping the record for an empty but self-consistent one leaves the Plane-A snapshot
 * still naming the original hash; rewriting both leaves the snapshot no longer the one the control
 * snapshot authorized. Applies identically at config v1 and v2 — indexing binds the Plane-A snapshot
 * unconditionally, so neither version can carry an unauthorized one.
 */
export function readUnresolvedReferenceBinding(
  reader: { getMeta(key: string): string | undefined },
): UnresolvedReferenceBinding {
  const rawRegistry = reader.getMeta(UNRESOLVED_REFERENCE_INDEX_META_KEY);
  if (rawRegistry === undefined || rawRegistry.length === 0) return unbound("REGISTRY_ABSENT");
  const registry = parseUnresolvedReferenceIndex(rawRegistry);
  if (registry === undefined) return unbound("REGISTRY_INVALID");

  const rawSnapshot = reader.getMeta(PLANE_A_INDEX_SNAPSHOT_META_KEY);
  if (rawSnapshot === undefined || rawSnapshot.length === 0) return unbound("SNAPSHOT_ABSENT");
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(rawSnapshot);
  } catch {
    return unbound("SNAPSHOT_INVALID");
  }
  if (!isRecord(snapshot)) return unbound("SNAPSHOT_INVALID");
  if (snapshot["unresolvedReferenceIndexHash"] !== registry.indexHash) {
    return unbound("REGISTRY_NOT_IN_SNAPSHOT");
  }

  let control;
  try {
    control = parseIndexedControlSnapshot(reader.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY));
  } catch {
    return unbound("CONTROL_SNAPSHOT_INVALID");
  }
  if (control === null) return unbound("CONTROL_SNAPSHOT_ABSENT");
  const authorized = control.schemaVersion === 2 ? control.planeAIndexSnapshotHash : undefined;
  if (authorized === undefined || authorized !== fingerprintPlaneAIndexSnapshot(rawSnapshot)) {
    return unbound("SNAPSHOT_UNAUTHORIZED");
  }
  return { status: "bound", references: registry.references };
}
