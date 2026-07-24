/** Zod schemas for Plane C external boundaries. Internal algorithms use the exported TypeScript types. */

import { z } from "zod";
import { MIGRATION_STEP_PROFILES } from "./constants";
import { classifyControlFreshnessSeal } from "./freshness";
import { Sha256HashSchema } from "./primitive-schemas";
import type { AuthoredSemanticLevel, ControlFreshnessSeal } from "./types";
export { Sha256HashSchema } from "./primitive-schemas";

export const SemanticLevelSchema = z.number().int().min(0).max(6);
export const AuthoredSemanticLevelSchema = SemanticLevelSchema.refine(
  (level): level is AuthoredSemanticLevel => level > 0,
  "authored semantics cannot occupy observed L0",
);
export const CoordinatePlaneSchema = z.enum(["repo", "semantic"]);
export const RepositoryCoordinateIdSchema = z.string().regex(/^repo:.+$/, "expected repo:<repository-node-id>");
export const SemanticCoordinateIdSchema = z.string().regex(/^semantic:.+$/, "expected semantic:<semantic-node-id>");
export const QualifiedCoordinateIdSchema = z.union([RepositoryCoordinateIdSchema, SemanticCoordinateIdSchema]);

export const EpistemicStatusSchema = z.enum([
  "human_declared",
  "statically_observed",
  "dynamically_observed",
  "test_observed",
  "historically_observed",
  "llm_inferred",
  "hypothetical",
]);

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
]);

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
});

export const CoordinateNodeSchema = z.object({
  id: QualifiedCoordinateIdSchema,
  plane: CoordinatePlaneSchema,
  sourceId: z.string().min(1),
  sourceKind: z.string().min(1),
  level: SemanticLevelSchema,
  category: CoordinateCategorySchema,
  label: z.string(),
  epistemicStatus: EpistemicStatusSchema,
  references: z.array(z.string()),
  metadata: z.record(z.string()).optional(),
}).strict().superRefine((value, context) => {
  if (!value.id.startsWith(`${value.plane}:`)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: "coordinate id must match its plane" });
  }
});

export const CoordinateEdgeSchema = z.object({
  from: QualifiedCoordinateIdSchema,
  to: QualifiedCoordinateIdSchema,
  relation: z.string().min(1),
  sourceRelation: z.string().min(1).optional(),
  evidenceRefs: z.array(z.string()),
}).strict();

export const CoordinatePathSchema = z.object({
  nodes: z.array(QualifiedCoordinateIdSchema).min(1),
  edges: z.array(CoordinateEdgeSchema),
}).strict().superRefine((value, context) => {
  if (value.edges.length !== value.nodes.length - 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "a path must have exactly one fewer edge than nodes" });
  }
});

export const LevelCoverageSchema = z.object({
  level: SemanticLevelSchema,
  categories: z.array(CoordinateCategorySchema),
  coordinateIds: z.array(QualifiedCoordinateIdSchema),
}).strict();

export const UnsupportedCoordinateSourceSchema = z.object({
  plane: CoordinatePlaneSchema,
  sourceId: z.string().min(1),
  sourceKind: z.string().min(1),
  reason: z.string().min(1),
}).strict();

export const UnmappedCoordinateSourceSchema = UnsupportedCoordinateSourceSchema;

export const StaleRepositoryLinkSchema = z.object({
  ownerId: z.string().min(1),
  link: z.object({ kind: z.string().min(1), ref: z.string().min(1) }).strict(),
  resolved: z.literal(false),
  reason: z.string().min(1),
}).strict();

export const DanglingSemanticReferenceSchema = z.object({
  ownerId: z.string().min(1),
  field: z.string().min(1),
  ref: z.string().min(1),
}).strict();

