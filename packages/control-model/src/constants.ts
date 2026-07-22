import type {
  CoordinateCategory,
  EpistemicStatus,
  MigrationState,
  MigrationStepProfileDefinition,
  MigrationStepKind,
  ProofObligation,
  ProofObligationPolicy,
  RiskLevel,
  SemanticLevel,
  Sha256Hash,
  SourceKindLevelMapping,
} from "./types";
import { compareCodeUnits } from "./ordering";

export const SEMANTIC_LEVELS = [0, 1, 2, 3, 4, 5, 6] as const satisfies readonly SemanticLevel[];

/** Hash of the canonical empty Git working-diff capture (`{ "entries": [] }`). */
export const CLEAN_CONTROL_WORKING_DIFF_HASH = "sha256:21dba70935f8f14f59199087ee440e16bec5dc567d8449b2cedf0c59c592abb1" as const satisfies Sha256Hash;

export const EPISTEMIC_STATUSES = [
  "human_declared",
  "statically_observed",
  "dynamically_observed",
  "test_observed",
  "historically_observed",
  "llm_inferred",
  "hypothetical",
] as const satisfies readonly EpistemicStatus[];

export const COORDINATE_CATEGORIES = [
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
] as const satisfies readonly CoordinateCategory[];

const repositoryMapping = {
  repository: [6, "system"],
  decision: [5, "decision"],
  invariant: [4, "invariant"],
  capability: [3, "capability"],
  package: [2, "module"],
  module: [2, "module"],
  bounded_context: [2, "bounded_context"],
  symbol: [1, "code_entity"],
  type: [1, "code_entity"],
  function: [1, "code_entity"],
  class: [1, "code_entity"],
  interface: [1, "code_entity"],
  enum: [1, "code_entity"],
  test: [1, "code_entity"],
  migration: [1, "code_entity"],
  document: [1, "code_entity"],
  contract: [1, "code_entity"],
  risk: [1, "code_entity"],
  external_integration: [1, "code_entity"],
} as const satisfies Record<string, readonly [SemanticLevel, CoordinateCategory]>;

export const REPOSITORY_LEVEL_MAPPING: readonly SourceKindLevelMapping[] = Object.entries(repositoryMapping)
  .map(([sourceKind, [level, category]]) => ({ plane: "repo" as const, sourceKind, level, category, supported: true }))
  .sort((a, b) => compareCodeUnits(a.sourceKind, b.sourceKind));

const semanticLevelMapping: SourceKindLevelMapping[] = [
  { plane: "semantic", sourceKind: "goal", level: 5, category: "goal", supported: true },
  { plane: "semantic", sourceKind: "decision", level: 5, category: "decision", supported: true },
  { plane: "semantic", sourceKind: "invariant", level: 4, category: "invariant", supported: true },
  { plane: "semantic", sourceKind: "assumption", level: null, category: null, supported: false, reason: "control_support_artifact" },
  { plane: "semantic", sourceKind: "unknown", level: null, category: null, supported: false, reason: "control_support_artifact" },
  { plane: "semantic", sourceKind: "evidence", level: null, category: null, supported: false, reason: "control_support_artifact" },
  { plane: "semantic", sourceKind: "change", level: null, category: null, supported: false, reason: "control_support_artifact" },
];

export const SEMANTIC_LEVEL_MAPPING: readonly SourceKindLevelMapping[] = semanticLevelMapping
  .sort((a, b) => compareCodeUnits(a.sourceKind, b.sourceKind));

export const NORMATIVE_LEVEL_MAPPING: readonly SourceKindLevelMapping[] = [
  ...REPOSITORY_LEVEL_MAPPING,
  ...SEMANTIC_LEVEL_MAPPING,
];

export const MIGRATION_STATES = [
  "OBSERVED",
  "MODELED",
  "TARGET_PROPOSED",
  "PROOFS_DEFINED",
  "PARALLEL_IMPLEMENTATION",
  "SHADOW_VALIDATED",
  "CUTOVER",
  "LEGACY_REMOVABLE",
  "DELETED",
] as const satisfies readonly MigrationState[];

export const MIGRATION_STEP_KINDS = [
  "capture",
  "characterize",
  "introduce",
  "shadow_compare",
  "cutover",
  "observe",
  "deletion_check",
] as const satisfies readonly MigrationStepKind[];

export const RISK_LEVELS = ["R0", "R1", "R2", "R3"] as const satisfies readonly RiskLevel[];

