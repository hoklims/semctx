import {
  compareIds,
  edgeId,
  evidenceId,
  type EvidenceRecord,
  type EvidenceRef,
  type MetadataValue,
  type RepositoryEdge,
  type RepositoryGraph,
  type RepositoryNode,
} from "@semantic-context/core";
import type { EdgeFact, EdgeProvenance, FactBatchV1, NodeFact, PlaneAFact } from "./model";
import { canonicalJson } from "./canonical";

export type PlaneAAssemblyErrorCode =
  | "FACT_ID_CONFLICT"
  | "INVALID_EVIDENCE_RANGE"
  | "FACT_OUT_OF_SCOPE"
  | "MISSING_ENDPOINT";

export class PlaneAAssemblyError extends Error {
  constructor(
    readonly code: PlaneAAssemblyErrorCode,
    readonly details: Readonly<Record<string, string | number>>,
  ) {
    super(`${code}: ${JSON.stringify(details)}`);
    this.name = "PlaneAAssemblyError";
  }
}

/**
 * An authored cross-reference naming a target this repository does not contain. The edge is kept
 * out of the graph — a dangling endpoint would break every downstream traversal — and reported
 * here so the gap stays visible instead of being silently dropped.
 */
export interface UnresolvedReference {
  readonly edgeId: string;
  readonly kind: RepositoryEdge["kind"];
  readonly from: string;
  readonly to: string;
  /** The absent endpoint. Always the target: an absent source stays a fatal assembly error. */
  readonly missing: string;
}

export interface AssembledPlaneA {
  graph: RepositoryGraph;
  evidence: EvidenceRecord[];
  unresolvedReferences: UnresolvedReference[];
}

export interface ImportEdgeOccurrence {
  readonly from: string;
  readonly to: string;
  readonly evidence: readonly EvidenceRef[];
  readonly specifier: string;
}

function compareFacts(left: PlaneAFact, right: PlaneAFact): number {
  if (left.ordinal !== right.ordinal) return left.ordinal - right.ordinal;
  if (left.factType !== right.factType) return left.factType < right.factType ? -1 : 1;
  const leftId = left.factType === "node" ? left.id : edgeId(left.kind, left.from, left.to);
  const rightId = right.factType === "node" ? right.id : edgeId(right.kind, right.from, right.to);
  const idOrder = compareIds(leftId, rightId);
  return idOrder !== 0
    ? idOrder
    : compareIds(canonicalJson(left), canonicalJson(right));
}

function validateEvidence(ref: EvidenceRef, selectedPaths: ReadonlySet<string>): void {
  if (
    (ref.startLine !== undefined && (!Number.isInteger(ref.startLine) || ref.startLine < 1))
    || (ref.endLine !== undefined && (!Number.isInteger(ref.endLine) || ref.endLine < 1))
    || (ref.endLine !== undefined && ref.startLine === undefined)
    || (
      ref.startLine !== undefined
      && ref.endLine !== undefined
      && ref.endLine < ref.startLine
    )
  ) {
    throw new PlaneAAssemblyError("INVALID_EVIDENCE_RANGE", {
      filePath: ref.filePath,
      startLine: ref.startLine ?? 0,
      endLine: ref.endLine ?? 0,
    });
  }
  if (!selectedPaths.has(ref.filePath)) {
    throw new PlaneAAssemblyError("FACT_OUT_OF_SCOPE", { filePath: ref.filePath });
  }
}

function validateNodeIdentity(existing: RepositoryNode, fact: NodeFact): void {
  const incompatible = existing.kind !== fact.kind
    || existing.name !== fact.name
    || (
      existing.filePath !== undefined
      && fact.filePath !== undefined
      && existing.filePath !== fact.filePath
    )
    || (
      existing.boundedContext !== undefined
      && fact.boundedContext !== undefined
      && existing.boundedContext !== fact.boundedContext
    );
  if (incompatible) {
    throw new PlaneAAssemblyError("FACT_ID_CONFLICT", {
      id: fact.id,
      existingKind: existing.kind,
      incomingKind: fact.kind,
    });
  }
  for (const [key, value] of Object.entries(fact.metadata)) {
    const existingValue = existing.metadata[key];
    if (
      existingValue !== undefined
      && key !== "statement"
      && canonicalJson(existingValue) !== canonicalJson(value)
    ) {
      throw new PlaneAAssemblyError("FACT_ID_CONFLICT", {
        id: fact.id,
        metadataKey: key,
      });
    }
  }
}

export class DeterministicGraphAssembler {
  readonly nodes = new Map<string, RepositoryNode>();
  readonly edges = new Map<string, RepositoryEdge>();
  private readonly evidence = new Map<string, EvidenceRecord>();
  private readonly selectedPaths: ReadonlySet<string>;
  private readonly recordedFacts: PlaneAFact[] = [];
  /** Provenance is assembler-owned, never read back from the assembled edge: nothing downstream can
   *  promote a derived edge to authored by writing a metadata key. */
  private readonly edgeProvenance = new Map<string, EdgeProvenance>();
  private nextOrdinal = 0;