export const CoordinateGraphReportSchema = z.object({
  schemaVersion: z.literal(1),
  nodes: z.array(CoordinateNodeSchema),
  edges: z.array(CoordinateEdgeSchema),
  mapping: z.array(SourceKindLevelMappingSchema),
  coverage: z.array(LevelCoverageSchema),
  unsupported: z.array(UnsupportedCoordinateSourceSchema),
  unmapped: z.array(UnmappedCoordinateSourceSchema),
  staleLinks: z.array(StaleRepositoryLinkSchema).optional(),
  danglingReferences: z.array(DanglingSemanticReferenceSchema).optional(),
}).strict();

export const ControlFreshnessSealSchema = z.object({
  sealSchemaVersion: z.literal(1),
  kind: z.literal("control_freshness_seal"),
  algorithm: z.literal("sha256-v1"),
  repositoryRoot: z.string().min(1),
  indexedRepositoryRoot: z.string().min(1).nullable(),
  headAtCapture: z.string().min(1).nullable(),
  indexedHeadCommit: z.string().min(1).nullable(),
  repositoryGraphHash: Sha256HashSchema,
  indexedRepositoryGraphHash: Sha256HashSchema.nullable(),
  semanticModelHash: Sha256HashSchema,
  indexedSemanticModelHash: Sha256HashSchema.nullable(),
  analysisInputHash: Sha256HashSchema,
  indexedAnalysisInputHash: Sha256HashSchema.nullable(),
  workingDiffHash: Sha256HashSchema.nullable(),
  indexedWorkingDiffHash: Sha256HashSchema.nullable(),
  indexedAt: z.string().datetime().nullable(),
  storeSchemaVersion: z.number().int().nonnegative().nullable(),
  indexedStoreSchemaVersion: z.number().int().nonnegative().nullable(),
  toolVersion: z.string().min(1),
  indexedToolVersion: z.string().min(1).nullable(),
  sealHash: Sha256HashSchema,
}).strict();

