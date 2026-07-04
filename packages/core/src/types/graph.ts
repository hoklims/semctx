/** Repository graph: nodes, edges, evidence and paths. All structurally derived. */

export type NodeKind =
  | "repository"
  | "package"
  | "module"
  | "symbol"
  | "type"
  | "function"
  | "class"
  | "interface"
  | "enum"
  | "test"
  | "migration"
  | "document"
  | "contract"
  | "invariant"
  | "capability"
  | "bounded_context"
  | "decision"
  | "risk"
  | "external_integration";

export type EdgeKind =
  | "imports"
  | "exports"
  | "calls"
  | "references"
  | "extends"
  | "implements"
  | "declares"
  | "tested_by"
  | "covers"
  | "depends_on"
  | "belongs_to"
  | "implements_capability"
  | "constrained_by"
  | "verifies"
  | "documents"
  | "decides"
  | "changes"
  | "contradicts"
  | "related_to";

export type EvidenceSourceKind = "code" | "test" | "document" | "git" | "runtime" | "manual";

/** A precise, checkable pointer into a source of truth. */
export interface EvidenceRef {
  filePath: string;
  startLine?: number;
  endLine?: number;
  sourceKind: EvidenceSourceKind;
  /** Optional short excerpt used verbatim in justifications. */
  excerpt?: string;
}

/** Evidence stored with a stable id so claims can reference it by id. */
export interface EvidenceRecord extends EvidenceRef {
  id: string;
}

export type MetadataValue = string | number | boolean;

export interface RepositoryNode {
  id: string;
  kind: NodeKind;
  name: string;
  filePath?: string;
  boundedContext?: string;
  exported?: boolean;
  evidence: EvidenceRef[];
  tags: string[];
  metadata: Record<string, MetadataValue>;
}

export interface RepositoryEdge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  evidence: EvidenceRef[];
  metadata: Record<string, MetadataValue>;
}

export interface RepositoryGraph {
  nodes: RepositoryNode[];
  edges: RepositoryEdge[];
}

/** A causal/structural path through the graph, with the edge kinds it traverses. */
export interface GraphPath {
  nodeIds: string[];
  edgeKinds: EdgeKind[];
  description: string;
}
