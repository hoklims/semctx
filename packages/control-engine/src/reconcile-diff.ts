import {
  PlanningBundleV1Schema,
  ReconcileDiffReportV1Schema,
  ReconciliationAnalysisV1Schema,
  RECONCILIATION_ADVISORY_CODES,
  canonicalizeReconciliationReasons,
  computePlanningBundleV1Hash,
  computeReconcileDiffReportV1Hash,
  computeSemanticChangeSetV1Hash,
  computeTaskEnvelopeV1Hash,
  normalizeReconcileDiffReportV1,
  sha256HashCanonicalJson,
  sha256HashUtf8,
  type EvidenceEvaluationV1,
  type ObservationAnalysisV1,
  type ObservedDiffHunkV1,
  type PlanningBundleV1,
  type ReconcileDiffReportV1,
  type ReconciliationInsufficiencyReasonV1,
  type ReconciliationAnalysisV1,
  type ReconciliationAdvisoryCodeV1,
  type ReconciliationReasonCodeV1,
  type ReconciliationRefusalReasonV1,
  type ReconciliationViolationReasonV1,
  type RepositoryEditExpectationV1,
  type Sha256Hash,
} from "@semantic-context/control-model/reconciliation";

export { RECONCILIATION_ADVISORY_CODES };
export type ReconciliationAdvisoryCode = ReconciliationAdvisoryCodeV1;

export interface ReconciliationCaptureV1 {
  observedCommit: string;
  observedWorkingDiffHash: Sha256Hash;
  currentHead: string;
  indexCommit: string;
  baselineSealHash: Sha256Hash;
  coordinateGraphSeal: Sha256Hash;
  indexSeal: Sha256Hash;
  sourceSealMatched: boolean;
  indexFresh: boolean;
  controlInputsSealed: boolean;
  gitStateBefore: Sha256Hash;
  gitStateAfter: Sha256Hash;
  candidateBytesStable: boolean;
  semanticModelHash: Sha256Hash;
  analyzerConfigHash: Sha256Hash;
  toolVersion: string;
  storeSchemaVersion: number;
  attestationSetHash: Sha256Hash | null;
  reconciliationAnalysisHash: Sha256Hash;
}

export interface ReconcileDiffInputV1 {
  planningBundle: PlanningBundleV1;
  capture: ReconciliationCaptureV1;
  sealedAnalysis: ReconciliationAnalysisV1;
}