export const ControlFreshnessVerdictSchema = z.enum(["FRESH", "DIRTY_KNOWN", "STALE", "UNSEALED"]);
export const ControlFreshnessReasonSchema = z.enum([
  "REPOSITORY_NOT_INITIALIZED",
  "REPOSITORY_NOT_INDEXED",
  "INDEX_SNAPSHOT_MISSING",
  "INDEX_SNAPSHOT_INVALID",
  "GIT_STATE_UNAVAILABLE",
  "STORE_SCHEMA_UNAVAILABLE",
  "REPOSITORY_ROOT_MISMATCH",
  "HEAD_MISMATCH",
  "REPOSITORY_GRAPH_MISMATCH",
  "SEMANTIC_MODEL_MISMATCH",
  "ANALYSIS_INPUT_MISMATCH",
  "WORKING_DIFF_MISMATCH",
  "STORE_SCHEMA_MISMATCH",
  "TOOL_VERSION_MISMATCH",
  "WORKING_TREE_DIRTY",
]);
export const ControlFreshnessStatusReportSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("control_freshness_status"),
  basis: z.literal("control_index_snapshot_v1"),
  verdict: ControlFreshnessVerdictSchema,
  canRunHighRiskControl: z.boolean(),
  reasons: z.array(ControlFreshnessReasonSchema),
  freshnessSeal: ControlFreshnessSealSchema.nullable(),
}).strict().superRefine((value, context) => {
  const allowed = value.verdict === "FRESH" || value.verdict === "DIRTY_KNOWN";
  if (value.canRunHighRiskControl !== allowed) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["canRunHighRiskControl"], message: "high-risk control is allowed only for fresh or sealed dirty inputs" });
  }
  if (value.verdict === "FRESH" && value.reasons.length > 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reasons"], message: "fresh status cannot carry reasons" });
  }
  if (value.verdict !== "FRESH" && value.reasons.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reasons"], message: "non-fresh status requires at least one reason" });
  }
  const uniqueReasons = new Set(value.reasons);
  if (uniqueReasons.size !== value.reasons.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reasons"], message: "freshness reasons must be unique" });
  }
  const reasonOrder = ControlFreshnessReasonSchema.options;
  const canonicalReasons = [...value.reasons].sort((left, right) => reasonOrder.indexOf(left) - reasonOrder.indexOf(right));
  if (canonicalReasons.some((reason, index) => reason !== value.reasons[index])) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reasons"], message: "freshness reasons must use canonical order" });
  }
  const unsealedReasons = new Set([
    "REPOSITORY_NOT_INITIALIZED",
    "REPOSITORY_NOT_INDEXED",
    "INDEX_SNAPSHOT_MISSING",
    "INDEX_SNAPSHOT_INVALID",
    "GIT_STATE_UNAVAILABLE",
    "STORE_SCHEMA_UNAVAILABLE",
  ]);
  const staleReasons = new Set([
    "REPOSITORY_ROOT_MISMATCH",
    "HEAD_MISMATCH",
    "REPOSITORY_GRAPH_MISMATCH",
    "SEMANTIC_MODEL_MISMATCH",
    "ANALYSIS_INPUT_MISMATCH",
    "WORKING_DIFF_MISMATCH",
    "STORE_SCHEMA_MISMATCH",
    "TOOL_VERSION_MISMATCH",
  ]);
  if (value.verdict === "DIRTY_KNOWN" && (value.reasons.length !== 1 || value.reasons[0] !== "WORKING_TREE_DIRTY")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reasons"], message: "sealed dirty status requires only WORKING_TREE_DIRTY" });
  }
  if (value.verdict === "STALE" && value.reasons.some((reason) => !staleReasons.has(reason))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reasons"], message: "stale status requires only mismatch reasons" });
  }
  if (value.verdict === "UNSEALED" && value.reasons.some((reason) => !unsealedReasons.has(reason))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reasons"], message: "unsealed status requires only unavailable-input reasons" });
  }
  if (value.freshnessSeal === null && value.verdict !== "UNSEALED") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["freshnessSeal"], message: "only unsealed status may omit the freshness seal" });
  }
  if (value.freshnessSeal !== null) {
    const expected = classifyControlFreshnessSeal(value.freshnessSeal as ControlFreshnessSeal);
    if (value.verdict !== expected.verdict) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["verdict"], message: "freshness verdict contradicts the embedded seal" });
    }
    if (
      value.reasons.length !== expected.reasons.length
      || value.reasons.some((reason, index) => reason !== expected.reasons[index])
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["reasons"], message: "freshness reasons contradict the embedded seal" });
    }
  }
});

export const TraversalDirectionSchema = z.enum(["lift", "lower"]);
const boundedDepth = z.number().int().min(0).max(100);
const boundedResults = z.number().int().min(1).max(10_000);
const boundedExpansions = z.number().int().min(1).max(100_000);
const boundedQueue = z.number().int().min(1).max(10_000);

export const TraversalReportSchema = z.object({
  schemaVersion: z.literal(1),
  direction: TraversalDirectionSchema,
  sourceId: QualifiedCoordinateIdSchema,
  targetLevel: SemanticLevelSchema,
  maxDepth: boundedDepth,
  maxResults: boundedResults,
  maxExpansions: boundedExpansions,
  maxQueue: boundedQueue,
  paths: z.array(CoordinatePathSchema),
  truncated: z.boolean(),
  freshnessSeal: ControlFreshnessSealSchema.optional(),
  freshnessStatus: ControlFreshnessStatusReportSchema.optional(),
}).strict();

export const ImpactedCoordinateSchema = z.object({
  id: QualifiedCoordinateIdSchema,
  paths: z.array(CoordinatePathSchema).min(1),
}).strict();

export const ImpactReportSchema = z.object({
  schemaVersion: z.literal(1),
  sourceIds: z.array(QualifiedCoordinateIdSchema).min(1),
  maxDepth: boundedDepth,
  maxResults: boundedResults,
  maxExpansions: boundedExpansions,
  maxQueue: boundedQueue,
  affected: z.array(ImpactedCoordinateSchema),
  truncated: z.boolean(),
}).strict();

