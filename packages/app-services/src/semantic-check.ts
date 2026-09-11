import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangeContract } from "@semantic-context/semantic-model";
import {
  checkSemanticModel,
  loadSemanticModel,
  readActiveChangePointer,
  sameChangeContractContent,
  type CheckReport,
  type RepositoryFacts,
  type SemanticLifecycleFinding,
} from "@semantic-context/semantic-engine";
import { assertUnlinkedWorkspace, dbPath, openReader } from "@semantic-context/repository-store";
import { captureVerificationGitState } from "./verification-state";

const ACTIVE_LIFECYCLES = new Set<ChangeContract["lifecycle"]>(["active", "partial", "blocked", "stale"]);
const TERMINAL_LIFECYCLES = new Set<ChangeContract["lifecycle"]>(["verified", "superseded"]);

interface VerificationStateV3 {
  version: 3;
  headCommit: string;
  analyzedSourceHash: string;
  workingStateHash: string;
  contentStateHash: string;
  repositoryStateHash: string;
  indexStateHash: string;
  headTreeHash: string;
  verdict: "PASS" | "WARN" | "BLOCK";
  recordedAt: string;
}

/** Shared CLI/MCP semantic integrity use case, including local lifecycle hygiene. */
export function checkSemanticState(root: string): CheckReport {
  // Covers the read-only index open and the verification-state read below.
  assertUnlinkedWorkspace(root);
  const loaded = loadSemanticModel(root);
  let facts: RepositoryFacts | undefined;
  let indexed = false;
  const database = dbPath(root);
  if (existsSync(database)) {
    const store = openReader(root);
    try {
      indexed = store.isIndexed();
      if (indexed) {
        facts = { graph: store.loadGraph(), claims: store.loadClaims(), evidence: store.loadEvidence() };
      }
    } finally {
      store.close();
    }
  }

  return checkSemanticModel({
    model: loaded.model,
    diagnostics: loaded.diagnostics,
    duplicateIds: loaded.duplicateIds,
    ...(facts !== undefined ? { facts } : {}),
    graphIndexed: indexed,
    lifecycleFindings: inspectSemanticLifecycle(root, loaded.model.changes),
  });
}

export function inspectSemanticLifecycle(root: string, changes: readonly ChangeContract[]): SemanticLifecycleFinding[] {
  const findings: SemanticLifecycleFinding[] = [];
  const active = changes.filter((change) => ACTIVE_LIFECYCLES.has(change.lifecycle));
  const pointer = readActiveChangePointer(root);

  if (pointer.state === "invalid") {
    findings.push({
      code: "ACTIVE_CHANGE_POINTER_INVALID",
      severity: "error",
      message: "The active-change pointer is malformed and cannot select a contract.",
      subjectIds: [],
    });
  } else if (pointer.state === "missing") {
    if (active.length > 0) {
      findings.push({
        code: "ACTIVE_CHANGE_POINTER_MISSING",
        severity: "warning",
        message: "One or more non-terminal change contracts exist without an active working pointer.",
        subjectIds: active.map((change) => change.id).sort(),
      });
    }
  } else if (pointer.change !== undefined) {
    const selected = changes.find((change) => change.id === pointer.change?.id);
    if (selected === undefined) {
      findings.push({
        code: "ACTIVE_CHANGE_POINTER_INVALID",
        severity: "error",
        message: `The active-change pointer selects an unknown contract: ${pointer.change.id}.`,
        subjectIds: [pointer.change.id],
      });
    } else if (TERMINAL_LIFECYCLES.has(selected.lifecycle)) {
      findings.push({
        code: "ACTIVE_CHANGE_OBSOLETE",
        severity: "error",
        message: `The active-change pointer still selects closed history: ${selected.id} [${selected.lifecycle}].`,
        subjectIds: [selected.id],
      });
    } else if (!sameChangeContractContent(pointer.change, selected)) {
      findings.push({
        code: "ACTIVE_CHANGE_POINTER_MISMATCH",
        severity: "error",
        message: `The active-change pointer no longer matches the selected versioned contract: ${selected.id}.`,
        subjectIds: [selected.id],
      });
    }

    for (const obsolete of active.filter((change) => change.id !== pointer.change?.id)) {
      findings.push({
        code: "ACTIVE_CHANGE_OBSOLETE",
        severity: "error",
        message: `The non-terminal contract ${obsolete.id} is not the selected active change.`,
        subjectIds: [obsolete.id],
      });
    }
  }

  const baseline = inspectVerificationBaseline(root);
  if (baseline === "invalid") {
    findings.push({
      code: "EVIDENCE_BASELINE_INVALID",
      severity: "error",
      message: "The recorded verification baseline is malformed or cannot be compared to the repository.",
      subjectIds: [],
    });
  } else if (baseline === "stale") {
    findings.push({
      code: "EVIDENCE_BASELINE_STALE",
      severity: "error",
      message: "The recorded verification baseline does not match the current analyzed content state.",
      subjectIds: [],
    });
  } else if (baseline === "superseded") {
    findings.push({
      code: "EVIDENCE_BASELINE_SUPERSEDED",
      severity: "warning",
      message: "The recorded verification baseline uses a schema this build no longer reads; re-record it with semctx verify diff --record.",
      subjectIds: [],
    });
  }
  return findings;
}

