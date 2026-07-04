/** Verifiable claims and the task-relative authority policies that rank them. */

export type ClaimKind =
  | "contract"
  | "invariant"
  | "decision"
  | "capability"
  | "behavior"
  | "risk"
  | "ownership"
  | "deprecation"
  | "assumption";

export type VerificationStatus =
  | "unverified"
  | "inferred"
  | "documented"
  | "tested"
  | "statically_verified"
  | "runtime_verified"
  | "contradicted"
  | "deprecated";

export interface Claim {
  id: string;
  kind: ClaimKind;
  statement: string;

  subjectNodeIds: string[];
  evidenceIds: string[];

  /** All three in [0,1]. Numeric signals only: never sufficient on their own. */
  authority: number;
  freshness: number;
  confidence: number;

  verificationStatus: VerificationStatus;

  validFrom?: string;
  validUntil?: string;

  tags: string[];
}

export type QuestionKind =
  | "public_api"
  | "persistence"
  | "business_rule"
  | "runtime_behavior"
  | "historical_reason"
  | "style"
  | "security";

/** Declarative rule: which claim kinds/statuses are authoritative for a question. */
export interface AuthorityPolicy {
  questionKind: QuestionKind;
  preferredClaimKinds: ClaimKind[];
  requiredVerificationStatuses?: VerificationStatus[];
  disallowedStatuses?: VerificationStatus[];
}
