import { z } from "zod";
import { compareCodeUnits } from "./ordering";
import { Sha256HashSchema } from "./primitive-schemas";
import type {
  ObservationAnalysisV1,
  PlanningBundleV1,
  ReconcileDiffReportV1,
  ReconciliationAnalysisV1,
  SemanticChangeSetV1,
  TaskEnvelopeV1,
  TaskFrameSnapshotV1,
} from "./task-envelope-types";
import {
  RECONCILIATION_ADVISORY_CODES,
  RECONCILIATION_INSUFFICIENCY_REASONS,
  RECONCILIATION_REFUSAL_REASONS,
  RECONCILIATION_VIOLATION_REASONS,
} from "./task-envelope-types";
import {
  RECONCILIATION_REASON_ORDER,
  computeObservationAnalysisV1Hash,
  computePlanningBundleV1Hash,
  computeReconcileDiffReportV1Hash,
  computeReconciliationAnalysisV1Hash,
  computeReconciliationArchitectureDeltaV1Hash,
  computeReconciliationObservedDiffV1Hash,
  computeSemanticChangeSetV1Hash,
  computeTaskEnvelopeV1Hash,
  computeTaskFrameSnapshotV1Hash,
  normalizeCanonicalRepoRelativePath,
  normalizeReconciliationAnalysisV1,
} from "./task-envelope-canonical";
import { createObservedDiffHunkV1, sha256HashCanonicalJson } from "./hashing";

const NonEmptyIdSchema = z.string().min(1);
const TimestampSchema = z.string().datetime({ offset: true });
const RepositoryCoordinateIdV1Schema = z.string().regex(/^repo:.+$/);
const SemanticLevelV1Schema = z.union([
  z.literal(0), z.literal(1), z.literal(2), z.literal(3),
  z.literal(4), z.literal(5), z.literal(6),
]);
const AuthoredSemanticLevelV1Schema = z.union([
  z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6),
]);
export const ReconciliationAdvisoryCodeV1Schema = z.enum(
  RECONCILIATION_ADVISORY_CODES,
);

export const CanonicalRepoRelativePathSchema = z.string().min(1).superRefine((value, context) => {
  try {
    if (normalizeCanonicalRepoRelativePath(value) !== value) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "stored repository path must already be canonical",
      });
    }
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "invalid repository-relative path",
    });
  }
});

export const TaskModeV1Schema = z.enum([
  "bugfix", "feature", "refactor", "audit", "performance", "security", "migration",
]);
export const RefinementProfileV1Schema = z.enum([
  "local_patch", "refactor", "feature", "redesign", "migration",
]);
export const TaskRiskV1Schema = z.enum(["R0", "R1", "R2", "R3"]);

export const TaskFrameSnapshotV1Schema = z.object({
  schemaVersion: z.literal(1),
  taskFrameId: NonEmptyIdSchema,
  rawTaskDigest: Sha256HashSchema,
  mode: TaskModeV1Schema,
  createdAt: TimestampSchema,
  capabilitySignals: z.array(NonEmptyIdSchema),
  riskSignals: z.array(NonEmptyIdSchema),
  descriptiveNonGoals: z.array(NonEmptyIdSchema).optional(),
  profileCandidate: RefinementProfileV1Schema.optional(),
  altitudeCandidate: SemanticLevelV1Schema.optional(),
}).strict().superRefine((value, context) => {
  requireCanonicalStrings(value.capabilitySignals, context, ["capabilitySignals"]);
  requireCanonicalStrings(value.riskSignals, context, ["riskSignals"]);
  if (value.descriptiveNonGoals !== undefined) {
    requireCanonicalStrings(value.descriptiveNonGoals, context, ["descriptiveNonGoals"]);
  }
});

export const CandidateAnchorV1Schema = z.object({
  schemaVersion: z.literal(1),
  anchorId: NonEmptyIdSchema,
  kind: z.enum(["path", "symbol", "coordinate", "semantic_term"]),
  value: NonEmptyIdSchema,
  provenance: z.enum(["task_text", "authored_link", "caller"]),
}).strict();

const ExactResolvedBindingScopeV1Schema = z.object({
  kind: z.literal("exact_coordinate"),
  coordinateId: RepositoryCoordinateIdV1Schema,
}).strict();
const FileResolvedBindingScopeV1Schema = z.object({
  kind: z.literal("file"),
  path: CanonicalRepoRelativePathSchema,
}).strict();
const CoordinateSetResolvedBindingScopeV1Schema = z.object({
  kind: z.literal("coordinate_set"),
  coordinateIds: z.array(RepositoryCoordinateIdV1Schema).min(1),
}).strict();
export const ResolvedBindingScopeV1Schema = z.discriminatedUnion("kind", [
  ExactResolvedBindingScopeV1Schema,
  FileResolvedBindingScopeV1Schema,
  CoordinateSetResolvedBindingScopeV1Schema,
]).superRefine((value, context) => {
  if (value.kind === "coordinate_set") {
    requireCanonicalStrings(value.coordinateIds, context, ["coordinateIds"]);
  }
});

export const ResolvedBindingV1Schema = z.object({
  schemaVersion: z.literal(1),
  bindingId: NonEmptyIdSchema,
  coordinateId: RepositoryCoordinateIdV1Schema,
  repositoryPath: CanonicalRepoRelativePathSchema,
  provenance: z.enum(["authored_link", "explicit_discovery"]),
  evidenceId: NonEmptyIdSchema,
  planningCommit: NonEmptyIdSchema,
  graphSeal: Sha256HashSchema,
  scope: ResolvedBindingScopeV1Schema,
}).strict().superRefine((value, context) => {
  if (
    value.scope.kind === "exact_coordinate"
    && value.scope.coordinateId !== value.coordinateId
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scope", "coordinateId"],
      message: "exact scope must name the resolved coordinate",
    });
  }
  if (
    value.scope.kind === "coordinate_set"
    && !value.scope.coordinateIds.includes(value.coordinateId)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scope", "coordinateIds"],
      message: "coordinate set must include the resolved coordinate",
    });
  }
  if (value.scope.kind === "file" && value.repositoryPath !== value.scope.path) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["repositoryPath"],
      message: "file binding repositoryPath must equal its exact file scope",
    });
  }
});

const ExactDeclaredScopeV1Schema = z.object({
  kind: z.literal("exact_coordinate"),
  bindingId: NonEmptyIdSchema,
  coordinateId: RepositoryCoordinateIdV1Schema,
}).strict();
const FileDeclaredScopeV1Schema = z.object({
  kind: z.literal("file"),
  bindingId: NonEmptyIdSchema,
  path: CanonicalRepoRelativePathSchema,
}).strict();
const CoordinateSetDeclaredScopeV1Schema = z.object({
  kind: z.literal("coordinate_set"),
  bindingIds: z.array(NonEmptyIdSchema).min(1),
  coordinateIds: z.array(RepositoryCoordinateIdV1Schema),
  filePaths: z.array(CanonicalRepoRelativePathSchema).optional(),
}).strict();
export const DeclaredReconciliationScopeV1Schema = z.discriminatedUnion("kind", [
  ExactDeclaredScopeV1Schema,
  FileDeclaredScopeV1Schema,
  CoordinateSetDeclaredScopeV1Schema,
]).superRefine((value, context) => {
  if (value.kind === "coordinate_set") {
    requireCanonicalStrings(value.bindingIds, context, ["bindingIds"]);
    requireCanonicalStrings(value.coordinateIds, context, ["coordinateIds"]);
    if (value.filePaths !== undefined) {
      requireCanonicalStrings(value.filePaths, context, ["filePaths"]);
    }
    if (value.coordinateIds.length === 0 && (value.filePaths?.length ?? 0) === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "combined scope requires at least one exact coordinate or file path",
      });
    }
  }
});

export const TargetReferenceV1Schema = z.object({
  schemaVersion: z.literal(1),
  targetId: z.string().regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),
  revision: z.number().int().positive().safe(),
  artifactHash: Sha256HashSchema,
}).strict();

