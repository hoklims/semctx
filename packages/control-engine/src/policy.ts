import {
  DELETION_PREREQUISITE_OBLIGATIONS,
  MIGRATION_STATES,
  PROOF_SUFFICIENCY_MATRIX,
  StepAuthorizationInputSchema,
  type AuthorizationDetail,
  type AuthorizationReason,
  type DeletionAuthorizationInput,
  type DeletionAuthorizationReport,
  type ProofAttestation,
  type ProofEvaluation,
  type ProofObligation,
  type ProofRequirementClause,
  type StepAuthorizationInput,
  type StepAuthorizationReport,
  type TransitionAuthorizationInput,
  type TransitionAuthorizationReport,
} from "@semantic-context/control-model";
import { compareIds } from "@semantic-context/core";

export function authorizeTransition(input: TransitionAuthorizationInput): TransitionAuthorizationReport {
  const reasons: AuthorizationReason[] = [];
  const fromIndex = MIGRATION_STATES.indexOf(input.fromState);
  const toIndex = MIGRATION_STATES.indexOf(input.toState);
  if (input.fromState === "DELETED") reasons.push("terminal_state");
  if (toIndex !== fromIndex + 1) reasons.push("transition_not_adjacent");
  if ((input.risk === "R2" || input.risk === "R3") && !input.rollback) reasons.push("rollback_missing");
  if ((input.risk === "R2" || input.risk === "R3") && input.rollback && input.rollback.testReference.trim() === "") reasons.push("rollback_untested");
  const obligations = expandObligations(input.proofObligations);
  if ((input.risk === "R2" || input.risk === "R3") && !obligations.includes("rollback_ready")) obligations.push("rollback_ready");
  const proofEvaluations = obligations.sort().map((obligation) => evaluateObligation(obligation, input));
  if (proofEvaluations.some((evaluation) => !evaluation.satisfied)) reasons.push("proof_missing");
  for (const evaluation of proofEvaluations) reasons.push(...evaluation.reasons);
  if (input.risk === "R3") {
    const approvalObligation = input.toState === "DELETED" ? "deletion_approved" : "cutover_approved";
    if (!hasValidHumanApproval(input.attestations.filter((proof) => proof.obligation === approvalObligation), input.subject, input.planningCommit, input.evaluatedAt)) reasons.push("human_approval_missing");
  }
  if (input.changesL4Invariant && !hasValidHumanApproval(input.attestations.filter((proof) => proof.obligation === "invariants_preserved"), input.subject, input.planningCommit, input.evaluatedAt)) reasons.push("invariant_approval_missing");
  const unique = uniqueReasons(reasons);
  return { schemaVersion: 1, decision: unique.length === 0 ? "ALLOW" : "DENY", fromState: input.fromState, toState: input.toState, risk: input.risk, reasons: unique, proofEvaluations, details: details(unique) };
}

