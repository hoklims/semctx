import { isSemctxError } from "@semantic-context/core";
import {
  CONTROL_STATUS_BUDGET_EXCEEDED,
  type ControlFreshnessReason,
  type ControlFreshnessStatusReport,
  type ControlStatusExplanation,
  type ControlStatusTimeoutReport,
} from "@semantic-context/control-model";

/** The one documented way to refresh and seal the index at a checkpoint (docs/reference/cli.md, `status`). */
export const SEAL_COMMAND = "semctx index --record";

const LIFECYCLE_REMEDY: Record<string, string> = {
  EVIDENCE_BASELINE_STALE: SEAL_COMMAND,
  EVIDENCE_BASELINE_INVALID: SEAL_COMMAND,
  EVIDENCE_BASELINE_SUPERSEDED: "semctx verify diff --record",
  ACTIVE_CHANGE_POINTER_INVALID: "semctx semantic check",
  ACTIVE_CHANGE_POINTER_MISSING: "semctx semantic check",
  ACTIVE_CHANGE_POINTER_MISMATCH: "semctx semantic check",
  ACTIVE_CHANGE_OBSOLETE: "semctx semantic check",
};

interface LifecycleFindingLike {
  code: string;
  message: string;
  subjectIds?: readonly string[];
}

interface DiagnosticLike {
  code?: string;
  file: string;
  line: number;
  message: string;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    : [];
}

function lifecycleFindings(details: Record<string, unknown>): LifecycleFindingLike[] {
  return records(details["lifecycleFindings"]).flatMap((entry) =>
    typeof entry["code"] === "string" && typeof entry["message"] === "string"
      ? [{
          code: entry["code"],
          message: entry["message"],
          subjectIds: Array.isArray(entry["subjectIds"]) ? entry["subjectIds"].filter((id): id is string => typeof id === "string") : [],
        }]
      : []);
}

function diagnostics(details: Record<string, unknown>): DiagnosticLike[] {
  return records(details["diagnostics"]).flatMap((entry) =>
    typeof entry["file"] === "string" && typeof entry["line"] === "number" && typeof entry["message"] === "string"
      ? [{
          ...(typeof entry["code"] === "string" ? { code: entry["code"] } : {}),
          file: entry["file"],
          line: entry["line"],
          message: entry["message"],
        }]
      : []);
}

function short(value: string | null | undefined): string {
  if (value === null || value === undefined) return "none";
  return /^[0-9a-f]{40}$/.test(value) ? value.slice(0, 12) : value;
}

/** Why the seal disagrees with the current state, from the two values the seal itself carries. */
function sealDetail(reason: ControlFreshnessReason, status: ControlFreshnessStatusReport): string {
  const seal = status.freshnessSeal;
  switch (reason) {
    case "REPOSITORY_ROOT_MISMATCH":
      return `the index was sealed for ${seal?.indexedRepositoryRoot ?? "another root"}, this repository is ${seal?.repositoryRoot ?? "unknown"}`;
    case "HEAD_MISMATCH":
      return `the index was sealed at ${short(seal?.indexedHeadCommit)}, HEAD is now ${short(seal?.headAtCapture)}`;
    case "REPOSITORY_GRAPH_MISMATCH":
      return "the stored repository graph no longer hashes to the sealed graph";
    case "SEMANTIC_MODEL_MISMATCH":
      return ".semctx/semantic changed since the index was sealed";
    case "ANALYSIS_INPUT_MISMATCH":
      return "the analyzed files or the analysis configuration changed since the index was sealed";
    case "WORKING_DIFF_MISMATCH":
      return "the uncommitted changes differ from those present when the index was sealed";
    case "STORE_SCHEMA_MISMATCH":
      return `the store schema is ${seal?.storeSchemaVersion ?? "unknown"}, the index was sealed under ${seal?.indexedStoreSchemaVersion ?? "unknown"}`;
    case "TOOL_VERSION_MISMATCH":
      return `the index was sealed by ${seal?.indexedToolVersion ?? "an unknown version"}, this is ${seal?.toolVersion ?? "an unknown version"}`;
    case "WORKING_TREE_DIRTY":
      return "the seal covers uncommitted changes; it is valid for this exact working tree only";
    case "INDEX_SNAPSHOT_MISSING":
      return "the index carries no control snapshot (it predates sealing or was built without one)";
    case "GIT_STATE_UNAVAILABLE":
      return "HEAD or the working diff could not be captured, at sealing time or now";
    case "STORE_SCHEMA_UNAVAILABLE":
      return "the store schema version could not be read";
    case "REPOSITORY_NOT_INITIALIZED":
      return "no .semctx/config.json: the repository was never set up";
    case "REPOSITORY_NOT_INDEXED":
      return "the repository has a configuration but no index";
    case "INDEX_SNAPSHOT_INVALID":
      return "a persisted index record is malformed or no longer bound to its index";
    case "SEMANTIC_MODEL_INVALID":
      return "the authored model under .semctx/semantic has errors or duplicate ids";
    case "SEMANTIC_LIFECYCLE_INVALID":
      return "the authored lifecycle (active change, verification baseline) is invalid";
  }
}