const TaskEnvelopeV1Shape = {
  schemaVersion: z.literal(1),
  kind: z.literal("task_envelope"),
  executionAuthority: z.literal("none"),
  envelopeId: NonEmptyIdSchema,
  envelopeHash: Sha256HashSchema,
  planningCommit: NonEmptyIdSchema,
  taskFrameSnapshot: TaskFrameSnapshotV1Schema,
  taskFrameHash: Sha256HashSchema,
  changeId: NonEmptyIdSchema,
  changeContractHash: Sha256HashSchema,
  coordinateGraphSeal: Sha256HashSchema,
  indexSeal: Sha256HashSchema,
  baselineFreshnessSeal: Sha256HashSchema,
  profile: RefinementProfileV1Schema,
  risk: TaskRiskV1Schema,
  requiredAltitude: SemanticLevelV1Schema,
  candidateAnchors: z.array(CandidateAnchorV1Schema),
  resolvedBindings: z.array(ResolvedBindingV1Schema).min(1),
  parentIntentIds: z.array(NonEmptyIdSchema),
  preservedInvariantIds: z.array(NonEmptyIdSchema),
  nonGoals: z.array(NonEmptyIdSchema),
  expectedBehaviorDelta: z.array(NonEmptyIdSchema),
  declaredReconciliationScope: DeclaredReconciliationScopeV1Schema,
  proofObligationIds: z.array(NonEmptyIdSchema),
  authoredTargetBinding: TargetReferenceV1Schema.optional(),
  advisoryTargetRef: TargetReferenceV1Schema.optional(),
  compatibilityNotes: z.array(NonEmptyIdSchema),
};

export const TaskEnvelopeV1Schema = z.object(TaskEnvelopeV1Shape).strict()
  .superRefine((value, context) => {
    requireCanonicalById(value.candidateAnchors, "anchorId", context, ["candidateAnchors"]);
    requireCanonicalById(value.resolvedBindings, "bindingId", context, ["resolvedBindings"]);
    for (const [field, values] of [
      ["parentIntentIds", value.parentIntentIds],
      ["preservedInvariantIds", value.preservedInvariantIds],
      ["nonGoals", value.nonGoals],
      ["expectedBehaviorDelta", value.expectedBehaviorDelta],
      ["proofObligationIds", value.proofObligationIds],
      ["compatibilityNotes", value.compatibilityNotes],
    ] as const) requireCanonicalStrings(values, context, [field]);
    if (
      value.taskFrameSnapshot.descriptiveNonGoals !== undefined
      && JSON.stringify(value.nonGoals)
        !== JSON.stringify(value.taskFrameSnapshot.descriptiveNonGoals)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nonGoals"],
        message: "envelope non-goals must preserve the descriptive TaskFrame snapshot",
      });
    }
    if (value.taskFrameHash !== computeTaskFrameSnapshotV1Hash(
      value.taskFrameSnapshot as TaskFrameSnapshotV1,
    )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["taskFrameHash"],
        message: "taskFrameHash does not match the canonical snapshot",
      });
    }
    value.resolvedBindings.forEach((binding, index) => {
      if (binding.planningCommit !== value.planningCommit) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["resolvedBindings", index, "planningCommit"],
          message: "binding planning commit must match envelope",
        });
      }
      if (binding.graphSeal !== value.coordinateGraphSeal) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["resolvedBindings", index, "graphSeal"],
          message: "binding graph seal must match envelope",
        });
      }
    });
    validateDeclaredScopeBindings(
      value.declaredReconciliationScope,
      value.resolvedBindings,
      context,
      ["declaredReconciliationScope"],
    );
    if (value.envelopeHash !== computeTaskEnvelopeV1Hash(value as TaskEnvelopeV1)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["envelopeHash"],
        message: "envelopeHash does not match canonical content",
      });
    }
  });

export const SemanticExpectationV1Schema = z.object({
  schemaVersion: z.literal(1),
  expectationId: NonEmptyIdSchema,
  kind: z.enum(["behavior", "capability", "contract", "invariant", "goal", "target_element"]),
  level: AuthoredSemanticLevelV1Schema,
  required: z.boolean(),
  subjectId: NonEmptyIdSchema,
  statement: NonEmptyIdSchema,
  acceptanceEvidenceIds: z.array(NonEmptyIdSchema),
}).strict().superRefine((value, context) => {
  requireCanonicalStrings(value.acceptanceEvidenceIds, context, ["acceptanceEvidenceIds"]);
});

const RepositoryEditExpectationBaseV1Shape = {
  schemaVersion: z.literal(1),
  editId: NonEmptyIdSchema,
  required: z.boolean(),
  expectedLiftedExpectationIds: z.array(NonEmptyIdSchema),
  acceptanceEvidenceIds: z.array(NonEmptyIdSchema),
};
const RepositoryEditAddV1Schema = z.object({
  ...RepositoryEditExpectationBaseV1Shape,
  kind: z.literal("add"),
  newPath: CanonicalRepoRelativePathSchema,
}).strict();
const OldRangeV1Schema = z.object({
  start: z.number().int().nonnegative(),
  lines: z.number().int().nonnegative(),
}).strict();
const RepositoryEditModifyV1Schema = z.object({
  ...RepositoryEditExpectationBaseV1Shape,
  kind: z.literal("modify"),
  path: CanonicalRepoRelativePathSchema,
  coordinateIds: z.array(RepositoryCoordinateIdV1Schema).min(1),
  oldRange: OldRangeV1Schema.optional(),
}).strict();
const RepositoryEditDeleteV1Schema = z.object({
  ...RepositoryEditExpectationBaseV1Shape,
  kind: z.literal("delete"),
  oldPath: CanonicalRepoRelativePathSchema,
  coordinateIds: z.array(RepositoryCoordinateIdV1Schema).min(1),
}).strict();
const RepositoryEditRenameV1Schema = z.object({
  ...RepositoryEditExpectationBaseV1Shape,
  kind: z.literal("rename"),
  oldPath: CanonicalRepoRelativePathSchema,
  newPath: CanonicalRepoRelativePathSchema,
  coordinateIds: z.array(RepositoryCoordinateIdV1Schema).min(1),
}).strict();

export const RepositoryEditExpectationV1Schema = z.discriminatedUnion("kind", [
  RepositoryEditAddV1Schema,
  RepositoryEditModifyV1Schema,
  RepositoryEditDeleteV1Schema,
  RepositoryEditRenameV1Schema,
]).superRefine((value, context) => {
  requireCanonicalStrings(
    value.expectedLiftedExpectationIds,
    context,
    ["expectedLiftedExpectationIds"],
  );
  requireCanonicalStrings(value.acceptanceEvidenceIds, context, ["acceptanceEvidenceIds"]);
  if ("coordinateIds" in value) {
    requireCanonicalStrings(value.coordinateIds, context, ["coordinateIds"]);
  }
  if (value.kind === "rename" && value.oldPath === value.newPath) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["newPath"],
      message: "rename paths must be distinct",
    });
  }
});

export const SemanticRefinementStepV1Schema = z.object({
  schemaVersion: z.literal(1),
  stepId: NonEmptyIdSchema,
  order: z.number().int().nonnegative(),
  fromExpectationIds: z.array(NonEmptyIdSchema),
  toExpectationIds: z.array(NonEmptyIdSchema),
  repositoryEditIds: z.array(NonEmptyIdSchema),
}).strict().superRefine((value, context) => {
  requireCanonicalStrings(value.fromExpectationIds, context, ["fromExpectationIds"]);
  requireCanonicalStrings(value.toExpectationIds, context, ["toExpectationIds"]);
  requireCanonicalStrings(value.repositoryEditIds, context, ["repositoryEditIds"]);
});

const SemanticChangeSetV1Shape = {
  schemaVersion: z.literal(1),
  kind: z.literal("semantic_change_set"),
  executionAuthority: z.literal("none"),
  changeSetId: NonEmptyIdSchema,
  changeSetHash: Sha256HashSchema,
  envelopeId: NonEmptyIdSchema,
  envelopeHash: Sha256HashSchema,
  planningCommit: NonEmptyIdSchema,
  profile: RefinementProfileV1Schema,
  targetBinding: TargetReferenceV1Schema.optional(),
  declaredReconciliationScope: DeclaredReconciliationScopeV1Schema,
  refinementSteps: z.array(SemanticRefinementStepV1Schema),
  semanticExpectations: z.array(SemanticExpectationV1Schema),
  repositoryEditExpectations: z.array(RepositoryEditExpectationV1Schema),
  rollbackDescription: NonEmptyIdSchema,
  testReferences: z.array(NonEmptyIdSchema),
  acceptanceEvidenceIds: z.array(NonEmptyIdSchema),
  proofObligationIds: z.array(NonEmptyIdSchema),
};

