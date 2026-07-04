import type { AuthorityPolicy, QuestionKind, TaskFrame } from "@semantic-context/core";

/**
 * Per-question authority policies (ADR 0003). Declarative: which claim kinds are
 * preferred, and which verification statuses are required/forbidden. Adding a question
 * kind is adding a row here, not rewriting the ranker.
 *
 * `requiredVerificationStatuses`, when present, is a GATE: a claim whose status is not in
 * the set is ineligible for authority on this question (e.g. security needs proof).
 * `disallowedStatuses` is a gate that eliminates stale/contradicted sources.
 */
export const AUTHORITY_POLICIES: Record<QuestionKind, AuthorityPolicy> = {
  public_api: {
    questionKind: "public_api",
    preferredClaimKinds: ["contract", "capability", "behavior"],
    requiredVerificationStatuses: ["statically_verified", "tested", "runtime_verified"],
    disallowedStatuses: ["deprecated", "contradicted"],
  },
  persistence: {
    questionKind: "persistence",
    preferredClaimKinds: ["invariant", "contract", "decision"],
    disallowedStatuses: ["deprecated", "contradicted"],
  },
  business_rule: {
    questionKind: "business_rule",
    preferredClaimKinds: ["invariant", "capability", "behavior", "decision"],
    disallowedStatuses: ["deprecated", "contradicted"],
  },
  runtime_behavior: {
    questionKind: "runtime_behavior",
    preferredClaimKinds: ["behavior", "invariant", "capability"],
    requiredVerificationStatuses: ["tested", "runtime_verified", "statically_verified"],
    disallowedStatuses: ["deprecated", "contradicted"],
  },
  historical_reason: {
    questionKind: "historical_reason",
    preferredClaimKinds: ["decision", "capability"],
    disallowedStatuses: ["contradicted"],
  },
  style: {
    questionKind: "style",
    preferredClaimKinds: ["capability", "behavior", "contract"],
    disallowedStatuses: ["deprecated", "contradicted"],
  },
  security: {
    questionKind: "security",
    preferredClaimKinds: ["invariant", "contract", "behavior", "risk"],
    requiredVerificationStatuses: ["statically_verified", "tested", "runtime_verified"],
    disallowedStatuses: ["deprecated", "contradicted", "unverified", "inferred"],
  },
};

const PERSISTENCE_HINTS = ["persist", "database", "migration", "schema", "sql", "table", "storage", "column"];
const API_HINTS = ["public api", "exported", "interface", "signature", "endpoint", "contract"];
const HISTORY_HINTS = ["why", "history", "historical", "decision", "rationale", "reason", "adr"];
const STYLE_HINTS = ["style", "convention", "formatting", "naming", "lint"];

function mentions(haystack: string, needles: readonly string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

/** Deterministic question classification from the task frame. Mode wins, then keywords. */
export function classifyQuestion(task: TaskFrame): QuestionKind {
  const text = `${task.rawTask} ${task.capabilities.join(" ")} ${task.riskSurfaces.join(" ")}`.toLowerCase();

  if (task.mode === "security") return "security";
  if (task.mode === "performance") return "runtime_behavior";
  if (task.mode === "migration") return "persistence";

  if (mentions(text, PERSISTENCE_HINTS)) return "persistence";
  if (mentions(text, API_HINTS)) return "public_api";
  if (task.mode === "audit" && mentions(text, HISTORY_HINTS)) return "historical_reason";
  if (mentions(text, HISTORY_HINTS)) return "historical_reason";
  if (mentions(text, STYLE_HINTS)) return "style";

  // Default: most tasks are about domain behaviour and its invariants.
  return "business_rule";
}

export function policyFor(question: QuestionKind): AuthorityPolicy {
  return AUTHORITY_POLICIES[question];
}
