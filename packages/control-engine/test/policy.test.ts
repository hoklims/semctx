import { describe, expect, test } from "bun:test";
import type { ArchitectureSnapshot, EpistemicStatus, ExecutionState, MigrationPlan, MigrationStep, ProofAttestation, ProofObligation, ProofReferenceKind } from "@semantic-context/control-model";
import { authorizeDeletion, authorizeStep, authorizeTransition, compileMigrationPlan } from "../src";

const evaluatedAt = "2026-07-19T12:00:00.000Z";
const readyPlan = makePlan();

describe("authorization policy", () => {
  test("allows only adjacent transitions and blocks terminal transitions", () => {
    expect(authorizeTransition(baseTransition({ fromState: "OBSERVED", toState: "TARGET_PROPOSED" })).reasons).toContain("transition_not_adjacent");
    expect(authorizeTransition(baseTransition({ fromState: "DELETED", toState: "DELETED" })).reasons).toContain("terminal_state");
  });

  test("fails closed on dependencies, stale proofs, and invalid canonical profiles", () => {
    const step = readyPlan.steps.find((candidate) => candidate.profile === "shadow_validate")!;
    const result = authorizeStep({ plan: readyPlan, step, executionState: state(step, []), attestations: [proof("shadow_equivalent", "test_observed", { observedAt: "2026-07-17T00:00:00.000Z", expiresAt: "2026-07-18T00:00:00.000Z" }), proof("shadow_equivalent", "llm_inferred")], evaluatedAt });
    expect(result.decision).toBe("DENY");
    expect(result.reasons).toEqual(expect.arrayContaining(["dependency_incomplete", "proof_stale"]));
    const capture = readyPlan.steps[0]!;
    expect(authorizeStep({ plan: readyPlan, step: { ...capture, risk: "R3" }, executionState: state(capture, []), attestations: [proof("baseline_captured", "statically_observed")], evaluatedAt }).reasons).toEqual(expect.arrayContaining(["input_invalid", "step_invalid"]));
  });

  test("allows a proof-complete low-risk step with matching attested execution state", () => {
    const step = readyPlan.steps[0]!;
    const result = authorizeStep({ plan: readyPlan, step, executionState: state(step, []), attestations: [proof("baseline_captured", "statically_observed")], evaluatedAt });
    expect(result).toMatchObject({ decision: "ALLOW", reasons: [] });
  });

  test("rejects stale or cross-plan completion attestations", () => {
    const step = readyPlan.steps[1]!;
    const completionProof = proof("baseline_captured", "statically_observed", { id: "completion" });
    const valid = completion(readyPlan.steps[0]!, [completionProof.id]);
    expect(authorizeStep({ plan: readyPlan, step, executionState: state(step, [{ ...valid, planId: "other" }]), attestations: [completionProof, proof("behavior_characterized", "test_observed")], evaluatedAt }).reasons).toContain("completion_invalid");
    expect(authorizeStep({ plan: readyPlan, step, executionState: state(step, [{ ...valid, observedAt: "2026-07-17T00:00:00.000Z", expiresAt: "2026-07-18T00:00:00.000Z" }]), attestations: [completionProof, proof("behavior_characterized", "test_observed")], evaluatedAt }).reasons).toContain("completion_invalid");
  });

  test("re-proves every completed step from only its referenced attestations", () => {
    const step = readyPlan.steps[2]!;
    const baseline = proof("baseline_captured", "statically_observed", { id: "proof:baseline" });
    const targetReviewed = proof("target_reviewed", "human_declared", { id: "proof:target", referenceKind: "architecture" });
    const baselineOnlyPrefix = [completion(readyPlan.steps[0]!, [baseline.id]), completion(readyPlan.steps[1]!, [baseline.id])];
    expect(authorizeStep({ plan: readyPlan, step, executionState: state(step, baselineOnlyPrefix), attestations: [baseline, targetReviewed], evaluatedAt }).reasons).toContain("completion_invalid");

    const behavior = proof("behavior_characterized", "test_observed", { id: "proof:behavior" });
    const provenPrefix = [completion(readyPlan.steps[0]!, [baseline.id]), completion(readyPlan.steps[1]!, [behavior.id])];
    expect(authorizeStep({ plan: readyPlan, step, executionState: state(step, provenPrefix), attestations: [baseline, behavior, targetReviewed], evaluatedAt })).toMatchObject({ decision: "ALLOW", reasons: [] });
  });

  test("R3 and invariant changes require explicit human approval", () => {
    const input = baseTransition({ fromState: "SHADOW_VALIDATED", toState: "CUTOVER", risk: "R3", changesL4Invariant: true, proofObligations: ["cutover_approved", "invariants_preserved", "rollback_ready"], rollback: { description: "restore", testReference: "test:rollback" }, attestations: [proof("cutover_approved", "test_observed"), proof("invariants_preserved", "test_observed"), proof("rollback_ready", "test_observed")] });
    expect(authorizeTransition(input).reasons).toEqual(expect.arrayContaining(["human_approval_missing", "invariant_approval_missing"]));
    input.attestations.push(proof("cutover_approved", "human_declared", { referenceKind: "human_approval" }));
    input.attestations.push(proof("invariants_preserved", "human_declared", { referenceKind: "human_approval" }));
    expect(authorizeTransition(input).decision).toBe("ALLOW");
  });

  test("deletion remains denied until every strong obligation is present", () => {
    expect(authorizeDeletion({ subject: "change.a", planningCommit: "abc", evaluatedAt, attestations: [proof("deletion_approved", "human_declared", { referenceKind: "human_approval" })] }).decision).toBe("DENY");
    expect(authorizeDeletion({ subject: "change.a", planningCommit: "abc", evaluatedAt, attestations: deletionProofs() }).decision).toBe("ALLOW");
  });

  test("deletion_check always aggregates deletion authorization", () => {
    const step = readyPlan.steps.at(-1)!; const completionProof = proof("baseline_captured", "statically_observed", { id: "completion" });
    const completed = readyPlan.steps.slice(0, -1).map((candidate) => completion(candidate, [completionProof.id]));
    const denied = authorizeStep({ plan: readyPlan, step, executionState: state(step, completed), attestations: [completionProof], evaluatedAt });
    expect(denied.reasons).toContain("deletion_denied");
  });
});

