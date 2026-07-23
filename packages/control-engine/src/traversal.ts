import { compareIds } from "@semantic-context/core";
import type {
  ControlReasonCodeV1,
  CoordinateEdge,
  CoordinateGraphReportV2,
  CoordinatePath,
  EvidenceRefV1,
  ExplanationReport,
  ImpactReport,
  QualifiedCoordinateId,
  RefinementCoverageReportV1,
  RefinementPathV1,
  RefinementRelationV1,
  RefinementTraversalStepV1,
  RelationEndpointV1,
  SemanticLevel,
  Sha256Hash,
  TraversalBudgetV1,
  TraversalDirectionV1,
  TraversalReportV2,
} from "@semantic-context/control-model";

type CoordinateId = QualifiedCoordinateId | Sha256Hash;

export interface TraversalBounds {
  maxDepth?: number;
  maxResults?: number;
  maxExpansions?: number;
  maxQueue?: number;
  sourceSeal?: Sha256Hash;
  indexSeal?: Sha256Hash;
}

const DEFAULTS = { maxDepth: 8, maxResults: 100, maxExpansions: 10_000, maxQueue: 1_000 } as const;
const LIMITS = { maxDepth: 100, maxResults: 10_000, maxExpansions: 100_000, maxQueue: 10_000 } as const;
const MAX_PATHS_PER_DESTINATION = 2;
const IMPACT_RELATIONS = new Set([
  "imports",
  "depends_on",
  "calls",
  "references",
  "extends",
  "implements",
  "tested_by",
  "covers",
  "verifies",
]);
const RATIONALE_RELATIONS = new Set(["serves", "justifies", "preserves"]);

export function lift(
  graph: CoordinateGraphReportV2,
  sourceId: CoordinateId,
  targetLevel: SemanticLevel,
  bounds: TraversalBounds = {},
): TraversalReportV2 {
  return traverseToLevel(graph, sourceId, targetLevel, "lift", bounds);
}

export function lower(
  graph: CoordinateGraphReportV2,
  sourceId: CoordinateId,
  targetLevel: SemanticLevel,
  bounds: TraversalBounds = {},
): TraversalReportV2 {
  return traverseToLevel(graph, sourceId, targetLevel, "lower", bounds);
}

export function refinementCoverage(
  graph: CoordinateGraphReportV2,
  sourceId: CoordinateId,
  targetLevel: SemanticLevel,
  direction: TraversalDirectionV1,
  bounds: TraversalBounds & { sourceSeal: Sha256Hash; indexSeal: Sha256Hash },
): RefinementCoverageReportV1 {
  const traversal = direction === "lower"
    ? lower(graph, sourceId, targetLevel, bounds)
    : lift(graph, sourceId, targetLevel, bounds);
  const sourceLevel = graph.nodes.find((node) => node.id === sourceId)?.appliesAtLevel ?? targetLevel;
  const loadBearingSteps = traversal.paths[0]?.steps ?? [];
  const coveredLevels = [...new Set([
    ...(traversal.paths[0]?.coordinates ?? []).flatMap((coordinate) => {
      const level = graph.nodes.find((node) => node.id === coordinate)?.appliesAtLevel;
      return level === null || level === undefined ? [] : [level];
    }),
  ])].sort((left, right) => left - right) as SemanticLevel[];
  const requiredLevels = inclusiveLevels(sourceLevel, targetLevel);
  const missingLevels = requiredLevels.filter((level) => !coveredLevels.includes(level));
  const advisorySteps = traversal.advisoryRelations.flatMap((relation) => {
    const directed = directedStep(graph, relation, direction);
    return directed && directed.fromLevel !== null && directed.toLevel !== null
      ? [{
          relation,
          from: directed.from,
          to: directed.to,
          fromLevel: directed.fromLevel,
          toLevel: directed.toLevel,
        }]
      : [];
  }).sort(compareRefinementStep);

  return {
    schemaVersion: 1,
    rootCoordinate: sourceId,
    sourceSeal: bounds.sourceSeal,
    indexSeal: bounds.indexSeal,
    direction,
    levelSpan: { from: sourceLevel, to: targetLevel },
    visitedCoordinates: traversal.visitedCoordinateIds,
    loadBearingSteps,
    advisorySteps,
    governingConstraints: traversal.governingConstraints,
    proofs: traversal.proofs,
    coveredLevels,
    missingLevels,
    loadBearingEvidence: uniqueEvidence(loadBearingSteps.flatMap((step) => step.relation.evidenceRefs)),
    proofReferences: uniqueEvidence(traversal.proofs.flatMap((relation) => relation.evidenceRefs)),
    terminalStatus: traversal.terminalStatus,
    ...(traversal.reasonCode ? { reasonCode: traversal.reasonCode } : {}),
    budget: traversal.budget,
    compatibilityNormalization: traversal.compatibilityNormalization,
  };
}

