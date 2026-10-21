import type { z } from "zod";
import type { ClaimKindSchema, VerificationStatusSchema, QuestionKindSchema } from "../repository-schemas";

/** Verifiable claims and the task-relative authority policies that rank them. */

export type ClaimKind = z.infer<typeof ClaimKindSchema>;

export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

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

export type QuestionKind = z.infer<typeof QuestionKindSchema>;

/** Declarative rule: which claim kinds/statuses are authoritative for a question. */
export interface AuthorityPolicy {
  questionKind: QuestionKind;
  preferredClaimKinds: ClaimKind[];
  requiredVerificationStatuses?: VerificationStatus[];
  disallowedStatuses?: VerificationStatus[];
}
