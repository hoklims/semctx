/** The compiled output: a minimal, justified, verifiable context pack for an agent. */
import type { TaskFrame } from "./task-frame";
import type { Claim, QuestionKind } from "./claim";
import type { RepositoryNode, GraphPath, EvidenceRecord } from "./graph";

export type ReadPriority = "critical" | "high" | "medium";

export interface RecommendedRead {
  path: string;
  reason: string;
  priority: ReadPriority;
  evidenceIds: string[];
}

export type VerdictLevel = "PASS" | "WARN" | "BLOCK";

export type VerificationStepKind = "run_test" | "static_check" | "manual_review" | "reproduce";

export interface VerificationStep {
  description: string;
  kind: VerificationStepKind;
  command?: string;
  targetNodeIds: string[];
  evidenceIds: string[];
}

export interface VerificationPlan {
  steps: VerificationStep[];
  /** Test node ids or file paths that should pass to accept the change. */
  requiredTests: string[];
  notes: string[];
}

export interface PriorityGate {
  name: string;
  passed: boolean;
  reason: string;
}

/** Full, inspectable rationale for why an element was selected or eliminated. */
export interface PriorityExplanation {
  targetId: string;
  targetKind: "node" | "claim";
  score: number;
  eligible: boolean;

  roleMatch: number;
  authority: number;
  graphReachability: number;
  verificationStrength: number;
  freshness: number;
  contradictionPenalty: number;

  gates: PriorityGate[];
  explanation: string[];
}

export interface ContextPackMeta {
  taskId: string;
  questionKind: QuestionKind;
  /** True when the pack is a pure function of repo state (no LLM, no external I/O). */
  deterministic: boolean;
  generator: string;
  candidateProviders: string[];
  warnings: string[];
}

export interface ContextPack {
  taskFrame: TaskFrame;

  hardConstraints: Claim[];
  authoritativeClaims: Claim[];

  primaryNodes: RepositoryNode[];
  secondaryNodes: RepositoryNode[];

  impactPaths: GraphPath[];
  relevantTests: RepositoryNode[];

  contradictions: Claim[];
  unknowns: string[];

  recommendedReads: RecommendedRead[];

  verificationPlan: VerificationPlan;

  generatedAt: string;

  /** Every evidence record referenced anywhere in the pack, resolved by id. */
  evidence: EvidenceRecord[];
  /** Ranking rationale for each selected/eliminated node and claim. */
  priorityExplanations: PriorityExplanation[];
  meta: ContextPackMeta;
}
