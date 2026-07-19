import {
  MIGRATION_STEP_PROFILES,
  type ArchitectureDelta,
  type ChangePlanningContext,
  type MigrationPlan,
  type MigrationPlanBlockedDetail,
  type MigrationPlanBlockedReason,
  type MigrationPlanReport,
  type MigrationPlanningInput,
  type MigrationStep,
  type ProofObligation,
  type QualifiedCoordinateId,
} from "@semantic-context/control-model";
import { architectureDeltasEqual, compareArchitectures } from "./architecture";

export function compileMigrationPlan(input: MigrationPlanningInput): MigrationPlanReport {
  const contextBlockers = planningContextBlockers(input.change);
  if (contextBlockers.length > 0) return report(blockedPlan(input, contextBlockers));
  if (!input.target) return report(blockedPlan(input, [detail("target_architecture_missing", [], "A target architecture snapshot is required.")]));
  const computedDelta = compareArchitectures(input.current, input.target).delta;
  if (input.delta && !architectureDeltasEqual(input.delta, computedDelta)) {
    return report(blockedPlan({ ...input, delta: computedDelta }, [detail("architecture_delta_inconsistent", [input.delta.currentSnapshotId, input.delta.targetSnapshotId], "The supplied delta does not match the current and target snapshots.")]));
  }
  const delta = input.delta ?? computedDelta;
  const affected = affectedIds(delta, input.change);
  const changesL4Invariant = delta.changedInvariantIds.length > 0 || input.change.preserves.length > 0;
  const steps = buildSteps(input.change.id, affected, changesL4Invariant);
  if (hasCycle(steps)) return report(blockedPlan({ ...input, delta }, [detail("migration_cycle_detected", steps.map((step) => step.id), "The generated migration dependency graph is cyclic.")]));
  return report({
    id: planId(input.change.id, input.current.id, input.target.id),
    changeId: input.change.id,
    planningCommit: input.current.commit,
    status: "READY",
    blockedDetails: [],
    planningContext: input.change,
    current: input.current,
    target: input.target,
    delta,
    steps,
    outstandingObligations: uniqueObligations(steps.flatMap((step) => step.proofObligations)),
  });
}

function buildSteps(changeId: string, affected: QualifiedCoordinateId[], changesL4Invariant: boolean): MigrationStep[] {
  const prefix = `migration:${changeId}`;
  return MIGRATION_STEP_PROFILES.map((profile, index) => {
    const obligations = [...profile.minimumProofObligations];
    const needsRollback = profile.risk === "R2" || profile.risk === "R3";
    const step: MigrationStep = {
      id: `${prefix}:${String(index + 1).padStart(2, "0")}:${profile.kind}`,
      profile: profile.profile,
      kind: profile.kind,
      title: title(profile.profile),
      fromState: profile.fromState,
      toState: profile.toState,
      risk: profile.risk,
      dependsOn: index === 0 ? [] : [`${prefix}:${String(index).padStart(2, "0")}:${MIGRATION_STEP_PROFILES[index - 1]!.kind}`],
      affectedCoordinateIds: affected,
      proofObligations: obligations,
      ...(needsRollback ? { rollback: rollback(profile.profile) } : {}),
      changesL4Invariant,
    };
    return step;
  });
}

function planningContextBlockers(change: ChangePlanningContext): MigrationPlanBlockedDetail[] {
  const blockers: MigrationPlanBlockedDetail[] = [];
  if (change.openUnknowns.length > 0) blockers.push(detail("open_unknowns", [...change.openUnknowns].sort(), "Open unknowns must be resolved before migration planning."));
  const unsatisfied = change.requiredEvidence.filter((requirement) => !requirement.satisfied).map((requirement) => requirement.id).sort();
  if (unsatisfied.length > 0) blockers.push(detail("required_evidence_unsatisfied", unsatisfied, "All required Plane B evidence must be satisfied or explicitly waived."));
  return blockers;
}

function blockedPlan(input: MigrationPlanningInput, blockedDetails: MigrationPlanBlockedDetail[]): MigrationPlan {
  const blockedReason = blockedDetails[0]!.reason;
  return {
    id: planId(input.change.id, input.current.id, input.target?.id ?? "missing"),
    changeId: input.change.id,
    planningCommit: input.current.commit,
    status: "BLOCKED",
    blockedReason,
    blockedDetails,
    planningContext: input.change,
    current: input.current,
    ...(input.target ? { target: input.target } : {}),
    ...(input.delta ? { delta: input.delta } : {}),
    steps: [],
    outstandingObligations: blockedReason === "target_architecture_missing" ? ["target_reviewed"] : [],
  };
}
function detail(reason: MigrationPlanBlockedReason, subjectIds: string[], message: string): MigrationPlanBlockedDetail { return { schemaVersion: 1, reason, subjectIds, message }; }
function report(plan: MigrationPlan): MigrationPlanReport { return { schemaVersion: 1, plan }; }
function planId(changeId: string, current: string, target: string): string { return `migration:${changeId}:${current}->${target}`; }
function rollback(stage: string): { description: string; testReference: string } { return { description: `Restore the pre-${stage} routing and data path`, testReference: `proof:rollback:${stage}` }; }
function coordinateId(value: string): QualifiedCoordinateId { return value.startsWith("repo:") || value.startsWith("semantic:") ? value as QualifiedCoordinateId : `semantic:${value}`; }
function affectedIds(delta: ArchitectureDelta, change: ChangePlanningContext): QualifiedCoordinateId[] {
  return [...new Set([
    ...delta.added.map((item) => item.id), ...delta.removed.map((item) => item.id), ...delta.changed.map((item) => item.id), ...delta.changedInvariantIds,
    ...change.serves.map(coordinateId), ...change.preserves.map(coordinateId),
  ])].sort();
}
function uniqueObligations(values: ProofObligation[]): ProofObligation[] { return [...new Set(values)].sort(); }
function hasCycle(steps: MigrationStep[]): boolean {
  const deps = new Map(steps.map((step) => [step.id, step.dependsOn])); const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): boolean => { if (visiting.has(id)) return true; if (visited.has(id)) return false; visiting.add(id); for (const dep of deps.get(id) ?? []) if (deps.has(dep) && visit(dep)) return true; visiting.delete(id); visited.add(id); return false; };
  return steps.some((step) => visit(step.id));
}
function title(profile: MigrationStep["profile"]): string {
  return ({ capture_baseline: "Capture current baseline", characterize_behavior: "Characterize current behavior", define_target_proofs: "Define and review target proofs", introduce_parallel: "Introduce replacement in parallel", shadow_validate: "Compare replacement in shadow mode", cutover_replacement: "Cut over to replacement", observe_cutover: "Observe the cutover window", authorize_deletion: "Authorize legacy deletion" })[profile];
}