export const SemanticChangeSetV1Schema = z.object(SemanticChangeSetV1Shape).strict()
  .superRefine((value, context) => {
    requireCanonicalById(value.semanticExpectations, "expectationId", context, ["semanticExpectations"]);
    requireCanonicalById(value.repositoryEditExpectations, "editId", context, ["repositoryEditExpectations"]);
    requireCanonicalByOrder(value.refinementSteps, context, ["refinementSteps"]);
    for (const [field, values] of [
      ["testReferences", value.testReferences],
      ["acceptanceEvidenceIds", value.acceptanceEvidenceIds],
      ["proofObligationIds", value.proofObligationIds],
    ] as const) requireCanonicalStrings(values, context, [field]);
    const expectationIds = new Set(value.semanticExpectations.map((item) => item.expectationId));
    const editIds = new Set(value.repositoryEditExpectations.map((item) => item.editId));
    value.repositoryEditExpectations.forEach((edit, index) => {
      for (const expectationId of edit.expectedLiftedExpectationIds) {
        if (!expectationIds.has(expectationId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["repositoryEditExpectations", index, "expectedLiftedExpectationIds"],
            message: `unknown semantic expectation ${expectationId}`,
          });
        }
      }
      validateEditScopeCoverage(
        edit,
        value.declaredReconciliationScope,
        context,
        ["repositoryEditExpectations", index],
      );
    });
    value.refinementSteps.forEach((step, index) => {
      for (const expectationId of [...step.fromExpectationIds, ...step.toExpectationIds]) {
        if (!expectationIds.has(expectationId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["refinementSteps", index],
            message: `unknown semantic expectation ${expectationId}`,
          });
        }
      }
      for (const editId of step.repositoryEditIds) {
        if (!editIds.has(editId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["refinementSteps", index],
            message: `unknown repository edit ${editId}`,
          });
        }
      }
    });
    if (value.changeSetHash !== computeSemanticChangeSetV1Hash(
      value as SemanticChangeSetV1,
    )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["changeSetHash"],
        message: "changeSetHash does not match canonical content",
      });
    }
  });

export const WorkspaceBaselineSnapshotV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("workspace_baseline"),
  planningCommit: NonEmptyIdSchema,
  cleanliness: z.enum(["FRESH", "DIRTY_KNOWN"]),
  freshnessSealHash: Sha256HashSchema,
  workingDiffHash: Sha256HashSchema,
  semanticModelHash: Sha256HashSchema,
  analyzerConfigHash: Sha256HashSchema,
  toolVersion: NonEmptyIdSchema,
  storeSchemaVersion: z.number().int().positive().safe(),
  attestationSetHash: Sha256HashSchema.nullable(),
}).strict();

const PlanningBundleV1Shape = {
  schemaVersion: z.literal(1),
  kind: z.literal("planning_bundle"),
  executionAuthority: z.literal("none"),
  bundleId: NonEmptyIdSchema,
  bundleHash: Sha256HashSchema,
  planningCommit: NonEmptyIdSchema,
  taskEnvelope: TaskEnvelopeV1Schema,
  semanticChangeSet: SemanticChangeSetV1Schema,
  baseline: WorkspaceBaselineSnapshotV1Schema,
  acceptedTargetBinding: TargetReferenceV1Schema.optional(),
};

export const PlanningBundleV1Schema = z.object(PlanningBundleV1Shape).strict()
  .superRefine((value, context) => {
    if (
      value.taskEnvelope.planningCommit !== value.planningCommit
      || value.semanticChangeSet.planningCommit !== value.planningCommit
      || value.baseline.planningCommit !== value.planningCommit
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["planningCommit"],
        message: "all planning artifacts must bind the same commit",
      });
    }
    if (
      value.semanticChangeSet.envelopeId !== value.taskEnvelope.envelopeId
      || value.semanticChangeSet.envelopeHash !== value.taskEnvelope.envelopeHash
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["semanticChangeSet", "envelopeHash"],
        message: "change set must bind the enclosed envelope",
      });
    }
    if (value.semanticChangeSet.profile !== value.taskEnvelope.profile) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["semanticChangeSet", "profile"],
        message: "change set profile must equal envelope profile",
      });
    }
    if (
      JSON.stringify(value.semanticChangeSet.declaredReconciliationScope)
      !== JSON.stringify(value.taskEnvelope.declaredReconciliationScope)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["semanticChangeSet", "declaredReconciliationScope"],
        message: "change set scope must equal envelope scope",
      });
    }
    if (value.baseline.freshnessSealHash !== value.taskEnvelope.baselineFreshnessSeal) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseline", "freshnessSealHash"],
        message: "baseline freshness seal must equal envelope baseline seal",
      });
    }
    const authoredTarget = value.taskEnvelope.authoredTargetBinding;
    const changeSetTarget = value.semanticChangeSet.targetBinding;
    const acceptedTarget = value.acceptedTargetBinding;
    if (
      acceptedTarget !== undefined
      && value.baseline.attestationSetHash === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseline", "attestationSetHash"],
        message: "an accepted target requires a sealed planning attestation set",
      });
    }
    if (changeSetTarget !== undefined && acceptedTarget === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["semanticChangeSet", "targetBinding"],
        message: "a certifying change-set target requires an accepted target binding",
      });
    }
    if (
      acceptedTarget !== undefined
      && (
        authoredTarget === undefined
        || changeSetTarget === undefined
        || JSON.stringify(acceptedTarget) !== JSON.stringify(authoredTarget)
        || JSON.stringify(acceptedTarget) !== JSON.stringify(changeSetTarget)
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["acceptedTargetBinding"],
        message: "accepted target must exactly equal authored and change-set target identities",
      });
    }
    validateBundleEditBindings(value, context);
    if (value.bundleHash !== computePlanningBundleV1Hash(value as PlanningBundleV1)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bundleHash"],
        message: "bundleHash does not match canonical content",
      });
    }
  });

const ObservationAddV1Schema = z.object({
  kind: z.literal("add"),
  newPath: CanonicalRepoRelativePathSchema,
  newSourceDigest: Sha256HashSchema,
}).strict();
const ObservationModifyV1Schema = z.object({
  kind: z.literal("modify"),
  path: CanonicalRepoRelativePathSchema,
  oldSourceDigest: Sha256HashSchema,
  newSourceDigest: Sha256HashSchema,
}).strict();
const ObservationDeleteV1Schema = z.object({
  kind: z.literal("delete"),
  oldPath: CanonicalRepoRelativePathSchema,
  oldSourceDigest: Sha256HashSchema,
}).strict();
const ObservationRenameV1Schema = z.object({
  kind: z.literal("rename"),
  oldPath: CanonicalRepoRelativePathSchema,
  newPath: CanonicalRepoRelativePathSchema,
  oldSourceDigest: Sha256HashSchema,
  newSourceDigest: Sha256HashSchema,
}).strict();
export const ObservationChangeV1Schema = z.discriminatedUnion("kind", [
  ObservationAddV1Schema,
  ObservationModifyV1Schema,
  ObservationDeleteV1Schema,
  ObservationRenameV1Schema,
]).superRefine((value, context) => {
  if (value.kind === "rename" && value.oldPath === value.newPath) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["newPath"], message: "rename paths differ" });
  }
});

const ObservationAnalysisV1Shape = {
  schemaVersion: z.literal(1),
  kind: z.literal("observation_analysis"),
  baselineSealHash: Sha256HashSchema,
  candidateDiffHash: Sha256HashSchema,
  analyzerConfigHash: Sha256HashSchema,
  toolVersion: NonEmptyIdSchema,
  changes: z.array(ObservationChangeV1Schema),
  candidateGraphHash: Sha256HashSchema,
  candidateArchitectureHash: Sha256HashSchema,
  completeness: z.enum(["complete", "partial"]),
  incompleteReasons: z.array(NonEmptyIdSchema),
  analysisHash: Sha256HashSchema,
};
export const ObservationAnalysisV1Schema = z.object(ObservationAnalysisV1Shape).strict()
  .superRefine((value, context) => {
    requireCanonicalObservations(value.changes, context, ["changes"]);
    requireCanonicalStrings(value.incompleteReasons, context, ["incompleteReasons"]);
    if ((value.completeness === "complete") !== (value.incompleteReasons.length === 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["incompleteReasons"],
        message: "complete analysis has no incomplete reasons; partial analysis has at least one",
      });
    }
    if (value.analysisHash !== computeObservationAnalysisV1Hash(
      value as ObservationAnalysisV1,
    )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["analysisHash"],
        message: "analysisHash does not match canonical content",
      });
    }
  });

