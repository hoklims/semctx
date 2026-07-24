import {
  PlanningBundleV1Schema,
  RepositoryEditExpectationV1Schema,
  SemanticChangeSetV1Schema,
  SemanticExpectationV1Schema,
  TaskEnvelopeV1Schema,
  computePlanningBundleV1Hash,
  computeSemanticChangeSetV1Hash,
  normalizePlanningBundleV1,
  normalizeSemanticChangeSetV1,
  serializeControlReport,
  sha256HashUtf8,
  type PlanningBundleV1,
  type RefinementProfileV1,
  type RepositoryEditExpectationV1,
  type SemanticChangeSetV1,
  type SemanticExpectationV1,
  type SemanticRefinementStepV1,
  type TaskEnvelopeV1,
  type TaskModeV1,
  type TaskRiskV1,
  type WorkspaceBaselineSnapshotV1,
} from "@semantic-context/control-model/reconciliation";

export interface RefinementProfileSelectionInput {
  mode: TaskModeV1;
  riskSignals: readonly string[];
  profileCandidate?: RefinementProfileV1;
  altitudeCandidate?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  hasAuthoredTarget: boolean;
}

export interface RefinementProfileSelectionV1 {
  profile: RefinementProfileV1;
  risk: TaskRiskV1;
  requiredAltitude: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  candidateDisposition: "absent" | "accepted" | "overridden";
  reasons: readonly string[];
}

export interface CompileSemanticChangeSetInput {
  envelope: TaskEnvelopeV1;
  semanticExpectations?: readonly SemanticExpectationV1[];
  repositoryEditExpectations?: readonly RepositoryEditExpectationV1[];
  rollbackDescription: string;
  testReferences?: readonly string[];
  acceptanceEvidenceIds?: readonly string[];
  proofObligationIds?: readonly string[];
}

/** Internal-only input used by the future app-service certifying constructor. */
export interface BuildPlanningBundleInternalInput {
  envelope: TaskEnvelopeV1;
  changeSet: SemanticChangeSetV1;
  baseline: WorkspaceBaselineSnapshotV1;
}

interface ProfileTemplate {
  phases: readonly string[];
  expectationKind: SemanticExpectationV1["kind"];
  expectationLevel: SemanticExpectationV1["level"];
  concreteEditFloor: "required" | "diagnostic";
}

const PROFILE_ALTITUDE: Record<RefinementProfileV1, 0 | 1 | 2 | 3 | 4 | 5 | 6> = {
  local_patch: 1,
  refactor: 2,
  feature: 3,
  redesign: 5,
  migration: 6,
};

const PROFILE_RISK: Record<RefinementProfileV1, TaskRiskV1> = {
  local_patch: "R1",
  refactor: "R2",
  feature: "R2",
  redesign: "R3",
  migration: "R3",
};

const PROFILE_ORDER: readonly RefinementProfileV1[] = [
  "local_patch",
  "refactor",
  "feature",
  "redesign",
  "migration",
];

const MIGRATION_REFINEMENT_STEPS = [
  {
    phase: "capture_baseline",
    proofObligationIds: ["baseline_captured"],
  },
  {
    phase: "characterize_behavior",
    proofObligationIds: ["behavior_characterized"],
  },
  {
    phase: "define_target_proofs",
    proofObligationIds: ["target_reviewed"],
  },
  {
    phase: "introduce_parallel",
    proofObligationIds: ["replacement_present"],
  },
  {
    phase: "shadow_validate",
    proofObligationIds: [
      "shadow_equivalent",
      "invariants_preserved",
      "rollback_ready",
    ],
  },
  {
    phase: "cutover_replacement",
    proofObligationIds: [
      "cutover_approved",
      "invariants_preserved",
      "rollback_ready",
    ],
  },
  {
    phase: "observe_cutover",
    proofObligationIds: ["observation_window_passed", "rollback_ready"],
  },
  {
    phase: "deletion_readiness",
    proofObligationIds: [
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
    ],
  },
] as const;

