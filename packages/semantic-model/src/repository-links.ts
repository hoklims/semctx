/** Shared Plane A link resolution used by both Plane B checks and Plane C coordinates. */

import { compareIds, parseLegacySymbolId, parseSymbolId, symbolScopePath } from "@semantic-context/core";
import type { Claim, EvidenceRecord, RepositoryGraph } from "@semantic-context/core";
// Deliberately the narrow subpath, not the package root: Plane B resolution must not pull the
// control plane's authority modules into its dependency closure, and an architecture test asserts
// exactly that.
import {
  LINK_RESOLUTION_REASON_CODES,
  MAX_LINK_CANDIDATES,
  type LinkResolutionReasonCode,
} from "@semantic-context/control-model/link-resolution";
import { allSemanticIds } from "./model";
import type { RepositoryLink, SemanticModel } from "./types";

/**
 * Re-exported from the shared Plane-C vocabulary rather than restated.
 *
 * The ordering is part of the contract — most-specific first, so a report can rank without
 * re-deriving intent — and it is the same tuple Plane C, reconciliation validation and MCP read.
 */
export const LINK_RESOLUTION_REASON_ORDER = LINK_RESOLUTION_REASON_CODES;
export { MAX_LINK_CANDIDATES };
export type { LinkResolutionReasonCode };

/**
 * Whether the deprecated line-bearing anchor form still resolves.
 *
 * `removed` is the terminal state: a legacy anchor stops resolving and is reported like any other
 * broken anchor. Threaded as a parameter rather than read from module state so the removal can be
 * exercised by a test instead of only being asserted about a constant.
 */
export type LegacySymbolAnchorSupport = "deprecated" | "removed";

/**
 * Current support level. Flipping this constant to `"removed"` is the whole removal: the resolver
 * reads it, so no other edit is required and no surface can keep honouring legacy anchors behind
 * its back.
 */
export const LEGACY_SYMBOL_ANCHOR_SUPPORT: LegacySymbolAnchorSupport = "deprecated";

/**
 * The release that first ships line-independent identity, recorded when it is tagged.
 *
 * `null` while unreleased. Compatibility is scoped to exactly that release: the release that
 * follows it must carry `LEGACY_SYMBOL_ANCHOR_SUPPORT = "removed"`. The condition is encoded here
 * and asserted by a test rather than written as an invented version number, because the release
 * numbering for this change is not yet an authority in this repository.
 */
export const LEGACY_SYMBOL_ANCHOR_SHIPPED_IN: string | null = null;

export interface LinkResolutionOptions {
  /** Defaults to the module constant. A test may pass `"removed"` to exercise the terminal state. */
  legacySupport?: LegacySymbolAnchorSupport;
}

export interface RepositoryFacts {
  graph: RepositoryGraph;
  claims: Claim[];
  evidence: EvidenceRecord[];
}

export interface RepositoryLinkIndex {
  nodeIds: ReadonlySet<string>;
  fileNodeIds: ReadonlyMap<string, readonly string[]>;
  claimIds: ReadonlySet<string>;
  evidenceIds: ReadonlySet<string>;
  /** `relPath \0 scopePath` → canonical symbol ids at that exact coordinate, any kind. */
  symbolsByCoordinate: ReadonlyMap<string, readonly string[]>;
  /**
   * `relPath \0 kind \0 scopePath` → canonical symbol ids of that exact kind at that coordinate.
   *
   * Separate from `symbolsByCoordinate` because "is anything declared here" and "is a *function*
   * declared here" are different questions, and answering the second with the first is what let a
   * collision be reported as `role_removed` while the kind had not changed at all.
   */
  symbolsByCoordinateKind: ReadonlyMap<string, readonly string[]>;
  /** `relPath \0 kind \0 name` → canonical symbol ids, whatever their scope. */
  symbolsByFileKindName: ReadonlyMap<string, readonly string[]>;
}

export type RepositoryLinkTarget =
  | { kind: "repository_node"; id: string }
  | { kind: "claim"; id: string }
  | { kind: "evidence"; id: string };

export interface RepositoryLinkResolution {
  resolved: boolean;
  targets: RepositoryLinkTarget[];
  reason?: string;
  /** Machine reason. Present exactly when `resolved` is false. */
  reasonCode?: LinkResolutionReasonCode;
  /** Bounded, sorted, deterministic. Offered for a human to choose; never chosen automatically. */
  candidates?: string[];
  /** Resolved only through the deprecated line-bearing anchor form. */
  legacy?: boolean;
}

