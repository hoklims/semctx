/**
 * Narrow read-only Plane-B surface for task planning and diff reconciliation.
 * It intentionally excludes the aggregate semantic schema and every writer.
 */
import { z } from "zod";

const AuthoredSemanticLevelSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
]);

export const ReconciliationRepositoryLinkSchema = z.object({
  kind: z.enum([
    "symbol",
    "file",
    "claim",
    "invariant",
    "contract",
    "capability",
    "test",
    "migration",
    "evidence",
  ]),
  ref: z.string().min(1),
});

const SourceRefSchema = z.object({
  file: z.string(),
  line: z.number().int().nonnegative(),
});

const ChangeTargetBindingV1Schema = z.object({
  schemaVersion: z.literal(1),
  targetId: z.string().regex(
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/,
    "expected a safe target id",
  ),
  revision: z.number().int().positive().safe(),
  artifactHash: z.string().regex(
    /^sha256:[0-9a-f]{64}$/,
    "expected sha256:<64 lowercase hex>",
  ),
}).strict();

export const ReconciliationChangeContractSchema = z.object({
  id: z.string().min(1),
  statement: z.string(),
  lifecycle: z.enum([
    "draft",
    "active",
    "verified",
    "partial",
    "blocked",
    "stale",
    "superseded",
  ]),
  provenance: z.enum(["author", "agent", "derived"]),
  sourceRefs: z.array(SourceRefSchema),
  serves: z.array(z.string()),
  preserves: z.array(z.string()),
  requiresEvidence: z.array(z.string()),
  openUnknowns: z.array(z.string()),
  repositoryLinks: z.array(ReconciliationRepositoryLinkSchema),
  tags: z.array(z.string()),
  metadata: z.record(z.string()).optional(),
  appliesAtLevel: AuthoredSemanticLevelSchema.optional(),
  targetBinding: ChangeTargetBindingV1Schema.optional(),
}).strict();

export {
  buildRepositoryLinkIndex,
  resolveRepositoryLink,
  resolveRepositoryLinks,
} from "./repository-links";
export {
  emptyModel,
  mergeModels,
} from "./model";
export {
  DEFAULT_STATUS_BY_KIND,
  isChangeLifecycle,
  isSemanticNodeKind,
  isSemanticProvenance,
  isSemanticStatus,
} from "./constants";
export {
  kindOfSemanticId,
  repositoryLinkFromRef,
} from "./ids";
export { normalizeLegacySemanticModelV1 } from "./compatibility";
export type { RepositoryFacts } from "./repository-links";
export type {
  ChangeContract,
  ChangeTargetBindingV1,
  RepositoryLink,
  SemanticCompatibilityNoteV1,
  SemanticModel,
  SemanticNode,
  SemanticNodeKind,
  SemanticProvenance,
  SemanticRelation,
  SemanticRelationKind,
  SemanticStatus,
} from "./types";