const PROFILE_TEMPLATES: Record<RefinementProfileV1, ProfileTemplate> = {
  local_patch: {
    phases: ["localize", "bind_repository", "verify"],
    expectationKind: "contract",
    expectationLevel: 2,
    concreteEditFloor: "required",
  },
  refactor: {
    phases: ["characterize", "preserve", "bind_repository", "verify"],
    expectationKind: "invariant",
    expectationLevel: 4,
    concreteEditFloor: "required",
  },
  feature: {
    phases: ["define_capability", "refine_contract", "bind_repository", "verify"],
    expectationKind: "capability",
    expectationLevel: 3,
    concreteEditFloor: "diagnostic",
  },
  redesign: {
    phases: ["capture_baseline", "define_target", "refine_architecture", "bind_repository", "verify"],
    expectationKind: "target_element",
    expectationLevel: 5,
    concreteEditFloor: "diagnostic",
  },
  migration: {
    phases: MIGRATION_REFINEMENT_STEPS.map((step) => step.phase),
    expectationKind: "target_element",
    expectationLevel: 6,
    concreteEditFloor: "required",
  },
};

export function selectRefinementProfile(
  input: RefinementProfileSelectionInput,
): RefinementProfileSelectionV1 {
  const modeFloor = profileForMode(input.mode);
  const signalRisk = inferRisk(input.mode, input.riskSignals);
  const riskFloor = profileForRisk(signalRisk, input.mode);
  const altitudeFloor = profileForAltitude(input.altitudeCandidate ?? 0, input.mode);
  const minimumProfile = highestProfile([modeFloor, riskFloor, altitudeFloor]);
  let profile = minimumProfile;
  const reasons = [
    `profile_floor:mode:${modeFloor}`,
    `profile_floor:risk:${riskFloor}`,
    `profile_floor:altitude:${altitudeFloor}`,
  ];
  let disposition: RefinementProfileSelectionV1["candidateDisposition"] = "absent";

  if (input.profileCandidate !== undefined) {
    if (
      candidateAllowed(input.profileCandidate, input.mode, input.hasAuthoredTarget)
      && profileRank(input.profileCandidate) >= profileRank(minimumProfile)
    ) {
      profile = input.profileCandidate;
      disposition = "accepted";
      reasons.push(`profile_candidate_accepted:${input.profileCandidate}`);
    } else {
      disposition = "overridden";
      reasons.push(`profile_candidate_overridden:${input.profileCandidate}->${minimumProfile}`);
    }
  }

  const risk = maxRisk(signalRisk, PROFILE_RISK[profile]);
  const requiredAltitude = maxAltitude(
    PROFILE_ALTITUDE[profile],
    input.altitudeCandidate ?? 0,
  );
  if (
    (profile === "redesign" || profile === "migration")
    && !input.hasAuthoredTarget
  ) reasons.push(`target_binding_missing:${profile}:diagnostic_only`);
  return {
    profile,
    risk,
    requiredAltitude,
    candidateDisposition: disposition,
    reasons: sortedUnique(reasons),
  };
}

/**
 * Compiles a descriptive ChangeSet only. It never promotes a target to
 * accepted: that admission belongs to the future app-service boundary.
 */