  constructor(selectedPaths: readonly string[]) {
    this.selectedPaths = new Set(selectedPaths);
  }

  addFact(fact: PlaneAFact): void {
    this.recordedFacts.push(fact);
    if (fact.factType === "node") this.addNodeFact(fact);
    else this.addEdgeFact(fact);
    this.nextOrdinal = Math.max(this.nextOrdinal, fact.ordinal + 1);
  }

  node(input: {
    id: string;
    kind: NodeFact["kind"];
    name: string;
    filePath?: string;
    boundedContext?: string;
    exported?: boolean;
    evidence?: readonly EvidenceRef[];
    tags?: readonly string[];
    metadata?: Readonly<Record<string, MetadataValue>>;
  }): RepositoryNode {
    const fact: NodeFact = {
      factType: "node",
      ordinal: this.nextOrdinal++,
      ...input,
      evidence: input.evidence ?? [],
      tags: input.tags ?? [],
      metadata: input.metadata ?? {},
    };
    this.recordedFacts.push(fact);
    this.addNodeFact(fact);
    const node = this.nodes.get(input.id);
    if (node === undefined) throw new Error(`node ${input.id} was not assembled`);
    return node;
  }

  edge(
    kind: EdgeFact["kind"],
    from: string,
    to: string,
    evidence: readonly EvidenceRef[],
    metadata: Readonly<Record<string, MetadataValue>> = {},
    provenance: EdgeProvenance = "derived",
  ): void {
    const fact: EdgeFact = {
      factType: "edge",
      ordinal: this.nextOrdinal++,
      kind,
      from,
      to,
      evidence,
      metadata,
      ...(provenance === "derived" ? {} : { provenance }),
    };
    this.recordedFacts.push(fact);
    this.addEdgeFact(fact);
  }

  facts(): readonly PlaneAFact[] {
    return [...this.recordedFacts];
  }

  build(): AssembledPlaneA {
    const unresolvedReferences: UnresolvedReference[] = [];
    const unresolvedEdgeIds = new Set<string>();
    for (const edge of this.edges.values()) {
      const sourceMissing = !this.nodes.has(edge.from);
      const targetMissing = !this.nodes.has(edge.to);
      if (!sourceMissing && !targetMissing) continue;
      // Authored input may name any target, so an absent target is an unresolved link. An absent
      // source is not: it is the declaring artifact, which the analyzer registers itself, so its
      // absence proves the assembler contradicted itself and stays fatal whatever the edge's
      // provenance.
      if (sourceMissing || this.edgeProvenance.get(edge.id) !== "authored") {
        throw new PlaneAAssemblyError("MISSING_ENDPOINT", {
          edgeId: edge.id,
          missing: sourceMissing ? edge.from : edge.to,
        });
      }
      unresolvedReferences.push({
        edgeId: edge.id,
        kind: edge.kind,
        from: edge.from,
        to: edge.to,
        missing: edge.to,
      });
      unresolvedEdgeIds.add(edge.id);
    }
    return {
      graph: {
        nodes: [...this.nodes.values()].sort((left, right) => compareIds(left.id, right.id)),
        edges: [...this.edges.values()]
          .filter((edge) => !unresolvedEdgeIds.has(edge.id))
          .sort((left, right) => compareIds(left.id, right.id)),
      },
      evidence: [...this.evidence.values()].sort((left, right) => compareIds(left.id, right.id)),
      unresolvedReferences: unresolvedReferences.sort((left, right) =>
        compareIds(left.edgeId, right.edgeId)),
    };
  }

  private recordEvidence(ref: EvidenceRef): void {
    validateEvidence(ref, this.selectedPaths);
    const id = evidenceId(ref.sourceKind, ref.filePath, ref.startLine, ref.endLine);
    if (!this.evidence.has(id)) this.evidence.set(id, { id, ...ref });
  }

  private addNodeFact(fact: NodeFact): void {
    if (fact.filePath !== undefined && !this.selectedPaths.has(fact.filePath)) {
      throw new PlaneAAssemblyError("FACT_OUT_OF_SCOPE", {
        factId: fact.id,
        filePath: fact.filePath,
      });
    }
    for (const ref of fact.evidence) this.recordEvidence(ref);
    const existing = this.nodes.get(fact.id);
    if (existing !== undefined) {
      validateNodeIdentity(existing, fact);
      existing.evidence.push(...fact.evidence);
      for (const tag of fact.tags) if (!existing.tags.includes(tag)) existing.tags.push(tag);
      for (const [key, value] of Object.entries(fact.metadata)) {
        if (!(key in existing.metadata)) existing.metadata[key] = value;
      }
      if (fact.filePath !== undefined && existing.filePath === undefined) {
        existing.filePath = fact.filePath;
      }
      if (fact.boundedContext !== undefined && existing.boundedContext === undefined) {
        existing.boundedContext = fact.boundedContext;
      }
      if (fact.exported === true) existing.exported = true;
      return;
    }
    this.nodes.set(fact.id, {
      id: fact.id,
      kind: fact.kind,
      name: fact.name,
      ...(fact.filePath !== undefined ? { filePath: fact.filePath } : {}),
      ...(fact.boundedContext !== undefined ? { boundedContext: fact.boundedContext } : {}),
      ...(fact.exported !== undefined ? { exported: fact.exported } : {}),
      evidence: [...fact.evidence],
      tags: [...fact.tags],
      metadata: { ...fact.metadata },
    });
  }

