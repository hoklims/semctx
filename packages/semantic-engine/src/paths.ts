/** Filesystem layout of the semantic layer under `.semctx/`. */

import { join } from "node:path";
import { semctxDir } from "@semantic-context/repository-store";
import type { SemanticNodeKind } from "@semantic-context/semantic-model";

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
  return join(changesDir(root), `${changeId}.sem`);
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