export function reconcileDiff(input: ReconcileDiffInputV1): ReconcileDiffReportV1 {
  const refusalReasons = validateInputs(input);
  if (refusalReasons.length > 0) {
    return buildReport(input, {
      terminalStatus: "REFUSED",
      reasons: refusalReasons,
    });
  }

  const bundle = input.planningBundle;
  const changeSet = bundle.semanticChangeSet;
  const envelope = bundle.taskEnvelope;
  const analysis = input.sealedAnalysis;
  const observation = analysis.observationAnalysis;
  const bindings = new Map(
    analysis.hunkBindings.map((binding) => [
      binding.hunkId,
      sortedUnique(binding.coordinateIds),
    ]),
  );
  const bindingEditIds = new Map(
    analysis.hunkBindings.map((binding) => [binding.hunkId, binding.editIds]),
  );
  const observedHunks = [...analysis.observedHunks].sort((a, b) =>
    compare(a.identity, b.identity)
  );
  const requiredEdits = changeSet.repositoryEditExpectations.filter((edit) => edit.required);
  const matched = new Map<string, Sha256Hash[]>();
  const matchedHunks = new Set<Sha256Hash>();
  const advisoryDiagnostics: ReconcileDiffReportV1["advisoryDiagnostics"][number][] = [
    ...analysis.advisoryDiagnostics.filter((item) =>
      RECONCILIATION_ADVISORY_CODES.includes(item.code as ReconciliationAdvisoryCode)
    ),
  ];
  const scopeEscapes: { path: string; coordinateId?: `repo:${string}` }[] = [];
  const unplannedCoordinates: `repo:${string}`[] = [];

  const renameGroups = new Map<string, Extract<RepositoryEditExpectationV1, { kind: "rename" }>[]>();
  for (const edit of changeSet.repositoryEditExpectations) {
    if (edit.kind !== "rename") continue;
    const key = `${edit.oldPath}\0${edit.newPath}`;
    renameGroups.set(key, [...(renameGroups.get(key) ?? []), edit]);
  }
  for (const edits of renameGroups.values()) {
    if (edits.length !== 1) {
      advisoryDiagnostics.push({
        code: "AMBIGUOUS_STEP_MATCH",
        message: "One observed rename pair cannot certify multiple planned rename edits.",
        subjectIds: edits.map((edit) => edit.editId),
      });
      continue;
    }
    const edit = edits[0]!;
    const renameChanges = observation.changes.filter(isRenameChange).filter((change) =>
      change.oldPath === edit.oldPath && change.newPath === edit.newPath
    );
    const oldSides = observedHunks.filter((hunk) =>
      observedKind(hunk) === "delete"
      && hunk.normalizedPath === edit.oldPath
      && (bindingEditIds.get(hunk.identity) ?? []).includes(edit.editId)
      && edit.coordinateIds.every((id) => (bindings.get(hunk.identity) ?? []).includes(id))
    );
    const newSides = observedHunks.filter((hunk) =>
      observedKind(hunk) === "add"
      && hunk.normalizedPath === edit.newPath
      && (bindingEditIds.get(hunk.identity) ?? []).includes(edit.editId)
    );
    const pair = oldSides.length === 1 && newSides.length === 1
      ? [oldSides[0]!, newSides[0]!] as const
      : null;
    const conflicts = pair?.some((hunk) =>
      changeSet.repositoryEditExpectations.some((candidate) =>
        candidate.editId !== edit.editId
        && candidate.kind !== "rename"
        && editMatchesHunk(
          candidate,
          hunk,
          bindings.get(hunk.identity) ?? [],
        )
      )
    ) ?? false;
    const pairInScope = pair?.every((hunk) =>
      pathInScope(
        hunk.normalizedPath,
        bindings.get(hunk.identity) ?? [],
        envelope,
        changeSet,
      )
    ) ?? false;
    if (renameChanges.length === 1 && pair !== null && pairInScope && !conflicts) {
      matched.set(edit.editId, pair.map((hunk) => hunk.identity));
      pair.forEach((hunk) => matchedHunks.add(hunk.identity));
      unplannedCoordinates.push(...uncoveredCoordinates(
        edit,
        pair[0],
        bindings.get(pair[0].identity) ?? [],
      ));
    } else if (oldSides.length + newSides.length > 0) {
      advisoryDiagnostics.push({
        code: "AMBIGUOUS_STEP_MATCH",
        message: "Rename requires one exact delete/add pair and one exact observation.",
        subjectIds: [
          edit.editId,
          ...oldSides.map((hunk) => hunk.identity),
          ...newSides.map((hunk) => hunk.identity),
        ],
      });
    }
  }

  for (const hunk of observedHunks) {
    const coordinates = bindings.get(hunk.identity) ?? [];
    const path = hunk.normalizedPath;
    if (!pathInScope(path, coordinates, envelope, changeSet)) {
      const exactScope = envelope.declaredReconciliationScope.kind === "exact_coordinate"
        ? envelope.declaredReconciliationScope
        : null;
      if (exactScope !== null) {
        unplannedCoordinates.push(...coordinates.filter((coordinateId) =>
          coordinateId !== exactScope.coordinateId
        ));
      }
      scopeEscapes.push(...(
        coordinates.length === 0
          ? [{ path }]
          : coordinates.map((coordinateId) => ({ path, coordinateId }))
      ));
      continue;
    }
    if (matchedHunks.has(hunk.identity)) continue;
    const matches = changeSet.repositoryEditExpectations.filter((edit) =>
      edit.kind !== "rename"
      &&
      (bindingEditIds.get(hunk.identity) ?? []).includes(edit.editId)
      &&
      editMatchesHunk(edit, hunk, coordinates)
    );
    if (matches.length !== 1) {
      if (matches.length > 1 || isAmbiguousRenameCandidate(hunk, observation)) {
        advisoryDiagnostics.push({
          code: "AMBIGUOUS_STEP_MATCH",
          message: "Observed hunk does not identify one unique planned edit.",
          subjectIds: [hunk.identity, ...matches.map((edit) => edit.editId)],
        });
      }
      unplannedCoordinates.push(...(
        coordinates.length > 0
          ? coordinates
          : [`repo:file:${hunk.normalizedPath}` as const]
      ));
      continue;
    }
    const edit = matches[0]!;
    matched.set(edit.editId, [...(matched.get(edit.editId) ?? []), hunk.identity]);
    matchedHunks.add(hunk.identity);
    unplannedCoordinates.push(...uncoveredCoordinates(edit, hunk, coordinates));
  }

  const missingRequired = requiredEdits
    .filter((edit) => !matched.has(edit.editId))
    .map((edit) => edit.editId);
  for (const edit of changeSet.repositoryEditExpectations) {
    if (!edit.required && !matched.has(edit.editId)) {
      advisoryDiagnostics.push({
        code: "OPTIONAL_EDIT_MISSING",
        message: "Optional repository edit was not observed.",
        subjectIds: [edit.editId],
      });
    }
  }
  for (const hunk of observedHunks) {
    if (!matchedHunks.has(hunk.identity) && !scopeEscapes.some((escape) =>
      escape.path === hunk.normalizedPath
    )) {
      const coordinates = bindings.get(hunk.identity) ?? [];
      unplannedCoordinates.push(...(
        coordinates.length > 0 ? coordinates : [`repo:file:${hunk.normalizedPath}` as const]
      ));
    }
  }

  const invariantDrift = sortedUnique(
    analysis.architectureDelta.changedInvariantIds
      .filter((id) => envelope.preservedInvariantIds.includes(id)),
  );
  const declaredLifted = new Set(
    changeSet.repositoryEditExpectations.flatMap((edit) => edit.expectedLiftedExpectationIds),
  );
  const undeclaredLifted = sortedUnique(
    analysis.liftedImpacts.flatMap((impact) => impact.expectationIds)
      .filter((id) => !declaredLifted.has(id)),
  );
  const evidence = evaluateEvidence(input);
  const roundTrips = evaluateRoundTrips(input, matched, bindings);
  advisoryDiagnostics.push(...roundTrips.advisories);
  const target = evaluateTarget(input);

  const violations: ReconciliationViolationReasonV1[] = [];
  if (scopeEscapes.length > 0) violations.push("SCOPE_ESCAPE");
  if (invariantDrift.length > 0) violations.push("INVARIANT_DRIFT");
  if (undeclaredLifted.length > 0) violations.push("UNDECLARED_LIFTED_IMPACT");
  if (missingRequired.length > 0) violations.push("MISSING_PLANNED_EDIT");
  if (unplannedCoordinates.length > 0) violations.push("UNPLANNED_COORDINATE");
  if (target.findings.some((finding) => finding.required && finding.result === "not_realized")) {
    violations.push("TARGET_NOT_REALIZED");
  }

  const insufficiencies: ReconciliationInsufficiencyReasonV1[] = [];
  if (bundle.baseline.cleanliness !== "FRESH") insufficiencies.push("BASELINE_NOT_CLEAN");
  if (observation.completeness !== "complete") {
    insufficiencies.push("OBSERVATION_ANALYSIS_INCOMPLETE");
  }
  if (!refinementConnected(changeSet)) insufficiencies.push("REFINEMENT_DISCONNECTED");
  if (analysis.traversalBudgetExhausted) insufficiencies.push("BUDGET_EXHAUSTED");
  if (roundTrips.missing.length > 0) insufficiencies.push("ROUND_TRIP_UNPROVEN");
  if (
    concreteExpectationsMissing(changeSet)
    || (
      bundle.acceptedTargetBinding !== undefined
      && target.requiredIds.length === 0
    )
  ) {
    insufficiencies.push("CONCRETE_EDIT_EXPECTATION_MISSING");
  }
  if (evidence.evaluations.some((evaluation) => evaluation.required && evaluation.result !== "satisfied")) {
    insufficiencies.push("REQUIRED_EVIDENCE_UNSATISFIED");
  }
  if (target.findings.some((finding) => finding.required && finding.result === "unproven")) {
    if (!insufficiencies.includes("OBSERVATION_ANALYSIS_UNAVAILABLE")
      && !insufficiencies.includes("OBSERVATION_ANALYSIS_INCOMPLETE")) {
      insufficiencies.push("OBSERVATION_ANALYSIS_INCOMPLETE");
    }
  }

  const terminalStatus = violations.length > 0
    ? "VIOLATED"
    : insufficiencies.length > 0
      ? "UNPROVEN"
      : "REALIZED";
  const reasons = terminalStatus === "VIOLATED" ? violations : insufficiencies;
  return buildReport(input, {
    terminalStatus,
    reasons,
    secondaryInsufficiencies: terminalStatus === "VIOLATED" ? insufficiencies : [],
    requiredPlannedEditIds: requiredEdits.map((edit) => edit.editId),
    matchedPlannedEdits: [...matched].map(([editId, observedHunkIds]) => ({
      editId,
      observedHunkIds,
    })),
    missingPlannedEditIds: missingRequired,
    unplannedCoordinateIds: unplannedCoordinates,
    scopeEscapes,
    invariantDriftIds: invariantDrift,
    undeclaredLiftedExpectationIds: undeclaredLifted,
    requiredTargetElementIds: target.requiredIds,
    targetRealizationFindings: target.findings,
    requiredEvidenceRequirementIds: evidence.requiredIds,
    evidenceEvaluations: evidence.evaluations,
    certifiedRoundTrips: roundTrips.certified,
    requiredRoundTripExpectationIds: roundTrips.requiredIds,
    advisoryDiagnostics,
  });
}

