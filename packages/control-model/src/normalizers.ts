import { compareCodeUnits } from "./ordering";
import { computeControlFreshnessSealV2Hash } from "./hashing";
import type {
  CompatibilityNormalizationNoteV1,
  ControlFreshnessSealV2,
  CoordinateGraphReportV1,
  CoordinateGraphReportV2,
  DeletionAuthorizationReportV1,
  DeletionAuthorizationReportV2,
  NormalizedV2,
  StepAuthorizationReportV1,
  StepAuthorizationReportV2,
  TransitionAuthorizationReportV1,
  TransitionAuthorizationReportV2,
  TraversalReportV1,
  TraversalReportV2,
} from "./refinement";
import type { ControlFreshnessSeal } from "./types";

export interface NormalizedControlFreshnessSealV1 extends NormalizedV2<ControlFreshnessSealV2> {
  compatibility: CompatibilityNormalizationNoteV1 & { legacySealHash: ControlFreshnessSeal["sealHash"] };
}

export function normalizeControlFreshnessSealV1(
  legacy: ControlFreshnessSeal,
): NormalizedControlFreshnessSealV1 {
  const { sealHash: legacySealHash, sealSchemaVersion: _version, ...preserved } = legacy;
  const payload: Omit<ControlFreshnessSealV2, "sealHash"> = {
    ...preserved,
    sealSchemaVersion: 2,
    attestationSetHash: null,
  };
  return {
    value: { ...payload, sealHash: computeControlFreshnessSealV2Hash(payload) },
    compatibility: {
      schemaVersion: 1,
      sourceSchemaVersion: 1,
      targetSchemaVersion: 2,
      legacySealHash,
      notes: [
        "legacy seal hash retained as metadata",
        "attestation binding remains absent",
      ],
    },
  };
}

export function normalizeCoordinateGraphReportV1(
  legacy: CoordinateGraphReportV1,
): NormalizedV2<CoordinateGraphReportV2> {
  const compatibility = compatibilityNote([
    "legacy node levels are not promoted to authored appliesAtLevel",
    "legacy untyped edges remain structural and non-certifying",
  ]);
  return {
    value: {
      schemaVersion: 2,
      nodes: legacy.nodes
        .map((node) => ({
          id: node.id,
          plane: node.plane,
          sourceId: node.sourceId,
          sourceKind: node.sourceKind,
          appliesAtLevel: null,
          category: null,
          label: node.label,
          epistemicStatus: node.epistemicStatus,
          references: [...node.references],
          ...(node.metadata ? { metadata: { ...node.metadata } } : {}),
        }))
        .sort((left, right) => compareCodeUnits(left.id, right.id)),
      structuralEdges: [...legacy.edges],
      refinementRelations: [],
      verifiedEvidenceDigests: [],
      mapping: legacy.mapping.map((mapping) => ({
        ...mapping,
        level: null,
        category: null,
        supported: false,
        reason: "legacy_level_mapping_not_authored",
      })),
      coverage: legacy.coverage.map((coverage) => ({
        level: coverage.level,
        categories: [],
        coordinateIds: [],
      })),
      unsupported: [...legacy.unsupported],
      unmapped: [...legacy.unmapped],
      staleLinks: [...(legacy.staleLinks ?? [])],
      danglingReferences: [...(legacy.danglingReferences ?? [])],
      compatibilityNormalization: [compatibility],
    },
    compatibility,
  };
}

export function normalizeTraversalReportV1(
  legacy: TraversalReportV1,
): NormalizedV2<TraversalReportV2> {
  const compatibility = compatibilityNote([
    "legacy generic paths remain non-certifying",
    "typed refinement evidence and governing relations remain absent",
  ]);
  const visitedCoordinateIds = [...new Set(legacy.paths.flatMap((path) => path.nodes))]
    .sort(compareCodeUnits);
  const terminalStatus = legacy.truncated ? "budget_exhausted" : "empty";
  return {
    value: {
      schemaVersion: 2,
      direction: legacy.direction,
      sourceId: legacy.sourceId,
      targetLevel: legacy.targetLevel,
      visitedCoordinateIds,
      paths: [],
      governingConstraints: [],
      proofs: [],
      advisoryRelations: [],
      terminalStatus,
      reasonCode: legacy.truncated ? "BUDGET_EXHAUSTED" : "REFINEMENT_DISCONNECTED",
      budget: {
        limit: legacy.maxExpansions,
        consumed: 0,
        remaining: legacy.maxExpansions,
        truncated: legacy.truncated,
      },
      compatibilityNormalization: [compatibility],
    },
    compatibility,
  };
}

export function normalizeTransitionAuthorizationReportV1(
  legacy: TransitionAuthorizationReportV1,
): NormalizedV2<TransitionAuthorizationReportV2> {
  return normalizeAuthorization(legacy);
}

export function normalizeStepAuthorizationReportV1(
  legacy: StepAuthorizationReportV1,
): NormalizedV2<StepAuthorizationReportV2> {
  return normalizeAuthorization(legacy);
}

export function normalizeDeletionAuthorizationReportV1(
  legacy: DeletionAuthorizationReportV1,
): NormalizedV2<DeletionAuthorizationReportV2> {
  return normalizeAuthorization(legacy);
}

function normalizeAuthorization<T extends { schemaVersion: 1 }>(
  legacy: T,
): NormalizedV2<Omit<T, "schemaVersion"> & {
  schemaVersion: 2;
  acceptedAttestations: readonly [];
  advisoryRejectedAttestations: readonly [];
}> {
  const { schemaVersion: _version, ...preserved } = legacy;
  const compatibility = compatibilityNote([
    "legacy authorization report has no sealed attestation binding",
    "accepted and advisory attestation collections remain empty",
  ]);
  return {
    value: {
      ...preserved,
      schemaVersion: 2,
      acceptedAttestations: [],
      advisoryRejectedAttestations: [],
    },
    compatibility,
  };
}

function compatibilityNote(notes: readonly string[]): CompatibilityNormalizationNoteV1 {
  return {
    schemaVersion: 1,
    sourceSchemaVersion: 1,
    targetSchemaVersion: 2,
    notes,
  };
}