function makePlan(): MigrationPlan {
  const current: ArchitectureSnapshot = { id: "c", commit: "abc", capturedAt: evaluatedAt, elements: [], relations: [] };
  const target: ArchitectureSnapshot = { id: "t", commit: "def", capturedAt: evaluatedAt, elements: [], relations: [] };
  return compileMigrationPlan({ change: { id: "change.a", serves: [], preserves: [], requiredEvidence: [], openUnknowns: [] }, current, target }).plan;
}
function state(step: MigrationStep, completedSteps: ExecutionState["completedSteps"]): ExecutionState { return { schemaVersion: 1, planId: readyPlan.id, planningCommit: readyPlan.planningCommit, currentState: step.fromState, recordedAt: evaluatedAt, completedSteps }; }
function completion(step: MigrationStep, attestationIds: string[]): ExecutionState["completedSteps"][number] { return { stepId: step.id, planId: readyPlan.id, commit: readyPlan.planningCommit, observedAt: "2026-07-19T10:00:00.000Z", expiresAt: "2026-07-20T10:00:00.000Z", attestationIds }; }
function baseTransition(overrides: Partial<Parameters<typeof authorizeTransition>[0]>): Parameters<typeof authorizeTransition>[0] { return { fromState: "OBSERVED", toState: "MODELED", risk: "R0", subject: "change.a", planningCommit: "abc", evaluatedAt, proofObligations: [], attestations: [], changesL4Invariant: false, ...overrides }; }
function proof(obligation: ProofObligation, epistemicStatus: EpistemicStatus, options: { id?: string; observedAt?: string; expiresAt?: string; referenceKind?: ProofReferenceKind } = {}): ProofAttestation { return { id: options.id ?? `${obligation}:${epistemicStatus}:${options.referenceKind ?? "other"}`, obligation, subject: "change.a", epistemicStatus, references: [{ kind: options.referenceKind ?? "test", uri: "proof://evidence", nonLlm: epistemicStatus !== "llm_inferred" }], commit: "abc", observedAt: options.observedAt ?? "2026-07-19T10:00:00.000Z", expiresAt: options.expiresAt ?? "2026-07-20T10:00:00.000Z" }; }
function deletionProofs(): ProofAttestation[] { return [proof("replacement_present", "statically_observed"), proof("shadow_equivalent", "test_observed"), proof("shadow_equivalent", "dynamically_observed"), proof("cutover_approved", "human_declared", { referenceKind: "human_approval" }), proof("cutover_approved", "test_observed"), proof("observation_window_passed", "dynamically_observed"), proof("static_dependencies_zero", "statically_observed"), proof("runtime_dependencies_zero", "dynamically_observed"), proof("invariants_preserved", "test_observed"), proof("data_migration_complete", "test_observed"), proof("rollback_ready", "test_observed"), proof("deletion_approved", "human_declared", { referenceKind: "human_approval" })]; }