export function authorizeStep(input: StepAuthorizationInput): StepAuthorizationReport {
  const parsed = StepAuthorizationInputSchema.safeParse(input);
  if (!parsed.success) {
    const reasons = uniqueReasons(["input_invalid", ...parsed.error.issues.map((issue): AuthorizationReason => {
      if (issue.path[0] === "plan") return "plan_invalid";
      if (issue.path[0] === "step") return "step_invalid";
      if (issue.path[0] === "executionState") return "execution_state_invalid";
      return "input_invalid";
    })]);
    return { schemaVersion: 1, decision: "DENY", stepId: safeStepId(input), reasons, missingDependencies: [], proofEvaluations: [], details: parsed.error.issues.map((issue) => ({ reason: issue.path[0] === "plan" ? "plan_invalid" : issue.path[0] === "step" ? "step_invalid" : issue.path[0] === "executionState" ? "execution_state_invalid" : "input_invalid", subjectId: issue.path.join("."), message: issue.message })) };
  }
  const { plan, step, executionState, attestations, evaluatedAt } = parsed.data as StepAuthorizationInput;
  const reasons: AuthorizationReason[] = [];
  const authorizationDetails: AuthorizationDetail[] = [];
  if (plan.status !== "READY") add(reasons, authorizationDetails, "plan_blocked", plan.id, "Only READY plans can authorize a step.");
  const plannedStep = plan.steps.find((candidate) => candidate.id === step.id);
  if (!plannedStep || stableJson(plannedStep) !== stableJson(step)) add(reasons, authorizationDetails, "step_invalid", step.id, "The requested step is not the exact step recorded in the plan.");
  if (executionState.planId !== plan.id) add(reasons, authorizationDetails, "execution_plan_mismatch", executionState.planId, "Execution state belongs to another plan.");
  if (executionState.planningCommit !== plan.planningCommit) add(reasons, authorizationDetails, "execution_commit_mismatch", executionState.planningCommit, "Execution state commit differs from the planning commit.");
  if (!isTimestampFresh(executionState.recordedAt, evaluatedAt, evaluatedAt)) add(reasons, authorizationDetails, "execution_state_stale", executionState.planId, "Execution state is dated after the authorization evaluation.");
  if (executionState.currentState !== step.fromState) add(reasons, authorizationDetails, "execution_state_invalid", executionState.currentState, "Execution state does not match the step's fromState.");

  const completed = new Map(executionState.completedSteps.map((completion) => [completion.stepId, completion]));
  for (const completion of executionState.completedSteps) {
    const completedPlanStep = plan.steps.find((candidate) => candidate.id === completion.stepId);
    const referencedAttestations = completion.attestationIds.map((id) => attestations.find((proof) => proof.id === id));
    const structurallyValid = completedPlanStep && completion.planId === plan.id && completion.commit === plan.planningCommit && isTimestampFresh(completion.observedAt, evaluatedAt, completion.expiresAt) && referencedAttestations.every((proof) => proof && proof.commit === plan.planningCommit && proof.subject === plan.changeId && isFresh(proof, evaluatedAt));
    const completedAuthorization = structurallyValid ? authorizeCompletedStep(completedPlanStep, plan.changeId, plan.planningCommit, evaluatedAt, referencedAttestations as ProofAttestation[]) : undefined;
    if (!structurallyValid || completedAuthorization?.decision !== "ALLOW") {
      add(reasons, authorizationDetails, "completion_invalid", completion.stepId, "Completed step evidence is absent, stale, or does not match this plan and commit.");
    }
  }
  const expectedCompletedIds = plan.steps.slice(0, executionState.completedSteps.length).map((candidate) => candidate.id);
  const actualCompletedIds = executionState.completedSteps.map((completion) => completion.stepId);
  if (stableJson(actualCompletedIds) !== stableJson(expectedCompletedIds)) add(reasons, authorizationDetails, "execution_state_invalid", executionState.planId, "Completed steps must be the canonical contiguous plan prefix.");
  const derivedState = executionState.completedSteps.length === 0 ? "OBSERVED" : plan.steps[executionState.completedSteps.length - 1]?.toState;
  if (derivedState !== executionState.currentState) add(reasons, authorizationDetails, "execution_state_invalid", executionState.currentState, "currentState does not match the attested completion prefix.");
  if (plan.steps[executionState.completedSteps.length]?.id !== step.id) add(reasons, authorizationDetails, "execution_state_invalid", step.id, "Only the next canonical plan step may be authorized.");
  const missingDependencies = step.dependsOn.filter((dependency) => !completed.has(dependency)).sort();
  if (missingDependencies.length > 0) add(reasons, authorizationDetails, "dependency_incomplete", step.id, `Incomplete dependencies: ${missingDependencies.join(", ")}`);

  const transition = authorizeTransition({ fromState: step.fromState, toState: step.toState, risk: step.risk, subject: plan.changeId, planningCommit: plan.planningCommit, evaluatedAt, proofObligations: step.proofObligations, attestations, rollback: step.rollback, changesL4Invariant: step.changesL4Invariant });
  reasons.push(...transition.reasons); authorizationDetails.push(...transition.details);
  let proofEvaluations = transition.proofEvaluations;
  if (step.kind === "deletion_check") {
    const deletion = authorizeDeletion({ subject: plan.changeId, planningCommit: plan.planningCommit, evaluatedAt, attestations });
    proofEvaluations = mergeEvaluations(proofEvaluations, deletion.proofEvaluations);
    if (deletion.decision === "DENY") add(reasons, authorizationDetails, "deletion_denied", step.id, "Deletion-specific authorization obligations were not satisfied.");
    reasons.push(...deletion.reasons); authorizationDetails.push(...deletion.details);
  }
  const unique = uniqueReasons(reasons);
  return { schemaVersion: 1, decision: unique.length === 0 ? "ALLOW" : "DENY", stepId: step.id, reasons: unique, missingDependencies, proofEvaluations, details: uniqueDetails(authorizationDetails) };
}