/**
 * Schema versions a previous build wrote and this one recognises without reading.
 *
 * A superseded baseline is not evidence and never becomes one: it is replaced, never
 * reinterpreted. It is a warning rather than an error because it reports an absence, not a
 * contradiction — the same reason `DURABLE_ANCHOR_IS_TRANSIENT` is a warning. Treating it as an
 * error closed the only exit: `index` refuses to seal on any lifecycle error, so the operation
 * that produces a current baseline was gated on already having one.
 */
function isSupersededVerificationState(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if ((state.verdict !== "PASS" && state.verdict !== "WARN" && state.verdict !== "BLOCK")
    || typeof state.recordedAt !== "string"
    || !Number.isFinite(Date.parse(state.recordedAt))) return false;
  if (state.version === 1) {
    return typeof state.diffHash === "string" && /^sha256:[0-9a-f]{64}$/.test(state.diffHash);
  }
  return state.version === 2
    && typeof state.headCommit === "string" && /^[0-9a-f]{40,64}$/.test(state.headCommit)
    && typeof state.workingStateHash === "string" && /^sha256:[0-9a-f]{64}$/.test(state.workingStateHash);
}

function inspectVerificationBaseline(
  root: string,
): "missing" | "valid" | "invalid" | "stale" | "superseded" {
  const path = join(root, ".semctx", "verification-state.json");
  if (!existsSync(path)) return "missing";
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return "invalid";
  }
  if (!isVerificationState(parsed)) {
    return isSupersededVerificationState(parsed) ? "superseded" : "invalid";
  }
  try {
    const current = captureVerificationGitState(root);
    return current.contentStateHash === parsed.contentStateHash
        && current.repositoryStateHash === parsed.repositoryStateHash
      ? "valid"
      : "stale";
  } catch {
    return "invalid";
  }
}

function isVerificationState(value: unknown): value is VerificationStateV3 {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Partial<VerificationStateV3>;
  return state.version === 3
    && typeof state.headCommit === "string"
    && /^[0-9a-f]{40,64}$/.test(state.headCommit)
    && typeof state.analyzedSourceHash === "string"
    && /^sha256:[0-9a-f]{64}$/.test(state.analyzedSourceHash)
    && typeof state.workingStateHash === "string"
    && /^sha256:[0-9a-f]{64}$/.test(state.workingStateHash)
    && typeof state.contentStateHash === "string"
    && /^sha256:[0-9a-f]{64}$/.test(state.contentStateHash)
    && typeof state.repositoryStateHash === "string"
    && /^sha256:[0-9a-f]{64}$/.test(state.repositoryStateHash)
    && typeof state.indexStateHash === "string"
    && /^sha256:[0-9a-f]{64}$/.test(state.indexStateHash)
    && typeof state.headTreeHash === "string"
    && /^sha256:[0-9a-f]{64}$/.test(state.headTreeHash)
    && (state.verdict === "PASS" || state.verdict === "WARN" || state.verdict === "BLOCK")
    && typeof state.recordedAt === "string"
    && Number.isFinite(Date.parse(state.recordedAt));
}
