import type { RepositoryEdge, RepositoryNode } from "@semantic-context/core";
import { compareIds } from "@semantic-context/core";
import type {
  CoordinateCategory,
  CoordinateEdge,
  CoordinateGraphReportV2,
  CoordinateNodeV2,
  EpistemicStatus,
  ObservedDiffHunkV1,
  QualifiedCoordinateId,
  RefinementRelationV1,
  SemanticLevel,
  Sha256Hash,
} from "@semantic-context/control-model/reconciliation";
import { ReconciliationRefinementRelationV1Schema } from "@semantic-context/control-model/reconciliation";
import {
  buildRepositoryLinkIndex,
  resolveRepositoryLink,
  resolveRepositoryLinks,
  type RepositoryFacts,
  type SemanticModel,
  type SemanticNode,
} from "@semantic-context/semantic-model/reconciliation-read";
import { parseSha256Hash } from "./reconciliation-validation";

export interface CoordinateGraphInput {
  repositoryFacts: RepositoryFacts;
  semanticModel: SemanticModel;
  observedHunks?: readonly ObservedDiffHunkV1[];
  verifiedEvidenceDigests?: readonly Sha256Hash[];
}

export class InvalidRefinementRelationError extends Error {
  readonly code = "INVALID_REFINEMENT_RELATION" as const;
  constructor(
    readonly relationId: string,
    readonly issues: readonly { path: PropertyKey[]; message: string }[],
  ) {
    super(`invalid refinement relation ${relationId}: ${issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    this.name = "InvalidRefinementRelationError";
  }
}

/**
 * Projects the structural A+B graph and the typed refinement overlay without
 * collapsing one into the other. Repository shape and semantic kind never
 * supply a missing authored abstraction level.
 */
export function buildCoordinateGraph(input: CoordinateGraphInput): CoordinateGraphReportV2 {
  const unsupported: CoordinateGraphReportV2["unsupported"][number][] = [];
  const unmapped: CoordinateGraphReportV2["unmapped"][number][] = [];
  const nodes: CoordinateNodeV2[] = [];
  const repositoryLinkIndex = buildRepositoryLinkIndex(input.repositoryFacts);
  const linkReport = resolveRepositoryLinks(input.semanticModel, input.repositoryFacts);
  const authoredSemanticIds = new Set([
    ...input.semanticModel.nodes.map((node) => node.id),
    ...input.semanticModel.changes.map((change) => change.id),
  ]);

  for (const source of input.repositoryFacts.graph.nodes) {
    nodes.push(repositoryCoordinate(source));
  }
  for (const source of input.semanticModel.nodes) {
    nodes.push(semanticCoordinate(source));
    if (source.appliesAtLevel === undefined) {
      unmapped.push({
        plane: "semantic",
        sourceId: source.id,
        sourceKind: source.kind,
        reason: "applies_at_level_missing",
      });
    }
  }
  for (const hunk of input.observedHunks ?? []) nodes.push(observedCoordinate(hunk));
  for (const change of input.semanticModel.changes) {
    unsupported.push({
      plane: "semantic",
      sourceId: change.id,
      sourceKind: "change",
      reason: "control_support_artifact",
    });
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const structuralEdges: CoordinateEdge[] = [];
  for (const edge of input.repositoryFacts.graph.edges) {
    const projected = structuralEdge(
      repoId(edge.from),
      repoId(edge.to),
      edge.kind,
      evidenceRefs(edge),
      byId,
    );
    if (projected) structuralEdges.push(projected);
  }

  for (const stale of linkReport.staleLinks) {
    unmapped.push({
      plane: "repo",
      sourceId: stale.link.ref,
      sourceKind: `repository_link:${stale.link.kind}`,
      reason: stale.reason ?? "unresolved",
    });
  }

  for (const source of input.semanticModel.nodes) {
    const sourceId = semanticId(source.id);
    for (const relation of source.relations) {
      const targetId = semanticId(relation.to);
      if (!byId.has(targetId)) {
        if (!authoredSemanticIds.has(relation.to)) {
          unmapped.push({
            plane: "semantic",
            sourceId: relation.to,
            sourceKind: "relation_target",
            reason: `missing_target_for:${source.id}`,
          });
        }
        continue;
      }
      const projected = structuralEdge(
        sourceId,
        targetId,
        relation.kind,
        sourceReferenceStrings(source),
        byId,
      );
      if (projected) structuralEdges.push(projected);
    }

    for (const link of source.repositoryLinks) {
      const resolution = resolveRepositoryLink(link, repositoryLinkIndex);
      if (!resolution.resolved) continue;
      const repositoryTargets = resolution.targets.filter((target) => target.kind === "repository_node");
      if (repositoryTargets.length === 0) {
        unsupported.push({
          plane: "repo",
          sourceId: link.ref,
          sourceKind: `repository_link:${link.kind}`,
          reason: `resolved_non_coordinate_fact_for:${source.id}`,
        });
        continue;
      }
      for (const target of repositoryTargets) {
        const projected = structuralEdge(
          repoId(target.id),
          sourceId,
          `repository_link:${link.kind}`,
          sourceReferenceStrings(source),
          byId,
        );
        if (projected) structuralEdges.push(projected);
      }
    }
  }

  const sortedNodes = uniqueBy(nodes, (node) => node.id).sort(compareNode);
  const sortedStructuralEdges = uniqueBy(structuralEdges, edgeKey).sort(compareEdge);
  const refinementRelations = validateRefinementRelations(input.semanticModel.refinementRelations ?? []);
  const verifiedEvidenceDigests = [...new Set(input.verifiedEvidenceDigests ?? [])]
    .map((digest) => parseSha256Hash(digest, "verified evidence digest"))
    .sort(compareIds);
  const coverage = ([0, 1, 2, 3, 4, 5, 6] as const).map((level) => {
    const levelNodes = sortedNodes.filter((node) => node.appliesAtLevel === level);
    return {
      level,
      categories: [...new Set(levelNodes.flatMap((node) => node.category === null ? [] : [node.category]))].sort(),
      coordinateIds: levelNodes.map((node) => node.id),
    };
  });

  return {
    schemaVersion: 2,
    nodes: sortedNodes,
    structuralEdges: sortedStructuralEdges,
    refinementRelations,
    mapping: [],
    coverage,
    unsupported: uniqueBy(unsupported, sourceIssueKey).sort(compareSourceIssue),
    unmapped: uniqueBy(unmapped, sourceIssueKey).sort(compareSourceIssue),
    staleLinks: linkReport.staleLinks.map((stale) => ({
      ownerId: stale.ownerId,
      link: stale.link,
      resolved: false as const,
      reason: stale.reason ?? "unresolved",
    })).sort((a, b) => compareIds(
      `${a.ownerId}\u0000${a.link.kind}\u0000${a.link.ref}`,
      `${b.ownerId}\u0000${b.link.kind}\u0000${b.link.ref}`,
    )),
    danglingReferences: [...linkReport.danglingReferences].sort((a, b) => compareIds(
      `${a.ownerId}\u0000${a.field}\u0000${a.ref}`,
      `${b.ownerId}\u0000${b.field}\u0000${b.ref}`,
    )),
    compatibilityNormalization: [],
    verifiedEvidenceDigests,
  };
}

function validateRefinementRelations(relations: readonly RefinementRelationV1[]): RefinementRelationV1[] {
  return relations.map((relation) => {
    const parsed = ReconciliationRefinementRelationV1Schema.safeParse(relation);
    if (!parsed.success) {
      throw new InvalidRefinementRelationError(
        typeof relation.id === "string" && relation.id.length > 0 ? relation.id : "<unknown>",
        parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      );
    }
    return parsed.data as RefinementRelationV1;
  }).sort(compareRelation);
}

function repositoryCoordinate(source: RepositoryNode): CoordinateNodeV2 {
  return {
    id: repoId(source.id),
    plane: "repo",
    sourceId: source.id,
    sourceKind: source.kind,
    appliesAtLevel: null,
    category: null,
    label: source.name,
    epistemicStatus: "statically_observed",
    references: evidenceRefs(source),
    metadata: sortedStringRecord(
      Object.fromEntries(Object.entries(source.metadata).map(([key, value]) => [key, String(value)])),
    ),
  };
}

function semanticCoordinate(source: SemanticNode): CoordinateNodeV2 {
  const mapped = source.appliesAtLevel !== undefined;
  return {
    id: semanticId(source.id),
    plane: "semantic",
    sourceId: source.id,
    sourceKind: source.kind,
    appliesAtLevel: source.appliesAtLevel ?? null,
    category: mapped ? semanticCategory(source.kind, source.appliesAtLevel!) : null,
    label: source.statement,
    epistemicStatus: semanticEpistemicStatus(source),
    references: sourceReferenceStrings(source),
    ...(source.metadata ? { metadata: sortedStringRecord(source.metadata) } : {}),
  };
}

function observedCoordinate(source: ObservedDiffHunkV1): CoordinateNodeV2 {
  return {
    id: source.identity,
    plane: "observed",
    sourceId: source.identity,
    sourceKind: "observed_diff_hunk",
    appliesAtLevel: 0,
    category: "syntax",
    label: `${source.normalizedPath}:${source.newRange.start}`,
    epistemicStatus: "statically_observed",
    references: [source.identity],
    metadata: sortedStringRecord({
      normalizedPath: source.normalizedPath,
      repositoryIdentity: source.repositoryIdentity,
    }),
  };
}

function semanticCategory(kind: SemanticNode["kind"], level: SemanticLevel): CoordinateCategory {
  if (kind === "goal") return level === 6 ? "strategy" : "goal";
  if (kind === "invariant") return "invariant";
  if (kind === "decision") return "decision";
  if (level === 5) return "goal";
  if (level === 4) return "policy";
  if (level === 3) return "capability";
  if (level === 2) return "bounded_context";
  if (level === 1) return "code_entity";
  if (level === 0) return "syntax";
  return "strategy";
}

function semanticEpistemicStatus(source: SemanticNode): EpistemicStatus {
  if (source.status === "tested") return "test_observed";
  if (source.status === "statically_verified") return "statically_observed";
  if (source.status === "runtime_verified") return "dynamically_observed";
  if (source.provenance === "author") return "human_declared";
  if (source.provenance === "derived") return "statically_observed";
  return "llm_inferred";
}

function structuralEdge(
  from: QualifiedCoordinateId,
  to: QualifiedCoordinateId,
  sourceRelation: string,
  refs: string[],
  byId: ReadonlyMap<CoordinateNodeV2["id"], CoordinateNodeV2>,
): CoordinateEdge | undefined {
  if (!byId.has(from) || !byId.has(to)) return undefined;
  return {
    from,
    to,
    relation: sourceRelation,
    sourceRelation,
    evidenceRefs: [...new Set(refs)].sort(compareIds),
  };
}

function evidenceRefs(source: RepositoryNode | RepositoryEdge): string[] {
  return source.evidence
    .map((evidence) => `${evidence.filePath}${evidence.startLine ? `:${evidence.startLine}` : ""}`)
    .sort(compareIds);
}

function sourceReferenceStrings(source: SemanticNode): string[] {
  return source.sourceRefs.map((ref) => `${ref.file}:${ref.line}`).sort(compareIds);
}

function repoId(id: string): `repo:${string}` { return `repo:${id}`; }
function semanticId(id: string): `semantic:${string}` { return `semantic:${id}`; }
function edgeKey(edge: CoordinateEdge): string {
  return `${edge.from}\u0000${edge.to}\u0000${edge.relation}\u0000${edge.sourceRelation ?? ""}\u0000${edge.evidenceRefs.join("\u0001")}`;
}
function compareEdge(left: CoordinateEdge, right: CoordinateEdge): number {
  return compareIds(edgeKey(left), edgeKey(right));
}
function compareRelation(left: RefinementRelationV1, right: RefinementRelationV1): number {
  return compareIds(left.id, right.id);
}
function compareNode(left: CoordinateNodeV2, right: CoordinateNodeV2): number {
  return compareIds(left.id, right.id);
}
function sourceIssueKey(issue: { plane: string; sourceId: string; sourceKind: string; reason: string }): string {
  return `${issue.plane}\u0000${issue.sourceId}\u0000${issue.sourceKind}\u0000${issue.reason}`;
}
function compareSourceIssue(
  left: { plane: string; sourceId: string; sourceKind: string; reason: string },
  right: { plane: string; sourceId: string; sourceKind: string; reason: string },
): number {
  return compareIds(sourceIssueKey(left), sourceIssueKey(right));
}
function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}
function sortedStringRecord(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compareIds(a, b)));
}