export const EvidenceEvaluationV1Schema = z.object({
  schemaVersion: z.literal(1),
  requirementId: NonEmptyIdSchema,
  origin: z.enum([
    "change_contract",
    "semantic_expectation",
    "repository_edit_expectation",
    "proof_obligation",
  ]),
  required: z.boolean(),
  evidenceId: NonEmptyIdSchema.nullable(),
  semanticEvidenceDigest: Sha256HashSchema.optional(),
  acceptedAttestationDigests: z.array(Sha256HashSchema),
  planningCommit: NonEmptyIdSchema,
  observedDiffHash: Sha256HashSchema,
  semanticModelHash: Sha256HashSchema,
  attestationSetHash: Sha256HashSchema.optional(),
  observationAnalysisHash: Sha256HashSchema.optional(),
  provenance: z.array(z.enum([
    "plane_b_authored", "plane_a_observed", "canonical_attestation",
  ])),
  result: z.enum(["satisfied", "missing", "stale", "unbound", "failing"]),
}).strict().superRefine((value, context) => {
  requireCanonicalStrings(
    value.acceptedAttestationDigests,
    context,
    ["acceptedAttestationDigests"],
  );
  requireCanonicalStrings(value.provenance, context, ["provenance"]);
  const provenance = new Set(value.provenance);
  const hasAttestations = value.acceptedAttestationDigests.length > 0;
  const hasCanonicalAttestation = provenance.has("canonical_attestation");
  if (
    hasAttestations !== hasCanonicalAttestation
    || hasAttestations !== (value.attestationSetHash !== undefined)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["acceptedAttestationDigests"],
      message: "accepted attestations require canonical provenance and a bound attestation set",
    });
  }
  if (value.result === "satisfied") {
    if (
      value.evidenceId === null
      || !provenance.has("plane_b_authored")
      || value.observationAnalysisHash === undefined
      || (value.semanticEvidenceDigest === undefined && !hasAttestations)
      || (
        value.semanticEvidenceDigest !== undefined
        && !provenance.has("plane_a_observed")
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "satisfied evidence requires bound positive content and Plane-B origin",
      });
    }
  } else if (value.result === "missing") {
    if (
      value.evidenceId !== null
      || value.semanticEvidenceDigest !== undefined
      || hasAttestations
      || value.provenance.length > 0
      || value.attestationSetHash !== undefined
      || value.observationAnalysisHash !== undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "missing evidence cannot carry evidence content or positive bindings",
      });
    }
  } else {
    if (value.evidenceId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidenceId"],
        message: `${value.result} evidence requires an evidence id`,
      });
    }
    if (
      value.result === "stale"
      && value.semanticEvidenceDigest === undefined
      && !hasAttestations
      && value.observationAnalysisHash === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "stale evidence must identify the stale content binding",
      });
    }
    if (value.result === "unbound" && (hasAttestations || hasCanonicalAttestation)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "unbound evidence cannot carry an accepted canonical attestation",
      });
    }
    if (value.result === "failing" && !provenance.has("plane_a_observed")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provenance"],
        message: "failing evidence requires an observed negative result",
      });
    }
  }
});

const ObservedDiffRangeV1Schema = z.object({
  start: z.number().int().min(0).max(0xffff_ffff),
  lines: z.number().int().min(0).max(0xffff_ffff),
}).strict();

const ObservedDiffHunkV1Schema = z.object({
  schemaVersion: z.literal(1),
  repositoryIdentity: NonEmptyIdSchema,
  normalizedPath: CanonicalRepoRelativePathSchema,
  oldRange: ObservedDiffRangeV1Schema,
  newRange: ObservedDiffRangeV1Schema,
  oldBlobId: z.string().regex(/^[\x20-\x7e]*$/).nullable(),
  newBlobId: z.string().regex(/^[\x20-\x7e]*$/).nullable(),
  rawHunkBytes: z.instanceof(Uint8Array),
  identity: Sha256HashSchema,
}).strict().superRefine((value, context) => {
  try {
    const canonical = createObservedDiffHunkV1(value);
    if (
      canonical.identity !== value.identity
      || canonical.normalizedPath !== value.normalizedPath
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "observed hunk identity and path must match its exact bytes",
      });
    }
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "invalid observed hunk",
    });
  }
});

const ArchitectureElementV1Schema = z.object({
  id: z.string().regex(/^(repo|semantic):.+$/),
  level: SemanticLevelV1Schema,
  category: NonEmptyIdSchema,
  fingerprint: NonEmptyIdSchema,
}).strict();
const ArchitectureRelationV1Schema = z.object({
  from: z.string().regex(/^(repo|semantic):.+$/),
  to: z.string().regex(/^(repo|semantic):.+$/),
  relation: NonEmptyIdSchema,
  fingerprint: NonEmptyIdSchema,
}).strict();
const ChangedArchitectureElementV1Schema = z.object({
  id: z.string().regex(/^(repo|semantic):.+$/),
  before: ArchitectureElementV1Schema,
  after: ArchitectureElementV1Schema,
}).strict();
const ChangedArchitectureRelationV1Schema = z.object({
  key: NonEmptyIdSchema,
  before: ArchitectureRelationV1Schema,
  after: ArchitectureRelationV1Schema,
}).strict();
const ReconciliationArchitectureDeltaV1Schema = z.object({
  currentSnapshotId: NonEmptyIdSchema,
  targetSnapshotId: NonEmptyIdSchema,
  added: z.array(ArchitectureElementV1Schema),
  removed: z.array(ArchitectureElementV1Schema),
  changed: z.array(ChangedArchitectureElementV1Schema),
  addedRelations: z.array(ArchitectureRelationV1Schema),
  removedRelations: z.array(ArchitectureRelationV1Schema),
  changedRelations: z.array(ChangedArchitectureRelationV1Schema),
  changedInvariantIds: z.array(z.string().regex(/^(repo|semantic):.+$/)),
}).strict();

const ReconciliationHunkBindingV1Schema = z.object({
  hunkId: Sha256HashSchema,
  coordinateIds: z.array(RepositoryCoordinateIdV1Schema),
  editIds: z.array(NonEmptyIdSchema),
}).strict();

const ReconciliationEvidenceInputV1Schema = z.object({
  requirementId: NonEmptyIdSchema,
  evidenceId: NonEmptyIdSchema,
  semanticEvidenceDigest: Sha256HashSchema.optional(),
  acceptedAttestationDigests: z.array(Sha256HashSchema).optional(),
  planningCommit: NonEmptyIdSchema,
  observedDiffHash: Sha256HashSchema,
  semanticModelHash: Sha256HashSchema,
  attestationSetHash: Sha256HashSchema.optional(),
  observationAnalysisHash: Sha256HashSchema.optional(),
  provenance: z.array(z.enum([
    "plane_b_authored", "plane_a_observed", "canonical_attestation",
  ])),
  result: z.enum(["satisfied", "stale", "unbound", "failing"]),
}).strict().superRefine((value, context) => {
  if (value.acceptedAttestationDigests !== undefined) {
    requireCanonicalStrings(
      value.acceptedAttestationDigests,
      context,
      ["acceptedAttestationDigests"],
    );
  }
  requireCanonicalStrings(value.provenance, context, ["provenance"]);
  const hasAttestations = (value.acceptedAttestationDigests?.length ?? 0) > 0;
  const hasCanonicalAttestation = value.provenance.includes("canonical_attestation");
  if (
    hasAttestations !== hasCanonicalAttestation
    || hasAttestations !== (value.attestationSetHash !== undefined)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["acceptedAttestationDigests"],
      message: "accepted attestations require canonical provenance and a bound attestation set",
    });
  }
  if (
    value.result === "satisfied"
    && (
      !value.provenance.includes("plane_b_authored")
      || value.observationAnalysisHash === undefined
      || (
        value.semanticEvidenceDigest === undefined
        && !hasAttestations
      )
      || (
        value.semanticEvidenceDigest !== undefined
        && !value.provenance.includes("plane_a_observed")
      )
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "satisfied evidence input requires sealed positive content",
    });
  }
  if (
    value.result === "unbound"
    && (hasAttestations || hasCanonicalAttestation)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "unbound evidence cannot carry an accepted canonical attestation",
    });
  }
  if (
    value.result === "failing"
    && !value.provenance.includes("plane_a_observed")
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["provenance"],
      message: "failing evidence requires observed negative content",
    });
  }
});