interface ReportFindings {
  terminalStatus: ReconcileDiffReportV1["terminalStatus"];
  reasons: readonly ReconciliationReasonCodeV1[];
  secondaryInsufficiencies?: readonly ReconciliationInsufficiencyReasonV1[];
  requiredPlannedEditIds?: readonly string[];
  matchedPlannedEdits?: ReconcileDiffReportV1["matchedPlannedEdits"];
  missingPlannedEditIds?: readonly string[];
  unplannedCoordinateIds?: readonly `repo:${string}`[];
  scopeEscapes?: ReconcileDiffReportV1["scopeEscapes"];
  invariantDriftIds?: readonly string[];
  undeclaredLiftedExpectationIds?: readonly string[];
  requiredTargetElementIds?: readonly string[];
  targetRealizationFindings?: ReconcileDiffReportV1["targetRealizationFindings"];
  requiredEvidenceRequirementIds?: readonly string[];
  evidenceEvaluations?: readonly EvidenceEvaluationV1[];
  certifiedRoundTrips?: ReconcileDiffReportV1["certifiedRoundTrips"];
  requiredRoundTripExpectationIds?: readonly string[];
  advisoryDiagnostics?: ReconcileDiffReportV1["advisoryDiagnostics"];
}

function buildReport(input: ReconcileDiffInputV1, findings: ReportFindings): ReconcileDiffReportV1 {
  const bundle = input.planningBundle as Partial<PlanningBundleV1>;
  const envelope = bundle.taskEnvelope;
  const changeSet = bundle.semanticChangeSet;
  const fallbackHash = sha256HashUtf8("unavailable");
  const reasons = canonicalizeReconciliationReasons(findings.reasons);
  const payload: Omit<ReconcileDiffReportV1, "reportHash"> = {
    schemaVersion: 1,
    kind: "reconcile_diff",
    changeSetId: changeSet?.changeSetId ?? "invalid-change-set",
    changeSetHash: changeSet?.changeSetHash ?? fallbackHash,
    envelopeId: envelope?.envelopeId ?? "invalid-envelope",
    envelopeHash: envelope?.envelopeHash ?? fallbackHash,
    planningCommit: bundle.planningCommit ?? "invalid-planning-commit",
    observedCommit: input.capture?.observedCommit ?? "unavailable",
    baselineSealHash: bundle.baseline?.freshnessSealHash ?? fallbackHash,
    observedWorkingDiffHash: input.capture?.observedWorkingDiffHash ?? fallbackHash,
    terminalStatus: findings.terminalStatus,
    primaryReason: reasons[0] ?? null,
    reasonCodes: reasons,
    requiredPlannedEditIds: findings.requiredPlannedEditIds ?? [],
    matchedPlannedEdits: findings.matchedPlannedEdits ?? [],
    missingPlannedEditIds: findings.missingPlannedEditIds ?? [],
    observedHunkIds: (input.sealedAnalysis?.observedHunks ?? []).map((hunk) => hunk.identity),
    unplannedCoordinateIds: findings.unplannedCoordinateIds ?? [],
    scopeEscapes: findings.scopeEscapes ?? [],
    invariantDriftIds: findings.invariantDriftIds ?? [],
    undeclaredLiftedExpectationIds: findings.undeclaredLiftedExpectationIds ?? [],
    requiredTargetElementIds: findings.requiredTargetElementIds ?? [],
    targetRealizationFindings: findings.targetRealizationFindings ?? [],
    requiredEvidenceRequirementIds: findings.requiredEvidenceRequirementIds ?? [],
    evidenceEvaluations: findings.evidenceEvaluations ?? [],
    certifiedRoundTrips: findings.certifiedRoundTrips ?? [],
    requiredRoundTripExpectationIds: findings.requiredRoundTripExpectationIds ?? [],
    observationAnalysis: findings.terminalStatus === "REFUSED" || input.sealedAnalysis === undefined
      ? null
      : {
          analysisHash: input.sealedAnalysis.observationAnalysis.analysisHash,
          completeness: input.sealedAnalysis.observationAnalysis.completeness,
        },
    advisoryDiagnostics: consolidateAdvisories(findings.advisoryDiagnostics ?? []),
    secondaryInsufficiencies: findings.secondaryInsufficiencies ?? [],
  };
  const normalized = normalizeReconcileDiffReportV1({
    ...payload,
    reportHash: fallbackHash,
  });
  const report = {
    ...normalized,
    reportHash: computeReconcileDiffReportV1Hash(normalized),
  };
  return ReconcileDiffReportV1Schema.parse(report) as ReconcileDiffReportV1;
}