export function compileSemanticChangeSet(
  input: CompileSemanticChangeSetInput,
): SemanticChangeSetV1 {
  const envelope = TaskEnvelopeV1Schema.parse(input.envelope) as TaskEnvelopeV1;
  const template = PROFILE_TEMPLATES[envelope.profile];
  const parsedExpectations = (input.semanticExpectations ?? [])
    .map((expectation) => SemanticExpectationV1Schema.parse(expectation) as SemanticExpectationV1);
  const generatedDefaultExpectation =
    parsedExpectations.length === 0 && envelope.profile !== "local_patch";
  const semanticExpectations = normalizeExpectations(
    generatedDefaultExpectation
      ? [defaultExpectation(envelope, template)]
      : parsedExpectations,
  );
  let repositoryEditExpectations = normalizeEdits(
    (input.repositoryEditExpectations ?? [])
      .map((edit) => RepositoryEditExpectationV1Schema.parse(edit) as RepositoryEditExpectationV1),
  );
  if (generatedDefaultExpectation) {
    const defaultExpectationId = semanticExpectations[0]!.expectationId;
    repositoryEditExpectations = repositoryEditExpectations.map((edit) =>
      edit.required
        ? {
            ...edit,
            expectedLiftedExpectationIds: sortedUnique([
              ...edit.expectedLiftedExpectationIds,
              defaultExpectationId,
            ]),
          }
        : edit
    );
  }
  for (const edit of repositoryEditExpectations) assertEditCovered(envelope, edit);

  const requiredEdits = repositoryEditExpectations.filter((edit) => edit.required);
  if (template.concreteEditFloor === "required" && requiredEdits.length === 0) {
    throw new Error(`${envelope.profile} requires at least one required repository edit expectation`);
  }
  const refinementSteps = templateRefinementSteps(
    envelope.profile,
    semanticExpectations,
    repositoryEditExpectations,
  );
  const acceptanceEvidenceIds = sortedUnique([
    ...envelope.proofObligationIds,
    ...(input.acceptanceEvidenceIds ?? []),
  ]);
  const nestedAcceptanceEvidenceIds = sortedUnique([
    ...semanticExpectations.flatMap((expectation) => expectation.acceptanceEvidenceIds),
    ...repositoryEditExpectations.flatMap((edit) => edit.acceptanceEvidenceIds),
  ]);
  const representedEvidenceIds = new Set([
    ...acceptanceEvidenceIds,
    ...nestedAcceptanceEvidenceIds,
  ]);
  // Profile predicates stay structural. This channel contains only external
  // requirements that reconciliation can satisfy with sealed evidence.
  const proofObligationIds = sortedUnique([
    ...(input.proofObligationIds ?? []),
    ...(envelope.profile === "migration"
      ? MIGRATION_REFINEMENT_STEPS.flatMap((step) => step.proofObligationIds)
      : []),
  ]).filter((id) => !representedEvidenceIds.has(id));
  const normalizedDraft = normalizeSemanticChangeSetV1({
    schemaVersion: 1,
    kind: "semantic_change_set",
    executionAuthority: "none",
    changeSetId: "change-set:pending",
    changeSetHash: sha256HashUtf8("pending"),
    envelopeId: envelope.envelopeId,
    envelopeHash: envelope.envelopeHash,
    planningCommit: envelope.planningCommit,
    profile: envelope.profile,
    declaredReconciliationScope: envelope.declaredReconciliationScope,
    refinementSteps,
    semanticExpectations,
    repositoryEditExpectations,
    rollbackDescription: input.rollbackDescription,
    testReferences: sortedUnique(input.testReferences ?? []),
    acceptanceEvidenceIds,
    proofObligationIds,
  });
  const {
    changeSetId: _pendingId,
    changeSetHash: _pendingHash,
    ...identityPayload
  } = normalizedDraft;
  const withIdentity = {
    ...normalizedDraft,
    changeSetId: `change-set:${digestId(identityPayload)}`,
  };
  const changeSet = {
    ...withIdentity,
    changeSetHash: computeSemanticChangeSetV1Hash(withIdentity),
  };
  return SemanticChangeSetV1Schema.parse(changeSet) as SemanticChangeSetV1;
}

/**
 * Internal primitive intentionally omitted from `@semantic-context/control-engine/planning`.
 * G005's app-service owns certifying reconstruction and target admission.
 */
export function buildPlanningBundleInternal(
  input: BuildPlanningBundleInternalInput,
): PlanningBundleV1 {
  const envelope = TaskEnvelopeV1Schema.parse(input.envelope) as TaskEnvelopeV1;
  const changeSet = SemanticChangeSetV1Schema.parse(input.changeSet) as SemanticChangeSetV1;
  if (changeSet.targetBinding !== undefined) {
    throw new Error("diagnostic control-engine bundles cannot certify an accepted target");
  }
  if (
    envelope.planningCommit !== input.baseline.planningCommit
    || changeSet.planningCommit !== input.baseline.planningCommit
  ) throw new Error("planning bundle inputs must share one planning commit");
  const payload: Omit<PlanningBundleV1, "bundleHash"> = {
    schemaVersion: 1,
    kind: "planning_bundle",
    executionAuthority: "none",
    bundleId: `planning-bundle:${digestId({
      envelopeHash: envelope.envelopeHash,
      changeSetHash: changeSet.changeSetHash,
      baseline: input.baseline,
    })}`,
    planningCommit: envelope.planningCommit,
    taskEnvelope: envelope,
    semanticChangeSet: changeSet,
    baseline: input.baseline,
  };
  const normalized = normalizePlanningBundleV1({
    ...payload,
    bundleHash: sha256HashUtf8("pending"),
  });
  const bundle = {
    ...normalized,
    bundleHash: computePlanningBundleV1Hash(normalized),
  };
  return PlanningBundleV1Schema.parse(bundle) as PlanningBundleV1;
}

