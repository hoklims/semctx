import type { CoordinateEdge, CoordinateGraphReport, CoordinatePath, ExplanationReport, ImpactReport, QualifiedCoordinateId, SemanticLevel, TraversalReport } from "@semantic-context/control-model";
import { compareIds } from "@semantic-context/core";

export interface TraversalBounds { maxDepth?: number; maxResults?: number; maxExpansions?: number; maxQueue?: number }
const DEFAULTS = { maxDepth: 8, maxResults: 100, maxExpansions: 10_000, maxQueue: 1_000 } as const;
const LIMITS = { maxDepth: 100, maxResults: 10_000, maxExpansions: 100_000, maxQueue: 10_000 } as const;
const MAX_PATHS_PER_DESTINATION = 2;

export function lift(graph: CoordinateGraphReport, sourceId: QualifiedCoordinateId, targetLevel: SemanticLevel, bounds: TraversalBounds = {}): TraversalReport { return traverseToLevel(graph, sourceId, targetLevel, "lift", bounds); }
export function lower(graph: CoordinateGraphReport, sourceId: QualifiedCoordinateId, targetLevel: SemanticLevel, bounds: TraversalBounds = {}): TraversalReport { return traverseToLevel(graph, sourceId, targetLevel, "lower", bounds); }

export function impact(graph: CoordinateGraphReport, sourceIds: QualifiedCoordinateId[], bounds: TraversalBounds = {}): ImpactReport {
  const budget = normalizeBounds(bounds); const outgoing = adjacency(graph.edges, false); const affected = new Map<QualifiedCoordinateId, CoordinatePath[]>(); const sources = [...new Set(sourceIds)].sort();
  const queue: CoordinatePath[] = sources.filter((id) => graph.nodes.some((node) => node.id === id)).map((id) => ({ nodes: [id], edges: [] })).slice(0, budget.maxQueue);
  const bestDepth = new Map(queue.map((path) => [path.nodes[0]!, 0])); let expansions = 0; let truncated = queue.length < sources.length;
  while (queue.length > 0) {
    if (expansions >= budget.maxExpansions) { truncated = true; break; }
    const path = queue.shift()!; const tail = path.nodes.at(-1)!; expansions += 1;
    if (path.edges.length >= budget.maxDepth) { if ((outgoing.get(tail)?.length ?? 0) > 0) truncated = true; continue; }
    for (const edge of outgoing.get(tail) ?? []) {
      const next = edge.to; if (path.nodes.includes(next)) continue;
      const nextPath = { nodes: [...path.nodes, next], edges: [...path.edges, edge] }; const depth = nextPath.edges.length;
      if (!sources.includes(next)) {
        const paths = affected.get(next) ?? [];
        if (paths.length < MAX_PATHS_PER_DESTINATION) { paths.push(nextPath); paths.sort(comparePath); affected.set(next, paths); }
        if (affected.size >= budget.maxResults) { truncated = queue.length > 0 || (outgoing.get(next)?.length ?? 0) > 0; queue.length = 0; break; }
      }
      const knownDepth = bestDepth.get(next);
      if (knownDepth === undefined || depth <= knownDepth) {
        bestDepth.set(next, Math.min(depth, knownDepth ?? depth));
        if (queue.length >= budget.maxQueue) truncated = true; else queue.push(nextPath);
      }
    }
  }
  return { schemaVersion: 1, sourceIds: sources, ...budget, affected: [...affected.entries()].sort(([a], [b]) => compareIds(a, b)).map(([id, paths]) => ({ id, paths })), truncated };
}

export function explainWhy(graph: CoordinateGraphReport, sourceId: QualifiedCoordinateId, bounds: TraversalBounds = {}): ExplanationReport {
  const budget = normalizeBounds(bounds); const source = graph.nodes.find((node) => node.id === sourceId);
  const base = { schemaVersion: 1 as const, sourceId, ...budget };
  if (!source) return { ...base, known: false, rationaleIds: [], paths: [], unknownReason: "coordinate_missing" };
  const rationale = new Set(graph.nodes.filter((node) => node.plane === "semantic" && ["goal", "invariant", "decision"].includes(node.category)).map((node) => node.id));
  if (rationale.has(sourceId)) return { ...base, known: true, rationaleIds: [sourceId], paths: [{ nodes: [sourceId], edges: [] }] };
  const outgoing = adjacency(graph.edges, false); const paths: CoordinatePath[] = []; const queue: CoordinatePath[] = [{ nodes: [sourceId], edges: [] }]; const bestDepth = new Map<QualifiedCoordinateId, number>([[sourceId, 0]]); let expansions = 0; let boundReached = false;
  while (queue.length > 0 && paths.length < budget.maxResults) {
    if (expansions >= budget.maxExpansions) { boundReached = true; break; }
    const path = queue.shift()!; const tail = path.nodes.at(-1)!; expansions += 1;
    if (path.edges.length >= budget.maxDepth) { if ((outgoing.get(tail)?.length ?? 0) > 0) boundReached = true; continue; }
    for (const edge of outgoing.get(tail) ?? []) {
      if (path.nodes.includes(edge.to)) continue;
      const next = { nodes: [...path.nodes, edge.to], edges: [...path.edges, edge] }; const depth = next.edges.length;
      if (rationale.has(edge.to)) paths.push(next);
      else if (bestDepth.get(edge.to) === undefined || depth <= bestDepth.get(edge.to)!) {
        bestDepth.set(edge.to, Math.min(depth, bestDepth.get(edge.to) ?? depth));
        if (queue.length >= budget.maxQueue) boundReached = true; else queue.push(next);
      }
      if (paths.length >= budget.maxResults) { boundReached = true; break; }
    }
  }
  paths.sort(comparePath); const rationaleIds = [...new Set(paths.map((path) => path.nodes.at(-1)!))].sort();
  return { ...base, known: paths.length > 0, rationaleIds, paths, ...(paths.length === 0 ? { unknownReason: boundReached ? "traversal_bound_reached" as const : "rationale_not_authored" as const } : {}) };
}

