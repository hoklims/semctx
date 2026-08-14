import type { ControlFreshnessStatusReport } from "@semantic-context/control-model";
import type {
  Claim,
  EvidenceRecord,
  RepositoryGraph,
} from "@semantic-context/core";
import { isSemctxError } from "@semantic-context/core";
import {
  PLANE_A_REASON_CODES,
  admissibleFor,
  aggregatePlaneAEvaluations,
  digestCanonical,
  evaluatePlaneA,
  type AnalysisOutcome,
  type DiscoveryLedgerEntry,
  type PlaneAEvaluationDecision,
  type PlaneAEvaluationReport,
  type PlaneAReasonCode,
  type PlaneASidecarV1,
} from "@semantic-context/plane-a-internal";
import { loadConfig } from "@semantic-context/repository-store";
import { openReadyRepository } from "./readiness";
import type { WorkspaceProjection } from "@semantic-context/workspace-analyzer-internal";
import { controlStatus } from "./control";
import { resolvePlaneACapabilityRequirement } from "./plane-a-capability-requirements";
import { isPlaneAOperationAdmitted } from "./plane-a-authority-policy";
import { readUnresolvedReferenceBinding } from "./unresolved-references";
import {
  CONTROL_INDEX_SNAPSHOT_META_KEY,
  PLANE_A_INDEX_SNAPSHOT_META_KEY,
  fingerprintRepositoryFacts,
  parseIndexedControlSnapshot,
} from "./freshness";

export { PLANE_A_INDEX_SNAPSHOT_META_KEY } from "./freshness";

export interface PersistedPlaneAIndexSnapshotV1 {
  schemaVersion: 1;
  capturedAt: string;
  repositoryGraphHash: string;
  sidecarDigest: string;
  workspaceDigest: string;
  /**
   * Binds the index's unresolved-reference record into the snapshot digest, and through it into the
   * control freshness seal. Optional so a snapshot written before the record existed still parses;
   * every snapshot this build writes carries it.
   */
  unresolvedReferenceIndexHash?: string;
  sidecar: PlaneASidecarV1;
  workspace: WorkspaceProjection;
}

export interface IndexHealthCandidateV1 {
  candidateIdentity: string;
  path: string;
  language: string;
  workspaceUnitId: string | null;
  selectionDecision: DiscoveryLedgerEntry["selectionDecision"];
  analysisOutcome: AnalysisOutcome;
  selectionReasons: string[];
  analysisReasons: string[];
  producer: { identity: string; version: string } | null;
  negativeEvidenceEligible: boolean;
}