export const ExplanationReportSchema = z.object({
  schemaVersion: z.literal(1),
  sourceId: QualifiedCoordinateIdSchema,
  maxDepth: boundedDepth,
  maxResults: boundedResults,
  maxExpansions: boundedExpansions,
  maxQueue: boundedQueue,
  known: z.boolean(),
  rationaleIds: z.array(QualifiedCoordinateIdSchema),
  paths: z.array(CoordinatePathSchema),
  unknownReason: z.enum(["coordinate_missing", "rationale_not_authored", "traversal_bound_reached"]).optional(),
}).strict().superRefine((value, context) => {
  if (value.known === (value.unknownReason !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "known explanations omit unknownReason; unknown explanations require it" });
  }
});

export const ArchitectureElementSchema = z.object({
  id: QualifiedCoordinateIdSchema,
  level: SemanticLevelSchema,
  category: CoordinateCategorySchema,
  fingerprint: z.string().min(1),
}).strict();

export const ArchitectureRelationSchema = z.object({
  from: QualifiedCoordinateIdSchema,
  to: QualifiedCoordinateIdSchema,
  relation: z.string().min(1),
  fingerprint: z.string().min(1),
}).strict();

const TimestampSchema = z.string().datetime({ offset: true });

export const ArchitectureSnapshotSchema = z.object({
  id: z.string().min(1),
  commit: z.string().min(1),
  capturedAt: TimestampSchema,
  elements: z.array(ArchitectureElementSchema),
  relations: z.array(ArchitectureRelationSchema),
}).strict().superRefine((value, context) => {
  reportDuplicates(value.elements.map((element) => element.id), context, ["elements"], "duplicate architecture element id");
  const elementIds = new Set(value.elements.map((element) => element.id));
  reportDuplicates(value.relations.map(relationKey), context, ["relations"], "duplicate architecture relation key");
  value.relations.forEach((relation, index) => {
    if (!elementIds.has(relation.from)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["relations", index, "from"], message: "relation source is absent from elements" });
    if (!elementIds.has(relation.to)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["relations", index, "to"], message: "relation target is absent from elements" });
  });
});

export const ChangedArchitectureElementSchema = z.object({
  id: QualifiedCoordinateIdSchema,
  before: ArchitectureElementSchema,
  after: ArchitectureElementSchema,
}).strict();

export const ChangedArchitectureRelationSchema = z.object({
  key: z.string().min(1),
  before: ArchitectureRelationSchema,
  after: ArchitectureRelationSchema,
}).strict();

export const ArchitectureDeltaSchema = z.object({
  currentSnapshotId: z.string().min(1),
  targetSnapshotId: z.string().min(1),
  added: z.array(ArchitectureElementSchema),
  removed: z.array(ArchitectureElementSchema),
  changed: z.array(ChangedArchitectureElementSchema),
  addedRelations: z.array(ArchitectureRelationSchema),
  removedRelations: z.array(ArchitectureRelationSchema),
  changedRelations: z.array(ChangedArchitectureRelationSchema),
  changedInvariantIds: z.array(QualifiedCoordinateIdSchema),
}).strict().superRefine((value, context) => {
  reportDuplicates([...value.added.map((item) => item.id), ...value.removed.map((item) => item.id), ...value.changed.map((item) => item.id)], context, [], "duplicate element id across delta partitions");
  reportDuplicates([
    ...value.addedRelations.map(relationKey),
    ...value.removedRelations.map(relationKey),
    ...value.changedRelations.map((item) => item.key),
  ], context, [], "duplicate relation key across delta partitions");
  reportDuplicates(value.changedInvariantIds, context, ["changedInvariantIds"], "duplicate changed invariant id");
  value.changed.forEach((item, index) => {
    if (item.id !== item.before.id || item.id !== item.after.id) context.addIssue({ code: z.ZodIssueCode.custom, path: ["changed", index], message: "changed element ids must agree" });
  });
  value.changedRelations.forEach((item, index) => {
    if (item.key !== relationKey(item.before) || item.key !== relationKey(item.after)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["changedRelations", index], message: "changed relation keys must agree" });
  });
});