const ReconciliationRoundTripStepV1Schema = z.object({
  relationId: NonEmptyIdSchema,
  relationDigest: Sha256HashSchema,
  fromId: NonEmptyIdSchema,
  toId: NonEmptyIdSchema,
  fromLevel: SemanticLevelV1Schema,
  toLevel: SemanticLevelV1Schema,
  epistemicStatus: z.enum([
    "human_declared", "statically_observed", "dynamically_observed",
    "test_observed", "historically_observed", "llm_inferred", "hypothetical",
  ]),
  evidenceDigests: z.array(Sha256HashSchema).min(1),
}).strict();
const ReconciliationRoundTripCoverageV1Schema = z.object({
  schemaVersion: z.literal(1),
  expectationId: NonEmptyIdSchema,
  editId: NonEmptyIdSchema,
  semanticSubjectId: NonEmptyIdSchema,
  semanticLevel: AuthoredSemanticLevelV1Schema,
  sourceSeal: Sha256HashSchema,
  indexSeal: Sha256HashSchema,
  observationAnalysisHash: Sha256HashSchema,
  steps: z.array(ReconciliationRoundTripStepV1Schema),
  terminalCoordinateIds: z.array(RepositoryCoordinateIdV1Schema),
  observedHunkIds: z.array(Sha256HashSchema),
  evidenceIds: z.array(NonEmptyIdSchema),
  terminalStatus: z.enum(["success", "empty", "refused", "budget_exhausted"]),
  truncated: z.boolean(),
}).strict().superRefine((value, context) => {
  requireCanonicalStrings(value.terminalCoordinateIds, context, ["terminalCoordinateIds"]);
  requireCanonicalStrings(value.observedHunkIds, context, ["observedHunkIds"]);
  requireCanonicalStrings(value.evidenceIds, context, ["evidenceIds"]);
  if (new Set(value.steps.map((step) => step.relationId)).size !== value.steps.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["steps"],
      message: "round-trip relation ids must be unique",
    });
  }
  value.steps.forEach((step, index) => {
    requireCanonicalStrings(step.evidenceDigests, context, ["steps", index, "evidenceDigests"]);
    const previous = value.steps[index - 1];
    if (
      step.toLevel !== step.fromLevel - 1
      || (
        previous !== undefined
        && (
          previous.toId !== step.fromId
          || previous.toLevel !== step.fromLevel
        )
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["steps", index],
        message: "round-trip steps must form one ordered adjacent descending chain",
      });
    }
  });
  if (
    value.terminalStatus === "success"
    && (
      value.truncated
      || value.steps.length === 0
      || value.terminalCoordinateIds.length === 0
      || value.observedHunkIds.length === 0
      || value.evidenceIds.length === 0
      || value.steps.some((step) =>
        step.epistemicStatus === "llm_inferred"
        || step.epistemicStatus === "hypothetical"
        || step.evidenceDigests.length === 0
      )
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["terminalStatus"],
      message: "successful round-trip coverage requires complete sealed non-LLM proof",
    });
  }
});

const ReconciliationTargetAnalysisV1Schema = z.object({
  targetRef: TargetReferenceV1Schema,
  normativeStatus: z.enum(["proposed", "accepted"]),
  reviewAttestationDigests: z.array(Sha256HashSchema),
  findings: z.array(z.object({
    targetElementId: NonEmptyIdSchema,
    result: z.enum(["realized", "not_realized", "unproven"]),
    evidenceIds: z.array(NonEmptyIdSchema),
  }).strict()),
}).strict().superRefine((value, context) => {
  requireCanonicalStrings(
    value.reviewAttestationDigests,
    context,
    ["reviewAttestationDigests"],
  );
  requireCanonicalById(value.findings, "targetElementId", context, ["findings"]);
  value.findings.forEach((finding, index) => {
    requireCanonicalStrings(finding.evidenceIds, context, ["findings", index, "evidenceIds"]);
  });
  if (
    value.normativeStatus === "proposed"
    && (
      value.reviewAttestationDigests.length > 0
      || value.findings.some((finding) => finding.result !== "unproven")
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["normativeStatus"],
      message: "a proposed target is diagnostic only",
    });
  }
  if (
    value.normativeStatus === "accepted"
    && value.reviewAttestationDigests.length === 0
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reviewAttestationDigests"],
      message: "an accepted target requires a sealed review attestation",
    });
  }
  if (
    value.findings.some((finding) =>
      finding.result === "realized" && finding.evidenceIds.length === 0
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["findings"],
      message: "positive target findings require evidence",
    });
  }
});

