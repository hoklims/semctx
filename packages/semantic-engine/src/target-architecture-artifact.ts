/** Pure, versioned contract for immutable Plane-B target architecture artifacts. */

import { z } from "zod";
import {
  Sha256HashSchema,
  compareCodeUnits,
  serializeControlReport,
  sha256HashUtf8,
  type ArchitectureElement,
  type ArchitectureRelation,
  type Sha256Hash,
} from "@semantic-context/control-model/reconciliation";

const TARGET_ARTIFACT_HASH_DOMAIN = "SEMCTX_TARGET_ARCHITECTURE_ARTIFACT_V1\0";
const TARGET_ARCHITECTURE_PAYLOAD_HASH_DOMAIN = "SEMCTX_TARGET_ARCHITECTURE_PAYLOAD_V1\0";
const SAFE_TARGET_ID = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

export type TargetAuthorshipOriginV1 = "human" | "agent" | "imported";
export type TargetNormativeStatusV1 = "proposed" | "accepted";

export interface TargetArchitectureRevisionRefV1 {
  targetId: string;
  revision: number;
  artifactHash: Sha256Hash;
}

export interface TargetArchitectureArtifactV1 {
  schemaVersion: 1;
  kind: "target_architecture";
  targetId: string;
  revision: number;
  statement: string;
  baseCommit: string;
  sourceGraphSeal: Sha256Hash;
  elements: readonly ArchitectureElement[];
  relations: readonly ArchitectureRelation[];
  preservedInvariantIds: readonly string[];
  authorshipOrigin: TargetAuthorshipOriginV1;
  normativeStatus: TargetNormativeStatusV1;
  reviewAttestationRef?: string;
  supersedesRef?: TargetArchitectureRevisionRefV1;
  artifactHash: Sha256Hash;
}

const QualifiedCoordinateIdSchema = z.union([
  z.string().regex(/^repo:.+$/, "expected repo:<repository-node-id>"),
  z.string().regex(/^semantic:.+$/, "expected semantic:<semantic-node-id>"),
]);

const ArchitectureElementV1Schema = z.object({
  id: QualifiedCoordinateIdSchema,
  level: z.number().int().min(0).max(6),
  category: z.enum([
    "syntax",
    "code_entity",
    "module",
    "bounded_context",
    "capability",
    "invariant",
    "policy",
    "goal",
    "decision",
    "system",
    "strategy",
  ]),
  fingerprint: z.string().min(1),
}).strict();

const ArchitectureRelationV1Schema = z.object({
  from: QualifiedCoordinateIdSchema,
  to: QualifiedCoordinateIdSchema,
  relation: z.string().min(1),
  fingerprint: z.string().min(1),
}).strict();

const TargetArchitectureRevisionRefV1Schema = z.object({
  targetId: z.string().regex(SAFE_TARGET_ID, "unsafe target id"),
  revision: z.number().int().positive(),
  artifactHash: Sha256HashSchema,
}).strict();

export const TargetArchitectureArtifactV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("target_architecture"),
  targetId: z.string().regex(SAFE_TARGET_ID, "unsafe target id"),
  revision: z.number().int().positive(),
  statement: z.string().min(1),
  baseCommit: z.string().min(1),
  sourceGraphSeal: Sha256HashSchema,
  elements: z.array(ArchitectureElementV1Schema),
  relations: z.array(ArchitectureRelationV1Schema),
  preservedInvariantIds: z.array(z.string().min(1)),
  authorshipOrigin: z.enum(["human", "agent", "imported"]),
  normativeStatus: z.enum(["proposed", "accepted"]),
  reviewAttestationRef: z.string().min(1).optional(),
  supersedesRef: TargetArchitectureRevisionRefV1Schema.optional(),
  artifactHash: Sha256HashSchema,
}).strict().superRefine((value, context) => {
  validateSortedUnique(value.elements, (item) => item.id, context, ["elements"]);
  validateSortedUnique(value.relations, targetArchitectureRelationSortKey, context, ["relations"]);
  const relationIdentities = value.relations.map(targetArchitectureRelationIdentityKey);
  if (new Set(relationIdentities).size !== relationIdentities.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["relations"],
      message: "duplicate architecture relation identity",
    });
  }
  validateSortedUnique(value.preservedInvariantIds, String, context, ["preservedInvariantIds"]);
  const elementIds = new Set(value.elements.map((element) => element.id));
  value.relations.forEach((relation, index) => {
    if (!elementIds.has(relation.from)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["relations", index, "from"],
        message: "relation source is absent from elements",
      });
    }
    if (!elementIds.has(relation.to)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["relations", index, "to"],
        message: "relation target is absent from elements",
      });
    }
  });
  if (value.normativeStatus === "proposed") {
    if (value.reviewAttestationRef !== undefined || value.supersedesRef !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "proposed targets cannot carry review or supersession references",
      });
    }
  } else if (value.reviewAttestationRef === undefined || value.supersedesRef === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "accepted targets require review and supersession references",
    });
  } else {
    if (value.supersedesRef.targetId !== value.targetId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["supersedesRef", "targetId"],
        message: "superseded target id must match",
      });
    }
    if (value.revision !== value.supersedesRef.revision + 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["revision"],
        message: "accepted review must create the next revision",
      });
    }
  }
  if (computeTargetArtifactHash(value as TargetArchitectureArtifactV1) !== value.artifactHash) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["artifactHash"],
      message: "target artifact hash mismatch",
    });
  }
});

export function computeTargetArtifactHash(
  artifact: Omit<TargetArchitectureArtifactV1, "artifactHash"> | TargetArchitectureArtifactV1,
): Sha256Hash {
  const { artifactHash: _artifactHash, ...payload } = artifact as TargetArchitectureArtifactV1;
  return hashTargetDomain(TARGET_ARTIFACT_HASH_DOMAIN, payload);
}

export function computeTargetArchitecturePayloadHash(
  artifact: TargetArchitectureArtifactV1,
): Sha256Hash {
  return hashTargetDomain(TARGET_ARCHITECTURE_PAYLOAD_HASH_DOMAIN, {
    statement: artifact.statement,
    baseCommit: artifact.baseCommit,
    sourceGraphSeal: artifact.sourceGraphSeal,
    elements: artifact.elements,
    relations: artifact.relations,
    preservedInvariantIds: artifact.preservedInvariantIds,
  });
}

export function targetArchitectureRelationSortKey(
  relation: { from: string; to: string; relation: string; fingerprint: string },
): string {
  return `${relation.from}\0${relation.to}\0${relation.relation}\0${relation.fingerprint}`;
}

function targetArchitectureRelationIdentityKey(
  relation: { from: string; to: string; relation: string },
): string {
  return `${relation.from}\0${relation.to}\0${relation.relation}`;
}

function hashTargetDomain(domain: string, payload: unknown): Sha256Hash {
  return sha256HashUtf8(`${domain}${serializeControlReport(payload)}`);
}

function validateSortedUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compareCodeUnits(key(values[index - 1]!), key(values[index]!)) >= 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index],
        message: "values must be sorted and unique",
      });
    }
  }
}
