/** Filesystem layout of the semantic layer under `.semctx/`. */

import { isAbsolute, join, relative, resolve } from "node:path";
import { SemctxError } from "@semantic-context/core";
import { semctxDir } from "@semantic-context/repository-store";
import { ChangeTargetBindingV1Schema, isValidSemanticId, type SemanticNodeKind } from "@semantic-context/semantic-model";

/** Git-versioned source of truth: authored declarations. */
export function semanticDir(root: string): string {
  return join(semctxDir(root), "semantic");
}

/** Local, git-ignored agent scratch (active change + handoff capsule). */
export function workingDir(root: string): string {
  return join(semctxDir(root), "working");
}

export function changesDir(root: string): string {
  return join(semanticDir(root), "changes");
}

export function targetsDir(root: string): string {
  return join(semanticDir(root), "targets");
}

export function isSafeTargetId(targetId: string): boolean {
  return ChangeTargetBindingV1Schema.shape.targetId.safeParse(targetId).success;
}

export function targetArtifactPath(root: string, targetId: string, revision: number): string {
  if (!isSafeTargetId(targetId)) {
    throw new SemctxError("INVALID_TASK_INPUT", `invalid target id: ${targetId}`);
  }
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new SemctxError("INVALID_TASK_INPUT", `invalid target revision: ${revision}`);
  }

  const base = resolve(targetsDir(root));
  const target = resolve(base, targetId, `r${revision}.target.json`);
  const fromBase = relative(base, target);
  if (fromBase.startsWith("..") || isAbsolute(fromBase)) {
    throw new SemctxError("INVALID_TASK_INPUT", `target path escapes targets directory: ${targetId}`);
  }
  return target;
}

/** Per-kind file that holds all truth nodes of a kind. */
export const KIND_FILE: Record<Exclude<SemanticNodeKind, "change">, string> = {
  goal: "goals.sem",
  invariant: "invariants.sem",
  decision: "decisions.sem",
  assumption: "assumptions.sem",
  unknown: "unknowns.sem",
  evidence: "evidence.sem",
};

export function kindFilePath(root: string, kind: Exclude<SemanticNodeKind, "change">): string {
  return join(semanticDir(root), KIND_FILE[kind]);
}

export function changeFilePath(root: string, changeId: string): string {
  if (!isValidSemanticId("change", changeId)) {
    throw new SemctxError("INVALID_TASK_INPUT", `invalid change id: ${changeId}`);
  }

  const base = resolve(changesDir(root));
  const target = resolve(base, `${changeId}.sem`);
  const fromBase = relative(base, target);
  if (fromBase.startsWith("..") || isAbsolute(fromBase)) {
    throw new SemctxError("INVALID_TASK_INPUT", `change path escapes changes directory: ${changeId}`);
  }
  return target;
}

export function activeChangePath(root: string): string {
  return join(workingDir(root), "active-change.sem");
}

export function handoffJsonPath(root: string): string {
  return join(workingDir(root), "handoff.json");
}

export function handoffMarkdownPath(root: string): string {
  return join(workingDir(root), "handoff.md");
}