export const ArchitectureComparisonReportSchema = z.object({
  schemaVersion: z.literal(1),
  current: ArchitectureSnapshotSchema,
  target: ArchitectureSnapshotSchema,
  delta: ArchitectureDeltaSchema,
}).strict();

export const ProofObligationSchema = z.enum([
  "baseline_captured",
  "behavior_characterized",
  "target_reviewed",
  "replacement_present",
  "shadow_equivalent",
  "cutover_approved",
  "observation_window_passed",
  "static_dependencies_zero",
  "runtime_dependencies_zero",
  "invariants_preserved",
  "data_migration_complete",
  "rollback_ready",
  "deletion_approved",
]);

export const ProofReferenceKindSchema = z.enum([
  "architecture",
  "static_analysis",
  "runtime_observation",
  "test",
  "history",
  "human_approval",
  "rollback",
  "other",
]);

export const ProofReferenceSchema = z.object({
  kind: ProofReferenceKindSchema,
  uri: z.string().min(1),
  nonLlm: z.boolean(),
}).strict();

export const ProofAttestationSchema = z.object({
  id: z.string().min(1),
  obligation: ProofObligationSchema,
  subject: z.string().min(1),
  epistemicStatus: EpistemicStatusSchema,
  references: z.array(ProofReferenceSchema).min(1),
  commit: z.string().min(1),
  observedAt: TimestampSchema,
  expiresAt: TimestampSchema,
}).strict().superRefine((value, context) => {
  if (Date.parse(value.observedAt) > Date.parse(value.expiresAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "expiry precedes observation" });
  }
});

export const ProofRequirementClauseSchema = z.object({
  statuses: z.array(EpistemicStatusSchema).min(1),
  referenceKinds: z.array(ProofReferenceKindSchema).min(1).optional(),
  requireNonLlmReference: z.boolean().optional(),
}).strict();

export const ProofObligationPolicySchema = z.object({
  obligation: ProofObligationSchema,
  allOf: z.array(ProofRequirementClauseSchema).min(1),
  prerequisiteObligations: z.array(ProofObligationSchema),
}).strict();

export const MigrationStateSchema = z.enum([
  "OBSERVED",
  "MODELED",
  "TARGET_PROPOSED",
  "PROOFS_DEFINED",
  "PARALLEL_IMPLEMENTATION",
  "SHADOW_VALIDATED",
  "CUTOVER",
  "LEGACY_REMOVABLE",
  "DELETED",
]);

export const RiskLevelSchema = z.enum(["R0", "R1", "R2", "R3"]);
export const MigrationStepKindSchema = z.enum([
  "capture",
  "characterize",
  "introduce",
  "shadow_compare",
  "cutover",
  "observe",
  "deletion_check",
]);
export const MigrationStepProfileSchema = z.enum([
  "capture_baseline", "characterize_behavior", "define_target_proofs", "introduce_parallel",
  "shadow_validate", "cutover_replacement", "observe_cutover", "authorize_deletion",
]);

export const RollbackPlanSchema = z.object({
  description: z.string().min(1),
  testReference: z.string().min(1),
}).strict();

export const MigrationStepSchema = z.object({
  id: z.string().min(1),
  kind: MigrationStepKindSchema,
  profile: MigrationStepProfileSchema,
  title: z.string().min(1),
  fromState: MigrationStateSchema,
  toState: MigrationStateSchema,
  risk: RiskLevelSchema,
  dependsOn: z.array(z.string().min(1)),
  affectedCoordinateIds: z.array(QualifiedCoordinateIdSchema),
  proofObligations: z.array(ProofObligationSchema),
  rollback: RollbackPlanSchema.optional(),
  changesL4Invariant: z.boolean(),
}).strict().superRefine((value, context) => {
  if ((value.risk === "R2" || value.risk === "R3") && value.rollback === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["rollback"], message: "R2/R3 steps require rollback" });
  }
  if ((value.risk === "R2" || value.risk === "R3") && !value.proofObligations.includes("rollback_ready")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["proofObligations"], message: "R2/R3 steps require rollback_ready proof" });
  }
  const profile = MIGRATION_STEP_PROFILES.find((candidate) => candidate.profile === value.profile);
  if (!profile || profile.kind !== value.kind || profile.fromState !== value.fromState || profile.toState !== value.toState || profile.risk !== value.risk) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["profile"], message: "step does not match its canonical profile" });
  } else {
    for (const obligation of profile.minimumProofObligations) if (!value.proofObligations.includes(obligation)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["proofObligations"], message: `profile requires ${obligation}` });
    }
  }
});

