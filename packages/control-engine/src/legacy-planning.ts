/**
 * Compatibility adapter for the pre-P2 migration profile vocabulary.
 *
 * This module is intentionally outside the narrow planning and reconciliation
 * entrypoints. It describes legacy data only and grants no execution authority.
 */
import {
  MIGRATION_STEP_PROFILES,
  type TaskEnvelopeV1,
} from "@semantic-context/control-model";

export interface MigrationRefinementAdapterStepV1 {
  schemaVersion: 1;
  executionAuthority: "none";
  order: number;
  legacyProfile: typeof MIGRATION_STEP_PROFILES[number]["profile"];
  kind: typeof MIGRATION_STEP_PROFILES[number]["kind"];
  dependsOnProfile: typeof MIGRATION_STEP_PROFILES[number]["profile"] | null;
  bindingIds: readonly string[];
  rollbackRequired: boolean;
  proofObligationIds: readonly string[];
}

export function describeMigrationRefinementAdapter(
  envelope: TaskEnvelopeV1,
): readonly MigrationRefinementAdapterStepV1[] {
  const bindingIds = sortedUnique(
    envelope.resolvedBindings.map((binding) => binding.bindingId),
  );
  return MIGRATION_STEP_PROFILES.map((profile, index) => ({
    schemaVersion: 1,
    executionAuthority: "none",
    order: index,
    legacyProfile: profile.profile,
    kind: profile.kind,
    dependsOnProfile:
      index === 0 ? null : MIGRATION_STEP_PROFILES[index - 1]!.profile,
    bindingIds,
    rollbackRequired: profile.risk === "R2" || profile.risk === "R3",
    proofObligationIds: sortedUnique(profile.minimumProofObligations),
  }));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
}