/** Structural impact deliberately ignores the typed refinement overlay. */
export function impact(
  graph: CoordinateGraphReportV2,
  sourceIds: QualifiedCoordinateId[],
  bounds: TraversalBounds = {},
): ImpactReport {
  const limits = normalizeBounds(bounds);
  const admissible = graph.structuralEdges.filter((edge) =>
    IMPACT_RELATIONS.has(edge.sourceRelation ?? edge.relation));
  const outgoing = structuralAdjacency(admissible);
  const sources = [...new Set(sourceIds)].sort(compareIds);
  const known = new Set(graph.nodes.map((node) => node.id));
  const queue: CoordinatePath[] = sources
    .filter((id) => known.has(id))
    .map((id) => ({ nodes: [id], edges: [] }))
    .slice(0, limits.maxQueue);
  const affected = new Map<QualifiedCoordinateId, CoordinatePath[]>();
  const bestDepth = new Map(queue.map((path) => [path.nodes[0]!, 0]));
  let expansions = 0;
  let truncated = queue.length < sources.length;

  while (queue.length > 0) {
    if (expansions >= limits.maxExpansions) {
      truncated = true;
      break;
    }
    const path = queue.shift()!;
    const tail = path.nodes.at(-1)!;
    expansions += 1;
    if (path.edges.length >= limits.maxDepth) {
      if ((outgoing.get(tail)?.length ?? 0) > 0) truncated = true;
      continue;
    }
    for (const edge of outgoing.get(tail) ?? []) {
      const next = edge.to;
      if (path.nodes.includes(next)) continue;
      const nextPath = { nodes: [...path.nodes, next], edges: [...path.edges, edge] };
      const depth = nextPath.edges.length;
      if (!sources.includes(next)) {
        const paths = affected.get(next) ?? [];
        if (paths.length < MAX_PATHS_PER_DESTINATION) {
          paths.push(nextPath);
          paths.sort(compareCoordinatePath);
          affected.set(next, paths);
        }
        if (affected.size >= limits.maxResults) {
          truncated = queue.length > 0 || (outgoing.get(next)?.length ?? 0) > 0;
          queue.length = 0;
          break;
        }
      }
      const knownDepth = bestDepth.get(next);
      if (knownDepth === undefined || depth <= knownDepth) {
        bestDepth.set(next, Math.min(depth, knownDepth ?? depth));
        if (queue.length >= limits.maxQueue) truncated = true;
        else queue.push(nextPath);
      }
    }
  }
  return {
    schemaVersion: 1,
    sourceIds: sources,
    maxDepth: limits.maxDepth,
    maxResults: limits.maxResults,
    maxExpansions: limits.maxExpansions,
    maxQueue: limits.maxQueue,
    affected: [...affected.entries()]
      .sort(([left], [right]) => compareIds(left, right))
      .map(([id, paths]) => ({ id, paths })),
    truncated,
  };
}

