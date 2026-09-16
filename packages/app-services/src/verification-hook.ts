import { readFileSync } from "node:fs";
import { SemctxError } from "@semantic-context/core";
import { verificationStatePath } from "@semantic-context/repository-store";
import {
  captureCommitTreeHash,
  captureRecordableVerificationGitState,
  parseVerificationStateV3,
  resolveRevisionObjectId,
  type VerificationStateV3,
} from "./verification-state";
import { recordVerificationState, requireStableVerificationGitState } from "./verification-recording";
import { runVerify, type VerifyComputation } from "./verify";

/**
 * Content proof as the last job of a project-managed Git hook chain (ADR 0029).
 *
 * The plugin's pre-tool guard observes the index before the project's own hooks run; a formatter
 * that rewrites and restages inside `pre-commit` therefore commits a tree the guard never saw.
 * These two evaluations run inside the hook chain, after the last writer, on the tree Git is
 * about to record or publish. They are the cheap path ADR 0007 asked for: a hash compare against
 * the recorded baseline, with analysis only when the tree drifted (pre-commit) and never on push.
 */
export type VerificationHookName = "pre-commit" | "pre-push";

/** One `<local ref> <local oid> <remote ref> <remote oid>` line as Git writes it to a pre-push hook's stdin. */
export interface PushedRef {
  localRef: string;
  localObjectId: string;
  remoteRef: string;
  remoteObjectId: string;
}

export type VerificationHookRefusal =
  | "PARTIAL_INDEX"
  | "NO_PROOF"
  | "PROOF_UNREADABLE"
  | "REF_DELETION"
  | "UNPROVEN_REF";

export type VerificationHookRecordReason = "NO_PROOF" | "PROOF_UNREADABLE" | "PROOF_STALE" | "PROOF_BLOCK";

export type VerificationHookOutcome =
  /** The recorded baseline already covers the tree; no analysis ran. */
  | { kind: "current"; hook: VerificationHookName; state: VerificationStateV3; checkedRefs: readonly PushedRef[] }
  /** pre-commit only: the tree drifted (or no usable record existed), so a new verification was recorded. */
  | { kind: "recorded"; hook: "pre-commit"; reason: VerificationHookRecordReason; verification: VerifyComputation; recordedPath: string }
  /** pre-push only: every pushed tree matches the record, but that record is a BLOCK verdict. */
  | { kind: "blocked"; hook: "pre-push"; state: VerificationStateV3; checkedRefs: readonly PushedRef[] }
  /** The hook cannot vouch for what Git is about to do; nothing was recorded. */
  | { kind: "refused"; hook: VerificationHookName; reason: VerificationHookRefusal; message: string; details: Record<string, unknown> };

const OBJECT_ID = /^[0-9a-f]{40,64}$/;

/** Parse the ref lines Git pipes into a pre-push hook. Blank input means "no refs were given". */
export function parsePrePushRefs(stdin: string): PushedRef[] {
  const refs: PushedRef[] = [];
  for (const line of stdin.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const fields = trimmed.split(/\s+/);
    const [localRef, localObjectId, remoteRef, remoteObjectId] = fields;
    if (
      fields.length !== 4
      || localRef === undefined || localObjectId === undefined || remoteRef === undefined || remoteObjectId === undefined
      || !OBJECT_ID.test(localObjectId) || !OBJECT_ID.test(remoteObjectId)
    ) {
      throw new SemctxError(
        "INVALID_TASK_INPUT",
        "pre-push stdin must carry `<local ref> <local oid> <remote ref> <remote oid>` lines",
        { line },
      );
    }
    refs.push({ localRef, localObjectId, remoteRef, remoteObjectId });
  }
  return refs;
}

type RecordedState =
  | { status: "missing" }
  | { status: "unreadable" }
  | { status: "read"; state: VerificationStateV3 };

function readRecordedState(root: string): RecordedState {
  let raw: string;
  try {
    raw = readFileSync(verificationStatePath(root), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "unreadable" };
  }
  const state = parseVerificationStateV3(parsed);
  return state === null ? { status: "unreadable" } : { status: "read", state };
}

function refused(
  hook: VerificationHookName,
  reason: VerificationHookRefusal,
  message: string,
  details: Record<string, unknown> = {},
): VerificationHookOutcome {
  return { kind: "refused", hook, reason, message, details };
}