function validateInputs(input: ReconcileDiffInputV1): ReconciliationRefusalReasonV1[] {
  const reasons: ReconciliationRefusalReasonV1[] = [];
  if (
    Object.keys(input as unknown as Record<string, unknown>).some((key) =>
      !["planningBundle", "capture", "sealedAnalysis"].includes(key)
    )
  ) reasons.push("INPUT_SCHEMA_INVALID");
  const raw = input.planningBundle as unknown as Record<string, unknown>;
  const envelope = raw?.taskEnvelope as Record<string, unknown> | undefined;
  const changeSet = raw?.semanticChangeSet as Record<string, unknown> | undefined;
  if (
    raw?.schemaVersion !== 1
    || envelope?.schemaVersion !== 1
    || changeSet?.schemaVersion !== 1
  ) reasons.push("SCHEMA_VERSION_UNSUPPORTED");
  else {
    try {
      if (envelope.envelopeHash !== computeTaskEnvelopeV1Hash(envelope as never)) {
        reasons.push("ENVELOPE_HASH_MISMATCH");
      }
      if (changeSet.changeSetHash !== computeSemanticChangeSetV1Hash(changeSet as never)) {
        reasons.push("CHANGE_SET_HASH_MISMATCH");
      }
    } catch {
      reasons.push("INPUT_SCHEMA_INVALID");
    }
    if (reasons.length === 0) {
      if (!PlanningBundleV1Schema.safeParse(input.planningBundle).success) {
        reasons.push("INPUT_SCHEMA_INVALID");
      } else if (input.planningBundle.bundleHash !== computePlanningBundleV1Hash(input.planningBundle)) {
        reasons.push("INPUT_SCHEMA_INVALID");
      }
    }
  }
  if (reasons.length > 0) return canonicalRefusals(reasons);
  const rawAnalysis = input.sealedAnalysis as unknown as Record<string, unknown> | undefined;
  if (rawAnalysis?.schemaVersion !== 1) {
    reasons.push("SCHEMA_VERSION_UNSUPPORTED");
  } else if (!ReconciliationAnalysisV1Schema.safeParse(input.sealedAnalysis).success) {
    reasons.push("INPUT_SCHEMA_INVALID");
  }
  if (reasons.length > 0) return canonicalRefusals(reasons);
  const analysis = input.sealedAnalysis;
  const observation = analysis.observationAnalysis;
  if (
    input.capture.currentHead !== input.planningBundle.planningCommit
    || input.capture.indexCommit !== input.planningBundle.planningCommit
    || input.capture.observedCommit !== input.planningBundle.planningCommit
  ) reasons.push("PLANNING_COMMIT_MISMATCH");
  if (!targetIdentityAdmissible(input)) reasons.push("TARGET_REVISION_MISMATCH");
  if (
    input.capture.semanticModelHash
    !== input.planningBundle.baseline.semanticModelHash
  ) reasons.push("SEMANTIC_MODEL_DRIFT");
  if (
    input.capture.analyzerConfigHash
    !== input.planningBundle.baseline.analyzerConfigHash
  ) reasons.push("ANALYZER_CONFIG_DRIFT");
  if (
    input.capture.toolVersion
    !== input.planningBundle.baseline.toolVersion
  ) reasons.push("TOOL_VERSION_DRIFT");
  if (
    input.capture.storeSchemaVersion
    !== input.planningBundle.baseline.storeSchemaVersion
  ) reasons.push("STORE_SCHEMA_DRIFT");
  if (
    input.capture.attestationSetHash
    !== input.planningBundle.baseline.attestationSetHash
  ) reasons.push("ATTESTATION_SET_DRIFT");
  if (
    !input.capture.sourceSealMatched
    || input.capture.baselineSealHash !== input.planningBundle.baseline.freshnessSealHash
    || input.capture.coordinateGraphSeal !== input.planningBundle.taskEnvelope.coordinateGraphSeal
    || input.capture.reconciliationAnalysisHash !== analysis.analysisHash
    || analysis.planningBundleHash !== input.planningBundle.bundleHash
    || analysis.planningCommit !== input.planningBundle.planningCommit
    || analysis.observedDiffHash !== input.capture.observedWorkingDiffHash
    || observation.baselineSealHash !== input.planningBundle.baseline.freshnessSealHash
    || observation.candidateDiffHash !== input.capture.observedWorkingDiffHash
    || observation.analyzerConfigHash !== input.planningBundle.baseline.analyzerConfigHash
    || observation.toolVersion !== input.planningBundle.baseline.toolVersion
    || input.capture.gitStateBefore !== input.capture.gitStateAfter
    || !input.capture.candidateBytesStable
  ) reasons.push("SOURCE_SEAL_MISMATCH");
  if (
    !input.capture.indexFresh
    || input.capture.indexSeal !== input.planningBundle.taskEnvelope.indexSeal
  ) reasons.push("INDEX_STALE");
  if (!input.capture.controlInputsSealed) reasons.push("CONTROL_INPUTS_UNSEALED");
  if (
    input.planningBundle.acceptedTargetBinding !== undefined
    && (analysis.targetAnalysis?.reviewAttestationDigests.length ?? 0) === 0
  ) reasons.push("ATTESTATION_UNBOUND");
  return canonicalRefusals(reasons);
}

