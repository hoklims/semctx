/**
 * Working delta for anti-compaction handoff (Section 4.6). Captures the active change, touched
 * invariants, obtained proofs, open assumptions/unknowns, explored links and the next validations
 * into a compact, deterministic capsule so a fresh agent context can be rehydrated. Persisted
 * locally in `.semctx/working/`. Uses explicit `handoff`/`resume` commands — no reliance on an
 * unverified compaction hook.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import { compareIds, SemctxError } from "@semantic-context/core";
import { writeFileNoFollow } from "@semantic-context/repository-store";
import { SemanticIndex, PROVEN_STATUSES, repositoryLinkToRef } from "@semantic-context/semantic-model";
import type { SemanticModel, ChangeContract } from "@semantic-context/semantic-model";
import { workingDir, handoffJsonPath, handoffMarkdownPath } from "./paths";
import { assertUnlinkedSemanticTree } from "./store";

export const HANDOFF_SCHEMA_VERSION = 1 as const;

export const HandoffCapsuleSchema = z.object({
  version: z.literal(HANDOFF_SCHEMA_VERSION).describe("Handoff-capsule schema version."),
  createdAt: z.string().describe("ISO capture timestamp."),
  activeChangeId: z.string().optional().describe("Optional active change identifier."),
  changeLifecycle: z.string().optional().describe("Optional active change lifecycle."),
  statement: z.string().optional().describe("Optional active change statement."),
  touchedInvariants: z.array(z.string()).describe("Invariants to preserve."),
  proofsObtained: z.array(z.string()).describe("Evidence already proven."),
  pendingProofs: z.array(z.string()).describe("Evidence still pending."),
  activeAssumptions: z.array(z.string()).describe("Active assumption identifiers."),
  exploredLinks: z.array(z.string()).describe("Repository links already explored."),
  openUnknowns: z.array(z.string()).describe("Open unknown identifiers."),
  nextValidations: z.array(z.string()).describe("Next required validations."),
  note: z.string().optional().describe("Optional handoff note."),
}).strict();

export type HandoffCapsule = z.infer<typeof HandoffCapsuleSchema>;

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
  assertUnlinkedSemanticTree(args.root);
  mkdirSync(workingDir(args.root), { recursive: true });
  writeFileNoFollow(args.root, handoffJsonPath(args.root), `${JSON.stringify(capsule, null, 2)}\n`);
  writeFileNoFollow(args.root, handoffMarkdownPath(args.root), renderHandoffMarkdown(capsule));
  return capsule;
}

function isHandoffCapsule(value: unknown): value is HandoffCapsule {
  return HandoffCapsuleSchema.safeParse(value).success;
}

/** Read a previously captured handoff capsule. Absence is optional; malformed content is not. */
export function readHandoff(root: string): HandoffCapsule | undefined {
  assertUnlinkedSemanticTree(root);
  const path = handoffJsonPath(root);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new SemctxError("CONFIG_INVALID", "handoff capsule is not valid JSON", {
      path,
      reason: "INVALID_JSON",
      cause: errorEvidence(cause),
    });
  }
  if (!isHandoffCapsule(parsed)) {
    throw new SemctxError("CONFIG_INVALID", "handoff capsule does not match its schema", {
      path,
      reason: "CAPSULE_INVALID",
      issues: HandoffCapsuleSchema.safeParse(parsed).error?.issues,
    });
  }
  return parsed;
}

function errorEvidence(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}