/** Authored rationale only; imports, repository proximity and generated text are excluded. */
export function explainWhy(
  graph: CoordinateGraphReportV2,
  sourceId: QualifiedCoordinateId,
  bounds: TraversalBounds = {},
): ExplanationReport {
  const limits = normalizeBounds(bounds);
  const source = graph.nodes.find((node) => node.id === sourceId);
  const base = {
    schemaVersion: 1 as const,
    sourceId,
    maxDepth: limits.maxDepth,
    maxResults: limits.maxResults,
    maxExpansions: limits.maxExpansions,
    maxQueue: limits.maxQueue,
  };
  if (!source) return { ...base, known: false, rationaleIds: [], paths: [], unknownReason: "coordinate_missing" };
  const rationale = new Set(
    graph.nodes
      .filter((node) =>
        node.plane === "semantic"
        && ["goal", "invariant", "decision", "policy", "strategy"].includes(node.category ?? ""))
      .map((node) => node.id)
      .filter((id): id is QualifiedCoordinateId => !id.startsWith("sha256:")),
  );
  if (rationale.has(sourceId)) {
    return { ...base, known: true, rationaleIds: [sourceId], paths: [{ nodes: [sourceId], edges: [] }] };
  }
  const admissible = graph.structuralEdges.filter((edge) =>
    RATIONALE_RELATIONS.has(edge.sourceRelation ?? edge.relation));
  const outgoing = structuralAdjacency(admissible);
  const paths: CoordinatePath[] = [];
  const queue: CoordinatePath[] = [{ nodes: [sourceId], edges: [] }];
  const bestDepth = new Map<QualifiedCoordinateId, number>([[sourceId, 0]]);
  let expansions = 0;
  let boundReached = false;

  while (queue.length > 0 && paths.length < limits.maxResults) {
    if (expansions >= limits.maxExpansions) {
      boundReached = true;
      break;
    }
    const path = queue.shift()!;
    const tail = path.nodes.at(-1)!;
    expansions += 1;
    if (path.edges.length >= limits.maxDepth) {
      if ((outgoing.get(tail)?.length ?? 0) > 0) boundReached = true;
      continue;
    }
    for (const edge of outgoing.get(tail) ?? []) {
      if (path.nodes.includes(edge.to)) continue;
      const next = { nodes: [...path.nodes, edge.to], edges: [...path.edges, edge] };
      const depth = next.edges.length;
      if (rationale.has(edge.to)) paths.push(next);
      else if (bestDepth.get(edge.to) === undefined || depth <= bestDepth.get(edge.to)!) {
        bestDepth.set(edge.to, Math.min(depth, bestDepth.get(edge.to) ?? depth));
        if (queue.length >= limits.maxQueue) boundReached = true;
        else queue.push(next);
      }
      if (paths.length >= limits.maxResults) {
        boundReached = true;
        break;
      }
    }
  }
  paths.sort(compareCoordinatePath);
  const rationaleIds = [...new Set(paths.map((path) => path.nodes.at(-1)!))].sort(compareIds);
  const unknownReason = boundReached
    ? "traversal_bound_reached" as const
    : "rationale_not_authored" as const;
  return {
    ...base,
    known: paths.length > 0,
    rationaleIds,
    paths,
    ...(paths.length === 0 ? { unknownReason } : {}),
  };
}

/** Proof queries use only authored proved_by relations. */
export function proof(graph: CoordinateGraphReportV2, sourceId: CoordinateId): RefinementRelationV1[] {
  return graph.refinementRelations
    .filter((relation) =>
      relation.kind === "proved_by"
      && endpointId(relation.source) === sourceId
      && isCertifyingRelation(graph, relation))
    .sort(compareRefinementRelation);
}

