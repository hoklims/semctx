import { compareIds, type EvidenceRecord } from "@semantic-context/core";
import {
  AttestationRequestV1Schema,
  CanonicalProofAttestationV1Schema,
  ControlQueryEnvelopeV1Schema,
  SealedAttestationIndexV1Schema,
  computeControlFreshnessSealV2Hash,
  normalizeControlFreshnessSealV1,
  type AdvisoryRejectedAttestationV1,
  type ArchitectureSnapshot,
  type AttestationRequestV1,
  type CanonicalProofAttestationV1,
  type ControlFreshnessSeal,
  type ControlFreshnessSealV2,
  type ControlFreshnessStatusReport,
  type ControlQueryEnvelopeV1,
  type CoordinateGraphReportV2,
  type DeletionAuthorizationInput,
  type DeletionAuthorizationReportV2,
  type ProofAttestation,
  type SealedAttestationIndexV1,
  type QualifiedCoordinateId,
  type SemanticLevel,
  type Sha256Hash,
  type StepAuthorizationInput,
  type StepAuthorizationReportV2,
  type TransitionAuthorizationInput,
  type TransitionAuthorizationReportV2,
} from "@semantic-context/control-model";
import {
  authorizeDeletion,
  authorizeStep,
  authorizeTransition,
  compareArchitectures,
  explainWhy,
  impact,
  lift,
  lower,
  refinementCoverage,
  type TraversalBounds,
} from "@semantic-context/control-engine";

export const CONTROL_ATTESTATION_INDEX_META_KEY = "control_attestation_index_v1";

type Envelope<K extends ControlQueryEnvelopeV1["kind"]> = Extract<ControlQueryEnvelopeV1, { kind: K }>;

export interface ControlQueryRuntime {
  graph: CoordinateGraphReportV2;
  freshnessStatus: ControlFreshnessStatusReport;
  freshnessSeal: ControlFreshnessSeal | ControlFreshnessSealV2 | null;
  currentArchitecture: ArchitectureSnapshot;
  sealedAttestationIndex: SealedAttestationIndexV1 | null;
  sealedEvidence: readonly EvidenceRecord[];
}

export interface TraversalQueryV1 extends TraversalBounds {
  sourceId: QualifiedCoordinateId | Sha256Hash;
  targetLevel: SemanticLevel;
  direction: "lift" | "lower";
}

export interface RefinementCoverageQueryV1 extends TraversalQueryV1 {
  sourceSeal?: Sha256Hash;
  indexSeal?: Sha256Hash;
}

export interface ImpactQueryV1 extends TraversalBounds {
  sourceIds: readonly QualifiedCoordinateId[];
}

export interface ExplanationQueryV1 extends TraversalBounds {
  sourceId: QualifiedCoordinateId;
}

export type TransitionAuthorizationQueryV1 =
  Omit<TransitionAuthorizationInput, "attestations"> & {
    attestationRequests: readonly AttestationRequestV1[];
  };

export type StepAuthorizationQueryV1 =
  Omit<StepAuthorizationInput, "attestations"> & {
    attestationRequests: readonly AttestationRequestV1[];
  };

export type DeletionAuthorizationQueryV1 =
  Omit<DeletionAuthorizationInput, "attestations"> & {
    attestationRequests: readonly AttestationRequestV1[];
  };

export function architectureComparisonQuery(
  runtime: ControlQueryRuntime,
  target: ArchitectureSnapshot,
): Envelope<"architecture_comparison"> {
  const refused = freshnessRefusal(runtime, "architecture_comparison");
  if (refused !== null) return refused;
  return envelope(runtime, "architecture_comparison", compareArchitectures(runtime.currentArchitecture, target));
}

export function coordinateGraphQuery(runtime: ControlQueryRuntime): Envelope<"coordinate_graph"> {
  const refused = freshnessRefusal(runtime, "coordinate_graph");
  return refused ?? envelope(runtime, "coordinate_graph", runtime.graph);
}

export function traversalQuery(
  runtime: ControlQueryRuntime,
  query: TraversalQueryV1,
): Envelope<"traversal"> {
  const refused = freshnessRefusal(runtime, "traversal");
  if (refused !== null) return refused;
  const report = query.direction === "lift"
    ? lift(runtime.graph, query.sourceId, query.targetLevel, query)
    : lower(runtime.graph, query.sourceId, query.targetLevel, query);
  return reportEnvelope(runtime, "traversal", report, report.terminalStatus, report.reasonCode);
}

