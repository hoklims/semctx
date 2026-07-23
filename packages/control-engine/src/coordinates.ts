import type { RepositoryEdge, RepositoryNode } from "@semantic-context/core";
import { compareIds } from "@semantic-context/core";
import {
  NORMATIVE_LEVEL_MAPPING,
  SEMANTIC_LEVELS,
  type CoordinateEdge,
  type CoordinateGraphReport,
  type CoordinateNode,
  type EpistemicStatus,
  type QualifiedCoordinateId,
  type SourceKindLevelMapping,
} from "@semantic-context/control-model";
import {
  buildRepositoryLinkIndex,
  resolveRepositoryLink,
  resolveRepositoryLinks,
  type RepositoryFacts,
  type SemanticModel,
  type SemanticNode,
} from "@semantic-context/semantic-model";

export interface CoordinateGraphInput {
  repositoryFacts: RepositoryFacts;
  semanticModel: SemanticModel;
}

const mappingByKey = new Map(NORMATIVE_LEVEL_MAPPING.map((mapping) => [`${mapping.plane}:${mapping.sourceKind}`, mapping]));

export function buildCoordinateGraph(input: CoordinateGraphInput): CoordinateGraphReport {
  const unsupported: CoordinateGraphReport["unsupported"] = [];
  const unmapped: CoordinateGraphReport["unmapped"] = [];
  const nodes: CoordinateNode[] = [];
  const repositoryFacts = input.repositoryFacts;
  const repositoryLinkIndex = buildRepositoryLinkIndex(repositoryFacts);
  const linkReport = resolveRepositoryLinks(input.semanticModel, repositoryFacts);
  const authoredSemanticIds = new Set([...input.semanticModel.nodes.map((node) => node.id), ...input.semanticModel.changes.map((change) => change.id)]);

  for (const source of repositoryFacts.graph.nodes) {
    const mapping = mappingByKey.get(`repo:${source.kind}`);
    if (!mapping) {
      unmapped.push({ plane: "repo", sourceId: source.id, sourceKind: source.kind, reason: "source_kind_not_mapped" });
      continue;
    }
    if (!isSupported(mapping)) {
      unsupported.push({ plane: "repo", sourceId: source.id, sourceKind: source.kind, reason: mapping.reason ?? "unsupported" });
      continue;
    }
    nodes.push(repositoryCoordinate(source, mapping));
  }

  for (const source of input.semanticModel.nodes) addSemanticSource(source, unsupported, unmapped, nodes);
  for (const change of input.semanticModel.changes) {
    unsupported.push({ plane: "semantic", sourceId: change.id, sourceKind: "change", reason: "control_support_artifact" });
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: CoordinateEdge[] = [];
  for (const edge of repositoryFacts.graph.edges) {
    const normalized = normalizeEdge(repoId(edge.from), repoId(edge.to), edge.kind, evidenceRefs(edge), byId);
    if (normalized) edges.push(normalized);
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
    if (!byId.has(sourceId)) continue;
    for (const relation of source.relations) {
      const targetId = semanticId(relation.to);
      if (!byId.has(targetId)) {
        if (authoredSemanticIds.has(relation.to)) continue;
        unmapped.push({ plane: "semantic", sourceId: relation.to, sourceKind: "relation_target", reason: `missing_target_for:${source.id}` });
        continue;
      }
      const normalized = normalizeEdge(sourceId, targetId, relation.kind, sourceReferenceStrings(source), byId);
      if (normalized) edges.push(normalized);
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
        const targetId = repoId(target.id);
        if (!byId.has(targetId)) {
          unsupported.push({
            plane: "repo",
            sourceId: target.id,
            sourceKind: `repository_link:${link.kind}`,
            reason: `resolved_target_not_mapped_for:${source.id}`,
          });
          continue;
        }
        const normalized = normalizeEdge(targetId, sourceId, `repository_link:${link.kind}`, sourceReferenceStrings(source), byId);
        if (normalized) edges.push(normalized);
      }
    }
  }

  const sortedNodes = uniqueBy(nodes, (node) => node.id).sort(compareNode);
  const sortedEdges = uniqueBy(edges, edgeKey).sort(compareEdge);
  const coverage = SEMANTIC_LEVELS.map((level) => {
    const levelNodes = sortedNodes.filter((node) => node.level === level);
    return {
      level,
      categories: [...new Set(levelNodes.map((node) => node.category))].sort(),
      coordinateIds: levelNodes.map((node) => node.id),
    };
  });

  return {
    schemaVersion: 1,
    nodes: sortedNodes,
    edges: sortedEdges,
    mapping: [...NORMATIVE_LEVEL_MAPPING].sort((a, b) => compareIds(`${a.plane}:${a.sourceKind}`, `${b.plane}:${b.sourceKind}`)),
    coverage,
    unsupported: uniqueBy(unsupported, sourceIssueKey).sort(compareSourceIssue),
    unmapped: uniqueBy(unmapped, sourceIssueKey).sort(compareSourceIssue),
    staleLinks: linkReport.staleLinks.map((stale) => ({
      ownerId: stale.ownerId,
      link: stale.link,
      resolved: false,
      reason: stale.reason ?? "unresolved",
    })),
    danglingReferences: [...linkReport.danglingReferences],
  };
}