function traverseToLevel(
  graph: CoordinateGraphReportV2,
  sourceId: CoordinateId,
  targetLevel: SemanticLevel,
  direction: TraversalDirectionV1,
  bounds: TraversalBounds,
): TraversalReportV2 {
  const limits = normalizeBounds(bounds);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const base = {
    schemaVersion: 2 as const,
    direction,
    sourceId,
    targetLevel,
    compatibilityNormalization: [] as const,
  };
  if (isStale(bounds)) {
    return {
      ...base,
      visitedCoordinateIds: [],
      paths: [],
      governingConstraints: [],
      proofs: [],
      advisoryRelations: [],
      terminalStatus: "refused",
      reasonCode: "INDEX_STALE",
      budget: traversalBudget(limits.maxExpansions, 0, false),
    };
  }
  const source = nodes.get(sourceId);
  if (!source) return emptyTraversal(base, "COORDINATE_UNKNOWN", limits.maxExpansions);
  if (source.appliesAtLevel === null) {
    return emptyTraversal(base, "MAPPING_MISSING", limits.maxExpansions, [sourceId]);
  }
  const validDirection = direction === "lift"
    ? targetLevel >= source.appliesAtLevel
    : targetLevel <= source.appliesAtLevel;
  if (!validDirection) {
    return emptyTraversal(base, "REFINEMENT_DISCONNECTED", limits.maxExpansions, [sourceId]);
  }
  if (targetLevel === source.appliesAtLevel) {
    return {
      ...base,
      visitedCoordinateIds: [sourceId],
      paths: [{ coordinates: [sourceId], steps: [] }],
      governingConstraints: decorations(graph, new Set([sourceId]), "constrained_by"),
      proofs: decorations(graph, new Set([sourceId]), "proved_by"),
      advisoryRelations: [],
      terminalStatus: "success",
      budget: traversalBudget(limits.maxExpansions, 0, false),
    };
  }

  const candidates = graph.refinementRelations
    .filter((relation) => relation.kind === "decomposes_to"
      || relation.kind === "realizes"
      || relation.kind === "implements")
    .sort(compareRefinementRelation);
  const adjacency = new Map<CoordinateId, DirectedCandidate[]>();
  const advisory = new Map<string, RefinementRelationV1>();
  let mappingMissing = false;
  for (const relation of candidates) {
    const directed = directedStep(graph, relation, direction);
    if (!directed) {
      advisory.set(relation.id, relation);
      continue;
    }
    if (directed.fromLevel === null || directed.toLevel === null) {
      advisory.set(relation.id, relation);
      continue;
    }
    const expectedDelta = direction === "lift" ? 1 : -1;
    const nonCertifying = directed.toLevel - directed.fromLevel !== expectedDelta
      || !isCertifyingRelation(graph, relation);
    if (nonCertifying) {
      advisory.set(relation.id, relation);
      continue;
    }
    const list = adjacency.get(endpointId(directed.from)) ?? [];
    list.push(directed as DirectedCandidate);
    list.sort((left, right) => compareIds(left.relation.id, right.relation.id));
    adjacency.set(endpointId(directed.from), list);
  }

  const queue: RefinementPathV1[] = [{ coordinates: [sourceId], steps: [] }];
  const paths: RefinementPathV1[] = [];
  const visited = new Set<CoordinateId>([sourceId]);
  const bestDepth = new Map<CoordinateId, number>([[sourceId, 0]]);
  let consumed = 0;
  let truncated = false;

  while (queue.length > 0 && paths.length < limits.maxResults) {
    if (consumed >= limits.maxExpansions) {
      truncated = true;
      break;
    }
    const path = queue.shift()!;
    const tail = path.coordinates.at(-1)!;
    consumed += 1;
    if (path.steps.length >= limits.maxDepth) {
      if ((adjacency.get(tail)?.length ?? 0) > 0) truncated = true;
      continue;
    }
    for (const directed of adjacency.get(tail) ?? []) {
      const nextId = endpointId(directed.to);
      if (path.coordinates.includes(nextId)) continue;
      const nextNode = nodes.get(nextId);
      if (!nextNode || nextNode.appliesAtLevel === null) {
        mappingMissing = true;
        advisory.set(directed.relation.id, directed.relation);
        continue;
      }
      visited.add(nextId);
      const step: RefinementTraversalStepV1 = {
        relation: directed.relation,
        from: directed.from,
        to: directed.to,
        fromLevel: directed.fromLevel,
        toLevel: directed.toLevel,
      };
      const nextPath: RefinementPathV1 = {
        coordinates: [...path.coordinates, nextId],
        steps: [...path.steps, step],
      };
      if (nextNode.appliesAtLevel === targetLevel) paths.push(nextPath);
      else {
        const remainsInDirection = direction === "lift"
          ? nextNode.appliesAtLevel < targetLevel
          : nextNode.appliesAtLevel > targetLevel;
        if (remainsInDirection) {
          const depth = nextPath.steps.length;
          const knownDepth = bestDepth.get(nextId);
          if (knownDepth === undefined || depth <= knownDepth) {
            bestDepth.set(nextId, Math.min(depth, knownDepth ?? depth));
            if (queue.length >= limits.maxQueue) truncated = true;
            else queue.push(nextPath);
          }
        }
      }
      if (paths.length >= limits.maxResults) {
        truncated = queue.length > 0 || (adjacency.get(nextId)?.length ?? 0) > 0;
        break;
      }
    }
  }
  paths.sort(compareRefinementPath);
  const visitedCoordinateIds = [...visited].sort(compareIds);
  const visitedSet = new Set(visitedCoordinateIds);
  const governingConstraints = decorations(graph, visitedSet, "constrained_by");
  const proofs = decorations(graph, visitedSet, "proved_by");
  for (const relation of graph.refinementRelations) {
    if (
      (relation.kind === "constrained_by" || relation.kind === "proved_by")
      && visitedSet.has(endpointId(relation.source))
      && !isCertifyingRelation(graph, relation)
    ) advisory.set(relation.id, relation);
  }
  const advisoryRelations = [...advisory.values()].sort(compareRefinementRelation);
  mappingMissing ||= advisoryRelations.some((relation) => {
    const directed = directedStep(graph, relation, direction);
    return directed !== undefined
      && visitedSet.has(endpointId(directed.from))
      && (directed.fromLevel === null || directed.toLevel === null);
  });
  const budget = traversalBudget(limits.maxExpansions, consumed, truncated);
  if (paths.length > 0) {
    return {
      ...base,
      visitedCoordinateIds,
      paths,
      governingConstraints,
      proofs,
      advisoryRelations,
      terminalStatus: "success",
      budget,
    };
  }
  let reasonCode: ControlReasonCodeV1 = "REFINEMENT_DISCONNECTED";
  if (truncated) reasonCode = "BUDGET_EXHAUSTED";
  else if (mappingMissing) reasonCode = "MAPPING_MISSING";
  return {
    ...base,
    visitedCoordinateIds,
    paths: [],
    governingConstraints,
    proofs,
    advisoryRelations,
    terminalStatus: truncated ? "budget_exhausted" : "empty",
    reasonCode,
    budget,
  };
}