export function refinementCoverageQuery(
  runtime: ControlQueryRuntime,
  query: RefinementCoverageQueryV1,
): Envelope<"refinement_coverage"> {
  const refused = freshnessRefusal(runtime, "refinement_coverage");
  if (refused !== null) return refused;
  const seal = asFreshnessV2(runtime.freshnessSeal);
  if (
    seal === null
    || (query.sourceSeal !== undefined && query.sourceSeal !== seal.sealHash)
    || (query.indexSeal !== undefined && query.indexSeal !== seal.sealHash)
  ) return refusal(runtime, "refinement_coverage", "INDEX_STALE");
  const {
    sourceSeal: _sourceSeal,
    indexSeal: _indexSeal,
    sourceId,
    targetLevel,
    direction,
    ...bounds
  } = query;
  const report = refinementCoverage(
    runtime.graph,
    sourceId,
    targetLevel,
    direction,
    { ...bounds, sourceSeal: seal.sealHash, indexSeal: seal.sealHash },
  );
  return reportEnvelope(runtime, "refinement_coverage", report, report.terminalStatus, report.reasonCode);
}

export function impactQuery(
  runtime: ControlQueryRuntime,
  query: ImpactQueryV1,
): Envelope<"impact"> {
  const refused = freshnessRefusal(runtime, "impact");
  if (refused !== null) return refused;
  const report = impact(runtime.graph, [...query.sourceIds], query);
  const known = new Set(runtime.graph.nodes.map((node) => node.id));
  const hasKnownSource = query.sourceIds.some((sourceId) => known.has(sourceId));
  if (!hasKnownSource) return reportEnvelope(runtime, "impact", report, "empty", "COORDINATE_UNKNOWN");
  return reportEnvelope(
    runtime,
    "impact",
    report,
    report.truncated ? "budget_exhausted" : "success",
    report.truncated ? "BUDGET_EXHAUSTED" : undefined,
  );
}

export function explanationQuery(
  runtime: ControlQueryRuntime,
  query: ExplanationQueryV1,
): Envelope<"explanation"> {
  const refused = freshnessRefusal(runtime, "explanation");
  if (refused !== null) return refused;
  const report = explainWhy(runtime.graph, query.sourceId, query);
  if (report.known) return reportEnvelope(runtime, "explanation", report, "success");
  let reason: "COORDINATE_UNKNOWN" | "BUDGET_EXHAUSTED" | "REFINEMENT_DISCONNECTED";
  if (report.unknownReason === "coordinate_missing") reason = "COORDINATE_UNKNOWN";
  else if (report.unknownReason === "traversal_bound_reached") reason = "BUDGET_EXHAUSTED";
  else reason = "REFINEMENT_DISCONNECTED";
  return reportEnvelope(
    runtime,
    "explanation",
    report,
    reason === "BUDGET_EXHAUSTED" ? "budget_exhausted" : "empty",
    reason,
  );
}

export function transitionAuthorizationQuery(
  runtime: ControlQueryRuntime,
  query: TransitionAuthorizationQueryV1,
): Envelope<"authorize_transition"> {
  const refused = freshnessRefusal(runtime, "authorize_transition");
  if (refused !== null) return refused;
  if (query.planningCommit !== runtime.currentArchitecture.commit) {
    return refusal(runtime, "authorize_transition", "PLANNING_COMMIT_MISMATCH");
  }
  const resolved = resolveAttestations(runtime, query.attestationRequests, query.planningCommit);
  const { attestationRequests: _requests, ...authorizationInput } = query;
  const report = authorizeTransition({
    ...authorizationInput,
    attestations: resolved.accepted.map(toProofAttestation),
  });
  const payload: TransitionAuthorizationReportV2 = {
    ...report,
    schemaVersion: 2,
    acceptedAttestations: resolved.accepted,
    advisoryRejectedAttestations: resolved.rejected,
  };
  return envelope(
    runtime,
    "authorize_transition",
    payload,
    resolved.rejected.length === 0 ? [] : ["ATTESTATION_UNBOUND"],
  );
}

export function stepAuthorizationQuery(
  runtime: ControlQueryRuntime,
  query: StepAuthorizationQueryV1,
): Envelope<"authorize_step"> {
  const refused = freshnessRefusal(runtime, "authorize_step");
  if (refused !== null) return refused;
  if (
    query.plan.planningCommit !== runtime.currentArchitecture.commit
    || query.executionState.planningCommit !== query.plan.planningCommit
  ) {
    return refusal(runtime, "authorize_step", "PLANNING_COMMIT_MISMATCH");
  }
  const resolved = resolveAttestations(runtime, query.attestationRequests, query.plan.planningCommit);
  const { attestationRequests: _requests, ...authorizationInput } = query;
  const report = authorizeStep({
    ...authorizationInput,
    attestations: resolved.accepted.map(toProofAttestation),
  });
  const payload: StepAuthorizationReportV2 = {
    ...report,
    schemaVersion: 2,
    acceptedAttestations: resolved.accepted,
    advisoryRejectedAttestations: resolved.rejected,
  };
  return envelope(
    runtime,
    "authorize_step",
    payload,
    resolved.rejected.length === 0 ? [] : ["ATTESTATION_UNBOUND"],
  );
}

