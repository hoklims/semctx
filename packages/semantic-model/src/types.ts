/**
 * Authored semantic truth (Plane B). Distinct from the derived repository graph (Plane A):
 * goals, business invariants, decisions, assumptions, unknowns, change contracts and evidence
 * are *declared* by a human or agent, never inferred from source. The only coupling to Plane A is
 * an explicit `RepositoryLink`.
 *
 * See docs/architecture/semantic-model.md for the full contract.
 */

/** The kind of an authored semantic node. `change` is represented by `ChangeContract`. */
export type SemanticNodeKind =
  | "goal"
  | "invariant"
  | "decision"
  | "assumption"
  | "unknown"
  | "change"
  | "evidence";

/**
 * Verification standing of a semantic node. Deliberately keeps `established` (tested/verified),
 * `assumed`, `declared` (unverified), `contradicted` and `stale` distinct — a status is never
 * silently upgraded.
 */
export type SemanticStatus =
  | "declared"
  | "proposed"
  | "assumed"
  | "tested"
  | "statically_verified"
  | "runtime_verified"
  | "contradicted"
  | "stale";

/** Who authored the node. `derived` is reserved for nodes a tool materialises from Plane A. */
export type SemanticProvenance = "author" | "agent" | "derived";

/** A typed, directed relation between two semantic nodes (by id). */
export type SemanticRelationKind =
  | "implements"
  | "preserves"
  | "serves"
  | "justifies"
  | "depends_on"
  | "requires_evidence"
  | "proved_by"
  | "risks"
  | "contradicts"
  | "supersedes";

/** Lifecycle of a change contract. Separate from `SemanticStatus` by design (Section 4.4). */
export type ChangeLifecycle =
  | "draft"
  | "active"
  | "verified"
  | "partial"
  | "blocked"
  | "stale"
  | "superseded";

/** What a repository link points at in Plane A. */
export type RepositoryLinkKind =
  | "symbol"
  | "file"
  | "claim"
  | "invariant"
  | "contract"
  | "capability"
  | "test"
  | "migration"
  | "evidence";

/** An explicit pointer from Plane B into Plane A. `ref` is a graph id, or a repo-relative path for a file link. */
export interface RepositoryLink {
  kind: RepositoryLinkKind;
  ref: string;
}

/** Where a node was authored: the `.sem` file and 1-based line of its block header. */
export interface SourceRef {
  file: string;
  line: number;
}

/** An outgoing typed relation from a semantic node to another (by semantic id). */
export interface SemanticRelation {
  kind: SemanticRelationKind;
  to: string;
}

/** A single authored declaration (one of the six truth kinds; `change` uses `ChangeContract`). */
export interface SemanticNode {
  id: string;
  kind: SemanticNodeKind;
  statement: string;
  status: SemanticStatus;
  provenance: SemanticProvenance;
  sourceRefs: SourceRef[];
  repositoryLinks: RepositoryLink[];
  relations: SemanticRelation[];
  tags: string[];
  metadata?: Record<string, string>;
}

/**
 * A proof-carrying change contract (kind `change`). Its typed relation arrays answer Section 4.4:
 * which goal it serves, which invariants it must preserve, which evidence it requires, and which
 * unknowns remain open.
 */
export interface ChangeContract {
  id: string;
  statement: string;
  lifecycle: ChangeLifecycle;
  provenance: SemanticProvenance;
  sourceRefs: SourceRef[];
  /** goal ids this change serves. */
  serves: string[];
  /** invariant ids this change must preserve. */
  preserves: string[];
  /** evidence ids this change requires as proof. */
  requiresEvidence: string[];
  /** unknown ids that remain open under this change. */
  openUnknowns: string[];
  repositoryLinks: RepositoryLink[];
  tags: string[];
  metadata?: Record<string, string>;
}

/** The aggregate authored model: truth nodes plus change contracts. */
export interface SemanticModel {
  nodes: SemanticNode[];
  changes: ChangeContract[];
}