const ReconciliationAnalysisV1Shape = {
  schemaVersion: z.literal(1),
  kind: z.literal("reconciliation_analysis"),
  executionAuthority: z.literal("none"),
  planningBundleHash: Sha256HashSchema,
  planningCommit: NonEmptyIdSchema,
  observedDiffHash: Sha256HashSchema,
  observationAnalysis: ObservationAnalysisV1Schema,
  candidateGraphHash: Sha256HashSchema,
  baselineArchitectureHash: Sha256HashSchema,
  candidateArchitectureHash: Sha256HashSchema,
  architectureDeltaHash: Sha256HashSchema,
  observedHunks: z.array(ObservedDiffHunkV1Schema),
  hunkBindings: z.array(ReconciliationHunkBindingV1Schema),
  architectureDelta: ReconciliationArchitectureDeltaV1Schema,
  liftedImpacts: z.array(z.object({
    hunkId: Sha256HashSchema,
    expectationIds: z.array(NonEmptyIdSchema),
    semanticSubjectIds: z.array(NonEmptyIdSchema),
  }).strict()),
  evidenceInputs: z.array(ReconciliationEvidenceInputV1Schema),
  evidenceEvaluations: z.array(EvidenceEvaluationV1Schema),
  roundTripCoverages: z.array(ReconciliationRoundTripCoverageV1Schema),
  targetAnalysis: ReconciliationTargetAnalysisV1Schema.optional(),
  traversalBudgetExhausted: z.boolean(),
  advisoryDiagnostics: z.array(z.object({
    code: ReconciliationAdvisoryCodeV1Schema,
    message: NonEmptyIdSchema,
    subjectIds: z.array(NonEmptyIdSchema),
  }).strict()),
  analysisHash: Sha256HashSchema,
};
export const ReconciliationAnalysisV1Schema = z.object(ReconciliationAnalysisV1Shape).strict()
  .superRefine((value, context) => {
    const analysis = value as ReconciliationAnalysisV1;
    if (value.analysisHash !== computeReconciliationAnalysisV1Hash(analysis)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["analysisHash"],
        message: "analysisHash does not match canonical content",
      });
    }
    if (
      value.architectureDeltaHash
      !== computeReconciliationArchitectureDeltaV1Hash(analysis.architectureDelta)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["architectureDeltaHash"],
        message: "architectureDeltaHash does not match canonical content",
      });
    }
    if (
      value.candidateGraphHash !== value.observationAnalysis.candidateGraphHash
      || value.candidateArchitectureHash !== value.observationAnalysis.candidateArchitectureHash
      || value.observedDiffHash !== value.observationAnalysis.candidateDiffHash
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "analysis artifact hashes must match the sealed observation analysis",
      });
    }
    const hunkIds = value.observedHunks.map((hunk) => hunk.identity);
    if (
      value.observedDiffHash
      !== computeReconciliationObservedDiffV1Hash(
        value.observationAnalysis.changes,
        value.observedHunks,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observedDiffHash"],
        message: "observedDiffHash must bind the canonical changes and exact hunk identities",
      });
    }
    const bindingIds = value.hunkBindings.map((binding) => binding.hunkId);
    if (
      new Set(hunkIds).size !== hunkIds.length
      || new Set(bindingIds).size !== bindingIds.length
      || hunkIds.length !== bindingIds.length
      || hunkIds.some((id) => !bindingIds.includes(id))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hunkBindings"],
        message: "every exact observed hunk must have one binding",
      });
    }
    value.hunkBindings.forEach((binding, index) => {
      requireCanonicalStrings(
        binding.coordinateIds,
        context,
        ["hunkBindings", index, "coordinateIds"],
      );
      requireCanonicalStrings(
        binding.editIds,
        context,
        ["hunkBindings", index, "editIds"],
      );
    });
    const observedIds = new Set(hunkIds);
    if (value.liftedImpacts.some((impact) => !observedIds.has(impact.hunkId))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["liftedImpacts"],
        message: "lifted impacts must bind an exact observed hunk",
      });
    }
    const liftedExpectationIds = new Set(
      value.liftedImpacts.flatMap((impact) => impact.expectationIds),
    );
    value.liftedImpacts.forEach((impact, index) => {
      requireCanonicalStrings(
        impact.expectationIds,
        context,
        ["liftedImpacts", index, "expectationIds"],
      );
      requireCanonicalStrings(
        impact.semanticSubjectIds,
        context,
        ["liftedImpacts", index, "semanticSubjectIds"],
      );
    });
    const evidenceIds = new Set(
      value.evidenceEvaluations.flatMap((evaluation) =>
        evaluation.evidenceId === null ? [] : [evaluation.evidenceId]
      ),
    );
    const coordinatesByHunk = new Map(
      value.hunkBindings.map((binding) => [binding.hunkId, new Set(binding.coordinateIds)]),
    );
    if (value.roundTripCoverages.some((coverage) =>
      coverage.observationAnalysisHash !== value.observationAnalysis.analysisHash
      || coverage.sourceSeal !== value.observationAnalysis.baselineSealHash
      || coverage.observedHunkIds.some((id) => !observedIds.has(id))
      || !liftedExpectationIds.has(coverage.expectationId)
      || !coverage.observedHunkIds.some((hunkId) =>
        value.hunkBindings.some((binding) =>
          binding.hunkId === hunkId && binding.editIds.includes(coverage.editId)
        )
      )
      || !coverage.observedHunkIds.some((hunkId) =>
        value.liftedImpacts.some((impact) =>
          impact.hunkId === hunkId
          && impact.expectationIds.includes(coverage.expectationId)
          && impact.semanticSubjectIds.includes(coverage.semanticSubjectId)
        )
      )
      || coverage.evidenceIds.some((id) => !evidenceIds.has(id))
      || coverage.terminalCoordinateIds.some((coordinateId) =>
        !coverage.observedHunkIds.some((hunkId) =>
          coordinatesByHunk.get(hunkId)?.has(coordinateId)
        )
      )
    )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["roundTripCoverages"],
        message: "round-trip coverage must bind this observation and exact hunks",
      });
    }
    if (value.evidenceEvaluations.some((evaluation) =>
      evaluation.planningCommit !== value.planningCommit
      || evaluation.observedDiffHash !== value.observedDiffHash
      || (
        evaluation.observationAnalysisHash !== undefined
        && evaluation.observationAnalysisHash !== value.observationAnalysis.analysisHash
      )
    )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidenceEvaluations"],
        message: "evidence evaluations must bind this planning and observation content",
      });
    }
    const evidenceInputs = new Map(
      value.evidenceInputs.map((input) => [input.requirementId, input]),
    );
    const evaluations = new Map(
      value.evidenceEvaluations.map((evaluation) => [evaluation.requirementId, evaluation]),
    );
    if (
      evidenceInputs.size !== value.evidenceInputs.length
      || evaluations.size !== value.evidenceEvaluations.length
      || value.evidenceInputs.some((input) => {
        const evaluation = evaluations.get(input.requirementId);
        return evaluation === undefined
          || evaluation.result === "missing"
          || evaluation.evidenceId !== input.evidenceId
          || evaluation.result !== input.result
          || evaluation.planningCommit !== input.planningCommit
          || evaluation.observedDiffHash !== input.observedDiffHash
          || evaluation.semanticModelHash !== input.semanticModelHash
          || evaluation.semanticEvidenceDigest !== input.semanticEvidenceDigest
          || evaluation.attestationSetHash !== input.attestationSetHash
          || evaluation.observationAnalysisHash !== input.observationAnalysisHash
          || JSON.stringify(evaluation.acceptedAttestationDigests)
            !== JSON.stringify(input.acceptedAttestationDigests ?? [])
          || JSON.stringify(evaluation.provenance) !== JSON.stringify(input.provenance);
      })
      || value.evidenceEvaluations.some((evaluation) =>
        evaluation.result !== "missing" && !evidenceInputs.has(evaluation.requirementId)
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidenceInputs"],
        message: "evidence evaluations must be content-bound to their exact admitted inputs",
      });
    }
    if (
      value.targetAnalysis?.normativeStatus === "accepted"
      && value.targetAnalysis.reviewAttestationDigests.some((digest) =>
        !value.evidenceEvaluations.some((evaluation) =>
          evaluation.result === "satisfied"
          && evaluation.acceptedAttestationDigests.includes(digest)
        )
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetAnalysis", "reviewAttestationDigests"],
        message: "accepted target review attestations must be admitted by satisfied evidence",
      });
    }
    const realizedTargetEvidence = value.targetAnalysis?.findings
      .filter((finding) => finding.result === "realized")
      .flatMap((finding) => finding.evidenceIds) ?? [];
    const realizedTargetEvaluations = realizedTargetEvidence.flatMap((evidenceId) =>
      value.evidenceEvaluations.filter((evaluation) =>
        evaluation.evidenceId === evidenceId
        && evaluation.result === "satisfied"
        && evaluation.planningCommit === value.planningCommit
        && evaluation.observedDiffHash === value.observedDiffHash
        && evaluation.observationAnalysisHash === value.observationAnalysis.analysisHash
        && evaluation.semanticEvidenceDigest !== undefined
        && evaluation.attestationSetHash !== undefined
        && value.targetAnalysis!.reviewAttestationDigests.every((digest) =>
          evaluation.acceptedAttestationDigests.includes(digest)
        )
      )
    );
    const targetSemanticModelHashes = new Set(
      realizedTargetEvaluations.map((evaluation) => evaluation.semanticModelHash),
    );
    const targetAttestationSetHashes = new Set(
      realizedTargetEvaluations.map((evaluation) => evaluation.attestationSetHash),
    );
    if (
      realizedTargetEvaluations.length !== realizedTargetEvidence.length
      || targetSemanticModelHashes.size > 1
      || targetAttestationSetHashes.size > 1
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetAnalysis", "findings"],
        message:
          "realized target evidence must resolve to satisfied evaluations bound to one reconciliation content set",
      });
    }
    const normalized = normalizeReconciliationAnalysisV1(analysis);
    if (sha256HashCanonicalJson(value) !== sha256HashCanonicalJson(normalized)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "reconciliation analysis arrays must be canonical",
      });
    }
  });

export const ReconciliationRefusalReasonV1Schema = z.enum(RECONCILIATION_REFUSAL_REASONS);
export const ReconciliationViolationReasonV1Schema = z.enum(RECONCILIATION_VIOLATION_REASONS);
export const ReconciliationInsufficiencyReasonV1Schema = z.enum(RECONCILIATION_INSUFFICIENCY_REASONS);
export const ReconciliationReasonCodeV1Schema = z.enum(RECONCILIATION_REASON_ORDER);
export const ReconcileTerminalStatusV1Schema = z.enum([
  "REALIZED", "VIOLATED", "UNPROVEN", "REFUSED",
]);