export const PROOF_OBLIGATIONS = [
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
] as const satisfies readonly ProofObligation[];

export const DELETION_PREREQUISITE_OBLIGATIONS = [
  "replacement_present",
  "shadow_equivalent",
  "cutover_approved",
  "observation_window_passed",
  "static_dependencies_zero",
  "runtime_dependencies_zero",
  "invariants_preserved",
  "data_migration_complete",
  "rollback_ready",
] as const satisfies readonly ProofObligation[];

/** The only eight migration transition profiles accepted by Plane C. */
export const MIGRATION_STEP_PROFILES: readonly Readonly<MigrationStepProfileDefinition>[] = Object.freeze([
  profile("capture_baseline", "capture", "OBSERVED", "MODELED", "R0", ["baseline_captured"]),
  profile("characterize_behavior", "characterize", "MODELED", "TARGET_PROPOSED", "R0", ["behavior_characterized"]),
  profile("define_target_proofs", "introduce", "TARGET_PROPOSED", "PROOFS_DEFINED", "R1", ["target_reviewed"]),
  profile("introduce_parallel", "introduce", "PROOFS_DEFINED", "PARALLEL_IMPLEMENTATION", "R1", ["replacement_present"]),
  profile("shadow_validate", "shadow_compare", "PARALLEL_IMPLEMENTATION", "SHADOW_VALIDATED", "R2", ["shadow_equivalent", "invariants_preserved", "rollback_ready"]),
  profile("cutover_replacement", "cutover", "SHADOW_VALIDATED", "CUTOVER", "R3", ["cutover_approved", "invariants_preserved", "rollback_ready"]),
  profile("observe_cutover", "observe", "CUTOVER", "LEGACY_REMOVABLE", "R2", ["observation_window_passed", "rollback_ready"]),
  profile("authorize_deletion", "deletion_check", "LEGACY_REMOVABLE", "DELETED", "R3", [...DELETION_PREREQUISITE_OBLIGATIONS, "deletion_approved"]),
]);

export const PROOF_SUFFICIENCY_MATRIX: Readonly<Record<ProofObligation, ProofObligationPolicy>> = {
  baseline_captured: policy("baseline_captured", [["statically_observed", "dynamically_observed"]]),
  behavior_characterized: policy("behavior_characterized", [["test_observed", "dynamically_observed"]]),
  target_reviewed: policy("target_reviewed", [["human_declared"]], [], {
    referenceKinds: ["architecture"], requireNonLlmReference: true,
  }),
  replacement_present: policy("replacement_present", [["statically_observed"]]),
  shadow_equivalent: policy("shadow_equivalent", [["test_observed"], ["dynamically_observed"]]),
  cutover_approved: policy("cutover_approved", [["human_declared"], ["test_observed", "dynamically_observed"]]),
  observation_window_passed: policy("observation_window_passed", [["dynamically_observed"]]),
  static_dependencies_zero: policy("static_dependencies_zero", [["statically_observed"]]),
  runtime_dependencies_zero: policy("runtime_dependencies_zero", [["dynamically_observed"]]),
  invariants_preserved: policy("invariants_preserved", [["test_observed"]]),
  data_migration_complete: policy("data_migration_complete", [["dynamically_observed", "test_observed"]]),
  rollback_ready: policy("rollback_ready", [["test_observed"]]),
  deletion_approved: policy("deletion_approved", [["human_declared"]], [...DELETION_PREREQUISITE_OBLIGATIONS]),
};

function policy(
  obligation: ProofObligation,
  statusClauses: EpistemicStatus[][],
  prerequisiteObligations: ProofObligation[] = [],
  referenceRequirement?: { referenceKinds: ("architecture")[]; requireNonLlmReference: boolean },
): ProofObligationPolicy {
  return {
    obligation,
    allOf: statusClauses.map((statuses, index) => ({
      statuses,
      ...(index === 0 && referenceRequirement ? referenceRequirement : {}),
    })),
    prerequisiteObligations,
  };
}

function profile(
  profileName: MigrationStepProfileDefinition["profile"],
  kind: MigrationStepKind,
  fromState: MigrationState,
  toState: MigrationState,
  risk: RiskLevel,
  minimumProofObligations: ProofObligation[],
): Readonly<MigrationStepProfileDefinition> {
  return Object.freeze({ profile: profileName, kind, fromState, toState, risk, minimumProofObligations: Object.freeze([...minimumProofObligations]) as ProofObligation[] });
}