interface DirectedCandidate {
  relation: RefinementRelationV1;
  from: RelationEndpointV1;
  to: RelationEndpointV1;
  fromLevel: SemanticLevel;
  toLevel: SemanticLevel;
}

function directedStep(
  graph: CoordinateGraphReportV2,
  relation: RefinementRelationV1,
  direction: TraversalDirectionV1,
): Omit<DirectedCandidate, "fromLevel" | "toLevel"> & {
  fromLevel: SemanticLevel | null;
  toLevel: SemanticLevel | null;
} | undefined {
  if (relation.kind === "constrained_by" || relation.kind === "proved_by") return undefined;
  const authoredLower = relation.kind === "decomposes_to";
  const followAuthored = direction === "lower" ? authoredLower : !authoredLower;
  const from = followAuthored ? relation.source : relation.target;
  const to = followAuthored ? relation.target : relation.source;
  return {
    relation,
    from,
    to,
    fromLevel: endpointLevel(graph, from),
    toLevel: endpointLevel(graph, to),
  };
}

function endpointLevel(graph: CoordinateGraphReportV2, endpoint: RelationEndpointV1): SemanticLevel | null {
  return graph.nodes.find((node) => node.id === endpointId(endpoint))?.appliesAtLevel ?? null;
}

function endpointId(endpoint: RelationEndpointV1): CoordinateId {
  return endpoint.plane === "A" ? endpoint.coordinateDigest : `semantic:${endpoint.nodeId}`;
}

function decorations(
  graph: CoordinateGraphReportV2,
  visited: ReadonlySet<CoordinateId>,
  kind: "constrained_by" | "proved_by",
): RefinementRelationV1[] {
  return graph.refinementRelations
    .filter((relation) =>
      relation.kind === kind
      && visited.has(endpointId(relation.source))
      && isCertifyingRelation(graph, relation))
    .sort(compareRefinementRelation);
}

function isCertifyingRelation(
  graph: CoordinateGraphReportV2,
  relation: RefinementRelationV1,
): boolean {
  const verified = new Set(graph.verifiedEvidenceDigests);
  return relation.evidenceRefs.length > 0
    && relation.epistemicStatus !== "llm_inferred"
    && relation.epistemicStatus !== "hypothetical"
    && relation.evidenceRefs.every((evidence) =>
      verified.has(`sha256:${evidence.digest.value}` as Sha256Hash));
}