export function authorizeDeletion(input: DeletionAuthorizationInput): DeletionAuthorizationReport {
  const obligations: ProofObligation[] = [...DELETION_PREREQUISITE_OBLIGATIONS, "deletion_approved"];
  const proofEvaluations = obligations.map((obligation) => evaluateObligation(obligation, input));
  const reasons: AuthorizationReason[] = [];
  if (proofEvaluations.some((evaluation) => !evaluation.satisfied)) reasons.push("proof_missing");
  for (const evaluation of proofEvaluations) reasons.push(...evaluation.reasons);
  if (!hasValidHumanApproval(input.attestations.filter((proof) => proof.obligation === "deletion_approved"), input.subject, input.planningCommit, input.evaluatedAt)) reasons.push("human_approval_missing");
  const unique = uniqueReasons(reasons);
  return { schemaVersion: 1, decision: unique.length === 0 ? "ALLOW" : "DENY", subject: input.subject, reasons: unique, proofEvaluations, details: details(unique) };
}

interface EvaluationContext { subject: string; planningCommit: string; evaluatedAt: string; attestations: ProofAttestation[] }
function evaluateObligation(obligation: ProofObligation, context: EvaluationContext): ProofEvaluation {
  const candidates = context.attestations.filter((proof) => proof.obligation === obligation); const preliminaryReasons: AuthorizationReason[] = [];
  if (candidates.length === 0) preliminaryReasons.push("proof_missing");
  else {
    if (candidates.every((proof) => proof.subject !== context.subject)) preliminaryReasons.push("proof_subject_mismatch");
    if (candidates.filter((proof) => proof.subject === context.subject).every((proof) => proof.commit !== context.planningCommit)) preliminaryReasons.push("proof_commit_mismatch");
    const matching = candidates.filter((proof) => proof.subject === context.subject && proof.commit === context.planningCommit && proof.epistemicStatus !== "llm_inferred" && proof.epistemicStatus !== "hypothetical");
    if (matching.length > 0 && matching.every((proof) => !isFresh(proof, context.evaluatedAt))) preliminaryReasons.push("proof_stale");
  }
  const usable = candidates.filter((proof) => proof.subject === context.subject && proof.commit === context.planningCommit && isFresh(proof, context.evaluatedAt) && proof.epistemicStatus !== "llm_inferred" && proof.epistemicStatus !== "hypothetical" && proof.references.some((reference) => reference.nonLlm));
  const clauseMatches = PROOF_SUFFICIENCY_MATRIX[obligation].allOf.map((clause) => usable.filter((proof) => satisfiesClause(proof, clause)));
  const satisfied = clauseMatches.every((matches) => matches.length > 0);
  if (usable.length > 0 && !satisfied) preliminaryReasons.push("proof_epistemically_insufficient");
  return { obligation, satisfied, acceptedAttestationIds: [...new Set(clauseMatches.flat().map((proof) => proof.id))].sort(), reasons: satisfied ? [] : uniqueReasons(preliminaryReasons.length > 0 ? preliminaryReasons : ["proof_epistemically_insufficient"]) };
}
function satisfiesClause(proof: ProofAttestation, clause: ProofRequirementClause): boolean { return clause.statuses.includes(proof.epistemicStatus) && (!clause.referenceKinds || proof.references.some((reference) => clause.referenceKinds!.includes(reference.kind))) && (!clause.requireNonLlmReference || proof.references.some((reference) => reference.nonLlm)); }
function hasValidHumanApproval(attestations: ProofAttestation[], subject: string, commit: string, evaluatedAt: string): boolean { return attestations.some((proof) => proof.epistemicStatus === "human_declared" && proof.subject === subject && proof.commit === commit && isFresh(proof, evaluatedAt) && proof.references.some((reference) => reference.nonLlm && (reference.kind === "human_approval" || reference.kind === "architecture"))); }
function isFresh(proof: ProofAttestation | undefined, evaluatedAt: string): proof is ProofAttestation { return !!proof && isTimestampFresh(proof.observedAt, evaluatedAt, proof.expiresAt); }
function isTimestampFresh(observedAt: string, evaluatedAt: string, expiresAt: string): boolean { const observed = Date.parse(observedAt); const evaluated = Date.parse(evaluatedAt); const expires = Date.parse(expiresAt); return Number.isFinite(observed) && Number.isFinite(evaluated) && Number.isFinite(expires) && observed <= evaluated && evaluated <= expires; }
function expandObligations(obligations: ProofObligation[]): ProofObligation[] { const expanded = new Set<ProofObligation>(); const visit = (obligation: ProofObligation): void => { if (expanded.has(obligation)) return; expanded.add(obligation); for (const prerequisite of PROOF_SUFFICIENCY_MATRIX[obligation].prerequisiteObligations) visit(prerequisite); }; for (const obligation of obligations) visit(obligation); return [...expanded]; }
function uniqueReasons(reasons: AuthorizationReason[]): AuthorizationReason[] { return [...new Set(reasons)].sort(); }
function details(reasons: AuthorizationReason[]): AuthorizationDetail[] { return reasons.map((reason) => ({ reason, message: reason.replaceAll("_", " ") })); }
function add(reasons: AuthorizationReason[], result: AuthorizationDetail[], reason: AuthorizationReason, subjectId: string, message: string): void { reasons.push(reason); result.push({ reason, subjectId, message }); }
function uniqueDetails(values: AuthorizationDetail[]): AuthorizationDetail[] { return [...new Map(values.map((value) => [`${value.reason}\u0000${value.subjectId ?? ""}\u0000${value.message}`, value])).values()].sort((a, b) => compareIds(`${a.reason}:${a.subjectId ?? ""}`, `${b.reason}:${b.subjectId ?? ""}`)); }
function mergeEvaluations(left: ProofEvaluation[], right: ProofEvaluation[]): ProofEvaluation[] { return [...new Map([...left, ...right].map((item) => [item.obligation, item])).values()].sort((a, b) => compareIds(a.obligation, b.obligation)); }
function safeStepId(input: unknown): string { return typeof input === "object" && input !== null && typeof (input as { step?: { id?: unknown } }).step?.id === "string" ? (input as { step: { id: string } }).step.id : "unknown"; }
function stableJson(value: unknown): string { return JSON.stringify(value); }

function authorizeCompletedStep(step: StepAuthorizationInput["step"], subject: string, planningCommit: string, evaluatedAt: string, attestations: ProofAttestation[]): TransitionAuthorizationReport {
  const transition = authorizeTransition({ fromState: step.fromState, toState: step.toState, risk: step.risk, subject, planningCommit, evaluatedAt, proofObligations: step.proofObligations, attestations, rollback: step.rollback, changesL4Invariant: step.changesL4Invariant });
  if (step.kind !== "deletion_check") return transition;
  const deletion = authorizeDeletion({ subject, planningCommit, evaluatedAt, attestations });
  const reasons = uniqueReasons([...transition.reasons, ...deletion.reasons, ...(deletion.decision === "DENY" ? ["deletion_denied" as const] : [])]);
  return { ...transition, decision: reasons.length === 0 ? "ALLOW" : "DENY", reasons, proofEvaluations: mergeEvaluations(transition.proofEvaluations, deletion.proofEvaluations), details: uniqueDetails([...transition.details, ...deletion.details]) };
}