function targetIdentityAdmissible(input: ReconcileDiffInputV1): boolean {
  const expected = input.planningBundle.acceptedTargetBinding;
  const actual = input.sealedAnalysis.targetAnalysis;
  if (expected === undefined) {
    if (actual === undefined) return true;
    const diagnostic = input.planningBundle.taskEnvelope.authoredTargetBinding
      ?? input.planningBundle.taskEnvelope.advisoryTargetRef;
    return diagnostic !== undefined
      && actual.normativeStatus === "proposed"
      && actual.targetRef.targetId === diagnostic.targetId
      && actual.targetRef.revision === diagnostic.revision
      && actual.targetRef.artifactHash === diagnostic.artifactHash;
  }
  return actual !== undefined
    && actual.normativeStatus === "accepted"
    && actual.targetRef.targetId === expected.targetId
    && actual.targetRef.revision === expected.revision
    && actual.targetRef.artifactHash === expected.artifactHash;
}

function evaluateEvidence(input: ReconcileDiffInputV1): {
  requiredIds: string[];
  evaluations: EvidenceEvaluationV1[];
} {
  const changeSet = input.planningBundle.semanticChangeSet;
  const requirements = new Map<string, {
    origin: EvidenceEvaluationV1["origin"];
    required: boolean;
  }>();
  const add = (id: string, origin: EvidenceEvaluationV1["origin"], required: boolean) => {
    const existing = requirements.get(id);
    requirements.set(id, existing === undefined
      ? { origin, required }
      : { origin: existing.origin, required: existing.required || required });
  };
  changeSet.acceptanceEvidenceIds.forEach((id) => add(id, "change_contract", true));
  changeSet.semanticExpectations.forEach((expectation) =>
    expectation.acceptanceEvidenceIds.forEach((id) =>
      add(id, "semantic_expectation", expectation.required)
    ));
  changeSet.repositoryEditExpectations.forEach((edit) =>
    edit.acceptanceEvidenceIds.forEach((id) =>
      add(id, "repository_edit_expectation", edit.required)
    ));
  changeSet.proofObligationIds.forEach((id) => add(id, "proof_obligation", true));
  if (exactAcceptedTargetAnalysis(input) !== undefined) {
    add("target_reviewed", "proof_obligation", true);
  }
  const supplied = new Map(
    input.sealedAnalysis.evidenceInputs.map((item) => [item.requirementId, item]),
  );
  const evaluations = [...requirements].map(([requirementId, requirement]) => {
    const value = supplied.get(requirementId);
    if (value === undefined) {
      return {
        schemaVersion: 1,
        requirementId,
        ...requirement,
        evidenceId: null,
        acceptedAttestationDigests: [],
        planningCommit: input.planningBundle.planningCommit,
        observedDiffHash: input.capture.observedWorkingDiffHash,
        semanticModelHash: input.capture.semanticModelHash,
        provenance: [],
        result: "missing",
      } satisfies EvidenceEvaluationV1;
    }
    const stale = value.planningCommit !== input.planningBundle.planningCommit
      || value.observedDiffHash !== input.capture.observedWorkingDiffHash
      || value.semanticModelHash !== input.capture.semanticModelHash
      || (value.attestationSetHash ?? null) !== input.capture.attestationSetHash
      || (
        value.observationAnalysisHash !== undefined
        && value.observationAnalysisHash
          !== input.sealedAnalysis.observationAnalysis.analysisHash
      );
    const suppliedAttestations = value.acceptedAttestationDigests ?? [];
    const hasAttestationBinding = suppliedAttestations.length > 0
      && value.attestationSetHash !== undefined
      && value.provenance.includes("canonical_attestation");
    const hasSemanticBinding = value.semanticEvidenceDigest !== undefined
      && value.provenance.includes("plane_a_observed");
    const hasPlaneBOrigin = value.provenance.includes("plane_b_authored");
    const structurallyBound = hasPlaneBOrigin && (hasAttestationBinding || hasSemanticBinding);
    let result = stale ? "stale" : value.result;
    if (result === "satisfied" && !structurallyBound) result = "unbound";
    if (result === "failing" && !value.provenance.includes("plane_a_observed")) {
      result = "unbound";
    }
    if (
      result === "stale"
      && value.semanticEvidenceDigest === undefined
      && !hasAttestationBinding
      && value.observationAnalysisHash === undefined
    ) {
      result = "unbound";
    }
    const acceptedAttestationDigests = hasAttestationBinding ? suppliedAttestations : [];
    const provenance = result === "unbound" && !hasAttestationBinding
      ? value.provenance.filter((item) => item !== "canonical_attestation")
      : value.provenance;
    return {
      schemaVersion: 1,
      requirementId,
      ...requirement,
      evidenceId: value.evidenceId,
      ...(value.semanticEvidenceDigest === undefined
        ? {}
        : { semanticEvidenceDigest: value.semanticEvidenceDigest }),
      acceptedAttestationDigests,
      planningCommit: value.planningCommit,
      observedDiffHash: value.observedDiffHash,
      semanticModelHash: value.semanticModelHash,
      ...(hasAttestationBinding ? { attestationSetHash: value.attestationSetHash } : {}),
      ...(value.observationAnalysisHash === undefined
        ? {}
        : { observationAnalysisHash: value.observationAnalysisHash }),
      provenance,
      result,
    } satisfies EvidenceEvaluationV1;
  });
  const sealedEvaluations = new Map(
    input.sealedAnalysis.evidenceEvaluations.map((item) => [item.requirementId, item]),
  );
  const coherentEvaluations = evaluations.map((evaluation) => {
    const sealed = sealedEvaluations.get(evaluation.requirementId);
    if (
      sealed !== undefined
      && sha256HashCanonicalJson(sealed) === sha256HashCanonicalJson(evaluation)
    ) return evaluation;
    return {
      ...evaluation,
      acceptedAttestationDigests: [],
      provenance: [],
      result: evaluation.result === "missing" ? "missing" : "unbound",
    } satisfies EvidenceEvaluationV1;
  });
  return {
    requiredIds: [...requirements].filter(([, value]) => value.required).map(([id]) => id),
    evaluations: coherentEvaluations,
  };
}

