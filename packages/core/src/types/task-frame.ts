/** Structured representation of a user task. Produced by a TaskFrameExtractor. */

export type TaskMode =
  | "bugfix"
  | "feature"
  | "refactor"
  | "audit"
  | "performance"
  | "security"
  | "migration";

export interface TaskHypothesis {
  id: string;
  statement: string;
  confidence: number;
  evidenceIds: string[];
  status: "unverified" | "supported" | "rejected";
}

export interface TaskFrame {
  id: string;
  rawTask: string;

  mode: TaskMode;
  capabilities: string[];

  observedBehavior: string[];
  expectedBehavior: string[];

  boundedContexts: string[];

  hardInvariants: string[];
  softConstraints: string[];

  acceptanceEvidence: string[];
  nonGoals: string[];
  riskSurfaces: string[];

  hypotheses: TaskHypothesis[];

  /** ISO timestamp. The only intentionally non-deterministic field (injected clock). */
  createdAt: string;
}
