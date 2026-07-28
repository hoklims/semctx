import { canonicalJson } from "./canonical";
import {
  PLANE_A_REASON_CODES,
  type AnalysisOutcome,
  type ArtifactScope,
  type CapabilityProfile,
  type DiscoveryLedgerEntry,
  type ExactSubjectDecision,
  type FactBatchV1,
  type PlaneAEvaluationDecision,
  type PlaneAEvaluationInput,
  type PlaneAEvaluationReport,
  type PlaneAGates,
  type PlaneAReason,
  type PlaneAReasonCode,
  type ReasonDetail,
} from "./model";

const reasonOrder = new Map<PlaneAReasonCode, number>(
  PLANE_A_REASON_CODES.map((code, index) => [code, index]),
);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const terminalReason: Partial<Record<AnalysisOutcome, PlaneAReasonCode>> = {
  disabled: "ANALYSIS_DISABLED",
  unsupported: "LANGUAGE_UNSUPPORTED",
  failed: "PRODUCER_FAILED",
};

export class InvalidDiscoveryLedgerEntryError extends Error {
  readonly code = "INVALID_DISCOVERY_TERMINAL_PAIR";

  constructor(readonly entry: DiscoveryLedgerEntry) {
    super(
      `invalid discovery terminal pair: ${entry.selectionDecision}/${entry.analysisOutcome}`,
    );
    this.name = "InvalidDiscoveryLedgerEntryError";
  }
}

export function normalizeDiscoveryLedgerEntry(
  entry: DiscoveryLedgerEntry,
): DiscoveryLedgerEntry {
  const valid = entry.selectionDecision === "excluded"
    ? entry.analysisOutcome === "not_applicable"
    : entry.analysisOutcome !== "not_applicable";
  if (!valid) throw new InvalidDiscoveryLedgerEntryError(entry);
  return {
    ...entry,
    selectionReasons: [...new Set(entry.selectionReasons)].sort(),
    analysisReasons: [...new Set(entry.analysisReasons)].sort(),
  };
}

function detailSortKey(detail: ReasonDetail): string {
  return [
    detail.coordinate,
    canonicalJson(detail.expected),
    canonicalJson(detail.actual),
  ].join("\u0000");
}

function normalizeReasons(
  inputs: readonly { code: PlaneAReasonCode; detail: ReasonDetail }[],
): PlaneAReason[] {
  const grouped = new Map<PlaneAReasonCode, Map<string, ReasonDetail>>();
  for (const input of inputs) {
    let details = grouped.get(input.code);
    if (details === undefined) {
      details = new Map<string, ReasonDetail>();
      grouped.set(input.code, details);
    }
    details.set(detailSortKey(input.detail), input.detail);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => (reasonOrder.get(left) ?? 0) - (reasonOrder.get(right) ?? 0))
    .map(([code, details]) => ({
      code,
      details: [...details.values()].sort((left, right) =>
        compareText(detailSortKey(left), detailSortKey(right))),
    }));
}

function identity(input: PlaneAEvaluationInput) {
  return {
    task: input.request.task,
    operation: input.request.operation,
    factKind: input.request.factKind,
    requestedScopeDescriptor: input.request.requestedScopeDescriptor,
    candidateIdentity: input.request.candidateIdentity,
  };
}

function notApplicableGates(): PlaneAGates {
  return {
    discoveryAndScope: "failed",
    bindingAndIntegrity: "not_applicable",
    currentFreshness: "not_applicable",
    capabilityMatch: "not_applicable",
    negativeCompleteness: "not_applicable",
    taskRelativeAuthority: "not_applicable",
  };
}

function sameScope(left: ArtifactScope, right: ArtifactScope): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameProducer(
  left: { identity: string; version: string },
  right: { identity: string; version: string },
): boolean {
  return left.identity === right.identity && left.version === right.version;
}

function addMismatch(
  reasons: { code: PlaneAReasonCode; detail: ReasonDetail }[],
  code: PlaneAReasonCode,
  coordinate: string,
  expected: ReasonDetail["expected"],
  actual: ReasonDetail["actual"],
): void {
  if (canonicalJson(expected) !== canonicalJson(actual)) {
    reasons.push({ code, detail: { coordinate, expected, actual } });
  }
}