function traverseToLevel(graph: CoordinateGraphReport, sourceId: QualifiedCoordinateId, targetLevel: SemanticLevel, direction: "lift" | "lower", bounds: TraversalBounds): TraversalReport {
  const budget = normalizeBounds(bounds); const nodes = new Map(graph.nodes.map((node) => [node.id, node])); const source = nodes.get(sourceId); const validDirection = source && (direction === "lift" ? targetLevel > source.level : targetLevel < source.level); const paths: CoordinatePath[] = []; let truncated = false;
  if (validDirection) {
    const edges = adjacency(graph.edges, direction === "lower"); const queue: CoordinatePath[] = [{ nodes: [sourceId], edges: [] }]; const bestDepth = new Map<QualifiedCoordinateId, number>([[sourceId, 0]]); const resultCounts = new Map<QualifiedCoordinateId, number>(); let expansions = 0;
    while (queue.length > 0 && paths.length < budget.maxResults) {
      if (expansions >= budget.maxExpansions) { truncated = true; break; }
      const path = queue.shift()!; const tail = path.nodes.at(-1)!; expansions += 1;
      if (path.edges.length >= budget.maxDepth) { if ((edges.get(tail)?.length ?? 0) > 0) truncated = true; continue; }
      for (const edge of edges.get(tail) ?? []) {
        const nextId = direction === "lower" ? edge.from : edge.to; if (path.nodes.includes(nextId)) continue; const nextNode = nodes.get(nextId); if (!nextNode) continue;
        const nextPath = { nodes: [...path.nodes, nextId], edges: [...path.edges, edge] }; const depth = nextPath.edges.length;
        if (nextNode.level === targetLevel) { const count = resultCounts.get(nextId) ?? 0; if (count < MAX_PATHS_PER_DESTINATION) { paths.push(nextPath); resultCounts.set(nextId, count + 1); } }
        else if (direction === "lift" ? nextNode.level < targetLevel : nextNode.level > targetLevel) {
          const knownDepth = bestDepth.get(nextId);
          if (knownDepth === undefined || depth <= knownDepth) { bestDepth.set(nextId, Math.min(depth, knownDepth ?? depth)); if (queue.length >= budget.maxQueue) truncated = true; else queue.push(nextPath); }
        }
        if (paths.length >= budget.maxResults) { truncated = true; break; }
      }
    }
  }
  paths.sort(comparePath); return { schemaVersion: 1, direction, sourceId, targetLevel, ...budget, paths, truncated };
}

function adjacency(edges: CoordinateEdge[], reverse: boolean): Map<QualifiedCoordinateId, CoordinateEdge[]> { const result = new Map<QualifiedCoordinateId, CoordinateEdge[]>(); for (const edge of [...edges].sort(compareEdge)) { const key = reverse ? edge.to : edge.from; const list = result.get(key) ?? []; list.push(edge); result.set(key, list); } return result; }
function normalizeBounds(bounds: TraversalBounds): { maxDepth: number; maxResults: number; maxExpansions: number; maxQueue: number } { return { maxDepth: bounded(bounds.maxDepth, DEFAULTS.maxDepth, 0, LIMITS.maxDepth), maxResults: bounded(bounds.maxResults, DEFAULTS.maxResults, 1, LIMITS.maxResults), maxExpansions: bounded(bounds.maxExpansions, DEFAULTS.maxExpansions, 1, LIMITS.maxExpansions), maxQueue: bounded(bounds.maxQueue, DEFAULTS.maxQueue, 1, LIMITS.maxQueue) }; }
function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number { return Number.isInteger(value) ? Math.min(maximum, Math.max(minimum, value!)) : fallback; }
function compareEdge(a: CoordinateEdge, b: CoordinateEdge): number { return compareIds(`${a.from}\u0000${a.to}\u0000${a.relation}`, `${b.from}\u0000${b.to}\u0000${b.relation}`); }
function comparePath(a: CoordinatePath, b: CoordinatePath): number { return compareIds(a.nodes.join("\u0000"), b.nodes.join("\u0000")); }