function reasonRemedy(reason: ControlFreshnessReason): string | null {
  switch (reason) {
    case "REPOSITORY_NOT_INITIALIZED":
      return "semctx setup";
    case "WORKING_TREE_DIRTY":
      return `commit or stash, then ${SEAL_COMMAND}`;
    case "SEMANTIC_MODEL_INVALID":
    case "SEMANTIC_LIFECYCLE_INVALID":
      return "semctx semantic check";
    case "GIT_STATE_UNAVAILABLE":
      return null;
    default:
      return SEAL_COMMAND;
  }
}

/**
 * One explanation per status reason. The causes come from the seal the report embeds or, for an
 * input that could not be sealed, from the failure that refused it; nothing is re-observed here.
 */
export function explainControlStatus(status: ControlFreshnessStatusReport, failure?: unknown): ControlStatusExplanation[] {
  const details = isSemctxError(failure) ? failure.details : {};
  const explanation: ControlStatusExplanation[] = [];
  for (const reason of status.reasons) {
    if (reason === "SEMANTIC_LIFECYCLE_INVALID") {
      const findings = lifecycleFindings(details);
      for (const finding of findings) {
        const subjects = finding.subjectIds !== undefined && finding.subjectIds.length > 0 ? ` (${finding.subjectIds.join(", ")})` : "";
        explanation.push({ reason, code: finding.code, detail: `${finding.message}${subjects}`, remedy: LIFECYCLE_REMEDY[finding.code] ?? "semctx semantic check" });
      }
      if (findings.length > 0) continue;
    }
    if (reason === "SEMANTIC_MODEL_INVALID") {
      const errors = diagnostics(details);
      for (const diagnostic of errors) {
        explanation.push({ reason, code: diagnostic.code ?? "SEMANTIC_PARSE_ERROR", detail: `${diagnostic.file}:${diagnostic.line}: ${diagnostic.message}`, remedy: "semctx semantic check" });
      }
      const duplicates = Array.isArray(details["duplicateIds"]) ? details["duplicateIds"].filter((id): id is string => typeof id === "string") : [];
      if (duplicates.length > 0) {
        explanation.push({ reason, code: "SEMANTIC_DUPLICATE_ID", detail: `duplicate authored ids: ${duplicates.join(", ")}`, remedy: "semctx semantic check" });
      }
      if (errors.length > 0 || duplicates.length > 0) continue;
    }
    explanation.push({ reason, code: reason, detail: sealDetail(reason, status), remedy: reasonRemedy(reason) });
  }
  return explanation;
}

/** The typed answer of a preflight that did not finish inside its budget. */
export function controlStatusTimeout(budgetMs: number, elapsedMs: number): ControlStatusTimeoutReport {
  return {
    schemaVersion: 1,
    kind: "control_freshness_status",
    basis: "control_index_snapshot_v1",
    verdict: "TIMEOUT",
    canRunHighRiskControl: false,
    reasons: [CONTROL_STATUS_BUDGET_EXCEEDED],
    freshnessSeal: null,
    budget: { budgetMs, elapsedMs },
    explanation: [{
      reason: CONTROL_STATUS_BUDGET_EXCEEDED,
      code: CONTROL_STATUS_BUDGET_EXCEEDED,
      detail: `the freshness preflight did not finish within ${budgetMs} ms and was stopped; nothing was observed, so nothing is fresh`,
      remedy: "semctx status --json",
    }],
  };
}