function evaluateRoundTrips(
  input: ReconcileDiffInputV1,
  matchedEdits: ReadonlyMap<string, readonly Sha256Hash[]>,
  bindings: ReadonlyMap<Sha256Hash, readonly `repo:${string}`[]>,
): {
  requiredIds: string[];
  missing: string[];
  certified: ReconcileDiffReportV1["certifiedRoundTrips"];
  advisories: ReconcileDiffReportV1["advisoryDiagnostics"];
} {
  const changeSet = input.planningBundle.semanticChangeSet;
  const linked = new Set(
    changeSet.repositoryEditExpectations
      .filter((edit) => edit.required)
      .flatMap((edit) => edit.expectedLiftedExpectationIds),
  );
  const requiredIds = changeSet.semanticExpectations
    .filter((expectation) => expectation.required && linked.has(expectation.expectationId))
    .map((expectation) => expectation.expectationId);
  const certified: ReconcileDiffReportV1["certifiedRoundTrips"][number][] = [];
  const advisories: ReconcileDiffReportV1["advisoryDiagnostics"][number][] = [];
  const analysis = input.sealedAnalysis;
  for (const expectationId of requiredIds) {
    const expectation = changeSet.semanticExpectations.find((item) =>
      item.expectationId === expectationId
    )!;
    const linkedEdits = changeSet.repositoryEditExpectations.filter((edit) =>
      edit.required && edit.expectedLiftedExpectationIds.includes(expectationId)
    );
    const accepted = linkedEdits.map((edit) => {
      const candidates = analysis.roundTripCoverages.filter((coverage) =>
        coverage.expectationId === expectationId && coverage.editId === edit.editId
      );
      if (candidates.length !== 1) return null;
      const coverage = candidates[0]!;
      const matchedHunks = matchedEdits.get(edit.editId) ?? [];
      const boundCoordinates = sortedUnique(matchedHunks.flatMap((hunkId) =>
        bindings.get(hunkId) ?? []
      ));
      return roundTripCoverageCertifies(
        input,
        expectation,
        coverage,
        matchedHunks,
        boundCoordinates,
      ) ? coverage : null;
    });
    if (accepted.length > 0 && accepted.every((coverage) => coverage !== null)) {
      certified.push({
        expectationId,
        coordinateIds: sortedUnique(accepted.flatMap((coverage) =>
          coverage?.terminalCoordinateIds ?? []
        )),
        evidenceIds: sortedUnique(accepted.flatMap((coverage) =>
          coverage?.evidenceIds ?? []
        )),
      });
    } else {
      advisories.push({
        code: "ROUND_TRIP_ADVISORY_ONLY",
        message: "Round-trip does not connect the exact semantic expectation to its matched edit.",
        subjectIds: [expectationId, ...linkedEdits.map((edit) => edit.editId)],
      });
    }
  }
  const certifiedIds = new Set(certified.map((item) => item.expectationId));
  return {
    requiredIds,
    missing: requiredIds.filter((id) => !certifiedIds.has(id)),
    certified,
    advisories,
  };
}