export interface LinkResolution {
  ownerId: string;
  link: RepositoryLink;
  resolved: boolean;
  reason?: string;
  reasonCode?: LinkResolutionReasonCode;
  candidates?: string[];
  legacy?: boolean;
}

export interface StaleLinkResolution extends LinkResolution {
  resolved: false;
  reason: string;
  reasonCode: LinkResolutionReasonCode;
}

export interface DanglingReference {
  ownerId: string;
  field: string;
  ref: string;
}

export interface LinkReport {
  resolutions: LinkResolution[];
  staleLinks: StaleLinkResolution[];
  danglingReferences: DanglingReference[];
  /** Owner ids with at least one stale link. */
  staleNodeIds: string[];
  /** Resolutions that only held through the deprecated line-bearing anchor form. */
  legacyAnchors: LinkResolution[];
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [value]);
  else bucket.push(value);
}

function frozen(map: Map<string, string[]>): Map<string, readonly string[]> {
  return new Map([...map].map(([key, ids]) => [key, [...new Set(ids)].sort(compareIds)]));
}

export function buildRepositoryLinkIndex(facts: RepositoryFacts): RepositoryLinkIndex {
  const nodeIds = new Set<string>();
  const fileNodeIds = new Map<string, string[]>();
  const symbolsByCoordinate = new Map<string, string[]>();
  const symbolsByCoordinateKind = new Map<string, string[]>();
  const symbolsByFileKindName = new Map<string, string[]>();
  for (const node of facts.graph.nodes) {
    nodeIds.add(node.id);
    const parsed = parseSymbolId(node.id);
    if (parsed !== undefined) {
      const coordinate = symbolScopePath(parsed.scope, parsed.name);
      push(symbolsByCoordinate, `${parsed.relPath}\0${coordinate}`, node.id);
      push(symbolsByCoordinateKind, `${parsed.relPath}\0${parsed.kind}\0${coordinate}`, node.id);
      push(symbolsByFileKindName, `${parsed.relPath}\0${parsed.kind}\0${parsed.name}`, node.id);
    }
    if (node.filePath === undefined) continue;
    push(fileNodeIds, node.filePath, node.id);
  }
  return {
    nodeIds,
    fileNodeIds: frozen(fileNodeIds),
    claimIds: new Set(facts.claims.map((claim) => claim.id)),
    evidenceIds: new Set(facts.evidence.map((item) => item.id)),
    symbolsByCoordinate: frozen(symbolsByCoordinate),
    symbolsByCoordinateKind: frozen(symbolsByCoordinateKind),
    symbolsByFileKindName: frozen(symbolsByFileKindName),
  };
}

function bounded(ids: readonly string[]): string[] {
  return [...ids].sort(compareIds).slice(0, MAX_LINK_CANDIDATES);
}

/** Every symbol id the file holds, for the candidate list of an anchor that matched nothing. */
function symbolsInFile(index: RepositoryLinkIndex, relPath: string): readonly string[] {
  return index.fileNodeIds.get(relPath)?.filter((id) => parseSymbolId(id) !== undefined) ?? [];
}

/**
 * Resolve a symbol anchor by name only — never by proximity, similarity or content.
 *
 * Three refusals are load-bearing and each of them is a place a previous version could silently
 * rebind an address to a different body.
 *
 * An id carrying a `#N` collision discriminator is **not an address**. The discriminator follows
 * source order, so inserting or reordering same-named declarations moves it; honouring it would let
 * yesterday's anchor name today's other function. Such an id exists as a graph fact, and the
 * resolver refuses it outright rather than resolving it under a suffix nobody can rely on.
 *
 * The bare id of a coordinate that holds a collision is refused too. Nothing there identifies which
 * body was meant, so `ambiguous` is the honest answer and the candidates are offered for a human.
 *
 * A legacy line-bearing anchor is recognised *before* the exact-id shortcut. An index built by an
 * older semctx can literally contain `sym:function:a.ts:run:12` as a node id; matching it exactly
 * would report a deprecated anchor as perfectly healthy and hide it from both the deprecation
 * warning and the migration.
 */