function addScopeMismatches(
  reasons: { code: PlaneAReasonCode; detail: ReasonDetail }[],
  code: PlaneAReasonCode,
  expected: ArtifactScope,
  actual: ArtifactScope,
  includeLanguageCoordinates: boolean,
): void {
  addMismatch(
    reasons,
    code,
    "repositoryIdentity",
    expected.repositoryIdentity,
    actual.repositoryIdentity,
  );
  addMismatch(
    reasons,
    code,
    "sourceStateDigest",
    expected.sourceStateDigest,
    actual.sourceStateDigest,
  );
  addMismatch(
    reasons,
    code,
    "selectedPathSetDigest",
    expected.selectedPathSetDigest,
    actual.selectedPathSetDigest,
  );
  addMismatch(
    reasons,
    code,
    "selectedPaths",
    expected.selectedPaths,
    actual.selectedPaths,
  );
  addMismatch(
    reasons,
    code,
    "workspaceUnitId",
    expected.workspaceUnitId ?? null,
    actual.workspaceUnitId ?? null,
  );
  if (includeLanguageCoordinates) {
    addMismatch(reasons, code, "language", expected.language, actual.language);
    addMismatch(
      reasons,
      code,
      "dialectVersion",
      expected.dialectVersion ?? null,
      actual.dialectVersion ?? null,
    );
  }
}

function capabilityReasons(
  input: PlaneAEvaluationInput,
  batch: FactBatchV1,
  profiles: readonly CapabilityProfile[],
): { code: PlaneAReasonCode; detail: ReasonDetail }[] {
  const profile = profiles.length === 1 ? profiles[0] : undefined;
  if (profile === undefined) {
    return [{
      code: "CAPABILITY_MISSING",
      detail: {
        coordinate: "capabilityProfileCardinality",
        expected: 1,
        actual: profiles.length,
      },
    }];
  }
  const reasons: { code: PlaneAReasonCode; detail: ReasonDetail }[] = [];
  addScopeMismatches(
    reasons,
    "SCOPE_MISMATCH",
    profile.scope,
    batch.scope,
    false,
  );
  addMismatch(reasons, "CAPABILITY_MISSING", "language", profile.scope.language, batch.scope.language);
  addMismatch(
    reasons,
    "CAPABILITY_MISSING",
    "dialectVersion",
    profile.scope.dialectVersion ?? null,
    batch.scope.dialectVersion ?? null,
  );
  addMismatch(
    reasons,
    "CAPABILITY_MISSING",
    "producerIdentity",
    profile.producer.identity,
    batch.producer.identity,
  );
  addMismatch(
    reasons,
    "PRODUCER_VERSION_MISMATCH",
    "producerVersion",
    profile.producer.version,
    batch.producer.version,
  );
  addMismatch(
    reasons,
    "CONFIG_DIGEST_MISMATCH",
    "producerConfigurationDigest",
    profile.producerConfigurationDigest,
    batch.producerConfigurationDigest,
  );
  addMismatch(
    reasons,
    "SCHEMA_DIGEST_MISMATCH",
    "factSchemaDigest",
    profile.factSchemaDigest,
    batch.factSchemaDigest,
  );
  addMismatch(
    reasons,
    "EVIDENCE_CONTRACT_MISMATCH",
    "evidenceContract",
    profile.evidenceContract,
    batch.evidenceContract,
  );
  addMismatch(
    reasons,
    "CAPABILITY_MISSING",
    "resolutionSemantics",
    input.requiredCapability.resolutionSemantics,
    profile.resolutionSemantics,
  );
  addMismatch(
    reasons,
    "CAPABILITY_MISSING",
    "soundnessClaim",
    input.requiredCapability.soundnessClaim,
    profile.soundnessClaim,
  );
  if (!input.request.negativeConclusion) {
    addMismatch(
      reasons,
      "CAPABILITY_MISSING",
      "completenessClaim",
      input.requiredCapability.completenessClaim,
      profile.completenessClaim,
    );
  }
  return reasons;
}

function exactDecision(
  input: PlaneAEvaluationInput,
  reasons: PlaneAReason[],
  gates: PlaneAGates,
  normalizedAnalysisOutcome: AnalysisOutcome,
): ExactSubjectDecision {
  const hasPolicyDenial = reasons.some((reason) => reason.code === "POLICY_DENIED");
  const hasInsufficient = reasons.some((reason) =>
    reason.code !== "POLICY_DENIED");
  const outcome = reasons.length === 0
    ? "PASS"
    : hasInsufficient
      ? "INSUFFICIENT_ANALYSIS"
      : hasPolicyDenial
        ? "POLICY_DENIED"
        : "UNKNOWN";
  return {
    ...identity(input),
    decisionKind: "exact_subject",
    scope: input.scopeResolution.status === "exact"
      ? input.scopeResolution.scope
      : input.ledgerEntry.scope,
    outcome,
    admissible: reasons.length === 0,
    normalizedAnalysisOutcome,
    reasons,
    ...(reasons[0] !== undefined ? { primaryReason: reasons[0].code } : {}),
    gates,
  };
}

