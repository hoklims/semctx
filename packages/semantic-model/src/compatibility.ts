import type {
  NormalizedLegacySemanticModelV1,
  SemanticCompatibilityNoteV1,
  SemanticModel,
} from "./types";

/**
 * Read-only compatibility normalization for the original authored model shape.
 *
 * Bare `{kind,to}` relations are retained for legacy consumers but never promoted into the
 * proof-carrying refinement overlay. Missing levels remain absent.
 */
export function normalizeLegacySemanticModelV1(model: SemanticModel): NormalizedLegacySemanticModelV1 {
  const compatibility: SemanticCompatibilityNoteV1[] = [
    ...model.nodes.map((node) => ({
      subjectId: node.id,
      appliesAtLevel: node.appliesAtLevel,
      hasLegacyRelations: node.relations.length > 0,
    })),
    ...model.changes.map((change) => ({
      subjectId: change.id,
      appliesAtLevel: change.appliesAtLevel,
      hasLegacyRelations:
        change.serves.length + change.preserves.length + change.requiresEvidence.length + change.openUnknowns.length > 0,
    })),
  ]
    .filter((item) => item.appliesAtLevel === undefined || item.hasLegacyRelations)
    .map((item) => ({
      schemaVersion: 1,
      source: "legacy_semantic_dsl_v1",
      subjectId: item.subjectId,
      uncertainties: [
        ...(item.appliesAtLevel === undefined ? ["appliesAtLevel" as const] : []),
        ...(item.hasLegacyRelations ? ["refinementEvidence" as const] : []),
      ],
    }));

  return {
    model: {
      nodes: model.nodes.map((node) => ({ ...node })),
      changes: model.changes.map((change) => ({
        ...change,
        ...(change.targetBinding === undefined ? {} : { targetBinding: { ...change.targetBinding } }),
      })),
      refinementRelations: [...(model.refinementRelations ?? [])],
    },
    compatibility,
  };
}
