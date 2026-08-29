/**
 * Whether an index may authorize rewriting authored anchor coordinates.
 *
 * The anchor migration edits files a human wrote, on the strength of what an index says the
 * repository contains. That is only defensible while the index still speaks for the working tree,
 * so the question is asked here — where the canonical control, freshness and health services live —
 * and answered as a verdict the migration itself cannot manufacture.
 *
 * Every reason is a *distinct repair*: re-index, commit or revert the tree, or rebuild a store
 * written before the current binding existed. Collapsing them into one "not ready" would leave the
 * operator guessing which.
 */

import { isSemctxError } from "@semantic-context/core";
import { SCHEMA_VERSION } from "@semantic-context/repository-store";
import {
  LEGACY_SYMBOL_ANCHOR_SUPPORT,
  authorized,
  refusedAuthority,
  type AnchorMigrationAuthority,
  type AnchorMigrationAuthorityReason,
  type AnchorMigrationGeneration,
} from "@semantic-context/semantic-engine";
import { indexHealth } from "./index-health";
import { openReadyRepository } from "./readiness";
import {
  CONTROL_INDEX_SNAPSHOT_META_KEY,
  PLANE_A_INDEX_SNAPSHOT_META_KEY,
  fingerprintPlaneAIndexSnapshot,
  parseIndexedControlSnapshot,
} from "./freshness";

interface StoreReading {
  /**
   * A store whose control snapshot predates the v2 binding cannot prove which Plane-A snapshot it
   * authorized, so nothing derived from it may license a write to authored files. Recognising it
   * separately from a merely invalid binding is what tells the operator to re-index rather than to
   * go looking for tampering.
   */
  normalized: boolean;
  /**
   * Which immutable generation this verdict speaks for. `null` when the store cannot name one,
   * which is refused downstream rather than treated as "any generation will do".
   */
  generation: AnchorMigrationGeneration | null;
}

const UNREADABLE: StoreReading = { normalized: false, generation: null };

/**
 * One pass over the store: whether its schema is normalized, and which generation it is.
 *
 * Both answers come from the same read so they cannot describe two different states of the store —
 * which is the very failure the generation exists to catch.
 */
function readStore(root: string): StoreReading {
  let reader;
  try {
    reader = openReadyRepository(root);
  } catch {
    return UNREADABLE;
  }
  try {
    const control = parseIndexedControlSnapshot(reader.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY));
    const normalized = control !== null
      && control.schemaVersion === 2
      && control.storeSchemaVersion === SCHEMA_VERSION;

    const rawSnapshot = reader.getMeta(PLANE_A_INDEX_SNAPSHOT_META_KEY);
    if (rawSnapshot === undefined || rawSnapshot.length === 0) {
      return { normalized, generation: null };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawSnapshot);
    } catch {
      return { normalized, generation: null };
    }
    const graphHash = (parsed as { repositoryGraphHash?: unknown } | null)?.repositoryGraphHash;
    const snapshotHash = fingerprintPlaneAIndexSnapshot(rawSnapshot);
    // A snapshot that cannot be fingerprinted, or that names no facts, cannot identify a generation.
    // Refusing to invent one here is what keeps a later "same generation?" check honest.
    if (typeof graphHash !== "string" || graphHash.length === 0 || snapshotHash === null) {
      return { normalized, generation: null };
    }
    return { normalized, generation: { snapshot: snapshotHash, facts: graphHash } };
  } catch {
    return UNREADABLE;
  } finally {
    reader.close();
  }
}

/** Read-only. Never indexes, re-seals, or mutates anything to make its own verdict greener. */
export function anchorMigrationAuthority(root: string): AnchorMigrationAuthority {
  // Once compatibility is retired the command has nothing left to migrate and is due for deletion;
  // it must refuse rather than quietly rewrite anchors under a rule that no longer exists.
  if (LEGACY_SYMBOL_ANCHOR_SUPPORT === "removed") {
    return refusedAuthority(["LEGACY_SUPPORT_REMOVED"]);
  }

  let health;
  try {
    health = indexHealth(root);
  } catch (error) {
    if (isSemctxError(error) && (error.code === "CONFIG_NOT_FOUND" || error.code === "REPO_NOT_INDEXED")) {
      return refusedAuthority(["INDEX_ABSENT"]);
    }
    throw error;
  }

  const reasons: AnchorMigrationAuthorityReason[] = [];
  if (health.binding.status === "absent") return refusedAuthority(["INDEX_ABSENT"]);
  if (health.binding.status === "invalid") reasons.push("INDEX_BINDING_INVALID");
  if (health.freshness.verdict === "STALE") reasons.push("INDEX_STALE");
  if (health.freshness.verdict === "UNSEALED") reasons.push("INDEX_UNSEALED");

  const store = readStore(root);
  if (!store.normalized) reasons.push("INDEX_SCHEMA_UNNORMALIZED");
  // A store that cannot name the generation it is cannot license a rewrite of authored files: the
  // whole point of naming it is to prove later that the index has not been rebuilt underneath.
  if (store.generation === null) reasons.push("INDEX_GENERATION_DRIFTED");

  return reasons.length === 0 && store.generation !== null
    ? authorized(store.generation)
    : refusedAuthority(reasons);
}