/**
 * Last `pre-commit` job. Runs after the last writer, so the index it observes is the tree Git will
 * record. A whole-index commit is required exactly as the guard requires it: unstaged edits or
 * non-ignored untracked files make the commit partial and are refused before any analysis.
 * With a current non-BLOCK record the hook returns without analysis; otherwise it records a new
 * working-tree verification under the same stability and refusal rules as `verify diff --record`.
 */
export function evaluatePreCommitHook(root: string, recordedAt: string): VerificationHookOutcome {
  const current = captureRecordableVerificationGitState(root);
  if (current.indexStateHash !== current.repositoryStateHash) {
    return refused(
      "pre-commit",
      "PARTIAL_INDEX",
      "the index does not materialize the working tree, so the commit would record content the proof does not cover; stage the complete state (or drop the unstaged edits) and retry",
    );
  }
  const recorded = readRecordedState(root);
  let reason: VerificationHookRecordReason;
  if (recorded.status === "missing") {
    reason = "NO_PROOF";
  } else if (recorded.status === "unreadable") {
    reason = "PROOF_UNREADABLE";
  } else if (
    recorded.state.contentStateHash !== current.contentStateHash
    || recorded.state.repositoryStateHash !== current.repositoryStateHash
  ) {
    reason = "PROOF_STALE";
  } else if (recorded.state.verdict === "BLOCK") {
    reason = "PROOF_BLOCK";
  } else {
    return { kind: "current", hook: "pre-commit", state: recorded.state, checkedRefs: [] };
  }

  const verification = runVerify(root, { kind: "working-tree" });
  const verifiedState = requireStableVerificationGitState(
    current,
    captureRecordableVerificationGitState(root),
    verification.analyzedSourceHash ?? "",
  );
  const recordedPath = recordVerificationState(root, verification.report.verdict, verifiedState, recordedAt);
  return { kind: "recorded", hook: "pre-commit", reason, verification, recordedPath };
}

/**
 * Last `pre-push` job. A pre-push hook cannot change the commits being pushed and a post-commit
 * working-tree verification would analyze an empty diff, so this never records: it checks that
 * the tree of every pushed commit is exactly the recorded verified state. Without ref lines (a
 * manual invocation) it checks HEAD.
 */
export function evaluatePrePushHook(root: string, pushedRefs: readonly PushedRef[]): VerificationHookOutcome {
  const recorded = readRecordedState(root);
  if (recorded.status === "missing") {
    return refused(
      "pre-push",
      "NO_PROOF",
      "no recorded verification covers the pushed commits; verify before committing (`semctx verify diff --record`, or `semctx verify hook pre-commit` as the last pre-commit job)",
    );
  }
  if (recorded.status === "unreadable") {
    return refused(
      "pre-push",
      "PROOF_UNREADABLE",
      "the recorded verification baseline is legacy, malformed or unreadable, so it cannot vouch for any commit; re-record it before committing",
    );
  }
  const { state } = recorded;
  const refs: PushedRef[] = pushedRefs.length > 0
    ? [...pushedRefs]
    : [{ localRef: "HEAD", localObjectId: resolveRevisionObjectId(root, "HEAD"), remoteRef: "(unspecified)", remoteObjectId: "0".repeat(40) }];
  for (const ref of refs) {
    if (/^0+$/.test(ref.localObjectId)) {
      return refused(
        "pre-push",
        "REF_DELETION",
        `deleting ${ref.remoteRef} is not covered by a content proof`,
        { ref },
      );
    }
    const treeHash = captureCommitTreeHash(root, ref.localObjectId);
    if (treeHash !== state.repositoryStateHash) {
      return refused(
        "pre-push",
        "UNPROVEN_REF",
        `${ref.localRef} (${ref.localObjectId}) does not materialize the recorded verified state; it was committed without a current proof, or a hook rewrote the tree after the proof`,
        { ref, treeHash, recordedRepositoryStateHash: state.repositoryStateHash },
      );
    }
  }
  if (state.verdict === "BLOCK") return { kind: "blocked", hook: "pre-push", state, checkedRefs: refs };
  return { kind: "current", hook: "pre-push", state, checkedRefs: refs };
}