const ReconcileDiffReportV1Shape = {
  schemaVersion: z.literal(1),
  kind: z.literal("reconcile_diff"),
  changeSetId: NonEmptyIdSchema,
  changeSetHash: Sha256HashSchema,
  envelopeId: NonEmptyIdSchema,
  envelopeHash: Sha256HashSchema,
  planningCommit: NonEmptyIdSchema,
  observedCommit: NonEmptyIdSchema,
  baselineSealHash: Sha256HashSchema,
  observedWorkingDiffHash: Sha256HashSchema,
  terminalStatus: ReconcileTerminalStatusV1Schema,
  primaryReason: ReconciliationReasonCodeV1Schema.nullable(),
  reasonCodes: z.array(ReconciliationReasonCodeV1Schema),
  requiredPlannedEditIds: z.array(NonEmptyIdSchema),
  matchedPlannedEdits: z.array(z.object({
    editId: NonEmptyIdSchema,
    observedHunkIds: z.array(Sha256HashSchema).min(1),
  }).strict()),
  missingPlannedEditIds: z.array(NonEmptyIdSchema),
  observedHunkIds: z.array(Sha256HashSchema),
  unplannedCoordinateIds: z.array(RepositoryCoordinateIdV1Schema),
  scopeEscapes: z.array(z.object({
    path: CanonicalRepoRelativePathSchema,
    coordinateId: RepositoryCoordinateIdV1Schema.optional(),
  }).strict()),
  invariantDriftIds: z.array(NonEmptyIdSchema),
  undeclaredLiftedExpectationIds: z.array(NonEmptyIdSchema),
  requiredTargetElementIds: z.array(NonEmptyIdSchema),
  targetRealizationFindings: z.array(z.object({
    targetElementId: NonEmptyIdSchema,
    required: z.boolean(),
    result: z.enum(["realized", "not_realized", "unproven"]),
    evidenceIds: z.array(NonEmptyIdSchema),
  }).strict()),
  requiredEvidenceRequirementIds: z.array(NonEmptyIdSchema),
  evidenceEvaluations: z.array(EvidenceEvaluationV1Schema),
  certifiedRoundTrips: z.array(z.object({
    expectationId: NonEmptyIdSchema,
    coordinateIds: z.array(RepositoryCoordinateIdV1Schema).min(1),
    evidenceIds: z.array(NonEmptyIdSchema).min(1),
  }).strict()),
  requiredRoundTripExpectationIds: z.array(NonEmptyIdSchema),
  observationAnalysis: z.object({
    analysisHash: Sha256HashSchema,
    completeness: z.enum(["complete", "partial"]),
  }).strict().nullable(),
  advisoryDiagnostics: z.array(z.object({
    code: ReconciliationAdvisoryCodeV1Schema,
    message: NonEmptyIdSchema,
    subjectIds: z.array(NonEmptyIdSchema),
  }).strict()),
  secondaryInsufficiencies: z.array(ReconciliationInsufficiencyReasonV1Schema),
  reportHash: Sha256HashSchema,
};

export const ReconcileDiffReportV1Schema = z.object(ReconcileDiffReportV1Shape).strict()
  .superRefine((value, context) => {
    requireCanonicalReasons(value.reasonCodes, context, ["reasonCodes"]);
    requireCanonicalReasons(
      value.secondaryInsufficiencies,
      context,
      ["secondaryInsufficiencies"],
    );
    requireCanonicalById(value.matchedPlannedEdits, "editId", context, ["matchedPlannedEdits"]);
    value.matchedPlannedEdits.forEach((match, index) =>
      requireCanonicalStrings(
        match.observedHunkIds,
        context,
        ["matchedPlannedEdits", index, "observedHunkIds"],
      ));
    for (const [field, values] of [
      ["requiredPlannedEditIds", value.requiredPlannedEditIds],
      ["missingPlannedEditIds", value.missingPlannedEditIds],
      ["observedHunkIds", value.observedHunkIds],
      ["unplannedCoordinateIds", value.unplannedCoordinateIds],
      ["invariantDriftIds", value.invariantDriftIds],
      ["undeclaredLiftedExpectationIds", value.undeclaredLiftedExpectationIds],
      ["requiredTargetElementIds", value.requiredTargetElementIds],
      ["requiredEvidenceRequirementIds", value.requiredEvidenceRequirementIds],
      ["requiredRoundTripExpectationIds", value.requiredRoundTripExpectationIds],
    ] as const) requireCanonicalStrings(values, context, [field]);
    requireCanonicalByCompound(
      value.scopeEscapes,
      (item) => `${item.path}\0${item.coordinateId ?? ""}`,
      context,
      ["scopeEscapes"],
    );
    requireCanonicalById(
      value.targetRealizationFindings,
      "targetElementId",
      context,
      ["targetRealizationFindings"],
    );
    value.targetRealizationFindings.forEach((finding, index) =>
      requireCanonicalStrings(
        finding.evidenceIds,
        context,
        ["targetRealizationFindings", index, "evidenceIds"],
      ));
    requireCanonicalByCompound(
      value.evidenceEvaluations,
      (item) => `${item.requirementId}\0${item.origin}`,
      context,
      ["evidenceEvaluations"],
    );
    requireCanonicalById(
      value.certifiedRoundTrips,
      "expectationId",
      context,
      ["certifiedRoundTrips"],
    );
    value.certifiedRoundTrips.forEach((roundTrip, index) => {
      requireCanonicalStrings(
        roundTrip.coordinateIds,
        context,
        ["certifiedRoundTrips", index, "coordinateIds"],
      );
      requireCanonicalStrings(
        roundTrip.evidenceIds,
        context,
        ["certifiedRoundTrips", index, "evidenceIds"],
      );
    });
    requireCanonicalByCompound(
      value.advisoryDiagnostics,
      (item) => `${item.code}\0${item.message}`,
      context,
      ["advisoryDiagnostics"],
    );
    value.advisoryDiagnostics.forEach((diagnostic, index) =>
      requireCanonicalStrings(
        diagnostic.subjectIds,
        context,
        ["advisoryDiagnostics", index, "subjectIds"],
      ));
    const expectedClass = value.terminalStatus === "REFUSED"
      ? new Set(RECONCILIATION_REFUSAL_REASONS)
      : value.terminalStatus === "VIOLATED"
        ? new Set(RECONCILIATION_VIOLATION_REASONS)
        : value.terminalStatus === "UNPROVEN"
          ? new Set(RECONCILIATION_INSUFFICIENCY_REASONS)
          : new Set<string>();
    if (value.terminalStatus === "REALIZED") {
      if (value.reasonCodes.length !== 0 || value.primaryReason !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reasonCodes"],
          message: "REALIZED has no primary or terminal reasons",
        });
      }
    } else {
      if (
        value.reasonCodes.length === 0
        || value.primaryReason !== value.reasonCodes[0]
        || value.reasonCodes.some((reason) => !expectedClass.has(reason))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reasonCodes"],
          message: "terminal status, primary reason, and reason class must agree",
        });
      }
    }
    if (
      value.terminalStatus !== "VIOLATED"
      && value.secondaryInsufficiencies.length > 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["secondaryInsufficiencies"],
        message: "only VIOLATED reports may retain secondary insufficiencies",
      });
    }
    if (value.terminalStatus === "REALIZED") {
      validateRealizedReport(value, context);
    }
    if (value.reportHash !== computeReconcileDiffReportV1Hash(
      value as ReconcileDiffReportV1,
    )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reportHash"],
        message: "reportHash does not match canonical content",
      });
    }
  });

export const ReconcileWorkingTreeInputV1Schema = z.object({
  schemaVersion: z.literal(1),
  planningBundle: PlanningBundleV1Schema,
}).strict();

function validateEditScopeCoverage(
  edit: z.infer<typeof RepositoryEditExpectationV1Schema>,
  scope: z.infer<typeof DeclaredReconciliationScopeV1Schema>,
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  if (scope.kind === "exact_coordinate") {
    if (
      edit.kind !== "add"
      && edit.coordinateIds.some((coordinateId) => coordinateId !== scope.coordinateId)
    ) {
      addScopeIssue(context, path, "edit coordinates escape exact-coordinate scope");
    }
    return;
  }
  if (scope.kind === "file") {
    if (edit.kind === "add") return;
    const editPath = edit.kind === "modify" ? edit.path : edit.oldPath;
    if (editPath !== scope.path) {
      addScopeIssue(context, path, "edit path escapes exact-file scope");
    }
    return;
  }
  const coordinateSet = new Set(scope.coordinateIds);
  const sourcePath = edit.kind === "add"
    ? edit.newPath
    : edit.kind === "modify"
      ? edit.path
      : edit.oldPath;
  if (scope.filePaths?.includes(sourcePath)) return;
  if (
    (edit.kind === "modify" || edit.kind === "delete" || edit.kind === "rename")
    && edit.coordinateIds.some((coordinateId) => !coordinateSet.has(coordinateId))
  ) {
    addScopeIssue(context, path, "old-side edit coordinates escape the declared coordinate set");
  }
}

