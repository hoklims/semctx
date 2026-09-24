/**
 * Join authored semantic nodes (Plane B) onto a change-impact exposure map (ADR 0030).
 *
 * A node is exposed only through a repository link that resolves exactly (the same resolver as
 * `semantic check`): an `inv:`/`contract:`/`sym:` link inherits the exposure of the node it names,
 * while a `file:` link — which names every node in a file — is capped at `possible`, so a mixed
 * module cannot mark every authored claim anchored to it as changed. Links that do not resolve,
 * links to claims or evidence, and invariants with no link at all are reported, never dropped:
 * their exposure is unknown, not absent.
 */

import { compareIds } from "@semantic-context/core";
import type { ExposedClaim, ImpactTier } from "@semantic-context/core";
import {
  buildRepositoryLinkIndex,
  resolveRepositoryLink,
  type RepositoryFacts,
  type SemanticModel,
} from "@semantic-context/semantic-model";

const TIER_RANK: Record<ImpactTier, number> = { changed: 0, direct: 1, transitive: 2, possible: 3 };

export interface SemanticExposureResult {
  claims: ExposedClaim[];
  /** Links whose target does not resolve against the index; their exposure is unknown. */
  unresolvedLinks: { ownerId: string; kind: string; ref: string; reasonCode: string }[];
  /** Resolved links to claims or evidence records, which carry no code position to expose. */
  unjoinableLinks: { ownerId: string; kind: string; ref: string }[];
  /** Invariants with no repository link: nothing ties them to code. */
  unanchoredInvariants: string[];
}

export function semanticExposure(args: {
  model: SemanticModel;
  facts: RepositoryFacts;
  exposure: ReadonlyMap<string, ImpactTier>;
}): SemanticExposureResult {
  const index = buildRepositoryLinkIndex(args.facts);
  const claims: ExposedClaim[] = [];
  const unresolvedLinks: SemanticExposureResult["unresolvedLinks"] = [];
  const unjoinableLinks: SemanticExposureResult["unjoinableLinks"] = [];
  const unanchoredInvariants: string[] = [];

  for (const node of [...args.model.nodes].sort((a, b) => compareIds(a.id, b.id))) {
    if (node.repositoryLinks.length === 0) {
      if (node.kind === "invariant") unanchoredInvariants.push(node.id);
      continue;
    }
    const anchors: ExposedClaim["anchors"] = [];
    for (const link of node.repositoryLinks) {
      const resolution = resolveRepositoryLink(link, index);
      if (!resolution.resolved) {
        unresolvedLinks.push({ ownerId: node.id, kind: link.kind, ref: link.ref, reasonCode: resolution.reasonCode ?? "unresolved" });
        continue;
      }
      let joinable = false;
      for (const target of resolution.targets) {
        if (target.kind !== "repository_node") continue;
        joinable = true;
        const tier = args.exposure.get(target.id);
        if (tier === undefined) continue;
        const capped: ImpactTier = link.kind === "file" && TIER_RANK[tier] < TIER_RANK.possible ? "possible" : tier;
        anchors.push({ nodeId: target.id, exposure: capped, relation: `link:${link.kind}` });
      }
      if (!joinable) unjoinableLinks.push({ ownerId: node.id, kind: link.kind, ref: link.ref });
    }
    if (anchors.length === 0) continue;
    const unique = new Map<string, ExposedClaim["anchors"][number]>();
    for (const anchor of anchors) {
      const key = `${anchor.nodeId}\0${anchor.relation}`;
      const existing = unique.get(key);
      if (existing === undefined || TIER_RANK[anchor.exposure] < TIER_RANK[existing.exposure]) unique.set(key, anchor);
    }
    const sorted = [...unique.values()].sort((a, b) => TIER_RANK[a.exposure] - TIER_RANK[b.exposure] || compareIds(a.nodeId, b.nodeId));
    claims.push({
      id: node.id,
      source: "semantic",
      kind: node.kind,
      ...(node.statement.length > 0 ? { statement: node.statement } : {}),
      tags: [...node.tags].sort(compareIds),
      exposure: sorted[0]!.exposure,
      anchors: sorted,
    });
  }
  return {
    claims: claims.sort((a, b) => TIER_RANK[a.exposure] - TIER_RANK[b.exposure] || compareIds(a.id, b.id)),
    unresolvedLinks,
    unjoinableLinks,
    unanchoredInvariants,
  };
}
