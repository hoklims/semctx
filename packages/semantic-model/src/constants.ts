/** Canonical vocabularies for the semantic model. Single source for validation and the DSL. */

import type {
  SemanticNodeKind,
  SemanticStatus,
  SemanticProvenance,
  SemanticRelationKind,
  ChangeLifecycle,
} from "./types";

export const SEMANTIC_NODE_KINDS: readonly SemanticNodeKind[] = [
  "goal",
  "invariant",
  "decision",
  "assumption",
  "unknown",
  "change",
  "evidence",
];

export const SEMANTIC_STATUSES: readonly SemanticStatus[] = [
  "declared",
  "proposed",
  "assumed",
  "tested",
  "statically_verified",
  "runtime_verified",
  "contradicted",
  "stale",
];

export const SEMANTIC_PROVENANCES: readonly SemanticProvenance[] = ["author", "agent", "derived"];

export const SEMANTIC_RELATION_KINDS: readonly SemanticRelationKind[] = [
  "implements",
  "preserves",
  "serves",
  "justifies",
  "depends_on",
  "requires_evidence",
  "proved_by",
  "risks",
  "contradicts",
  "supersedes",
];

export const CHANGE_LIFECYCLES: readonly ChangeLifecycle[] = [
  "draft",
  "active",
  "verified",
  "partial",
  "blocked",
  "stale",
  "superseded",
];

/** Default status for a newly declared truth node of each kind. */
export const DEFAULT_STATUS_BY_KIND: Record<Exclude<SemanticNodeKind, "change">, SemanticStatus> = {
  goal: "declared",
  invariant: "declared",
  decision: "declared",
  assumption: "assumed",
  unknown: "declared",
  evidence: "proposed",
};

/** Statuses that count as a *proof* (an obtained, verified fact). */
export const PROVEN_STATUSES: ReadonlySet<SemanticStatus> = new Set<SemanticStatus>([
  "tested",
  "statically_verified",
  "runtime_verified",
]);

export function isSemanticNodeKind(value: string): value is SemanticNodeKind {
  return (SEMANTIC_NODE_KINDS as readonly string[]).includes(value);
}

export function isSemanticStatus(value: string): value is SemanticStatus {
  return (SEMANTIC_STATUSES as readonly string[]).includes(value);
}

export function isSemanticProvenance(value: string): value is SemanticProvenance {
  return (SEMANTIC_PROVENANCES as readonly string[]).includes(value);
}

export function isSemanticRelationKind(value: string): value is SemanticRelationKind {
  return (SEMANTIC_RELATION_KINDS as readonly string[]).includes(value);
}

export function isChangeLifecycle(value: string): value is ChangeLifecycle {
  return (CHANGE_LIFECYCLES as readonly string[]).includes(value);
}