function profileForMode(mode: TaskModeV1): RefinementProfileV1 {
  if (mode === "migration") return "migration";
  if (mode === "feature") return "feature";
  if (mode === "refactor" || mode === "performance") return "refactor";
  return "local_patch";
}

function profileForRisk(risk: TaskRiskV1, mode: TaskModeV1): RefinementProfileV1 {
  if (mode === "migration") return "migration";
  if (risk === "R3") return "redesign";
  if (risk === "R2") return mode === "feature" ? "feature" : "refactor";
  return "local_patch";
}

function profileForAltitude(
  altitude: 0 | 1 | 2 | 3 | 4 | 5 | 6,
  mode: TaskModeV1,
): RefinementProfileV1 {
  if (mode === "migration") return "migration";
  if (altitude >= 5) return "redesign";
  if (altitude >= 3) return "feature";
  if (altitude === 2) return "refactor";
  return "local_patch";
}

function candidateAllowed(
  candidate: RefinementProfileV1,
  mode: TaskModeV1,
  hasAuthoredTarget: boolean,
): boolean {
  if (candidate === "migration") return mode === "migration" && hasAuthoredTarget;
  if (candidate === "redesign") return hasAuthoredTarget;
  if (candidate === "feature") return mode === "feature";
  if (candidate === "refactor") return mode === "refactor" || mode === "performance";
  return mode !== "migration";
}

function inferRisk(mode: TaskModeV1, signals: readonly string[]): TaskRiskV1 {
  const normalized = signals.map((signal) => signal.toLowerCase());
  if (
    mode === "migration"
    || mode === "security"
    || normalized.some((signal) =>
      signal.includes("critical")
      || signal.includes("security")
      || signal.includes("cutover")
      || signal.includes("delete")
    )
  ) return "R3";
  if (
    mode === "feature"
    || mode === "refactor"
    || mode === "performance"
    || normalized.some((signal) =>
      signal.includes("cross-package")
      || signal.includes("architecture")
      || signal.includes("data")
    )
  ) return "R2";
  return normalized.length === 0 ? "R0" : "R1";
}

function defaultExpectation(
  envelope: TaskEnvelopeV1,
  template: ProfileTemplate,
): SemanticExpectationV1 {
  return {
    schemaVersion: 1,
    expectationId: `expectation:${envelope.changeId}:${envelope.profile}`,
    kind: template.expectationKind,
    level: template.expectationLevel,
    required: true,
    subjectId: envelope.changeId,
    statement: envelope.expectedBehaviorDelta[0] ?? `Realize authored change ${envelope.changeId}`,
    acceptanceEvidenceIds: [],
  };
}

function templateRefinementSteps(
  profile: RefinementProfileV1,
  expectations: readonly SemanticExpectationV1[],
  edits: readonly RepositoryEditExpectationV1[],
): SemanticRefinementStepV1[] {
  const high = sortedUnique(
    expectations.filter((item) => item.level >= 4).map((item) => item.expectationId),
  );
  const low = sortedUnique(
    expectations.filter((item) => item.level < 4).map((item) => item.expectationId),
  );
  const editIds = sortedUnique(edits.map((item) => item.editId));
  return PROFILE_TEMPLATES[profile].phases.map((phase, index, phases) => ({
    schemaVersion: 1,
    stepId: `refinement:${profile}:${String(index + 1).padStart(2, "0")}:${phase}`,
    order: index,
    fromExpectationIds: index === 0 ? high : sortedUnique([...high, ...low]),
    toExpectationIds: index === phases.length - 1 ? sortedUnique([...high, ...low]) : low,
    repositoryEditIds: phase === "bind_repository"
      || phase === "introduce_parallel"
      || phase === "cutover_replacement"
      ? editIds
      : [],
  }));
}

