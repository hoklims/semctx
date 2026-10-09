import { z } from "zod";
import type {
  AuthoredSemanticLevel,
  CoordinateCategory,
  CoordinateEdge,
  CoordinatePlane,
  DanglingSemanticReference,
  EpistemicStatus,
  QualifiedCoordinateId,
  RepositoryCoordinateId,
  SemanticCoordinateId,
  Sha256Hash,
  SourceKindLevelMapping,
  UnsupportedCoordinateSource,
  UnmappedCoordinateSource,
} from "./types";

export const Sha256HashSchema = z.string()
  .regex(/^sha256:[0-9a-f]{64}$/, "expected sha256:<64 lowercase hex>") as z.ZodType<Sha256Hash>;

// These casts brand values only after the complete runtime predicate has accepted their bytes.
export const SemanticLevelSchema = z.number().int().min(0).max(6);
export const AuthoredSemanticLevelSchema = SemanticLevelSchema.refine(
  (level): level is AuthoredSemanticLevel => level > 0,
  "authored semantics cannot occupy observed L0",
);
export const CoordinatePlaneSchema = z.enum(["repo", "semantic"]) satisfies z.ZodType<CoordinatePlane>;
export const RepositoryCoordinateIdSchema = z.string()
  .regex(/^repo:.+$/, "expected repo:<repository-node-id>") as z.ZodType<RepositoryCoordinateId>;
export const SemanticCoordinateIdSchema = z.string()
  .regex(/^semantic:.+$/, "expected semantic:<semantic-node-id>") as z.ZodType<SemanticCoordinateId>;
export const QualifiedCoordinateIdSchema = z.union([
  RepositoryCoordinateIdSchema,
  SemanticCoordinateIdSchema,
]) satisfies z.ZodType<QualifiedCoordinateId>;

export const EpistemicStatusSchema = z.enum([
  "human_declared",
  "statically_observed",
  "dynamically_observed",
  "test_observed",
  "historically_observed",
  "llm_inferred",
  "hypothetical",
]) satisfies z.ZodType<EpistemicStatus>;

export const CoordinateCategorySchema = z.enum([
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
]) satisfies z.ZodType<CoordinateCategory>;

export const SourceKindLevelMappingSchema = z.object({
  plane: CoordinatePlaneSchema,
  sourceKind: z.string().min(1),
  level: SemanticLevelSchema.nullable(),
  category: CoordinateCategorySchema.nullable(),
  supported: z.boolean(),
  reason: z.string().min(1).optional(),
}).strict().superRefine((value, context) => {
  if (value.supported && (value.level === null || value.category === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "supported mappings require level and category" });
  }
  if (!value.supported && (value.level !== null || value.category !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "unsupported mappings cannot assign an implicit level" });
  }
}) as z.ZodType<SourceKindLevelMapping>;

export const CoordinateEdgeSchema = z.object({
  from: QualifiedCoordinateIdSchema,
  to: QualifiedCoordinateIdSchema,
  relation: z.string().min(1),
  sourceRelation: z.string().min(1).optional(),
  evidenceRefs: z.array(z.string()),
}).strict() satisfies z.ZodType<CoordinateEdge>;

export const UnsupportedCoordinateSourceSchema = z.object({
  plane: CoordinatePlaneSchema,
  sourceId: z.string().min(1),
  sourceKind: z.string().min(1),
  reason: z.string().min(1),
}).strict() satisfies z.ZodType<UnsupportedCoordinateSource>;

export const UnmappedCoordinateSourceSchema = UnsupportedCoordinateSourceSchema satisfies
  z.ZodType<UnmappedCoordinateSource>;

export const DanglingSemanticReferenceSchema = z.object({
  ownerId: z.string().min(1),
  field: z.string().min(1),
  ref: z.string().min(1),
}).strict() satisfies z.ZodType<DanglingSemanticReference>;