export interface IndexHealthReportV1 {
  schemaVersion: 1;
  kind: "index_health";
  capturedAt: string | null;
  binding: {
    status: "valid" | "invalid" | "absent";
    sidecarDigest: string | null;
    workspaceDigest: string | null;
  };
  freshness: Pick<
    ControlFreshnessStatusReport,
    "verdict" | "canRunHighRiskControl" | "reasons"
  >;
  coverage: {
    status: "complete" | "partial" | "insufficient";
    candidates: number;
    selected: number;
    excluded: number;
    analyzed: number;
    disabled: number;
    unsupported: number;
    failed: number;
  };
  candidates: IndexHealthCandidateV1[];
  capabilities: {
    profileId: string;
    factKind: string;
    language: string;
    producer: { identity: string; version: string };
    completenessClaim: string;
    negativeEvidenceEligible: boolean;
    label: string | null;
  }[];
  workspace: WorkspaceProjection | null;
  evaluations: PlaneAEvaluationReport;
  reasonSummary: PlaneAReasonCode[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NODE_KINDS = new Set([
  "repository",
  "package",
  "module",
  "symbol",
  "type",
  "function",
  "class",
  "interface",
  "enum",
  "test",
  "migration",
  "document",
  "contract",
  "invariant",
  "capability",
  "bounded_context",
  "decision",
  "risk",
  "external_integration",
]);

const EDGE_KINDS = new Set([
  "imports",
  "exports",
  "calls",
  "references",
  "extends",
  "implements",
  "declares",
  "tested_by",
  "covers",
  "depends_on",
  "belongs_to",
  "implements_capability",
  "constrained_by",
  "verifies",
  "documents",
  "decides",
  "changes",
  "contradicts",
  "related_to",
]);

const EVIDENCE_SOURCE_KINDS = new Set([
  "code",
  "test",
  "document",
  "git",
  "runtime",
  "manual",
]);

const CLAIM_KINDS = new Set([
  "contract",
  "invariant",
  "decision",
  "capability",
  "behavior",
  "risk",
  "ownership",
  "deprecation",
  "assumption",
]);

const VERIFICATION_STATUSES = new Set([
  "unverified",
  "inferred",
  "documented",
  "tested",
  "statically_verified",
  "runtime_verified",
  "contradicted",
  "deprecated",
]);

const ANALYSIS_OUTCOMES = new Set<AnalysisOutcome>([
  "not_applicable",
  "disabled",
  "unsupported",
  "failed",
  "analyzed",
]);

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isSha256(value: unknown): value is string {
  return isString(value) && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value);
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isOptionalLine(value: unknown): value is number | undefined {
  return value === undefined
    || (typeof value === "number" && Number.isSafeInteger(value) && value >= 1);
}

function isMetadata(value: unknown): value is Record<string, string | number | boolean> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((member) =>
    typeof member === "string"
    || typeof member === "boolean"
    || (typeof member === "number" && Number.isFinite(member)));
}

function isEvidenceRef(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isString(value["filePath"])
    && EVIDENCE_SOURCE_KINDS.has(value["sourceKind"] as string)
    && isOptionalLine(value["startLine"])
    && isOptionalLine(value["endLine"])
    && isOptionalString(value["excerpt"])
  );
}

function isArtifactScope(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value["repositoryIdentity"])
    && isSha256(value["sourceStateDigest"])
    && isSha256(value["selectedPathSetDigest"])
    && isStringArray(value["selectedPaths"])
    && isOptionalString(value["workspaceUnitId"])
    && isNonEmptyString(value["language"])
    && isOptionalString(value["dialectVersion"])
  );
}

function isProducerIdentity(value: unknown): boolean {
  return (
    isRecord(value)
    && isNonEmptyString(value["identity"])
    && isNonEmptyString(value["version"])
  );
}

function isPlaneAFact(value: unknown): boolean {
  if (
    !isRecord(value)
    || typeof value["ordinal"] !== "number"
    || !Number.isSafeInteger(value["ordinal"])
    || value["ordinal"] < 0
  ) {
    return false;
  }
  if (
    !Array.isArray(value["evidence"])
    || !value["evidence"].every(isEvidenceRef)
    || !isMetadata(value["metadata"])
  ) {
    return false;
  }
  if (value["factType"] === "node") {
    return (
      isNonEmptyString(value["id"])
      && NODE_KINDS.has(value["kind"] as string)
      && isString(value["name"])
      && isOptionalString(value["filePath"])
      && isOptionalString(value["boundedContext"])
      && isOptionalBoolean(value["exported"])
      && isStringArray(value["tags"])
    );
  }
  if (value["factType"] === "edge") {
    return (
      EDGE_KINDS.has(value["kind"] as string)
      && isNonEmptyString(value["from"])
      && isNonEmptyString(value["to"])
    );
  }
  return false;
}

function isCapabilityProfile(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value["profileId"])
    && isNonEmptyString(value["factKind"])
    && isArtifactScope(value["scope"])
    && isProducerIdentity(value["producer"])
    && isSha256(value["producerConfigurationDigest"])
    && isSha256(value["factSchemaDigest"])
    && isNonEmptyString(value["evidenceContract"])
    && isNonEmptyString(value["resolutionSemantics"])
    && isNonEmptyString(value["soundnessClaim"])
    && isNonEmptyString(value["completenessClaim"])
    && typeof value["negativeEvidenceEligible"] === "boolean"
    && isOptionalString(value["label"])
  );
}

function isDiscoveryLedgerEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value["candidateIdentity"])
    && isArtifactScope(value["scope"])
    && (value["selectionDecision"] === "selected" || value["selectionDecision"] === "excluded")
    && ANALYSIS_OUTCOMES.has(value["analysisOutcome"] as AnalysisOutcome)
    && isStringArray(value["selectionReasons"])
    && isStringArray(value["analysisReasons"])
    && (value["selectedProducer"] === undefined || isProducerIdentity(value["selectedProducer"]))
  );
}

function isProducerResult(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value["resultId"])
    && (value["status"] === "completed" || value["status"] === "failed")
    && isProducerIdentity(value["producer"])
    && isArtifactScope(value["scope"])
    && isNonEmptyString(value["factBatchId"])
  );
}

function isFactBatch(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    value["schemaVersion"] === 1
    && isNonEmptyString(value["batchId"])
    && isArtifactScope(value["scope"])
    && isProducerIdentity(value["producer"])
    && isSha256(value["producerConfigurationDigest"])
    && isSha256(value["factSchemaDigest"])
    && isSha256(value["sourceDigest"])
    && isStringArray(value["factKinds"])
    && isStringArray(value["capabilityProfileIds"])
    && isNonEmptyString(value["evidenceContract"])
    && Array.isArray(value["facts"])
    && value["facts"].every(isPlaneAFact)
  );
}

function sameProducer(
  left: { identity: string; version: string },
  right: { identity: string; version: string },
): boolean {
  return left.identity === right.identity && left.version === right.version;
}

function sameScope(
  left: PlaneASidecarV1["scope"],
  right: PlaneASidecarV1["scope"],
): boolean {
  return digestCanonical(left) === digestCanonical(right);
}

function hasExactAnalyzedCardinality(sidecar: PlaneASidecarV1): boolean {
  return sidecar.discoveryLedger.every((entry) => {
    if (entry.analysisOutcome !== "analyzed") return true;
    if (entry.selectedProducer === undefined) return false;
    const results = sidecar.producerResults.filter((result) =>
      sameScope(result.scope, entry.scope)
      && sameProducer(result.producer, entry.selectedProducer!));
    if (results.length !== 1 || results[0]!.status !== "completed") return false;
    const batches = sidecar.factBatches.filter((batch) =>
      sameScope(batch.scope, entry.scope)
      && sameProducer(batch.producer, entry.selectedProducer!));
    return batches.length === 1 && batches[0]!.batchId === results[0]!.factBatchId;
  });
}

function isPlaneASidecar(value: unknown): value is PlaneASidecarV1 {
  if (!isRecord(value)) return false;
  const structurallyValid = (
    value["schemaVersion"] === 1
    && isArtifactScope(value["scope"])
    && isSha256(value["producerConfigurationDigest"])
    && isSha256(value["factSchemaDigest"])
    && isSha256(value["sourceDigest"])
    && Array.isArray(value["capabilityProfiles"])
    && value["capabilityProfiles"].every(isCapabilityProfile)
    && Array.isArray(value["discoveryLedger"])
    && value["discoveryLedger"].every(isDiscoveryLedgerEntry)
    && Array.isArray(value["producerResults"])
    && value["producerResults"].every(isProducerResult)
    && Array.isArray(value["factBatches"])
    && value["factBatches"].every(isFactBatch)
  );
  return structurallyValid
    && hasExactAnalyzedCardinality(value as unknown as PlaneASidecarV1);
}

function isWorkspaceManifestEvidence(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const evidenceValue = value["value"];
  return (
    isNonEmptyString(value["manifestPath"])
    && isNonEmptyString(value["field"])
    && (
      isString(evidenceValue)
      || (Array.isArray(evidenceValue) && evidenceValue.every(isString))
    )
  );
}

function hasWorkspaceEvidence(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value["evidence"])
    && value["evidence"].every(isWorkspaceManifestEvidence)
  );
}