function isStale(bounds: TraversalBounds): boolean {
  return bounds.sourceSeal !== undefined
    && bounds.indexSeal !== undefined
    && bounds.sourceSeal !== bounds.indexSeal;
}

function emptyTraversal(
  base: Pick<TraversalReportV2, "schemaVersion" | "direction" | "sourceId" | "targetLevel" | "compatibilityNormalization">,
  reasonCode: ControlReasonCodeV1,
  limit: number,
  visitedCoordinateIds: readonly CoordinateId[] = [],
): TraversalReportV2 {
  return {
    ...base,
    visitedCoordinateIds,
    paths: [],
    governingConstraints: [],
    proofs: [],
    advisoryRelations: [],
    terminalStatus: reasonCode === "INDEX_STALE" ? "refused" : "empty",
    reasonCode,
    budget: traversalBudget(limit, 0, false),
  };
}

function traversalBudget(limit: number, consumed: number, truncated: boolean): TraversalBudgetV1 {
  return {
    limit,
    consumed,
    remaining: Math.max(0, limit - consumed),
    truncated,
  };
}

function inclusiveLevels(from: SemanticLevel, to: SemanticLevel): SemanticLevel[] {
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  return Array.from({ length: high - low + 1 }, (_, index) => low + index) as SemanticLevel[];
}

function uniqueEvidence(values: readonly EvidenceRefV1[]): EvidenceRefV1[] {
  return [...new Map(
    [...values]
      .sort(compareEvidence)
      .map((value) => [evidenceKey(value), value]),
  ).values()];
}

function evidenceKey(value: EvidenceRefV1): string {
  return `${value.kind}\u0000${value.locator}\u0000${value.digest.algorithm}:${value.digest.value}`;
}
function compareEvidence(left: EvidenceRefV1, right: EvidenceRefV1): number {
  return compareIds(evidenceKey(left), evidenceKey(right));
}
function compareRefinementRelation(left: RefinementRelationV1, right: RefinementRelationV1): number {
  return compareIds(left.id, right.id);
}
function compareRefinementStep(left: RefinementTraversalStepV1, right: RefinementTraversalStepV1): number {
  return compareIds(left.relation.id, right.relation.id);
}
function compareRefinementPath(left: RefinementPathV1, right: RefinementPathV1): number {
  return compareIds(left.coordinates.join("\u0000"), right.coordinates.join("\u0000"));
}
function structuralAdjacency(edges: readonly CoordinateEdge[]): Map<QualifiedCoordinateId, CoordinateEdge[]> {
  const result = new Map<QualifiedCoordinateId, CoordinateEdge[]>();
  for (const edge of [...edges].sort(compareStructuralEdge)) {
    const list = result.get(edge.from) ?? [];
    list.push(edge);
    result.set(edge.from, list);
  }
  return result;
}
function compareStructuralEdge(left: CoordinateEdge, right: CoordinateEdge): number {
  return compareIds(
    `${left.from}\u0000${left.to}\u0000${left.relation}`,
    `${right.from}\u0000${right.to}\u0000${right.relation}`,
  );
}
function compareCoordinatePath(left: CoordinatePath, right: CoordinatePath): number {
  return compareIds(left.nodes.join("\u0000"), right.nodes.join("\u0000"));
}
function normalizeBounds(bounds: TraversalBounds): {
  maxDepth: number;
  maxResults: number;
  maxExpansions: number;
  maxQueue: number;
} {
  return {
    maxDepth: bounded(bounds.maxDepth, DEFAULTS.maxDepth, 0, LIMITS.maxDepth),
    maxResults: bounded(bounds.maxResults, DEFAULTS.maxResults, 1, LIMITS.maxResults),
    maxExpansions: bounded(bounds.maxExpansions, DEFAULTS.maxExpansions, 1, LIMITS.maxExpansions),
    maxQueue: bounded(bounds.maxQueue, DEFAULTS.maxQueue, 1, LIMITS.maxQueue),
  };
}
function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isInteger(value) ? Math.min(maximum, Math.max(minimum, value!)) : fallback;
}