function roundTripCoverageCertifies(
  input: ReconcileDiffInputV1,
  expectation: PlanningBundleV1["semanticChangeSet"]["semanticExpectations"][number],
  coverage: ReconciliationAnalysisV1["roundTripCoverages"][number],
  matchedHunks: readonly Sha256Hash[],
  boundCoordinates: readonly `repo:${string}`[],
): boolean {
  const first = coverage.steps[0];
  const last = coverage.steps.at(-1);
  if (first === undefined || last === undefined) return false;
  return coverage.semanticSubjectId === expectation.subjectId
    && coverage.semanticLevel === expectation.level
    && coverage.sourceSeal === input.planningBundle.baseline.freshnessSealHash
    && coverage.indexSeal === input.planningBundle.taskEnvelope.indexSeal
    && coverage.observationAnalysisHash
      === input.sealedAnalysis.observationAnalysis.analysisHash
    && coverage.terminalStatus === "success"
    && !coverage.truncated
    && first.fromId === expectation.subjectId
    && first.fromLevel === expectation.level
    && last.toLevel === 0
    && coverage.steps.every((step, index) =>
      step.toLevel === step.fromLevel - 1
      && step.epistemicStatus !== "llm_inferred"
      && step.epistemicStatus !== "hypothetical"
      && step.evidenceDigests.length > 0
      && (
        index === 0
        || coverage.steps[index - 1]!.toId === step.fromId
      )
    )
    && (
      coverage.observedHunkIds.includes(last.toId as Sha256Hash)
      || coverage.terminalCoordinateIds.includes(last.toId as `repo:${string}`)
    )
    && sameStrings(coverage.observedHunkIds, matchedHunks)
    && coverage.terminalCoordinateIds.length > 0
    && coverage.terminalCoordinateIds.every((id) => boundCoordinates.includes(id))
    && coverage.evidenceIds.length > 0;
}

function evaluateTarget(input: ReconcileDiffInputV1): {
  requiredIds: string[];
  findings: ReconcileDiffReportV1["targetRealizationFindings"];
} {
  const authoredRequiredIds = input.planningBundle.semanticChangeSet.semanticExpectations
    .filter((expectation) => expectation.required && expectation.kind === "target_element")
    .map((expectation) => expectation.subjectId);
  const acceptedAnalysis = exactAcceptedTargetAnalysis(input);
  const requiredIds = sortedUnique([
    ...authoredRequiredIds,
    ...(acceptedAnalysis?.findings.map((finding) => finding.targetElementId) ?? []),
  ]);
  const supplied = new Map(
    (acceptedAnalysis?.findings ?? [])
      .map((finding) => [finding.targetElementId, finding]),
  );
  const findings = requiredIds.map((targetElementId) => {
    const finding = supplied.get(targetElementId);
    return {
      targetElementId,
      required: true,
      result: finding?.result ?? "unproven",
      evidenceIds: finding?.evidenceIds ?? [],
    };
  });
  return { requiredIds, findings };
}

function exactAcceptedTargetAnalysis(
  input: ReconcileDiffInputV1,
): ReconciliationAnalysisV1["targetAnalysis"] | undefined {
  const acceptedBinding = input.planningBundle.acceptedTargetBinding;
  const targetAnalysis = input.sealedAnalysis.targetAnalysis;
  return acceptedBinding !== undefined
    && targetAnalysis?.normativeStatus === "accepted"
    && targetAnalysis.targetRef.targetId === acceptedBinding.targetId
    && targetAnalysis.targetRef.revision === acceptedBinding.revision
    && targetAnalysis.targetRef.artifactHash === acceptedBinding.artifactHash
      ? targetAnalysis
      : undefined;
}

function editMatchesHunk(
  edit: RepositoryEditExpectationV1,
  hunk: ObservedDiffHunkV1,
  coordinates: readonly `repo:${string}`[],
): boolean {
  const kind = observedKind(hunk);
  if (edit.kind !== kind) return false;
  if (edit.kind === "add") return hunk.normalizedPath === edit.newPath;
  if (edit.kind === "delete") {
    return hunk.normalizedPath === edit.oldPath
      && edit.coordinateIds.every((id) => coordinates.includes(id));
  }
  if (edit.kind === "modify") {
    return hunk.normalizedPath === edit.path
      && edit.coordinateIds.every((id) => coordinates.includes(id))
      && (
        edit.oldRange === undefined
        || (
          hunk.oldRange.start === edit.oldRange.start
          && hunk.oldRange.lines === edit.oldRange.lines
        )
      );
  }
  return false;
}

