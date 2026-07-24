import { createHash } from "node:crypto";
import { compareCodeUnits as compareIds } from "@semantic-context/control-model/reconciliation";
import type {
  ArchitectureComparisonReport,
  ArchitectureDelta,
  ArchitectureElement,
  ArchitectureRelation,
  ArchitectureSnapshot,
  CoordinateGraphReport,
  CoordinateGraphReportV2,
  QualifiedCoordinateId,
} from "@semantic-context/control-model/reconciliation";

export interface SnapshotIdentity { id: string; commit: string; capturedAt: string }

/** Content identity for the exact federated A+B graph used by a read-only planning snapshot. */
export function fingerprintCoordinateGraph(graph: CoordinateGraphReport | CoordinateGraphReportV2): string {
  const normalized = graph.schemaVersion === 2 ? {
    schemaVersion: 2,
    nodes: [...graph.nodes].sort((a, b) => compareIds(a.id, b.id)),
    structuralEdges: [...graph.structuralEdges].sort((a, b) => compareIds(edgeKey(a), edgeKey(b))),
    refinementRelations: [...graph.refinementRelations].sort((a, b) => compareIds(a.id, b.id)),
    mapping: [...graph.mapping].sort((a, b) => compareIds(`${a.plane}:${a.sourceKind}`, `${b.plane}:${b.sourceKind}`)),
    coverage: normalizeCoverage(graph.coverage),
    unsupported: [...graph.unsupported].sort(compareSource),
    unmapped: [...graph.unmapped].sort(compareSource),
    staleLinks: [...graph.staleLinks].sort(compareStaleLink),
    danglingReferences: [...graph.danglingReferences].sort(compareDanglingReference),
    compatibilityNormalization: [...graph.compatibilityNormalization],
    verifiedEvidenceDigests: [...graph.verifiedEvidenceDigests].sort(compareIds),
  } : {
    schemaVersion: 1,
    nodes: [...graph.nodes].sort((a, b) => compareIds(a.id, b.id)),
    edges: [...graph.edges].sort((a, b) => compareIds(edgeKey(a), edgeKey(b))),
    mapping: [...graph.mapping].sort((a, b) => compareIds(`${a.plane}:${a.sourceKind}`, `${b.plane}:${b.sourceKind}`)),
    coverage: normalizeCoverage(graph.coverage),
    unsupported: [...graph.unsupported].sort(compareSource),
    unmapped: [...graph.unmapped].sort(compareSource),
    staleLinks: [...(graph.staleLinks ?? [])].sort(compareStaleLink),
    danglingReferences: [...(graph.danglingReferences ?? [])].sort(compareDanglingReference),
  };
  return createHash("sha256").update(stableJson(normalized)).digest("hex");
}

export function snapshotArchitecture(graph: CoordinateGraphReport | CoordinateGraphReportV2, identity: SnapshotIdentity): ArchitectureSnapshot {
  const elements = graph.schemaVersion === 2
    ? graph.nodes.flatMap((node) =>
        node.appliesAtLevel === null || node.category === null || node.id.startsWith("sha256:")
          ? []
          : [{
              id: node.id as QualifiedCoordinateId,
              level: node.appliesAtLevel,
              category: node.category,
              fingerprint: stableJson({
                category: node.category,
                epistemicStatus: node.epistemicStatus,
                label: node.label,
                level: node.appliesAtLevel,
                metadata: node.metadata ?? {},
                sourceKind: node.sourceKind,
              }),
            }])
    : graph.nodes.map((node) => ({
        id: node.id,
        level: node.level,
        category: node.category,
        fingerprint: stableJson({ category: node.category, epistemicStatus: node.epistemicStatus, label: node.label, level: node.level, metadata: node.metadata ?? {}, sourceKind: node.sourceKind }),
      }));
  const structuralRelations = (graph.schemaVersion === 2 ? graph.structuralEdges : graph.edges).map((edge) => ({
    from: edge.from,
    to: edge.to,
    relation: edge.relation,
    fingerprint: stableJson({ evidenceRefs: [...edge.evidenceRefs].sort(), sourceRelation: edge.sourceRelation ?? "" }),
  }));
  const refinementRelations = graph.schemaVersion === 2
    ? graph.refinementRelations.flatMap((relation) => {
        if (relation.source.plane !== "B" || relation.target.plane !== "B") return [];
        return [{
          from: `semantic:${relation.source.nodeId}` as QualifiedCoordinateId,
          to: `semantic:${relation.target.nodeId}` as QualifiedCoordinateId,
          relation: relation.kind,
          fingerprint: stableJson({
            epistemicStatus: relation.epistemicStatus,
            evidenceRefs: relation.evidenceRefs,
            provenance: relation.provenance,
          }),
        }];
      })
    : [];
  const sortedElements = elements.sort((a, b) => compareIds(a.id, b.id));
  const retainedElementIds = new Set(sortedElements.map((element) => element.id));
  const relations = [...structuralRelations, ...refinementRelations]
    .filter((relation) =>
      retainedElementIds.has(relation.from)
      && retainedElementIds.has(relation.to))
    .sort(compareRelation);
  return {
    ...identity,
    elements: sortedElements,
    relations,
  };
}