function resolveSymbolLink(
  ref: string,
  index: RepositoryLinkIndex,
  legacySupport: LegacySymbolAnchorSupport,
): RepositoryLinkResolution {
  const legacy = parseLegacySymbolId(ref);
  if (legacy !== undefined) {
    const byName = index.symbolsByFileKindName.get(`${legacy.relPath}\0${legacy.kind}\0${legacy.name}`) ?? [];
    if (legacySupport === "removed") {
      return {
        resolved: false,
        targets: [],
        reasonCode: "symbol_gone",
        reason: "line-bearing symbol anchors are no longer supported; re-anchor on the scope-qualified form",
        candidates: bounded(byName.length > 0 ? byName : symbolsInFile(index, legacy.relPath)),
      };
    }
    // An older index can hold this exact id as a node. It resolves, but it is still the deprecated
    // form and must be reported as such.
    if (index.nodeIds.has(ref)) {
      return { resolved: true, targets: [{ kind: "repository_node", id: ref }], legacy: true };
    }
    if (byName.length === 1) {
      return {
        resolved: true,
        targets: [{ kind: "repository_node", id: byName[0]! }],
        legacy: true,
      };
    }
    if (byName.length > 1) {
      return {
        resolved: false,
        targets: [],
        reasonCode: "ambiguous",
        reason: "deprecated line-bearing anchor matches more than one symbol; re-anchor it explicitly",
        candidates: bounded(byName),
      };
    }
    return {
      resolved: false,
      targets: [],
      reasonCode: "symbol_gone",
      reason: "deprecated line-bearing anchor names a symbol this repository no longer contains",
      candidates: bounded(symbolsInFile(index, legacy.relPath)),
    };
  }

  const canonical = parseSymbolId(ref);
  if (canonical === undefined) {
    return { resolved: false, targets: [], reasonCode: "symbol_gone", reason: "symbol node id not found in the graph" };
  }

  const coordinate = symbolScopePath(canonical.scope, canonical.name);
  const sameKindHere = index.symbolsByCoordinateKind
    .get(`${canonical.relPath}\0${canonical.kind}\0${coordinate}`) ?? [];

  if (canonical.ordinal !== undefined) {
    return {
      resolved: false,
      targets: [],
      reasonCode: "ambiguous",
      reason: "a '#N' collision discriminator follows source order and is not an anchorable address",
      candidates: bounded(sameKindHere),
    };
  }

  if (index.nodeIds.has(ref)) {
    return { resolved: true, targets: [{ kind: "repository_node", id: ref }] };
  }

  // The kind did not change — several declarations of it share this coordinate and none of them
  // owns the bare id. Diagnosing this as `role_removed` would send the author looking for a role
  // that is still there.
  if (sameKindHere.length > 0) {
    return {
      resolved: false,
      targets: [],
      reasonCode: "ambiguous",
      reason: `several ${canonical.kind} declarations share this coordinate; none of them owns the unqualified anchor`,
      candidates: bounded(sameKindHere),
    };
  }

  // Same coordinate, different kind: the declaration is still there, the role named by the anchor
  // is not. Repairing this means changing the anchor's kind, not hunting for the symbol.
  const atCoordinate = index.symbolsByCoordinate.get(`${canonical.relPath}\0${coordinate}`) ?? [];
  if (atCoordinate.length > 0) {
    return {
      resolved: false,
      targets: [],
      reasonCode: "role_removed",
      reason: `no ${canonical.kind} is declared at this coordinate any more`,
      candidates: bounded(atCoordinate),
    };
  }

  const elsewhere = index.symbolsByFileKindName.get(`${canonical.relPath}\0${canonical.kind}\0${canonical.name}`) ?? [];
  if (elsewhere.length > 1) {
    return {
      resolved: false,
      targets: [],
      reasonCode: "ambiguous",
      reason: "several symbols of this kind and name exist in the file, none at the anchored scope",
      candidates: bounded(elsewhere),
    };
  }
  return {
    resolved: false,
    targets: [],
    reasonCode: "symbol_gone",
    reason: "symbol node id not found in the graph",
    candidates: bounded(elsewhere),
  };
}

