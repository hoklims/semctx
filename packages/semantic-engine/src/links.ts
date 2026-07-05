/**
 * Resolve authored repository links (Plane B → Plane A) and detect stale ones.
 *
 * A `RepositoryLink` points at a graph node id, a claim id, an evidence id, or a file path. A link
 * that no longer resolves marks its owner **stale** — the declared coupling to code has drifted.
 * Also detects dangling *internal* references (a relation/serves/preserves/requires/unknown pointing
 * at a semantic id that is not declared). Pure: no I/O, deterministic ordering.
 */

import { compareIds } from "@semantic-context/core";
import type { RepositoryGraph, Claim, EvidenceRecord } from "@semantic-context/core";
import { allSemanticIds } from "@semantic-context/semantic-model";
import type { SemanticModel, RepositoryLink } from "@semantic-context/semantic-model";

export interface RepositoryFacts {
  graph: RepositoryGraph;
  claims: Claim[];
  evidence: EvidenceRecord[];
}

export interface LinkResolution {
  ownerId: string;
  link: RepositoryLink;
  resolved: boolean;
  reason?: string;
}

export interface DanglingReference {
  ownerId: string;
  field: string;
  ref: string;
}

export interface LinkReport {
  resolutions: LinkResolution[];
  staleLinks: LinkResolution[];
  danglingReferences: DanglingReference[];
  /** Owner ids with at least one stale link. */
  staleNodeIds: string[];
}

function factsIndex(facts: RepositoryFacts): {
  nodeIds: Set<string>;
  filePaths: Set<string>;
  claimIds: Set<string>;
  evidenceIds: Set<string>;
} {
  const nodeIds = new Set<string>();
  const filePaths = new Set<string>();
  for (const node of facts.graph.nodes) {
    nodeIds.add(node.id);
    if (node.filePath !== undefined) filePaths.add(node.filePath);
  }
  return {
    nodeIds,
    filePaths,
    claimIds: new Set(facts.claims.map((c) => c.id)),
    evidenceIds: new Set(facts.evidence.map((e) => e.id)),
  };
}

function resolveOne(link: RepositoryLink, idx: ReturnType<typeof factsIndex>): { resolved: boolean; reason?: string } {
  switch (link.kind) {
    case "file":
      return idx.filePaths.has(link.ref) ? { resolved: true } : { resolved: false, reason: "no indexed file matches this path" };
    case "claim":
      return idx.claimIds.has(link.ref) ? { resolved: true } : { resolved: false, reason: "claim id not found in the graph" };
    case "evidence":
      return idx.evidenceIds.has(link.ref) ? { resolved: true } : { resolved: false, reason: "evidence id not found in the graph" };
    default:
      // symbol/invariant/contract/capability/test/migration → a graph node id.
      return idx.nodeIds.has(link.ref) ? { resolved: true } : { resolved: false, reason: `${link.kind} node id not found in the graph` };
  }
}

/** Every (ownerId, link) pair across the model, deterministically ordered. */
function allLinks(model: SemanticModel): { ownerId: string; link: RepositoryLink }[] {
  const out: { ownerId: string; link: RepositoryLink }[] = [];
  for (const node of model.nodes) for (const link of node.repositoryLinks) out.push({ ownerId: node.id, link });
  for (const change of model.changes) for (const link of change.repositoryLinks) out.push({ ownerId: change.id, link });
  return out.sort((a, b) => compareIds(a.ownerId, b.ownerId) || compareIds(a.link.ref, b.link.ref));
}

/** Internal semantic references that point at an id not declared anywhere in the model. */
export function findDanglingReferences(model: SemanticModel): DanglingReference[] {
  const ids = allSemanticIds(model);
  const out: DanglingReference[] = [];
  for (const node of model.nodes) {
    for (const rel of node.relations) if (!ids.has(rel.to)) out.push({ ownerId: node.id, field: rel.kind, ref: rel.to });
  }
  for (const change of model.changes) {
    for (const to of change.serves) if (!ids.has(to)) out.push({ ownerId: change.id, field: "serves", ref: to });
    for (const to of change.preserves) if (!ids.has(to)) out.push({ ownerId: change.id, field: "preserves", ref: to });
    for (const to of change.requiresEvidence) if (!ids.has(to)) out.push({ ownerId: change.id, field: "requires_evidence", ref: to });
    for (const to of change.openUnknowns) if (!ids.has(to)) out.push({ ownerId: change.id, field: "unknown", ref: to });
  }
  return out.sort((a, b) => compareIds(a.ownerId, b.ownerId) || compareIds(a.field, b.field) || compareIds(a.ref, b.ref));
}

/** Resolve all repository links and internal references against the indexed facts. */
export function resolveRepositoryLinks(model: SemanticModel, facts: RepositoryFacts): LinkReport {
  const idx = factsIndex(facts);
  const resolutions: LinkResolution[] = [];
  const staleOwners = new Set<string>();
  for (const { ownerId, link } of allLinks(model)) {
    const r = resolveOne(link, idx);
    const resolution: LinkResolution = r.resolved ? { ownerId, link, resolved: true } : { ownerId, link, resolved: false, reason: r.reason ?? "unresolved" };
    resolutions.push(resolution);
    if (!r.resolved) staleOwners.add(ownerId);
  }
  return {
    resolutions,
    staleLinks: resolutions.filter((r) => !r.resolved),
    danglingReferences: findDanglingReferences(model),
    staleNodeIds: [...staleOwners].sort(compareIds),
  };
}