function isWorkspaceProjection(value: unknown): value is WorkspaceProjection {
  if (!isRecord(value)) return false;
  return (
    value["schemaVersion"] === 1
    && isNonEmptyString(value["repositoryId"])
    && Array.isArray(value["nodes"])
    && value["nodes"].every((node) =>
      isRecord(node)
      && isNonEmptyString(node["id"])
      && node["kind"] === "package"
      && isNonEmptyString(node["root"])
      && isNonEmptyString(node["identity"])
      && hasWorkspaceEvidence(node))
    && Array.isArray(value["edges"])
    && value["edges"].every((edge) =>
      isRecord(edge)
      && isNonEmptyString(edge["id"])
      && (edge["kind"] === "contained_in_workspace" || edge["kind"] === "workspace_member_of")
      && isNonEmptyString(edge["from"])
      && isNonEmptyString(edge["to"])
      && hasWorkspaceEvidence(edge))
    && Array.isArray(value["candidates"])
    && value["candidates"].every((candidate) =>
      isRecord(candidate)
      && isNonEmptyString(candidate["root"])
      && candidate["reason"] === "conventional-directory")
    && Array.isArray(value["diagnostics"])
    && value["diagnostics"].every((diagnostic) =>
      isRecord(diagnostic)
      && diagnostic["code"] === "AMBIGUOUS_LAYOUT"
      && isNonEmptyString(diagnostic["message"])
      && isStringArray(diagnostic["roots"])
      && hasWorkspaceEvidence(diagnostic))
  );
}

function isRepositoryGraph(value: unknown): value is RepositoryGraph {
  if (!isRecord(value) || !Array.isArray(value["nodes"]) || !Array.isArray(value["edges"])) {
    return false;
  }
  return (
    value["nodes"].every((node) =>
      isRecord(node)
      && isNonEmptyString(node["id"])
      && NODE_KINDS.has(node["kind"] as string)
      && isString(node["name"])
      && isOptionalString(node["filePath"])
      && isOptionalString(node["boundedContext"])
      && isOptionalBoolean(node["exported"])
      && Array.isArray(node["evidence"])
      && node["evidence"].every(isEvidenceRef)
      && isStringArray(node["tags"])
      && isMetadata(node["metadata"]))
    && value["edges"].every((edge) =>
      isRecord(edge)
      && isNonEmptyString(edge["id"])
      && EDGE_KINDS.has(edge["kind"] as string)
      && isNonEmptyString(edge["from"])
      && isNonEmptyString(edge["to"])
      && Array.isArray(edge["evidence"])
      && edge["evidence"].every(isEvidenceRef)
      && isMetadata(edge["metadata"]))
  );
}

function isEvidenceRecord(value: unknown): value is EvidenceRecord {
  return (
    isRecord(value)
    && isNonEmptyString(value["id"])
    && isEvidenceRef(value)
  );
}

function isClaim(value: unknown): value is Claim {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value["id"])
    && CLAIM_KINDS.has(value["kind"] as string)
    && isString(value["statement"])
    && isStringArray(value["subjectNodeIds"])
    && isStringArray(value["evidenceIds"])
    && typeof value["authority"] === "number"
    && value["authority"] >= 0
    && value["authority"] <= 1
    && typeof value["freshness"] === "number"
    && value["freshness"] >= 0
    && value["freshness"] <= 1
    && typeof value["confidence"] === "number"
    && value["confidence"] >= 0
    && value["confidence"] <= 1
    && VERIFICATION_STATUSES.has(value["verificationStatus"] as string)
    && isOptionalString(value["validFrom"])
    && isOptionalString(value["validUntil"])
    && isStringArray(value["tags"])
  );
}