function addSemanticSource(
  source: SemanticNode,
  unsupported: CoordinateGraphReport["unsupported"],
  unmapped: CoordinateGraphReport["unmapped"],
  nodes: CoordinateNode[],
): void {
  const mapping = mappingByKey.get(`semantic:${source.kind}`);
  if (!mapping) {
    unmapped.push({ plane: "semantic", sourceId: source.id, sourceKind: source.kind, reason: "source_kind_not_mapped" });
    return;
  }
  if (!isSupported(mapping)) {
    unsupported.push({ plane: "semantic", sourceId: source.id, sourceKind: source.kind, reason: mapping.reason ?? "unsupported" });
    return;
  }
  nodes.push({
    id: semanticId(source.id),
    plane: "semantic",
    sourceId: source.id,
    sourceKind: source.kind,
    level: mapping.level,
    category: mapping.category,
    label: source.statement,
    epistemicStatus: semanticEpistemicStatus(source),
    references: sourceReferenceStrings(source),
    ...(source.metadata ? { metadata: sortedStringRecord(source.metadata) } : {}),
  });
}

function repositoryCoordinate(source: RepositoryNode, mapping: SupportedMapping): CoordinateNode {
  return {
    id: repoId(source.id),
    plane: "repo",
    sourceId: source.id,
    sourceKind: source.kind,
    level: mapping.level,
    category: mapping.category,
    label: source.name,
    epistemicStatus: "statically_observed",
    references: evidenceRefs(source),
    metadata: sortedStringRecord(Object.fromEntries(Object.entries(source.metadata).map(([key, value]) => [key, String(value)]))),
  };
}

function semanticEpistemicStatus(source: SemanticNode): EpistemicStatus {
  if (source.status === "tested") return "test_observed";
  if (source.status === "statically_verified") return "statically_observed";
  if (source.status === "runtime_verified") return "dynamically_observed";
  if (source.provenance === "author") return "human_declared";
  if (source.provenance === "derived") return "statically_observed";
  return "llm_inferred";
}

function normalizeEdge(
  from: QualifiedCoordinateId,
  to: QualifiedCoordinateId,
  sourceRelation: string,
  refs: string[],
  byId: ReadonlyMap<QualifiedCoordinateId, CoordinateNode>,
): CoordinateEdge | undefined {
  const fromNode = byId.get(from);
  const toNode = byId.get(to);
  if (!fromNode || !toNode) return undefined;
  const reverse = fromNode.level > toNode.level || (sourceRelation === "declares" && fromNode.level < toNode.level);
  const normalizedFrom = reverse ? to : from;
  const normalizedTo = reverse ? from : to;
  return {
    from: normalizedFrom,
    to: normalizedTo,
    relation: fromNode.level === toNode.level ? sourceRelation : "supports",
    sourceRelation,
    evidenceRefs: [...new Set(refs)].sort(),
  };
}

function evidenceRefs(source: RepositoryNode | RepositoryEdge): string[] {
  return source.evidence.map((evidence) => `${evidence.filePath}${evidence.startLine ? `:${evidence.startLine}` : ""}`).sort();
}

function sourceReferenceStrings(source: SemanticNode): string[] {
  return source.sourceRefs.map((ref) => `${ref.file}:${ref.line}`).sort();
}

function repoId(id: string): `repo:${string}` { return `repo:${id}`; }
function semanticId(id: string): `semantic:${string}` { return `semantic:${id}`; }

type SupportedMapping = SourceKindLevelMapping & { level: Exclude<SourceKindLevelMapping["level"], null>; category: Exclude<SourceKindLevelMapping["category"], null>; supported: true };
function isSupported(mapping: SourceKindLevelMapping): mapping is SupportedMapping {
  return mapping.supported && mapping.level !== null && mapping.category !== null;
}

function edgeKey(edge: CoordinateEdge): string {
  return `${edge.from}\u0000${edge.to}\u0000${edge.relation}\u0000${edge.sourceRelation ?? ""}\u0000${edge.evidenceRefs.join("\u0001")}`;
}
function compareEdge(left: CoordinateEdge, right: CoordinateEdge): number { return compareIds(edgeKey(left), edgeKey(right)); }
function compareNode(left: CoordinateNode, right: CoordinateNode): number { return compareIds(left.id, right.id); }
function sourceIssueKey(issue: { plane: string; sourceId: string; sourceKind: string; reason: string }): string { return `${issue.plane}\u0000${issue.sourceId}\u0000${issue.sourceKind}\u0000${issue.reason}`; }
function compareSourceIssue(left: { plane: string; sourceId: string; sourceKind: string; reason: string }, right: { plane: string; sourceId: string; sourceKind: string; reason: string }): number { return compareIds(sourceIssueKey(left), sourceIssueKey(right)); }
function uniqueBy<T>(values: T[], key: (value: T) => string): T[] { return [...new Map(values.map((value) => [key(value), value])).values()]; }
function sortedStringRecord(value: Record<string, string>): Record<string, string> { return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compareIds(a, b))); }