export function evaluatePlaneA(input: PlaneAEvaluationInput): PlaneAEvaluationDecision {
  const normalizedLedger = normalizeDiscoveryLedgerEntry(input.ledgerEntry);
  input = { ...input, ledgerEntry: normalizedLedger };
  if (input.scopeResolution.status === "unresolved") {
    const reasons = normalizeReasons(input.scopeResolution.failures);
    const primaryReason = reasons[0]?.code;
    if (primaryReason === undefined) {
      throw new TypeError("unresolved scope requires at least one gate-1 failure");
    }
    return {
      ...identity(input),
      decisionKind: "pre_subject",
      outcome: "INSUFFICIENT_ANALYSIS",
      admissible: false,
      reasons,
      primaryReason,
      gates: notApplicableGates(),
    };
  }
  const exactScope = input.scopeResolution.scope;

  const ledger = input.ledgerEntry;
  if (!sameScope(exactScope, ledger.scope)) {
    const scopeFailures: { code: PlaneAReasonCode; detail: ReasonDetail }[] = [];
    addScopeMismatches(
      scopeFailures,
      "DISCOVERY_NOT_ESTABLISHED",
      exactScope,
      ledger.scope,
      true,
    );
    const reasons = normalizeReasons(scopeFailures);
    return exactDecision(input, reasons, notApplicableGates(), "failed");
  }
  if (ledger.selectionDecision === "excluded") {
    const reasons = normalizeReasons([{
      code: "DISCOVERY_NOT_ESTABLISHED",
      detail: { coordinate: "selectionDecision", expected: "selected", actual: "excluded" },
    }]);
    return exactDecision(input, reasons, notApplicableGates(), ledger.analysisOutcome);
  }
  if (ledger.analysisOutcome !== "analyzed") {
    const code = terminalReason[ledger.analysisOutcome];
    if (code === undefined) {
      throw new TypeError(`invalid selected analysis outcome: ${ledger.analysisOutcome}`);
    }
    const reasons = normalizeReasons([{
      code,
      detail: {
        coordinate: "analysisOutcome",
        expected: "analyzed",
        actual: ledger.analysisOutcome,
      },
    }]);
    return exactDecision(input, reasons, notApplicableGates(), ledger.analysisOutcome);
  }

  const completedResults = input.completedResults.filter((result) =>
    result.status === "completed"
    && sameScope(result.scope, exactScope)
    && ledger.selectedProducer !== undefined
    && sameProducer(result.producer, ledger.selectedProducer));
  if (completedResults.length !== 1) {
    const reasons = normalizeReasons([{
      code: "PRODUCER_FAILED",
      detail: {
        coordinate: "resultCardinality",
        expected: 1,
        actual: completedResults.length,
      },
    }]);
    return exactDecision(input, reasons, notApplicableGates(), "failed");
  }
  const completedResult = completedResults[0];
  const scopedFactBatches = input.factBatches.filter((batch) =>
    batch.factKinds.includes(input.request.factKind)
    && sameScope(batch.scope, exactScope)
    && ledger.selectedProducer !== undefined
    && sameProducer(batch.producer, ledger.selectedProducer));
  const correspondingBatches = scopedFactBatches.filter((batch) =>
    batch.batchId === completedResult?.factBatchId);
  const factBatchCardinality = scopedFactBatches.length === 1
    ? correspondingBatches.length
    : scopedFactBatches.length;
  if (factBatchCardinality !== 1) {
    const reasons = normalizeReasons([{
      code: "PRODUCER_FAILED",
      detail: {
        coordinate: "factBatchCardinality",
        expected: 1,
        actual: factBatchCardinality,
      },
    }]);
    return exactDecision(input, reasons, notApplicableGates(), "failed");
  }
  const factBatch = correspondingBatches[0]!;
  const failures: { code: PlaneAReasonCode; detail: ReasonDetail }[] = [];
  if (input.bindingAttestation === "absent") {
    failures.push({
      code: "BINDING_UNSEALED",
      detail: { coordinate: "bindingAttestation", expected: "valid", actual: "absent" },
    });
  } else if (input.bindingAttestation === "invalid") {
    failures.push({
      code: "BINDING_INVALID",
      detail: { coordinate: "bindingAttestation", expected: "valid", actual: "invalid" },
    });
  }
  if (input.currentFreshness === "UNSEALED") {
    failures.push({
      code: "CURRENT_STATE_UNSEALED",
      detail: { coordinate: "currentFreshness", expected: "FRESH", actual: "UNSEALED" },
    });
  } else if (input.currentFreshness === "STALE") {
    failures.push({
      code: "CURRENT_STATE_STALE",
      detail: { coordinate: "currentFreshness", expected: "FRESH", actual: "STALE" },
    });
  }
  const profilesForFactKind = input.capabilityProfiles
    .filter((candidate) =>
      candidate.factKind === input.request.factKind
      && factBatch.capabilityProfileIds.includes(candidate.profileId))
    .sort((left, right) => compareText(left.profileId, right.profileId));
  const profile = profilesForFactKind.length === 1 ? profilesForFactKind[0] : undefined;
  failures.push(...capabilityReasons(input, factBatch, profilesForFactKind));
  if (input.request.negativeConclusion) {
    if (
      profile === undefined
      || profile.completenessClaim !== input.requiredCapability.completenessClaim
    ) {
      failures.push({
        code: "NEGATIVE_COMPLETENESS_MISSING",
        detail: {
          coordinate: "completenessClaim",
          expected: input.requiredCapability.completenessClaim,
          actual: profile?.completenessClaim ?? null,
        },
      });
    }
    if (profile?.negativeEvidenceEligible !== true) {
      failures.push({
        code: "NEGATIVE_COMPLETENESS_MISSING",
        detail: {
          coordinate: "negativeEvidenceEligible",
          expected: true,
          actual: profile?.negativeEvidenceEligible ?? null,
        },
      });
    }
  }
  if (!input.taskRelativeAuthority.admissible) {
    failures.push({
      code: "POLICY_DENIED",
      detail: {
        coordinate: "taskRelativeAuthority",
        expected: true,
        actual: false,
      },
    });
  }

  const reasons = normalizeReasons(failures);
  const codes = new Set(reasons.map((reason) => reason.code));
  const gates: PlaneAGates = {
    discoveryAndScope: "passed",
    bindingAndIntegrity: codes.has("BINDING_UNSEALED") || codes.has("BINDING_INVALID")
      ? "failed"
      : "passed",
    currentFreshness: codes.has("CURRENT_STATE_UNSEALED") || codes.has("CURRENT_STATE_STALE")
      ? "failed"
      : "passed",
    capabilityMatch: reasons.some((reason) =>
      reasonOrder.get(reason.code)! >= reasonOrder.get("SCOPE_MISMATCH")!
      && reasonOrder.get(reason.code)! <= reasonOrder.get("EVIDENCE_CONTRACT_MISMATCH")!)
      ? "failed"
      : "passed",
    negativeCompleteness: input.request.negativeConclusion
      ? codes.has("NEGATIVE_COMPLETENESS_MISSING") ? "failed" : "passed"
      : "not_applicable",
    taskRelativeAuthority: codes.has("POLICY_DENIED") ? "failed" : "passed",
  };
  return exactDecision(input, reasons, gates, "analyzed");
}

function decisionSortKey(decision: PlaneAEvaluationDecision): string {
  return canonicalJson([
    decision.task,
    decision.operation,
    decision.factKind,
    decision.requestedScopeDescriptor,
    decision.candidateIdentity,
    decision.decisionKind,
    decision.decisionKind === "exact_subject" ? decision.scope : null,
  ]);
}

export function aggregatePlaneAEvaluations(
  decisions: readonly PlaneAEvaluationDecision[],
): PlaneAEvaluationReport {
  const ordered = [...decisions].sort((left, right) =>
    compareText(decisionSortKey(left), decisionSortKey(right)));
  const present = new Set(ordered.flatMap((decision) =>
    decision.reasons.map((reason) => reason.code)));
  const reasonSummary = PLANE_A_REASON_CODES.filter((code) => present.has(code));
  return {
    schemaVersion: 1,
    decisions: ordered,
    reasonSummary,
    ...(reasonSummary[0] !== undefined ? { primaryReason: reasonSummary[0] } : {}),
  };
}
