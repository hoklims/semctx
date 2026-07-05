/**
 * Working delta for anti-compaction handoff (Section 4.6). Captures the active change, touched
 * invariants, obtained proofs, open assumptions/unknowns, explored links and the next validations
 * into a compact, deterministic capsule so a fresh agent context can be rehydrated. Persisted
 * locally in `.semctx/working/`. Uses explicit `handoff`/`resume` commands — no reliance on an
 * unverified compaction hook.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { compareIds } from "@semantic-context/core";
import { SemanticIndex, PROVEN_STATUSES, repositoryLinkToRef } from "@semantic-context/semantic-model";
import type { SemanticModel, ChangeContract } from "@semantic-context/semantic-model";
import { workingDir, handoffJsonPath, handoffMarkdownPath } from "./paths";

export const HANDOFF_SCHEMA_VERSION = 1 as const;

export interface HandoffCapsule {
  version: typeof HANDOFF_SCHEMA_VERSION;
  createdAt: string;
  activeChangeId?: string;
  changeLifecycle?: string;
  statement?: string;
  touchedInvariants: string[];
  proofsObtained: string[];
  pendingProofs: string[];
  activeAssumptions: string[];
  exploredLinks: string[];
  openUnknowns: string[];
  nextValidations: string[];
  note?: string;
}

export interface CaptureArgs {
  root: string;
  now: string;
  model: SemanticModel;
  activeChange?: ChangeContract | undefined;
  note?: string | undefined;
}

function sorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareIds);
}

export function buildHandoffCapsule(args: CaptureArgs): HandoffCapsule {
  const { model, activeChange, now, note } = args;
  const index = new SemanticIndex(model);

  const proofsObtained: string[] = [];
  const pendingProofs: string[] = [];
  const nextValidations: string[] = [];
  if (activeChange !== undefined) {
    for (const evId of activeChange.requiresEvidence) {
      const ev = index.node(evId);
      if (ev !== undefined && PROVEN_STATUSES.has(ev.status)) proofsObtained.push(evId);
      else {
        pendingProofs.push(evId);
        nextValidations.push(`obtain proof: ${evId}`);
      }
    }
    for (const invId of activeChange.preserves) nextValidations.push(`re-verify invariant holds: ${invId}`);
  }

  const capsule: HandoffCapsule = {
    version: HANDOFF_SCHEMA_VERSION,
    createdAt: now,
    touchedInvariants: sorted(activeChange?.preserves ?? []),
    proofsObtained: sorted(proofsObtained),
    pendingProofs: sorted(pendingProofs),
    activeAssumptions: index.nodesOfKind("assumption").map((a) => a.id),
    exploredLinks: sorted((activeChange?.repositoryLinks ?? []).map(repositoryLinkToRef)),
    openUnknowns: sorted(activeChange?.openUnknowns ?? []),
    nextValidations: sorted(nextValidations),
  };
  if (activeChange !== undefined) {
    capsule.activeChangeId = activeChange.id;
    capsule.changeLifecycle = activeChange.lifecycle;
    capsule.statement = activeChange.statement;
  }
  if (note !== undefined && note.length > 0) capsule.note = note;
  return capsule;
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

export function renderHandoffMarkdown(capsule: HandoffCapsule): string {
  const lines: string[] = [];
  lines.push(`# semctx handoff capsule`);
  lines.push("");
  lines.push(`- created: ${capsule.createdAt}`);
  if (capsule.activeChangeId !== undefined) {
    lines.push(`- active change: **${capsule.activeChangeId}** [${capsule.changeLifecycle}]`);
    if (capsule.statement !== undefined) lines.push(`- statement: ${capsule.statement}`);
  } else {
    lines.push(`- active change: (none)`);
  }
  const list = (title: string, items: string[]): void => {
    lines.push("", `## ${title}`);
    if (items.length === 0) lines.push("- (none)");
    else for (const item of items) lines.push(`- ${item}`);
  };
  list("Invariants to preserve", capsule.touchedInvariants);
  list("Proofs obtained", capsule.proofsObtained);
  list("Pending proofs", capsule.pendingProofs);
  list("Open unknowns", capsule.openUnknowns);
  list("Active assumptions", capsule.activeAssumptions);
  list("Explored links", capsule.exploredLinks);
  list("Next validations", capsule.nextValidations);
  if (capsule.note !== undefined) list("Note", [capsule.note]);
  return `${lines.join("\n")}\n`;
}

/** Capture and persist a handoff capsule to `.semctx/working/`. Returns the capsule. */
export function captureHandoff(args: CaptureArgs): HandoffCapsule {
  const capsule = buildHandoffCapsule(args);
  mkdirSync(workingDir(args.root), { recursive: true });
  writeAtomic(handoffJsonPath(args.root), `${JSON.stringify(capsule, null, 2)}\n`);
  writeAtomic(handoffMarkdownPath(args.root), renderHandoffMarkdown(capsule));
  return capsule;
}

const REQUIRED_ARRAYS = ["touchedInvariants", "proofsObtained", "pendingProofs", "activeAssumptions", "exploredLinks", "openUnknowns", "nextValidations"] as const;

/** Structural guard at the file boundary: a hand-edited/stale handoff.json must not crash resume. */
function isHandoffCapsule(value: unknown): value is HandoffCapsule {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["createdAt"] !== "string") return false;
  return REQUIRED_ARRAYS.every((key) => Array.isArray(v[key]));
}

/** Read a previously captured handoff capsule, if any. Rejects malformed/partial files (→ undefined). */
export function readHandoff(root: string): HandoffCapsule | undefined {
  const path = handoffJsonPath(root);
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isHandoffCapsule(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