function assertEditCovered(
  envelope: TaskEnvelopeV1,
  edit: RepositoryEditExpectationV1,
): void {
  const scope = envelope.declaredReconciliationScope;
  const editCoordinates = "coordinateIds" in edit ? edit.coordinateIds : [];
  let sourcePath: string;
  if (edit.kind === "add") {
    sourcePath = edit.newPath;
  } else if (edit.kind === "delete" || edit.kind === "rename") {
    sourcePath = edit.oldPath;
  } else {
    sourcePath = edit.path;
  }
  if (
    editCoordinates.some((coordinateId) =>
      bindingsForCoordinate(envelope, coordinateId)
        .every((binding) => binding.repositoryPath !== sourcePath)
    )
  ) throw new Error(`repository edit ${edit.editId} path does not match its sealed coordinate`);

  if (scope.kind === "exact_coordinate") {
    if (edit.kind === "add") return;
    if (
      editCoordinates.some((coordinateId) => coordinateId !== scope.coordinateId)
      || envelope.resolvedBindings
        .find((binding) => binding.bindingId === scope.bindingId)
        ?.repositoryPath !== sourcePath
    ) throw new Error(`repository edit ${edit.editId} escapes exact-coordinate scope`);
    return;
  }
  if (scope.kind === "file") {
    if (edit.kind !== "add" && sourcePath !== scope.path) {
      throw new Error(`repository edit ${edit.editId} escapes file scope`);
    }
    return;
  }
  if (editCoordinates.some((coordinateId) => !scope.coordinateIds.includes(coordinateId))) {
    throw new Error(`repository edit ${edit.editId} escapes coordinate-set scope`);
  }
}

function bindingsForCoordinate(
  envelope: TaskEnvelopeV1,
  coordinateId: `repo:${string}`,
): readonly TaskEnvelopeV1["resolvedBindings"][number][] {
  return envelope.resolvedBindings.filter((binding) =>
    binding.coordinateId === coordinateId
    || (
      binding.scope.kind === "coordinate_set"
      && binding.scope.coordinateIds.includes(coordinateId)
    )
  );
}

function normalizeExpectations(
  values: readonly SemanticExpectationV1[],
): SemanticExpectationV1[] {
  return [...values].map((value) => ({
    ...value,
    acceptanceEvidenceIds: sortedUnique(value.acceptanceEvidenceIds),
  })).sort((left, right) => compareText(left.expectationId, right.expectationId));
}

function normalizeEdits(
  values: readonly RepositoryEditExpectationV1[],
): RepositoryEditExpectationV1[] {
  return [...values].map((value) => ({
    ...value,
    ...("coordinateIds" in value
      ? { coordinateIds: sortedUnique(value.coordinateIds) }
      : {}),
    expectedLiftedExpectationIds: sortedUnique(value.expectedLiftedExpectationIds),
    acceptanceEvidenceIds: sortedUnique(value.acceptanceEvidenceIds),
  })).sort((left, right) => compareText(left.editId, right.editId));
}

function highestProfile(profiles: readonly RefinementProfileV1[]): RefinementProfileV1 {
  return profiles.reduce((highest, profile) =>
    profileRank(profile) > profileRank(highest) ? profile : highest
  , "local_patch");
}

function profileRank(profile: RefinementProfileV1): number {
  return PROFILE_ORDER.indexOf(profile);
}

function maxRisk(left: TaskRiskV1, right: TaskRiskV1): TaskRiskV1 {
  const order: readonly TaskRiskV1[] = ["R0", "R1", "R2", "R3"];
  return order[Math.max(order.indexOf(left), order.indexOf(right))]!;
}

function maxAltitude(
  left: 0 | 1 | 2 | 3 | 4 | 5 | 6,
  right: 0 | 1 | 2 | 3 | 4 | 5 | 6,
): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  return Math.max(left, right) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

function digestId(value: unknown): string {
  return sha256HashUtf8(serializeControlReport(value))
    .slice("sha256:".length, "sha256:".length + 24);
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
