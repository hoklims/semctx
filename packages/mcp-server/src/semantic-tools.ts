/**
 * Semantic-layer MCP tools (Plane B). These extend the agent workflow without touching the
 * first-class `semctx_verify_change`. Changes authored through these tools carry `provenance: agent`.
 */

import { checkSemanticState, closeChange, openChange, updateChange, verifyAuthoredChange } from "@semantic-context/app-services";
import {
  loadModelWithWorking,
  loadActiveChange,
  sliceSemanticModel,
  renderSlice,
  inspectSemantic,
  captureHandoff,
  readHandoff,
  buildHandoffCapsule,
  type RepositoryFacts,
  type SemanticSlice,
  type ChangeVerifyReport,
  type SemanticInspection,
  type HandoffCapsule,
  type CheckReport,
} from "@semantic-context/semantic-engine";
import type { ChangeContract, ChangeLifecycle } from "@semantic-context/semantic-model";
import { ensureReady, nowIso } from "./tools";

function facts(root: string): RepositoryFacts {
  const store = ensureReady(root);
  try {
    const graph = store.loadGraph();
    return { graph, claims: store.loadClaims(), evidence: store.loadEvidence() };
  } finally {
    store.close();
  }
}

export interface SliceInput {
  changeId?: string;
  symbolRef?: string;
  claimRef?: string;
  maxNodes?: number;
}

/** semctx_semantic_check: the same versioned integrity and lifecycle report as the CLI. */
export function semanticCheckTool(root: string): CheckReport {
  return checkSemanticState(root);
}

/** semctx_semantic_slice: bounded, deterministic capsule from explicit scopes (no free-text retrieval). */
export function semanticSliceTool(root: string, input: SliceInput): { slice: SemanticSlice; capsule: string } {
  const { model } = loadModelWithWorking(root);
  const slice = sliceSemanticModel(model, {
    ...(input.changeId !== undefined ? { changeId: input.changeId } : {}),
    ...(input.symbolRef !== undefined ? { symbolRef: input.symbolRef } : {}),
    ...(input.claimRef !== undefined ? { claimRef: input.claimRef } : {}),
    ...(input.maxNodes !== undefined ? { maxNodes: input.maxNodes } : {}),
  });
  return { slice, capsule: renderSlice(slice, "symbols") };
}

export interface ChangeOpenInput {
  id: string;
  statement: string;
  serves?: string[];
  preserves?: string[];
  requires?: string[];
  unknowns?: string[];
  links?: string[];
  tags?: string[];
  draft?: boolean;
}

/** semctx_change_open: open an agent-authored change contract and set it active. */
export function changeOpenTool(root: string, input: ChangeOpenInput): ChangeContract {
  return openChange(root, {
    id: input.id,
    statement: input.statement,
    provenance: "agent",
    lifecycle: input.draft === true ? "draft" : "active",
    serves: input.serves ?? [],
    preserves: input.preserves ?? [],
    requiresEvidence: input.requires ?? [],
    openUnknowns: input.unknowns ?? [],
    links: input.links ?? [],
    tags: input.tags ?? [],
  });
}

export interface ChangeUpdateInput {
  id: string;
  statement?: string;
  status?: ChangeLifecycle;
  addServes?: string[];
  addPreserves?: string[];
  addRequires?: string[];
  addUnknowns?: string[];
  resolveUnknowns?: string[];
  addLinks?: string[];
  addTags?: string[];
}

/** semctx_change_update: patch a change contract additively. */
export function changeUpdateTool(root: string, input: ChangeUpdateInput): ChangeContract {
  return updateChange(root, {
    id: input.id,
    provenance: "agent",
    ...(input.statement !== undefined ? { statement: input.statement } : {}),
    ...(input.status !== undefined ? { lifecycle: input.status } : {}),
    addServes: input.addServes ?? [],
    addPreserves: input.addPreserves ?? [],
    addRequires: input.addRequires ?? [],
    addUnknowns: input.addUnknowns ?? [],
    resolveUnknowns: input.resolveUnknowns ?? [],
    addLinks: input.addLinks ?? [],
    addTags: input.addTags ?? [],
  });
}

/** semctx_change_verify: compose verify diff with a change contract → VERIFIED/PARTIAL/BLOCKED/STALE. */
export function changeVerifyTool(root: string, input: { changeId: string; gitDiff?: string }): ChangeVerifyReport {
  const source = input.gitDiff !== undefined
    ? { kind: "provided" as const, diffText: input.gitDiff }
    : { kind: "working-tree" as const };
  return verifyAuthoredChange(root, input.changeId, source);
}

/** semctx_semantic_inspect: resolve a semantic id, its incoming references and link resolution. */
export function semanticInspectTool(root: string, input: { id: string }): SemanticInspection {
  const { model } = loadModelWithWorking(root);
  return inspectSemantic(model, input.id, facts(root));
}

/** semctx_handoff: capture the working delta into .semctx/working/ before a compaction/handoff. */
export function handoffTool(root: string, input: { note?: string }): HandoffCapsule {
  const { model } = loadModelWithWorking(root);
  return captureHandoff({ root, now: nowIso(), model, activeChange: loadActiveChange(root), ...(input.note !== undefined ? { note: input.note } : {}) });
}

/** semctx_resume: re-emit the last handoff capsule (or one rebuilt from the active change). */
export function resumeTool(root: string): HandoffCapsule | { message: string } {
  const existing = readHandoff(root);
  if (existing !== undefined) return existing;
  const { model } = loadModelWithWorking(root);
  const active = loadActiveChange(root);
  if (active === undefined) return { message: "no handoff on record and no active change to resume" };
  return buildHandoffCapsule({ root, now: nowIso(), model, activeChange: active });
}

/** Close a change contract (verified, or superseded). Exposed for symmetry; not a primary tool. */
export function changeCloseTool(root: string, input: { id: string; superseded?: boolean; gitDiff?: string }): ChangeContract {
  const source = input.gitDiff !== undefined
    ? { kind: "provided" as const, diffText: input.gitDiff }
    : { kind: "working-tree" as const };
  return closeChange(root, { id: input.id, superseded: input.superseded, source });
}