export function parsePlaneAIndexSnapshot(
  raw: string | undefined,
): PersistedPlaneAIndexSnapshotV1 | undefined {
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value)
      || value["schemaVersion"] !== 1
      || typeof value["capturedAt"] !== "string"
      || !Number.isFinite(Date.parse(value["capturedAt"]))
      || !isSha256(value["repositoryGraphHash"])
      || !isSha256(value["sidecarDigest"])
      || !isSha256(value["workspaceDigest"])
      || (
        value["unresolvedReferenceIndexHash"] !== undefined
        && !isSha256(value["unresolvedReferenceIndexHash"])
      )
      || !isPlaneASidecar(value["sidecar"])
      || !isWorkspaceProjection(value["workspace"])
    ) {
      return undefined;
    }
    return value as unknown as PersistedPlaneAIndexSnapshotV1;
  } catch {
    return undefined;
  }
}

export function createPlaneAIndexSnapshot(args: {
  capturedAt: string;
  repositoryGraphHash: string;
  unresolvedReferenceIndexHash: string;
  sidecar: PlaneASidecarV1;
  workspace: WorkspaceProjection;
}): PersistedPlaneAIndexSnapshotV1 {
  return {
    schemaVersion: 1,
    capturedAt: args.capturedAt,
    repositoryGraphHash: args.repositoryGraphHash,
    sidecarDigest: digestCanonical(args.sidecar),
    workspaceDigest: digestCanonical(args.workspace),
    unresolvedReferenceIndexHash: args.unresolvedReferenceIndexHash,
    sidecar: args.sidecar,
    workspace: args.workspace,
  };
}

function candidatePath(entry: DiscoveryLedgerEntry): string {
  return entry.scope.selectedPaths.length === 1
    ? entry.scope.selectedPaths[0]!
    : entry.candidateIdentity;
}

function countOutcome(
  candidates: readonly IndexHealthCandidateV1[],
  outcome: AnalysisOutcome,
): number {
  return candidates.filter((candidate) => candidate.analysisOutcome === outcome).length;
}

function orderedReasons(codes: ReadonlySet<PlaneAReasonCode>): PlaneAReasonCode[] {
  return PLANE_A_REASON_CODES.filter((code) => codes.has(code));
}

function terminalReason(outcome: AnalysisOutcome): PlaneAReasonCode | undefined {
  if (outcome === "disabled") return "ANALYSIS_DISABLED";
  if (outcome === "unsupported") return "LANGUAGE_UNSUPPORTED";
  if (outcome === "failed") return "PRODUCER_FAILED";
  return undefined;
}

function pathWithinRoot(path: string, root: string): boolean {
  return root === "." || path === root || path.startsWith(`${root}/`);
}

function evaluateSnapshot(
  snapshot: PersistedPlaneAIndexSnapshotV1,
  bindingAttestation: "valid" | "invalid",
  freshness: ControlFreshnessStatusReport,
  configVersion: 1 | 2,
  producerConfigurationDigest: string,
): PlaneAEvaluationReport {
  const decisions: PlaneAEvaluationDecision[] = [];
  for (const entry of snapshot.sidecar.discoveryLedger) {
    if (entry.selectionDecision !== "selected") continue;
    const path = candidatePath(entry);
    const ambiguousRoots = [...new Set(
      snapshot.workspace.diagnostics
        .flatMap((diagnostic) => diagnostic.roots)
        .filter((root) => pathWithinRoot(path, root)),
    )].sort();
    const batches = entry.selectedProducer === undefined
      ? []
      : snapshot.sidecar.factBatches.filter((batch) =>
          sameScope(batch.scope, entry.scope)
          && sameProducer(batch.producer, entry.selectedProducer!));
    const factKinds = [...new Set(
      batches.flatMap((batch) => batch.factKinds),
    )].sort();
    if (factKinds.length === 0) factKinds.push("analysis");

    for (const factKind of factKinds) {
      const batch = batches.find((candidate) => candidate.factKinds.includes(factKind));
      const referencedProfiles = snapshot.sidecar.capabilityProfiles
        .filter((profile) =>
          profile.factKind === factKind
          && batch?.capabilityProfileIds.includes(profile.profileId));
      const referencedProfile =
        referencedProfiles.length === 1 ? referencedProfiles[0] : undefined;
      const requiredCapability = resolvePlaneACapabilityRequirement({
        configVersion,
        producerConfigurationDigest,
        task: "verify",
        operation: "change",
        language: entry.scope.language,
        factKind,
        completenessClaim: referencedProfile?.completenessClaim ?? "",
      });
      const policy = admissibleFor({
        task: "verify",
        operation: "change",
        factKind,
        scope: entry.scope,
      });
      const operationAdmitted = isPlaneAOperationAdmitted({
        configVersion,
        task: "verify",
        operation: "change",
        factKind,
        scope: entry.scope,
      });
      decisions.push(evaluatePlaneA({
        request: {
          task: "verify",
          operation: "change",
          factKind,
          requestedScopeDescriptor: path,
          candidateIdentity: entry.candidateIdentity,
          negativeConclusion: true,
        },
        scopeResolution: ambiguousRoots.length === 0
          ? { status: "exact", scope: entry.scope }
          : {
              status: "unresolved",
              failures: [{
                code: "AMBIGUOUS_LAYOUT",
                detail: {
                  coordinate: "workspaceRoots",
                  expected: "one unambiguous workspace ancestry",
                  actual: ambiguousRoots,
                },
              }],
            },
        ledgerEntry: entry,
        completedResults: snapshot.sidecar.producerResults,
        factBatches: snapshot.sidecar.factBatches,
        bindingAttestation,
        currentFreshness: freshness.verdict,
        capabilityProfiles: snapshot.sidecar.capabilityProfiles,
        requiredCapability,
        taskRelativeAuthority: {
          admissible: policy.admissible && operationAdmitted,
        },
      }));
    }
  }
  return aggregatePlaneAEvaluations(decisions);
}