export function deletionAuthorizationQuery(
  runtime: ControlQueryRuntime,
  query: DeletionAuthorizationQueryV1,
): Envelope<"authorize_deletion"> {
  const refused = freshnessRefusal(runtime, "authorize_deletion");
  if (refused !== null) return refused;
  if (query.planningCommit !== runtime.currentArchitecture.commit) {
    return refusal(runtime, "authorize_deletion", "PLANNING_COMMIT_MISMATCH");
  }
  const resolved = resolveAttestations(runtime, query.attestationRequests, query.planningCommit);
  const { attestationRequests: _requests, ...authorizationInput } = query;
  const report = authorizeDeletion({
    ...authorizationInput,
    attestations: resolved.accepted.map(toProofAttestation),
  });
  const payload: DeletionAuthorizationReportV2 = {
    ...report,
    schemaVersion: 2,
    acceptedAttestations: resolved.accepted,
    advisoryRejectedAttestations: resolved.rejected,
  };
  return envelope(
    runtime,
    "authorize_deletion",
    payload,
    resolved.rejected.length === 0 ? [] : ["ATTESTATION_UNBOUND"],
  );
}

export function parseSealedAttestationIndex(value: string | undefined): SealedAttestationIndexV1 | null {
  if (value === undefined) return null;
  try {
    return SealedAttestationIndexV1Schema.parse(JSON.parse(value)) as SealedAttestationIndexV1;
  } catch {
    return null;
  }
}

export function bindControlFreshnessSealV2(
  seal: ControlFreshnessSeal,
  committedAttestationSetHash: Sha256Hash | null,
): ControlFreshnessSealV2 {
  const normalized = normalizeControlFreshnessSealV1(seal).value;
  const { sealHash: _normalizedHash, ...preserved } = normalized;
  const payload: Omit<ControlFreshnessSealV2, "sealHash"> = {
    ...preserved,
    attestationSetHash: committedAttestationSetHash,
  };
  return { ...payload, sealHash: computeControlFreshnessSealV2Hash(payload) };
}

function resolveAttestations(
  runtime: ControlQueryRuntime,
  requests: readonly AttestationRequestV1[],
  planningCommit: string,
): {
  accepted: CanonicalProofAttestationV1[];
  rejected: AdvisoryRejectedAttestationV1[];
} {
  const canonicalRequests = canonicalizeRequests(requests);
  const index = runtime.sealedAttestationIndex;
  const seal = asFreshnessV2(runtime.freshnessSeal);
  const indexValid = index !== null
    && SealedAttestationIndexV1Schema.safeParse(index).success
    && seal?.attestationSetHash !== null
    && seal?.attestationSetHash === index.attestationSetHash;
  const byId = new Map(indexValid ? index.entries.map((entry) => [entry.id, entry]) : []);
  const evidenceById = new Map(runtime.sealedEvidence.map((evidence) => [evidence.id, evidence]));
  const accepted: CanonicalProofAttestationV1[] = [];
  const rejected: AdvisoryRejectedAttestationV1[] = [];

  for (const request of canonicalRequests) {
    const candidate = byId.get(request.attestationRef);
    const candidateValid = candidate !== undefined
      && CanonicalProofAttestationV1Schema.safeParse(candidate).success
      && candidate.commit === planningCommit
      && candidate.references.every((reference) => {
        const evidence = evidenceById.get(reference.uri);
        return evidence !== undefined && proofKindAcceptsEvidence(reference.kind, evidence.sourceKind);
      });
    if (candidateValid) accepted.push(candidate);
    else rejected.push({
      schemaVersion: 1,
      attestationRef: request.attestationRef,
      reason: "ATTESTATION_UNBOUND",
    });
  }

  return {
    accepted: accepted.sort((left, right) => compareIds(left.id, right.id)),
    rejected: rejected.sort((left, right) => compareIds(left.attestationRef, right.attestationRef)),
  };
}