export function resolveRepositoryLink(
  link: RepositoryLink,
  index: RepositoryLinkIndex,
  options: LinkResolutionOptions = {},
): RepositoryLinkResolution {
  switch (link.kind) {
    case "file": {
      const ids = index.fileNodeIds.get(link.ref) ?? [];
      return ids.length > 0
        ? { resolved: true, targets: ids.map((id) => ({ kind: "repository_node" as const, id })) }
        : { resolved: false, targets: [], reasonCode: "path_absent", reason: "no indexed file matches this path" };
    }
    case "claim":
      return index.claimIds.has(link.ref)
        ? { resolved: true, targets: [{ kind: "claim", id: link.ref }] }
        : { resolved: false, targets: [], reasonCode: "claim_absent", reason: "claim id not found in the graph" };
    case "evidence":
      return index.evidenceIds.has(link.ref)
        ? { resolved: true, targets: [{ kind: "evidence", id: link.ref }] }
        : { resolved: false, targets: [], reasonCode: "evidence_absent", reason: "evidence id not found in the graph" };
    case "symbol":
      return resolveSymbolLink(
        link.ref,
        index,
        options.legacySupport ?? LEGACY_SYMBOL_ANCHOR_SUPPORT,
      );
    default:
      return index.nodeIds.has(link.ref)
        ? { resolved: true, targets: [{ kind: "repository_node", id: link.ref }] }
        : { resolved: false, targets: [], reasonCode: "node_absent", reason: `${link.kind} node id not found in the graph` };
  }
}

/** Internal semantic references that point at an id not declared anywhere in the model. */
export function findDanglingReferences(model: SemanticModel): DanglingReference[] {
  const ids = allSemanticIds(model);
  const out: DanglingReference[] = [];
  for (const node of model.nodes) {
    for (const relation of node.relations) {
      if (!ids.has(relation.to)) out.push({ ownerId: node.id, field: relation.kind, ref: relation.to });
    }
  }
  for (const change of model.changes) {
    for (const to of change.serves) if (!ids.has(to)) out.push({ ownerId: change.id, field: "serves", ref: to });
    for (const to of change.preserves) if (!ids.has(to)) out.push({ ownerId: change.id, field: "preserves", ref: to });
    for (const to of change.requiresEvidence) if (!ids.has(to)) out.push({ ownerId: change.id, field: "requires_evidence", ref: to });
    for (const to of change.openUnknowns) if (!ids.has(to)) out.push({ ownerId: change.id, field: "unknown", ref: to });
  }
  return out.sort((left, right) => compareIds(left.ownerId, right.ownerId) || compareIds(left.field, right.field) || compareIds(left.ref, right.ref));
}

/** Resolve all authored repository links and internal references against indexed facts. */
export function resolveRepositoryLinks(
  model: SemanticModel,
  facts: RepositoryFacts,
  options: LinkResolutionOptions = {},
): LinkReport {
  const index = buildRepositoryLinkIndex(facts);
  const resolutions: LinkResolution[] = allLinks(model).map(({ ownerId, link }) => {
    const result = resolveRepositoryLink(link, index, options);
    return result.resolved
      ? { ownerId, link, resolved: true, ...(result.legacy === true ? { legacy: true } : {}) }
      : {
          ownerId,
          link,
          resolved: false,
          reason: result.reason ?? "unresolved",
          reasonCode: result.reasonCode ?? missingReasonCode(link.kind),
          ...(result.candidates !== undefined && result.candidates.length > 0
            ? { candidates: result.candidates }
            : {}),
        };
  });
  const staleLinks = resolutions.filter((resolution): resolution is StaleLinkResolution =>
    !resolution.resolved && resolution.reason !== undefined && resolution.reasonCode !== undefined);
  return {
    resolutions,
    staleLinks,
    danglingReferences: findDanglingReferences(model),
    staleNodeIds: [...new Set(staleLinks.map((resolution) => resolution.ownerId))].sort(compareIds),
    legacyAnchors: resolutions.filter((resolution) => resolution.legacy === true),
  };
}

function missingReasonCode(kind: RepositoryLink["kind"]): LinkResolutionReasonCode {
  if (kind === "symbol") return "symbol_gone";
  if (kind === "file") return "path_absent";
  if (kind === "claim") return "claim_absent";
  if (kind === "evidence") return "evidence_absent";
  return "node_absent";
}

function allLinks(model: SemanticModel): { ownerId: string; link: RepositoryLink }[] {
  const out: { ownerId: string; link: RepositoryLink }[] = [];
  for (const node of model.nodes) for (const link of node.repositoryLinks) out.push({ ownerId: node.id, link });
  for (const change of model.changes) for (const link of change.repositoryLinks) out.push({ ownerId: change.id, link });
  return out.sort((left, right) => compareIds(left.ownerId, right.ownerId) || compareIds(left.link.kind, right.link.kind) || compareIds(left.link.ref, right.link.ref));
}
