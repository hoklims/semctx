import type {
  Claim,
  TaskFrame,
  AuthorityPolicy,
  PriorityExplanation,
  PriorityGate,
  NodeKind,
} from "@semantic-context/core";
import { GraphIndex } from "./graph-index";
import {
  WEIGHTS,
  roleMatchScore,
  reachabilityScore,
  VERIFICATION_STRENGTH,
  clamp01,
} from "./scoring";

const CODE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "module",
]);

export interface PriorityContext {
  index: GraphIndex;
  taskFrame: TaskFrame;
  policy: AuthorityPolicy;
  entrypoints: Set<string>;
  /** node id -> hop distance from an entrypoint (BFS over structural edges). */
  reachable: Map<string, number>;
  /** claim ids explicitly involved in an unresolved contradiction. */
  contradictedClaimIds: Set<string>;
}

function minReachableHop(ctx: PriorityContext, subjectIds: readonly string[]): number | undefined {
  let best: number | undefined;
  for (const id of subjectIds) {
    const hop = ctx.reachable.get(id);
    if (hop !== undefined && (best === undefined || hop < best)) best = hop;
  }
  return best;
}

function isCodeAnchored(ctx: PriorityContext, claim: Claim): boolean {
  return claim.subjectNodeIds.some((id) => {
    const node = ctx.index.node(id);
    return node !== undefined && CODE_KINDS.has(node.kind);
  });
}

function subjectBoundedContexts(ctx: PriorityContext, claim: Claim): string[] {
  const bcs: string[] = [];
  for (const id of claim.subjectNodeIds) {
    const node = ctx.index.node(id);
    if (node?.boundedContext !== undefined) bcs.push(node.boundedContext);
  }
  return bcs;
}

/**
 * Evaluate one claim for a task: run gates first (any failure => ineligible), then, if it
 * survived, compute a transparent weighted score. Every step is recorded in the returned
 * explanation so no selection is a black box (ADR 0003).
 */
export function evaluateClaim(claim: Claim, ctx: PriorityContext): PriorityExplanation {
  const gates: PriorityGate[] = [];
  const explanation: string[] = [];

  // Gate 1: status must be allowed by the policy (kills deprecated/contradicted, etc.).
  const disallowed = ctx.policy.disallowedStatuses ?? [];
  const statusAllowed = !disallowed.includes(claim.verificationStatus);
  gates.push({
    name: "status-allowed",
    passed: statusAllowed,
    reason: statusAllowed
      ? `status "${claim.verificationStatus}" is permitted for a ${ctx.policy.questionKind} question`
      : `status "${claim.verificationStatus}" is disallowed for a ${ctx.policy.questionKind} question`,
  });

  // Gate 2: contradiction must be resolved.
  const contradicted = ctx.contradictedClaimIds.has(claim.id) || claim.verificationStatus === "contradicted";
  gates.push({
    name: "contradiction-resolved",
    passed: !contradicted,
    reason: contradicted
      ? "claim is part of an unresolved contradiction and cannot be authoritative"
      : "no unresolved contradiction on this claim",
  });

  // Gate 3: bounded context.
  const taskBcs = ctx.taskFrame.boundedContexts;
  const subjectBcs = subjectBoundedContexts(ctx, claim);
  let inContext = true;
  if (taskBcs.length > 0 && subjectBcs.length > 0) {
    inContext = subjectBcs.some((bc) => taskBcs.includes(bc));
  }
  gates.push({
    name: "within-bounded-context",
    passed: inContext,
    reason: inContext
      ? "claim is within the selected bounded context"
      : `claim lives in [${subjectBcs.join(", ")}], outside the selected [${taskBcs.join(", ")}]`,
  });

  // Gate 4: verification sufficiency (question-specific required statuses).
  const required = ctx.policy.requiredVerificationStatuses;
  const verificationSufficient = required === undefined || required.includes(claim.verificationStatus);
  gates.push({
    name: "verification-sufficient",
    passed: verificationSufficient,
    reason: verificationSufficient
      ? "verification level meets the bar for this question"
      : `a ${ctx.policy.questionKind} question requires one of [${(required ?? []).join(", ")}], got "${claim.verificationStatus}"`,
  });

  // Gate 5: reachability from a task entrypoint (code-anchored claims only).
  const codeAnchored = isCodeAnchored(ctx, claim);
  const hop = minReachableHop(ctx, claim.subjectNodeIds);
  const reachableOk = !codeAnchored || ctx.entrypoints.size === 0 || hop !== undefined;
  gates.push({
    name: "reachable-from-entrypoint",
    passed: reachableOk,
    reason: reachableOk
      ? codeAnchored
        ? `reachable from a task entrypoint (${hop ?? 0} hop(s))`
        : "not code-anchored; reachability gate not applicable"
      : "code claim is not reachable from any task-relevant entrypoint",
  });

  const eligible = gates.every((g) => g.passed);

  // Component scores.
  const preferredIndex = ctx.policy.preferredClaimKinds.indexOf(claim.kind);
  const roleMatch = roleMatchScore(preferredIndex, ctx.policy.preferredClaimKinds.length);
  const authority = claim.authority;
  const graphReachability = hop !== undefined ? reachabilityScore(hop) : codeAnchored ? 0 : 0.3;
  const verificationStrength = VERIFICATION_STRENGTH[claim.verificationStatus];
  const freshness = claim.freshness;
  const contradictionPenalty = contradicted ? 0.5 : 0;

  const rawScore =
    WEIGHTS.roleMatch * roleMatch +
    WEIGHTS.authority * authority +
    WEIGHTS.graphReachability * graphReachability +
    WEIGHTS.verificationStrength * verificationStrength +
    WEIGHTS.freshness * freshness -
    contradictionPenalty;
  const score = eligible ? clamp01(rawScore) : 0;

  if (!eligible) {
    const failed = gates.filter((g) => !g.passed).map((g) => g.name);
    explanation.push(`Eliminated by gate(s): ${failed.join(", ")}.`);
  } else {
    explanation.push(
      `Selected for a ${ctx.policy.questionKind} question (score ${score.toFixed(3)}).`,
      `role match ${roleMatch.toFixed(2)} (kind "${claim.kind}"), authority ${authority.toFixed(2)}, verification ${verificationStrength.toFixed(2)}, reachability ${graphReachability.toFixed(2)}, freshness ${freshness.toFixed(2)}.`,
    );
  }

  return {
    targetId: claim.id,
    targetKind: "claim",
    score,
    eligible,
    roleMatch,
    authority,
    graphReachability,
    verificationStrength,
    freshness,
    contradictionPenalty,
    gates,
    explanation,
  };
}