function proofKindAcceptsEvidence(
  proofKind: CanonicalProofAttestationV1["references"][number]["kind"],
  sourceKind: EvidenceRecord["sourceKind"],
): boolean {
  switch (proofKind) {
    case "architecture": return sourceKind === "document";
    case "static_analysis": return sourceKind === "code";
    case "runtime_observation": return sourceKind === "runtime";
    case "test": return sourceKind === "test";
    case "history": return sourceKind === "git";
    case "human_approval": return sourceKind === "manual";
    case "rollback": return sourceKind === "test" || sourceKind === "document";
    case "other": return false;
  }
}

function canonicalizeRequests(requests: readonly AttestationRequestV1[]): AttestationRequestV1[] {
  const parsed = requests.map((request) => AttestationRequestV1Schema.parse({
    schemaVersion: request.schemaVersion,
    attestationRef: request.attestationRef,
  }) as AttestationRequestV1);
  return [...new Map(parsed.map((request) => [request.attestationRef, request])).values()]
    .sort((left, right) => compareIds(left.attestationRef, right.attestationRef));
}

function toProofAttestation(attestation: CanonicalProofAttestationV1): ProofAttestation {
  return {
    id: attestation.id,
    obligation: attestation.obligation,
    subject: attestation.subject,
    epistemicStatus: attestation.epistemicStatus,
    references: attestation.references.map((reference) => ({ ...reference })),
    commit: attestation.commit,
    observedAt: attestation.observedAt,
    expiresAt: attestation.expiresAt,
  };
}

function asFreshnessV2(
  seal: ControlFreshnessSeal | ControlFreshnessSealV2 | null,
): ControlFreshnessSealV2 | null {
  if (seal === null) return null;
  return seal.sealSchemaVersion === 2
    ? seal as ControlFreshnessSealV2
    : normalizeControlFreshnessSealV1(seal as ControlFreshnessSeal).value;
}

function freshnessRefusal<K extends ControlQueryEnvelopeV1["kind"]>(
  runtime: ControlQueryRuntime,
  kind: K,
): Extract<ControlQueryEnvelopeV1, { kind: K }> | null {
  return runtime.freshnessStatus.canRunHighRiskControl
    ? null
    : refusal(runtime, kind, "INDEX_STALE");
}

function refusal<K extends ControlQueryEnvelopeV1["kind"]>(
  runtime: ControlQueryRuntime,
  kind: K,
  reason: "INDEX_STALE" | "PLANNING_COMMIT_MISMATCH",
): Extract<ControlQueryEnvelopeV1, { kind: K }> {
  return validateEnvelope({
    schemaVersion: 1,
    kind,
    freshness: freshness(runtime),
    terminalStatus: "refused",
    reasonCodes: [reason],
    payload: null,
  } as unknown as Extract<ControlQueryEnvelopeV1, { kind: K }>);
}

function envelope<K extends ControlQueryEnvelopeV1["kind"]>(
  runtime: ControlQueryRuntime,
  kind: K,
  payload: Extract<ControlQueryEnvelopeV1, { kind: K }>["payload"] extends infer P | null ? P : never,
  reasonCodes: Extract<ControlQueryEnvelopeV1, { kind: K }>["reasonCodes"] = [],
): Extract<ControlQueryEnvelopeV1, { kind: K }> {
  return validateEnvelope({
    schemaVersion: 1,
    kind,
    freshness: freshness(runtime),
    terminalStatus: "success",
    reasonCodes: [...reasonCodes].sort(compareIds),
    payload,
  } as unknown as Extract<ControlQueryEnvelopeV1, { kind: K }>);
}

function reportEnvelope<K extends ControlQueryEnvelopeV1["kind"]>(
  runtime: ControlQueryRuntime,
  kind: K,
  payload: NonNullable<Extract<ControlQueryEnvelopeV1, { kind: K }>["payload"]>,
  terminalStatus: Extract<ControlQueryEnvelopeV1, { kind: K }>["terminalStatus"],
  reason?: Extract<ControlQueryEnvelopeV1, { kind: K }>["reasonCodes"][number],
): Extract<ControlQueryEnvelopeV1, { kind: K }> {
  return validateEnvelope({
    schemaVersion: 1,
    kind,
    freshness: freshness(runtime),
    terminalStatus,
    reasonCodes: reason === undefined ? [] : [reason],
    payload,
  } as unknown as Extract<ControlQueryEnvelopeV1, { kind: K }>);
}

function freshness(runtime: ControlQueryRuntime): ControlQueryEnvelopeV1["freshness"] {
  return {
    verdict: runtime.freshnessStatus.verdict,
    reasons: [...runtime.freshnessStatus.reasons],
    seal: asFreshnessV2(runtime.freshnessSeal),
  };
}

function validateEnvelope<T extends ControlQueryEnvelopeV1>(value: T): T {
  return ControlQueryEnvelopeV1Schema.parse(value) as unknown as T;
}
