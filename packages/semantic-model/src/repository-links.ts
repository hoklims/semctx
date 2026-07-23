/** Shared Plane A link resolution used by both Plane B checks and Plane C coordinates. */

import { compareIds } from "@semantic-context/core";
import type { Claim, EvidenceRecord, RepositoryGraph } from "@semantic-context/core";
import { allSemanticIds } from "./model";
import type { RepositoryLink, SemanticModel } from "./types";

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
}

export type RepositoryLinkTarget =
  | { kind: "repository_node"; id: string }
  | { kind: "claim"; id: string }
  | { kind: "evidence"; id: string };

export interface RepositoryLinkResolution {
  resolved: boolean;
  targets: RepositoryLinkTarget[];
  reason?: string;
}

export interface LinkResolution {
  ownerId: string;
  link: RepositoryLink;
  resolved: boolean;
  reason?: string;
}

export interface StaleLinkResolution extends LinkResolution {
  resolved: false;
  reason: string;
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
}

export function buildRepositoryLinkIndex(facts: RepositoryFacts): RepositoryLinkIndex {
  const nodeIds = new Set<string>();
  const fileNodeIds = new Map<string, string[]>();
  for (const node of facts.graph.nodes) {
    nodeIds.add(node.id);
    if (node.filePath === undefined) continue;
    const ids = fileNodeIds.get(node.filePath) ?? [];
    ids.push(node.id);
    fileNodeIds.set(node.filePath, ids);
  }
  return {
    nodeIds,
    fileNodeIds: new Map([...fileNodeIds].map(([path, ids]) => [path, [...new Set(ids)].sort(compareIds)])),
    claimIds: new Set(facts.claims.map((claim) => claim.id)),
    evidenceIds: new Set(facts.evidence.map((item) => item.id)),
  };
}

export function resolveRepositoryLink(link: RepositoryLink, index: RepositoryLinkIndex): RepositoryLinkResolution {
  switch (link.kind) {
    case "file": {
      const ids = index.fileNodeIds.get(link.ref) ?? [];
      return ids.length > 0
        ? { resolved: true, targets: ids.map((id) => ({ kind: "repository_node" as const, id })) }
        : { resolved: false, targets: [], reason: "no indexed file matches this path" };
    }
    case "claim":
      return index.claimIds.has(link.ref)
        ? { resolved: true, targets: [{ kind: "claim", id: link.ref }] }
        : { resolved: false, targets: [], reason: "claim id not found in the graph" };
    case "evidence":
      return index.evidenceIds.has(link.ref)
        ? { resolved: true, targets: [{ kind: "evidence", id: link.ref }] }
        : { resolved: false, targets: [], reason: "evidence id not found in the graph" };
    default:
      return index.nodeIds.has(link.ref)
        ? { resolved: true, targets: [{ kind: "repository_node", id: link.ref }] }
        : { resolved: false, targets: [], reason: `${link.kind} node id not found in the graph` };
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
export function resolveRepositoryLinks(model: SemanticModel, facts: RepositoryFacts): LinkReport {
  const index = buildRepositoryLinkIndex(facts);
  const resolutions: LinkResolution[] = allLinks(model).map(({ ownerId, link }) => {
    const result = resolveRepositoryLink(link, index);
    return result.resolved
      ? { ownerId, link, resolved: true }
      : { ownerId, link, resolved: false, reason: result.reason ?? "unresolved" };
  });
  const staleLinks = resolutions.filter((resolution): resolution is StaleLinkResolution => !resolution.resolved && resolution.reason !== undefined);
  return {
    resolutions,
    staleLinks,
    danglingReferences: findDanglingReferences(model),
    staleNodeIds: [...new Set(staleLinks.map((resolution) => resolution.ownerId))].sort(compareIds),
  };
}

function allLinks(model: SemanticModel): { ownerId: string; link: RepositoryLink }[] {
  const out: { ownerId: string; link: RepositoryLink }[] = [];
  for (const node of model.nodes) for (const link of node.repositoryLinks) out.push({ ownerId: node.id, link });
  for (const change of model.changes) for (const link of change.repositoryLinks) out.push({ ownerId: change.id, link });
  return out.sort((left, right) => compareIds(left.ownerId, right.ownerId) || compareIds(left.link.kind, right.link.kind) || compareIds(left.link.ref, right.link.ref));
}
