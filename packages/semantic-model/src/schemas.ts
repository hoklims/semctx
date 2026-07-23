/** Zod schemas for the semantic model. Boundary use only: MCP/IPC payloads and defensive checks. */

import { z } from "zod";
import {
  RefinementRelationV1Schema,
  SemanticLevelSchema,
} from "@semantic-context/control-model";

export const SemanticNodeKindSchema = z.enum([
  "goal",
  "invariant",
  "decision",
  "assumption",
  "unknown",
  "change",
  "evidence",
]);

export const SemanticStatusSchema = z.enum([
  "declared",
  "proposed",
  "assumed",
  "tested",
  "statically_verified",
  "runtime_verified",
  "contradicted",
  "stale",
]);

export const SemanticProvenanceSchema = z.enum(["author", "agent", "derived"]);

export const SemanticRelationKindSchema = z.enum([
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
]);

export const ChangeLifecycleSchema = z.enum([
  "draft",
  "active",
  "verified",
  "partial",
  "blocked",
  "stale",
  "superseded",
]);

export const RepositoryLinkKindSchema = z.enum([
  "symbol",
  "file",
  "claim",
  "invariant",
  "contract",
  "capability",
  "test",
  "migration",
  "evidence",
]);

export const RepositoryLinkSchema = z.object({
  kind: RepositoryLinkKindSchema,
  ref: z.string().min(1),
});

export const SourceRefSchema = z.object({
  file: z.string(),
  line: z.number().int().nonnegative(),
});

export const SemanticRelationSchema = z.object({
  kind: SemanticRelationKindSchema,
  to: z.string().min(1),
});

export const SemanticNodeSchema = z.object({
  id: z.string().min(1),
  kind: SemanticNodeKindSchema,
  statement: z.string(),
  status: SemanticStatusSchema,
  provenance: SemanticProvenanceSchema,
  sourceRefs: z.array(SourceRefSchema),
  repositoryLinks: z.array(RepositoryLinkSchema),
  relations: z.array(SemanticRelationSchema),
  tags: z.array(z.string()),
  metadata: z.record(z.string()).optional(),
  appliesAtLevel: SemanticLevelSchema.refine((level) => level > 0, "authored semantic nodes cannot occupy observed L0").optional(),
});

export const ChangeContractSchema = z.object({
  id: z.string().min(1),
  statement: z.string(),
  lifecycle: ChangeLifecycleSchema,
  provenance: SemanticProvenanceSchema,
  sourceRefs: z.array(SourceRefSchema),
  serves: z.array(z.string()),
  preserves: z.array(z.string()),
  requiresEvidence: z.array(z.string()),
  openUnknowns: z.array(z.string()),
  repositoryLinks: z.array(RepositoryLinkSchema),
  tags: z.array(z.string()),
  metadata: z.record(z.string()).optional(),
  appliesAtLevel: SemanticLevelSchema.refine((level) => level > 0, "authored change contracts cannot occupy observed L0").optional(),
});

export const SemanticModelSchema = z.object({
  nodes: z.array(SemanticNodeSchema),
  changes: z.array(ChangeContractSchema),
  refinementRelations: z.array(RefinementRelationV1Schema).optional(),
});

export type SemanticNodeParsed = z.infer<typeof SemanticNodeSchema>;
export type ChangeContractParsed = z.infer<typeof ChangeContractSchema>;
export type SemanticModelParsed = z.infer<typeof SemanticModelSchema>;