export function compareArchitectures(current: ArchitectureSnapshot, target: ArchitectureSnapshot): ArchitectureComparisonReport {
  const normalizedCurrent = normalizeSnapshot(current);
  const normalizedTarget = normalizeSnapshot(target);
  const currentElements = new Map(normalizedCurrent.elements.map((element) => [element.id, element]));
  const targetElements = new Map(normalizedTarget.elements.map((element) => [element.id, element]));
  const currentRelations = new Map(normalizedCurrent.relations.map((relation) => [relationKey(relation), relation]));
  const targetRelations = new Map(normalizedTarget.relations.map((relation) => [relationKey(relation), relation]));
  const changed = intersections(currentElements, targetElements)
    .filter((id) => stableJson(currentElements.get(id)) !== stableJson(targetElements.get(id)))
    .map((id) => ({ id, before: currentElements.get(id)!, after: targetElements.get(id)! }));
  const changedRelations = intersections(currentRelations, targetRelations)
    .filter((key) => stableJson(currentRelations.get(key)) !== stableJson(targetRelations.get(key)))
    .map((key) => ({ key, before: currentRelations.get(key)!, after: targetRelations.get(key)! }));
  const delta: ArchitectureDelta = {
    currentSnapshotId: current.id,
    targetSnapshotId: target.id,
    added: difference(targetElements, currentElements),
    removed: difference(currentElements, targetElements),
    changed,
    addedRelations: difference(targetRelations, currentRelations),
    removedRelations: difference(currentRelations, targetRelations),
    changedRelations,
    changedInvariantIds: [...new Set([
      ...difference(targetElements, currentElements).filter(isInvariant).map((item) => item.id),
      ...difference(currentElements, targetElements).filter(isInvariant).map((item) => item.id),
      ...changed.filter((item) => isInvariant(item.before) || isInvariant(item.after)).map((item) => item.id),
    ])].sort(),
  };
  return { schemaVersion: 1, current: normalizedCurrent, target: normalizedTarget, delta };
}

export function architectureDeltasEqual(left: ArchitectureDelta, right: ArchitectureDelta): boolean {
  return stableJson(normalizeDelta(left)) === stableJson(normalizeDelta(right));
}

function normalizeSnapshot(snapshot: ArchitectureSnapshot): ArchitectureSnapshot {
  return { ...snapshot, elements: [...snapshot.elements].sort((a, b) => compareIds(a.id, b.id)), relations: [...snapshot.relations].sort(compareRelation) };
}
function normalizeDelta(delta: ArchitectureDelta): ArchitectureDelta {
  return {
    ...delta,
    added: [...delta.added].sort((a, b) => compareIds(a.id, b.id)),
    removed: [...delta.removed].sort((a, b) => compareIds(a.id, b.id)),
    changed: [...delta.changed].sort((a, b) => compareIds(a.id, b.id)),
    addedRelations: [...delta.addedRelations].sort(compareRelation),
    removedRelations: [...delta.removedRelations].sort(compareRelation),
    changedRelations: [...delta.changedRelations].sort((a, b) => compareIds(a.key, b.key)),
    changedInvariantIds: [...new Set(delta.changedInvariantIds)].sort(),
  };
}
function difference<K extends string, T>(left: Map<K, T>, right: Map<K, T>): T[] { return [...left.entries()].filter(([key]) => !right.has(key)).sort(([a], [b]) => compareIds(a, b)).map(([, value]) => value); }
function intersections<K extends string, T, U>(left: Map<K, T>, right: Map<K, U>): K[] { return [...left.keys()].filter((key) => right.has(key)).sort(); }
function relationKey(relation: ArchitectureRelation): string { return `${relation.from}\u0000${relation.to}\u0000${relation.relation}`; }
function compareRelation(a: ArchitectureRelation, b: ArchitectureRelation): number { return compareIds(relationKey(a), relationKey(b)); }
function edgeKey(edge: CoordinateGraphReport["edges"][number]): string { return `${edge.from}\u0000${edge.to}\u0000${edge.relation}\u0000${edge.sourceRelation ?? ""}`; }
function normalizeCoverage(coverage: CoordinateGraphReport["coverage"] | CoordinateGraphReportV2["coverage"]) {
  return [...coverage].map((entry) => ({
    ...entry,
    categories: [...entry.categories].sort(),
    coordinateIds: [...entry.coordinateIds].sort(),
  })).sort((a, b) => a.level - b.level);
}
function compareSource(a: CoordinateGraphReport["unsupported"][number], b: CoordinateGraphReport["unsupported"][number]): number { return compareIds(`${a.plane}:${a.sourceKind}:${a.sourceId}`, `${b.plane}:${b.sourceKind}:${b.sourceId}`); }
function compareStaleLink(a: NonNullable<CoordinateGraphReport["staleLinks"]>[number], b: NonNullable<CoordinateGraphReport["staleLinks"]>[number]): number { return compareIds(`${a.ownerId}:${a.link.kind}:${a.link.ref}`, `${b.ownerId}:${b.link.kind}:${b.link.ref}`); }
function compareDanglingReference(a: NonNullable<CoordinateGraphReport["danglingReferences"]>[number], b: NonNullable<CoordinateGraphReport["danglingReferences"]>[number]): number { return compareIds(`${a.ownerId}:${a.field}:${a.ref}`, `${b.ownerId}:${b.field}:${b.ref}`); }
function isInvariant(element: ArchitectureElement): boolean { return element.level === 4 || element.category === "invariant" || element.category === "policy"; }
function stableJson(value: unknown): string { return JSON.stringify(canonical(value)); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => compareIds(a, b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