export const MigrationPlanStatusSchema = z.enum(["READY", "BLOCKED"]);
export const MigrationPlanBlockedReasonSchema = z.enum([
  "control_inputs_stale",
  "control_inputs_unsealed",
  "target_architecture_missing",
  "architecture_delta_missing",
  "architecture_delta_inconsistent",
  "migration_cycle_detected",
  "open_unknowns",
  "required_evidence_unsatisfied",
]);

export const PlanningEvidenceRequirementSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["satisfied", "unsatisfied", "waived"]),
  satisfied: z.boolean(),
  attestationIds: z.array(z.string().min(1)),
}).strict().superRefine((value, context) => {
  if (value.satisfied !== (value.status === "satisfied" || value.status === "waived")) context.addIssue({ code: z.ZodIssueCode.custom, message: "status and satisfied disagree" });
  if (value.status === "satisfied" && value.attestationIds.length === 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ["attestationIds"], message: "satisfied evidence requires an attestation" });
});
export const ChangePlanningContextSchema = z.object({
  id: z.string().min(1),
  serves: z.array(z.string().min(1)),
  preserves: z.array(z.string().min(1)),
  requiredEvidence: z.array(PlanningEvidenceRequirementSchema),
  openUnknowns: z.array(z.string().min(1)),
}).strict().superRefine((value, context) => {
  reportDuplicates(value.serves, context, ["serves"], "duplicate served goal");
  reportDuplicates(value.preserves, context, ["preserves"], "duplicate preserved invariant");
  reportDuplicates(value.requiredEvidence.map((item) => item.id), context, ["requiredEvidence"], "duplicate evidence requirement");
  reportDuplicates(value.openUnknowns, context, ["openUnknowns"], "duplicate open unknown");
});
export const MigrationPlanBlockedDetailSchema = z.object({
  schemaVersion: z.literal(1), reason: MigrationPlanBlockedReasonSchema,
  subjectIds: z.array(z.string().min(1)), message: z.string().min(1),
}).strict();

export const MigrationPlanSchema = z.object({
  id: z.string().min(1),
  changeId: z.string().min(1),
  planningCommit: z.string().min(1),
  status: MigrationPlanStatusSchema,
  blockedReason: MigrationPlanBlockedReasonSchema.optional(),
  blockedDetails: z.array(MigrationPlanBlockedDetailSchema),
  planningContext: ChangePlanningContextSchema,
  current: ArchitectureSnapshotSchema,
  target: ArchitectureSnapshotSchema.optional(),
  delta: ArchitectureDeltaSchema.optional(),
  steps: z.array(MigrationStepSchema),
  outstandingObligations: z.array(ProofObligationSchema),
}).strict().superRefine((value, context) => {
  if (value.status === "BLOCKED" && value.blockedReason === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["blockedReason"], message: "blocked plans require a reason" });
  }
  if (value.status === "READY" && value.blockedReason !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["blockedReason"], message: "ready plans cannot carry a blocked reason" });
  }
  if (value.status === "READY" && (value.target === undefined || value.delta === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "ready plans require target and delta" });
  }
  if (value.status === "READY" && value.blockedDetails.length > 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ["blockedDetails"], message: "ready plans cannot carry blocked details" });
  if (value.status === "BLOCKED" && value.blockedDetails.length === 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ["blockedDetails"], message: "blocked plans require details" });
  if (value.status === "READY" && (value.steps.length !== MIGRATION_STEP_PROFILES.length || value.steps.some((step, index) => step.profile !== MIGRATION_STEP_PROFILES[index]?.profile))) context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: "ready plans require the canonical ordered eight-profile DAG" });
  if (value.planningContext.id !== value.changeId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["planningContext", "id"], message: "planning context id must match changeId" });
  if (value.planningCommit !== value.current.commit) context.addIssue({ code: z.ZodIssueCode.custom, path: ["planningCommit"], message: "planning commit must match current snapshot" });
  if (value.delta && (value.delta.currentSnapshotId !== value.current.id || value.delta.targetSnapshotId !== value.target?.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["delta"], message: "delta snapshot ids must match the plan snapshots" });
  if (value.status === "READY") value.steps.forEach((step, index) => {
    const expected = index === 0 ? [] : [value.steps[index - 1]!.id];
    if (JSON.stringify(step.dependsOn) !== JSON.stringify(expected)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index, "dependsOn"], message: "canonical DAG steps must depend exactly on their predecessor" });
  });
  validateMigrationDag(value.steps, context);
});