function validateBundleEditBindings(
  value: z.infer<z.ZodObject<typeof PlanningBundleV1Shape>>,
  context: z.RefinementCtx,
): void {
  value.semanticChangeSet.repositoryEditExpectations.forEach((edit, index) => {
    if (edit.kind === "add") return;
    const sourcePath = edit.kind === "modify" ? edit.path : edit.oldPath;
    const unboundCoordinates = edit.coordinateIds.filter((coordinateId) =>
      value.taskEnvelope.resolvedBindings.every((binding) =>
        binding.repositoryPath !== sourcePath
        || (
          binding.coordinateId !== coordinateId
          && (
            binding.scope.kind !== "coordinate_set"
            || !binding.scope.coordinateIds.includes(coordinateId)
          )
        )
      )
    );
    if (unboundCoordinates.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["semanticChangeSet", "repositoryEditExpectations", index],
        message: "old-side edit coordinates must be proven by resolved bindings for the source path",
      });
    }
  });
}

function validateRealizedReport(
  value: z.infer<z.ZodObject<typeof ReconcileDiffReportV1Shape>>,
  context: z.RefinementCtx,
): void {
  const failures: string[] = [];
  if (value.missingPlannedEditIds.length > 0) failures.push("missing planned edits");

  const matchedEditIds = new Set(value.matchedPlannedEdits.map((match) => match.editId));
  if (value.requiredPlannedEditIds.some((editId) => !matchedEditIds.has(editId))) {
    failures.push("required planned edit without a match");
  }
  const accountedHunks = value.matchedPlannedEdits.flatMap((match) => match.observedHunkIds);
  const observedHunks = new Set(value.observedHunkIds);
  if (
    accountedHunks.length !== new Set(accountedHunks).size
    || accountedHunks.length !== observedHunks.size
    || accountedHunks.some((hunkId) => !observedHunks.has(hunkId))
  ) failures.push("observed hunks are not accounted exactly once");

  if (value.unplannedCoordinateIds.length > 0) failures.push("unplanned coordinates");
  if (value.scopeEscapes.length > 0) failures.push("scope escapes");
  if (value.invariantDriftIds.length > 0) failures.push("invariant drift");
  if (value.undeclaredLiftedExpectationIds.length > 0) {
    failures.push("undeclared lifted impacts");
  }
  const targetFindings = new Map(
    value.targetRealizationFindings.map((finding) => [finding.targetElementId, finding]),
  );
  if (value.requiredTargetElementIds.some((targetId) => {
    const finding = targetFindings.get(targetId);
    return finding === undefined
      || !finding.required
      || finding.result !== "realized"
      || finding.evidenceIds.length === 0;
  }) || value.targetRealizationFindings.some((finding) =>
    finding.required && (finding.result !== "realized" || finding.evidenceIds.length === 0))) {
    failures.push("required target finding is not positively realized");
  }
  const evidenceEvaluations = new Map(
    value.evidenceEvaluations.map((evaluation) => [evaluation.requirementId, evaluation]),
  );
  if (value.requiredEvidenceRequirementIds.some((requirementId) => {
    const evaluation = evidenceEvaluations.get(requirementId);
    return evaluation === undefined || !evaluation.required || evaluation.result !== "satisfied";
  }) || value.evidenceEvaluations.some((evaluation) =>
    evaluation.required && evaluation.result !== "satisfied")) {
    failures.push("required evidence is not satisfied");
  }
  const certifiedRoundTrips = new Set(
    value.certifiedRoundTrips.map((roundTrip) => roundTrip.expectationId),
  );
  if (value.requiredRoundTripExpectationIds.some((id) => !certifiedRoundTrips.has(id))) {
    failures.push("required round trip is absent");
  }
  if (
    value.observationAnalysis === null
    || value.observationAnalysis.completeness !== "complete"
  ) failures.push("observation analysis is not complete");
  if (value.reasonCodes.length > 0 || value.secondaryInsufficiencies.length > 0) {
    failures.push("blocking reasons remain");
  }
  if (failures.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["terminalStatus"],
      message: `REALIZED positive predicate failed: ${failures.join("; ")}`,
    });
  }
}

function validateDeclaredScopeBindings(
  scope: z.infer<typeof DeclaredReconciliationScopeV1Schema>,
  bindings: readonly z.infer<typeof ResolvedBindingV1Schema>[],
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  const byId = new Map(bindings.map((binding) => [binding.bindingId, binding]));
  if (scope.kind === "exact_coordinate") {
    const binding = byId.get(scope.bindingId);
    if (
      binding === undefined
      || binding.scope.kind !== "exact_coordinate"
      || binding.scope.coordinateId !== scope.coordinateId
    ) addScopeIssue(context, path, "exact scope is not proven by its resolved binding");
    return;
  }
  if (scope.kind === "file") {
    const binding = byId.get(scope.bindingId);
    if (
      binding === undefined
      || binding.scope.kind !== "file"
      || binding.scope.path !== scope.path
    ) addScopeIssue(context, path, "file scope is not proven by its resolved binding");
    return;
  }
  const selected = scope.bindingIds.map((id) => byId.get(id));
  if (selected.some((binding) => binding === undefined)) {
    addScopeIssue(context, path, "coordinate set references an unknown binding");
    return;
  }
  const provenCoordinates = new Set(selected.flatMap((binding) =>
    binding!.scope.kind === "coordinate_set"
      ? binding!.scope.coordinateIds
      : binding!.scope.kind === "exact_coordinate"
        ? [binding!.scope.coordinateId]
        : [binding!.coordinateId]));
  const provenFilePaths = new Set(selected.flatMap((binding) =>
    binding!.scope.kind === "file" ? [binding!.scope.path] : []));
  if (scope.coordinateIds.some((coordinateId) => !provenCoordinates.has(coordinateId))) {
    addScopeIssue(context, path, "every coordinate must be proven by a listed binding");
  }
  if (scope.filePaths?.some((filePath) => !provenFilePaths.has(filePath))) {
    addScopeIssue(context, path, "every file path must be proven by a listed file binding");
  }
  if (selected.some((binding) =>
    binding!.scope.kind === "file"
      ? scope.filePaths !== undefined
        && (
          !scope.filePaths.includes(binding!.scope.path)
          || !scope.coordinateIds.includes(binding!.coordinateId)
        )
      : binding!.scope.kind === "exact_coordinate"
        ? !scope.coordinateIds.includes(binding!.scope.coordinateId)
        : binding!.scope.coordinateIds.some((coordinateId) =>
          !scope.coordinateIds.includes(coordinateId)
        )
  )) {
    addScopeIssue(context, path, "combined scope must preserve every listed binding scope");
  }
}

function addScopeIssue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function requireCanonicalStrings(
  values: readonly string[],
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  const canonical = [...new Set(values)].sort(compareCodeUnits);
  if (
    canonical.length !== values.length
    || canonical.some((value, index) => value !== values[index])
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: "values must be sorted and unique",
    });
  }
}

function requireCanonicalById<
  T extends Record<K, string>,
  K extends keyof T,
>(
  values: readonly T[],
  key: K,
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  requireCanonicalByCompound(values, (item) => item[key], context, path);
}

function requireCanonicalByCompound<T>(
  values: readonly T[],
  key: (item: T) => string,
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  const keys = values.map(key);
  requireCanonicalStrings(keys, context, path);
}

function requireCanonicalByOrder(
  values: readonly { order: number; stepId: string }[],
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (value.order !== index) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index, "order"],
        message: "refinement steps use zero-based contiguous order",
      });
    }
    if (seen.has(value.stepId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index, "stepId"],
        message: "duplicate refinement step id",
      });
    }
    seen.add(value.stepId);
  });
}

function requireCanonicalReasons(
  values: readonly string[],
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  const canonical = [...new Set(values)].sort(
    (left, right) =>
      RECONCILIATION_REASON_ORDER.indexOf(left as never)
      - RECONCILIATION_REASON_ORDER.indexOf(right as never),
  );
  if (
    canonical.length !== values.length
    || canonical.some((value, index) => value !== values[index])
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: "reasons must be unique and follow canonical precedence",
    });
  }
}

function requireCanonicalObservations(
  values: readonly z.infer<typeof ObservationChangeV1Schema>[],
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  const keys = values.map((value) => {
    const file = value.kind === "add"
      ? value.newPath
      : value.kind === "modify"
        ? value.path
        : value.oldPath;
    return `${file}\0${value.kind}`;
  });
  requireCanonicalStrings(keys, context, path);
}
