/**
 * Deterministic, bounded semantic slice. NOT free-text retrieval: it seeds only from explicit
 * scopes (a change id, a repository symbol/claim ref) and expands along authored relations up to a
 * node cap. Stable order, every element points to a source, nothing is invented, and anything not
 * present is shown as an open unknown — never asserted true or false. (Section 4.5.)
 */

import { compareIds } from "@semantic-context/core";
import { SemanticIndex, PROVEN_STATUSES } from "@semantic-context/semantic-model";
import type { SemanticModel, SemanticNode, ChangeContract, RepositoryLink } from "@semantic-context/semantic-model";

export interface SliceScope {
  changeId?: string;
  symbolRef?: string;
  claimRef?: string;
  maxNodes?: number;
  criticalTags?: string[];
}

export interface SemanticSlice {
  scope: { changeId?: string; symbolRef?: string; claimRef?: string; maxNodes: number };
  truncated: boolean;
  intentions: SemanticNode[];
  invariants: SemanticNode[];
  decisions: SemanticNode[];
  assumptions: SemanticNode[];
  changes: ChangeContract[];
  linkedRepository: RepositoryLink[];
  evidence: SemanticNode[];
  openUnknowns: SemanticNode[];
  safetyConstraints: SemanticNode[];
  /** Required evidence ids on selected changes that are not yet proven (open proof obligations). */
  nextProofs: string[];
}

const DEFAULT_MAX_NODES = 60;
const DEFAULT_CRITICAL_TAGS = ["critical", "security"];

function changeNeighbors(change: ChangeContract): string[] {
  return [...change.serves, ...change.preserves, ...change.requiresEvidence, ...change.openUnknowns];
}

function linkTargetsRef(links: readonly RepositoryLink[], ref: string): boolean {
  return links.some((l) => l.ref === ref);
}

/** Compute the seed id set from the explicit scopes only. */
function seeds(model: SemanticModel, scope: SliceScope): string[] {
  const ids = new Set<string>();
  if (scope.changeId !== undefined) ids.add(scope.changeId);
  const ref = scope.symbolRef ?? scope.claimRef;
  if (ref !== undefined) {
    for (const node of model.nodes) if (linkTargetsRef(node.repositoryLinks, ref)) ids.add(node.id);
    for (const change of model.changes) if (linkTargetsRef(change.repositoryLinks, ref)) ids.add(change.id);
  }
  return [...ids].sort(compareIds);
}

/** Bounded BFS over semantic relations from the seeds. Deterministic (sorted frontier). */
function selectIds(index: SemanticIndex, seedIds: string[], maxNodes: number): { selected: Set<string>; truncated: boolean } {
  const selected = new Set<string>();
  let frontier = [...seedIds].sort(compareIds);
  let truncated = false;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      if (selected.has(id)) continue;
      if (selected.size >= maxNodes) {
        truncated = true;
        continue;
      }
      if (!index.has(id)) continue; // unresolved reference: surfaced elsewhere, not expanded
      selected.add(id);
      const node = index.node(id);
      const change = index.change(id);
      const neighbors = node !== undefined ? node.relations.map((r) => r.to) : change !== undefined ? changeNeighbors(change) : [];
      for (const n of neighbors) if (!selected.has(n)) next.push(n);
    }
    frontier = [...new Set(next)].sort(compareIds);
  }
  return { selected, truncated };
}

export function sliceSemanticModel(model: SemanticModel, scope: SliceScope): SemanticSlice {
  const index = new SemanticIndex(model);
  const maxNodes = scope.maxNodes ?? DEFAULT_MAX_NODES;
  const criticalTags = new Set(scope.criticalTags ?? DEFAULT_CRITICAL_TAGS);
  const { selected, truncated } = selectIds(index, seeds(model, scope), maxNodes);

  const nodes = [...selected].map((id) => index.node(id)).filter((n): n is SemanticNode => n !== undefined).sort((a, b) => compareIds(a.id, b.id));
  const changes = [...selected].map((id) => index.change(id)).filter((c): c is ChangeContract => c !== undefined).sort((a, b) => compareIds(a.id, b.id));

  const byKind = (k: SemanticNode["kind"]): SemanticNode[] => nodes.filter((n) => n.kind === k);
  const invariants = byKind("invariant");

  const linkMap = new Map<string, RepositoryLink>();
  for (const n of nodes) for (const l of n.repositoryLinks) linkMap.set(`${l.kind}:${l.ref}`, l);
  for (const c of changes) for (const l of c.repositoryLinks) linkMap.set(`${l.kind}:${l.ref}`, l);
  const linkedRepository = [...linkMap.values()].sort((a, b) => compareIds(a.ref, b.ref));

  const nextProofs = new Set<string>();
  for (const change of changes) {
    for (const evId of change.requiresEvidence) {
      const ev = index.node(evId);
      if (ev === undefined || !PROVEN_STATUSES.has(ev.status)) nextProofs.add(evId);
    }
  }

  return {
    scope: {
      ...(scope.changeId !== undefined ? { changeId: scope.changeId } : {}),
      ...(scope.symbolRef !== undefined ? { symbolRef: scope.symbolRef } : {}),
      ...(scope.claimRef !== undefined ? { claimRef: scope.claimRef } : {}),
      maxNodes,
    },
    truncated,
    intentions: byKind("goal"),
    invariants,
    decisions: byKind("decision"),
    assumptions: byKind("assumption"),
    changes,
    linkedRepository,
    evidence: byKind("evidence"),
    openUnknowns: byKind("unknown"),
    safetyConstraints: invariants.filter((inv) => inv.tags.some((t) => criticalTags.has(t))),
    nextProofs: [...nextProofs].sort(compareIds),
  };
}