function emptyWorkspace(): WorkspaceProjection {
  return {
    schemaVersion: 1,
    repositoryId: "repository",
    nodes: [],
    edges: [],
    candidates: [],
    diagnostics: [],
  };
}

function emptyEvaluations(): PlaneAEvaluationReport {
  return {
    schemaVersion: 1,
    decisions: [],
    reasonSummary: [],
  };
}

function unavailableReport(
  freshness: ControlFreshnessStatusReport,
): IndexHealthReportV1 {
  const reasons = new Set<PlaneAReasonCode>(["DISCOVERY_NOT_ESTABLISHED"]);
  if (freshness.verdict === "UNSEALED") reasons.add("CURRENT_STATE_UNSEALED");
  if (freshness.verdict === "STALE") reasons.add("CURRENT_STATE_STALE");
  return {
    schemaVersion: 1,
    kind: "index_health",
    capturedAt: null,
    binding: {
      status: "absent",
      sidecarDigest: null,
      workspaceDigest: null,
    },
    freshness: {
      verdict: freshness.verdict,
      canRunHighRiskControl: freshness.canRunHighRiskControl,
      reasons: freshness.reasons,
    },
    coverage: {
      status: "insufficient",
      candidates: 0,
      selected: 0,
      excluded: 0,
      analyzed: 0,
      disabled: 0,
      unsupported: 0,
      failed: 0,
    },
    candidates: [],
    capabilities: [],
    workspace: null,
    evaluations: emptyEvaluations(),
    reasonSummary: orderedReasons(reasons),
  };
}

function invalidBindingReport(
  freshness: ControlFreshnessStatusReport,
  snapshot?: PersistedPlaneAIndexSnapshotV1,
): IndexHealthReportV1 {
  const reasons = new Set<PlaneAReasonCode>(["BINDING_INVALID"]);
  if (freshness.verdict === "UNSEALED") reasons.add("CURRENT_STATE_UNSEALED");
  if (freshness.verdict === "STALE") reasons.add("CURRENT_STATE_STALE");
  return {
    schemaVersion: 1,
    kind: "index_health",
    capturedAt: snapshot?.capturedAt ?? null,
    binding: {
      status: "invalid",
      sidecarDigest: snapshot?.sidecarDigest ?? null,
      workspaceDigest: snapshot?.workspaceDigest ?? null,
    },
    freshness: {
      verdict: freshness.verdict,
      canRunHighRiskControl: freshness.canRunHighRiskControl,
      reasons: freshness.reasons,
    },
    coverage: {
      status: "insufficient",
      candidates: 0,
      selected: 0,
      excluded: 0,
      analyzed: 0,
      disabled: 0,
      unsupported: 0,
      failed: 0,
    },
    candidates: [],
    capabilities: [],
    workspace: null,
    evaluations: emptyEvaluations(),
    reasonSummary: orderedReasons(reasons),
  };
}