function observedKind(hunk: ObservedDiffHunkV1): "add" | "modify" | "delete" {
  if (hunk.oldBlobId === null && hunk.newBlobId !== null) return "add";
  if (hunk.oldBlobId !== null && hunk.newBlobId === null) return "delete";
  return "modify";
}

function isAmbiguousRenameCandidate(
  hunk: ObservedDiffHunkV1,
  observation: ObservationAnalysisV1 | undefined,
): boolean {
  const explicitRenames = observation?.changes.filter(isRenameChange).filter((change) =>
    change.oldPath === hunk.normalizedPath || change.newPath === hunk.normalizedPath
  ).length ?? 0;
  if (explicitRenames > 1) return true;
  if (explicitRenames === 1 || observation === undefined) return false;
  const deletedPaths = new Set(observation.changes.flatMap((change) =>
    change.kind === "delete" ? [change.oldPath] : []
  ));
  const addedPaths = new Set(observation.changes.flatMap((change) =>
    change.kind === "add" ? [change.newPath] : []
  ));
  return (deletedPaths.has(hunk.normalizedPath) && addedPaths.size > 0)
    || (addedPaths.has(hunk.normalizedPath) && deletedPaths.size > 0);
}

function isRenameChange(
  change: ObservationAnalysisV1["changes"][number],
): change is Extract<ObservationAnalysisV1["changes"][number], { kind: "rename" }> {
  return change.kind === "rename";
}

function pathInScope(
  path: string,
  coordinates: readonly `repo:${string}`[],
  envelope: PlanningBundleV1["taskEnvelope"],
  changeSet: PlanningBundleV1["semanticChangeSet"],
): boolean {
  if (changeSet.repositoryEditExpectations.some((edit) =>
    (edit.kind === "add" || edit.kind === "rename")
    && edit.newPath === path
  )) return true;
  const scope = envelope.declaredReconciliationScope;
  if (scope.kind === "file") return path === scope.path;
  if (scope.kind === "exact_coordinate") {
    const binding = envelope.resolvedBindings.find((item) => item.bindingId === scope.bindingId);
    return binding?.repositoryPath === path
      && coordinates.length === 1
      && coordinates[0] === scope.coordinateId;
  }
  const pathBindings = envelope.resolvedBindings.filter((binding) =>
    scope.bindingIds.includes(binding.bindingId)
    && binding.repositoryPath === path
  );
  if (pathBindings.some((binding) => binding.scope.kind === "file")) return true;
  return pathBindings.length > 0
    && coordinates.length > 0
    && coordinates.every((coordinateId) => scope.coordinateIds.includes(coordinateId));
}

function uncoveredCoordinates(
  edit: RepositoryEditExpectationV1,
  hunk: ObservedDiffHunkV1,
  coordinates: readonly `repo:${string}`[],
): `repo:${string}`[] {
  if (
    edit.kind === "add"
    || (edit.kind === "rename" && hunk.normalizedPath === edit.newPath)
  ) {
    return [];
  }
  return coordinates.filter((coordinateId) => !edit.coordinateIds.includes(coordinateId));
}

function refinementConnected(changeSet: PlanningBundleV1["semanticChangeSet"]): boolean {
  const requiredSemantic = new Set(
    changeSet.semanticExpectations
      .filter((item) => item.required)
      .map((item) => item.expectationId),
  );
  if (requiredSemantic.size === 0) return true;
  const connected = new Set(changeSet.refinementSteps.flatMap((step) => [
    ...step.fromExpectationIds,
    ...step.toExpectationIds,
  ]));
  return [...requiredSemantic].every((id) => connected.has(id));
}

function concreteExpectationsMissing(changeSet: PlanningBundleV1["semanticChangeSet"]): boolean {
  return changeSet.semanticExpectations.some((expectation) =>
    expectation.required
    && expectation.level >= 2
    && !changeSet.repositoryEditExpectations.some((edit) =>
      edit.required && edit.expectedLiftedExpectationIds.includes(expectation.expectationId)
    )
  );
}

function canonicalRefusals(
  reasons: readonly ReconciliationRefusalReasonV1[],
): ReconciliationRefusalReasonV1[] {
  return canonicalizeReconciliationReasons(reasons) as ReconciliationRefusalReasonV1[];
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compare);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = sortedUnique(left);
  const normalizedRight = sortedUnique(right);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function consolidateAdvisories(
  values: ReconcileDiffReportV1["advisoryDiagnostics"],
): ReconcileDiffReportV1["advisoryDiagnostics"] {
  const byKey = new Map<string, ReconcileDiffReportV1["advisoryDiagnostics"][number]>();
  for (const value of values) {
    const key = `${value.code}\0${value.message}`;
    const existing = byKey.get(key);
    byKey.set(key, {
      ...value,
      subjectIds: sortedUnique([
        ...(existing?.subjectIds ?? []),
        ...value.subjectIds,
      ]),
    });
  }
  return [...byKey.values()];
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