export const MigrationPlanReportSchema = z.object({
  schemaVersion: z.literal(1),
  plan: MigrationPlanSchema,
  freshnessSeal: ControlFreshnessSealSchema.optional(),
  freshnessStatus: ControlFreshnessStatusReportSchema.optional(),
}).strict();

export const AuthorizationDecisionSchema = z.enum(["ALLOW", "DENY"]);
export const AuthorizationReasonSchema = z.enum([
  "transition_not_adjacent",
  "terminal_state",
  "dependency_incomplete",
  "proof_missing",
  "proof_subject_mismatch",
  "proof_commit_mismatch",
  "proof_stale",
  "proof_epistemically_insufficient",
  "rollback_missing",
  "rollback_untested",
  "human_approval_missing",
  "invariant_approval_missing",
  "plan_blocked",
  "input_invalid", "plan_invalid", "step_invalid", "execution_state_invalid",
  "execution_plan_mismatch", "execution_commit_mismatch", "execution_state_stale",
  "completion_invalid", "profile_mismatch", "deletion_denied",
]);
export const AuthorizationDetailSchema = z.object({
  reason: AuthorizationReasonSchema, subjectId: z.string().min(1).optional(), message: z.string().min(1),
}).strict();

export const ProofEvaluationSchema = z.object({
  obligation: ProofObligationSchema,
  satisfied: z.boolean(),
  acceptedAttestationIds: z.array(z.string()),
  reasons: z.array(AuthorizationReasonSchema),
}).strict();

export const TransitionAuthorizationReportSchema = z.object({
  schemaVersion: z.literal(1),
  decision: AuthorizationDecisionSchema,
  fromState: MigrationStateSchema,
  toState: MigrationStateSchema,
  risk: RiskLevelSchema,
  reasons: z.array(AuthorizationReasonSchema),
  proofEvaluations: z.array(ProofEvaluationSchema),
  details: z.array(AuthorizationDetailSchema),
}).strict();

export const StepAuthorizationReportSchema = z.object({
  schemaVersion: z.literal(1),
  decision: AuthorizationDecisionSchema,
  stepId: z.string().min(1),
  reasons: z.array(AuthorizationReasonSchema),
  missingDependencies: z.array(z.string()),
  proofEvaluations: z.array(ProofEvaluationSchema),
  details: z.array(AuthorizationDetailSchema),
}).strict();

export const DeletionAuthorizationReportSchema = z.object({
  schemaVersion: z.literal(1),
  decision: AuthorizationDecisionSchema,
  subject: z.string().min(1),
  reasons: z.array(AuthorizationReasonSchema),
  proofEvaluations: z.array(ProofEvaluationSchema),
  details: z.array(AuthorizationDetailSchema),
}).strict();