  private addEdgeFact(fact: EdgeFact): void {
    for (const ref of fact.evidence) this.recordEvidence(ref);
    const id = edgeId(fact.kind, fact.from, fact.to);
    const incoming: EdgeProvenance = fact.provenance ?? "derived";
    const recorded = this.edgeProvenance.get(id);
    // Two producers disagreeing on provenance means at least one of them derived the edge, so the
    // stricter reading wins and a missing endpoint stays fatal.
    this.edgeProvenance.set(
      id,
      recorded === undefined || recorded === incoming ? incoming : "derived",
    );
    const existing = this.edges.get(id);
    if (existing !== undefined) {
      for (const [key, value] of Object.entries(fact.metadata)) {
        const existingValue = existing.metadata[key];
        if (
          existingValue !== undefined
          && canonicalJson(existingValue) !== canonicalJson(value)
        ) {
          throw new PlaneAAssemblyError("FACT_ID_CONFLICT", {
            id,
            metadataKey: key,
          });
        }
        if (existingValue === undefined) existing.metadata[key] = value;
      }
      existing.evidence.push(...fact.evidence);
      return;
    }
    this.edges.set(id, {
      id,
      kind: fact.kind,
      from: fact.from,
      to: fact.to,
      evidence: [...fact.evidence],
      metadata: { ...fact.metadata },
    });
  }
}

/**
 * Repository import edges are relations between modules, not individual import statements.
 * Aggregate occurrence-level evidence before the strict assembler sees the relation so parallel
 * declarations cannot disagree on singular metadata.
 */
export function addAggregatedImportEdges(
  assembler: DeterministicGraphAssembler,
  occurrences: readonly ImportEdgeOccurrence[],
): void {
  const grouped = new Map<string, {
    readonly from: string;
    readonly to: string;
    readonly evidence: Map<string, EvidenceRef>;
    readonly specifiers: Set<string>;
  }>();
  for (const occurrence of occurrences) {
    const key = canonicalJson([occurrence.from, occurrence.to]);
    const existing = grouped.get(key);
    const group = existing ?? {
      from: occurrence.from,
      to: occurrence.to,
      evidence: new Map<string, EvidenceRef>(),
      specifiers: new Set<string>(),
    };
    for (const ref of occurrence.evidence) {
      group.evidence.set(canonicalJson(ref), ref);
    }
    group.specifiers.add(occurrence.specifier);
    if (existing === undefined) grouped.set(key, group);
  }

  for (const [, group] of [...grouped].sort(([left], [right]) =>
    compareIds(left, right))) {
    const specifiers = [...group.specifiers].sort(compareIds);
    assembler.edge(
      "imports",
      group.from,
      group.to,
      [...group.evidence].sort(([left], [right]) => compareIds(left, right))
        .map(([, ref]) => ref),
      specifiers.length === 1
        ? { specifier: specifiers[0] ?? "" }
        : { specifiers: canonicalJson(specifiers) },
    );
  }
}

function batchSortKey(batch: FactBatchV1): string {
  return [
    batch.scope.repositoryIdentity,
    batch.scope.selectedPathSetDigest,
    batch.producer.identity,
    batch.producer.version,
    batch.batchId,
    canonicalJson(batch),
  ].join("\u0000");
}

export function assembleFactBatches(batches: readonly FactBatchV1[]): AssembledPlaneA {
  const orderedBatches = [...batches].sort((left, right) =>
    compareIds(batchSortKey(left), batchSortKey(right)));
  const selectedPaths = new Set<string>();
  for (const batch of orderedBatches) {
    for (const path of batch.scope.selectedPaths) selectedPaths.add(path);
  }
  const assembler = new DeterministicGraphAssembler([...selectedPaths]);
  for (const batch of orderedBatches) {
    const facts = [...batch.facts].sort(compareFacts);
    const scopeValidator = new DeterministicGraphAssembler(batch.scope.selectedPaths);
    for (const fact of facts) scopeValidator.addFact(fact);
    for (const fact of facts) assembler.addFact(fact);
  }
  return assembler.build();
}

export type { MetadataValue };