/** Read-only coverage report. Freshness remains a separate, explicitly nested dimension. */
export function indexHealth(root: string): IndexHealthReportV1 {
  const freshness = controlStatus(root);
  let reader;
  try {
    reader = openReadyRepository(root);
  } catch (error) {
    if (
      isSemctxError(error)
      && (error.code === "CONFIG_NOT_FOUND" || error.code === "REPO_NOT_INDEXED")
    ) {
      return unavailableReport(freshness);
    }
    throw error;
  }
  let snapshot: PersistedPlaneAIndexSnapshotV1 | undefined;
  try {
    const rawSnapshot = reader.getMeta(PLANE_A_INDEX_SNAPSHOT_META_KEY);
    if (rawSnapshot === undefined) return unavailableReport(freshness);
    snapshot = parsePlaneAIndexSnapshot(rawSnapshot);
    if (snapshot === undefined) return invalidBindingReport(freshness);

    const graph: unknown = reader.loadGraph();
    const evidence: unknown = reader.loadEvidence();
    const claims: unknown = reader.loadClaims();
    if (
      !isRepositoryGraph(graph)
      || !Array.isArray(evidence)
      || !evidence.every(isEvidenceRecord)
      || !Array.isArray(claims)
      || !claims.every(isClaim)
    ) {
      return invalidBindingReport(freshness, snapshot);
    }
    const actualGraphHash = fingerprintRepositoryFacts({ graph, evidence, claims });
    const config = loadConfig(root);
    const indexedControlSnapshot = parseIndexedControlSnapshot(
      reader.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY),
    );
    // No config-version escape: indexing authorizes the Plane-A snapshot at both versions, so a
    // snapshot the control snapshot does not name is a rewritten one whatever the config says.
    const controlPlaneABindingValid =
      indexedControlSnapshot?.schemaVersion === 2
      && indexedControlSnapshot.planeAIndexSnapshotHash === digestCanonical(snapshot);
    const validBinding =
      snapshot.sidecarDigest === digestCanonical(snapshot.sidecar)
      && snapshot.workspaceDigest === digestCanonical(snapshot.workspace)
      && snapshot.repositoryGraphHash === actualGraphHash
      && controlPlaneABindingValid
      // A binding cannot be reported valid while the record of what this index failed to resolve
      // has drifted from the index that produced it.
      && readUnresolvedReferenceBinding(reader).status === "bound";

    const sidecar = snapshot.sidecar;
    const candidates = [...sidecar.discoveryLedger]
      .sort((left, right) =>
        left.candidateIdentity < right.candidateIdentity
          ? -1
          : left.candidateIdentity > right.candidateIdentity
            ? 1
            : 0)
      .map((entry): IndexHealthCandidateV1 => {
        const profiles = entry.selectedProducer === undefined
          ? []
          : sidecar.capabilityProfiles.filter((profile) =>
              sameScope(profile.scope, entry.scope)
              && sameProducer(profile.producer, entry.selectedProducer!));
        return {
          candidateIdentity: entry.candidateIdentity,
          path: candidatePath(entry),
          language: entry.scope.language,
          workspaceUnitId: entry.scope.workspaceUnitId ?? null,
          selectionDecision: entry.selectionDecision,
          analysisOutcome: entry.analysisOutcome,
          selectionReasons: [...entry.selectionReasons],
          analysisReasons: [...entry.analysisReasons],
          producer: entry.selectedProducer ?? null,
          negativeEvidenceEligible:
            profiles.length > 0
            && profiles.every((profile) => profile.negativeEvidenceEligible),
        };
      });
    const evaluations = evaluateSnapshot(
      snapshot,
      validBinding ? "valid" : "invalid",
      freshness,
      config.version,
      digestCanonical(config),
    );

    const reasonCodes = new Set<PlaneAReasonCode>();
    if (!validBinding) reasonCodes.add("BINDING_INVALID");
    if (freshness.verdict === "UNSEALED") reasonCodes.add("CURRENT_STATE_UNSEALED");
    if (freshness.verdict === "STALE") reasonCodes.add("CURRENT_STATE_STALE");
    for (const candidate of candidates) {
      const reason = terminalReason(candidate.analysisOutcome);
      if (reason !== undefined) reasonCodes.add(reason);
      if (
        candidate.analysisOutcome === "analyzed"
        && !candidate.negativeEvidenceEligible
      ) {
        reasonCodes.add("NEGATIVE_COMPLETENESS_MISSING");
      }
    }
    if (snapshot.workspace.diagnostics.length > 0) reasonCodes.add("AMBIGUOUS_LAYOUT");
    for (const reason of evaluations.reasonSummary) reasonCodes.add(reason);

    const selected = candidates.filter((candidate) =>
      candidate.selectionDecision === "selected");
    const hasInsufficient =
      !validBinding
      || snapshot.workspace.diagnostics.length > 0
      || evaluations.decisions.some((decision) =>
        decision.decisionKind === "pre_subject"
        || decision.gates.discoveryAndScope === "failed"
        || decision.gates.bindingAndIntegrity === "failed"
        || decision.gates.currentFreshness === "failed"
        || decision.gates.capabilityMatch === "failed"
        || decision.gates.taskRelativeAuthority === "failed")
      || selected.some((candidate) =>
        candidate.analysisOutcome === "disabled"
        || candidate.analysisOutcome === "unsupported"
        || candidate.analysisOutcome === "failed");
    const hasPartial = selected.some((candidate) =>
      candidate.analysisOutcome === "analyzed"
      && (!candidate.negativeEvidenceEligible || candidate.analysisReasons.length > 0));

    return {
      schemaVersion: 1,
      kind: "index_health",
      capturedAt: snapshot.capturedAt,
      binding: {
        status: validBinding ? "valid" : "invalid",
        sidecarDigest: snapshot.sidecarDigest,
        workspaceDigest: snapshot.workspaceDigest,
      },
      freshness: {
        verdict: freshness.verdict,
        canRunHighRiskControl: freshness.canRunHighRiskControl,
        reasons: freshness.reasons,
      },
      coverage: {
        status: hasInsufficient ? "insufficient" : hasPartial ? "partial" : "complete",
        candidates: candidates.length,
        selected: selected.length,
        excluded: candidates.length - selected.length,
        analyzed: countOutcome(candidates, "analyzed"),
        disabled: countOutcome(candidates, "disabled"),
        unsupported: countOutcome(candidates, "unsupported"),
        failed: countOutcome(candidates, "failed"),
      },
      candidates,
      capabilities: [...snapshot.sidecar.capabilityProfiles]
        .sort((left, right) =>
          left.profileId < right.profileId ? -1 : left.profileId > right.profileId ? 1 : 0)
        .map((profile) => ({
          profileId: profile.profileId,
          factKind: profile.factKind,
          language: profile.scope.language,
          producer: profile.producer,
          completenessClaim: profile.completenessClaim,
          negativeEvidenceEligible: profile.negativeEvidenceEligible,
          label: profile.label ?? null,
        })),
      workspace: snapshot.workspace ?? emptyWorkspace(),
      evaluations,
      reasonSummary: orderedReasons(reasonCodes),
    };
  } catch (error) {
    if (
      isSemctxError(error)
      && error.code === "STORE_ERROR"
      && error.message === "invalid persisted control index snapshot"
    ) {
      return invalidBindingReport(freshness, snapshot);
    }
    throw error;
  } finally {
    reader.close();
  }
}