export const TransitionAuthorizationInputSchema = z.object({
  fromState: MigrationStateSchema,
  toState: MigrationStateSchema,
  risk: RiskLevelSchema,
  subject: z.string().min(1),
  planningCommit: z.string().min(1),
  evaluatedAt: TimestampSchema,
  proofObligations: z.array(ProofObligationSchema),
  attestations: z.array(ProofAttestationSchema),
  rollback: RollbackPlanSchema.optional(),
  changesL4Invariant: z.boolean(),
}).strict();

export const StepAuthorizationInputSchema = z.object({
  plan: MigrationPlanSchema,
  step: MigrationStepSchema,
  executionState: z.lazy(() => ExecutionStateSchema),
  attestations: z.array(ProofAttestationSchema),
  evaluatedAt: TimestampSchema,
}).strict();

export const StepCompletionSchema = z.object({
  stepId: z.string().min(1), planId: z.string().min(1), commit: z.string().min(1),
  observedAt: TimestampSchema, expiresAt: TimestampSchema, attestationIds: z.array(z.string().min(1)).min(1),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.observedAt) > Date.parse(value.expiresAt)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "expiry precedes observation" });
});
export const ExecutionStateSchema: z.ZodTypeAny = z.object({
  schemaVersion: z.literal(1), planId: z.string().min(1), planningCommit: z.string().min(1),
  currentState: MigrationStateSchema, recordedAt: TimestampSchema, completedSteps: z.array(StepCompletionSchema),
}).strict().superRefine((value, context) => reportDuplicates(value.completedSteps.map((item: { stepId: string }) => item.stepId), context, ["completedSteps"], "duplicate completed step"));

export const DeletionAuthorizationInputSchema = z.object({
  subject: z.string().min(1),
  planningCommit: z.string().min(1),
  evaluatedAt: TimestampSchema,
  attestations: z.array(ProofAttestationSchema),
}).strict();

export const MigrationPlanningInputSchema = z.object({
  change: ChangePlanningContextSchema,
  current: ArchitectureSnapshotSchema,
  target: ArchitectureSnapshotSchema.optional(),
  delta: ArchitectureDeltaSchema.optional(),
}).strict();

export const PublicControlReportSchema = z.union([
  CoordinateGraphReportSchema,
  ControlFreshnessStatusReportSchema,
  TraversalReportSchema,
  ImpactReportSchema,
  ExplanationReportSchema,
  ArchitectureComparisonReportSchema,
  MigrationPlanReportSchema,
  TransitionAuthorizationReportSchema,
  StepAuthorizationReportSchema,
  DeletionAuthorizationReportSchema,
]);

function relationKey(relation: { from: string; to: string; relation: string }): string { return `${relation.from}\u0000${relation.to}\u0000${relation.relation}`; }
function reportDuplicates(values: string[], context: z.RefinementCtx, path: (string | number)[], message: string): void {
  const seen = new Set<string>();
  values.forEach((value, index) => { if (seen.has(value)) context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, index], message }); else seen.add(value); });
}
function validateMigrationDag(steps: Array<{ id: string; profile: string; dependsOn: string[] }>, context: z.RefinementCtx): void {
  reportDuplicates(steps.map((step) => step.id), context, ["steps"], "duplicate migration step id");
  reportDuplicates(steps.map((step) => step.profile), context, ["steps"], "duplicate migration step profile");
  const ids = new Set(steps.map((step) => step.id));
  steps.forEach((step, index) => step.dependsOn.forEach((dependency) => { if (!ids.has(dependency)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index, "dependsOn"], message: "dependency is absent from plan" }); }));
  const visiting = new Set<string>(); const visited = new Set<string>(); const byId = new Map(steps.map((step) => [step.id, step]));
  const visit = (id: string): boolean => { if (visiting.has(id)) return true; if (visited.has(id)) return false; visiting.add(id); for (const dependency of byId.get(id)?.dependsOn ?? []) if (visit(dependency)) return true; visiting.delete(id); visited.add(id); return false; };
  if (steps.some((step) => visit(step.id))) context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: "migration DAG contains a cycle" });
}
