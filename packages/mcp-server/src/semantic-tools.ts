/**
 * Semantic-layer MCP tools (Plane B). These extend the agent workflow without touching the
 * first-class `semctx_verify_change`. Changes authored through these tools carry `provenance: agent`.
 */

import { GraphIndex, analyzeDiff, buildVerifyReport } from "@semantic-context/context-engine";
import { loadConfig } from "@semantic-context/repository-store";
import type { VerifyReportGitMeta } from "@semantic-context/context-engine";
import type { VerifyReport } from "@semantic-context/core";
import {
  loadModelWithWorking,
  loadActiveChange,
  writeChangeFile,
  writeActiveChange,
  clearActiveChange,
  ensureSemanticGitignore,
  newChangeContract,
  applyChangePatch,
  verifyChangeContract,
  resolveSemanticPolicy,
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
} from "@semantic-context/semantic-engine";
import type { ChangeContract, ChangeLifecycle } from "@semantic-context/semantic-model";
import { kindOfSemanticId, semanticId } from "@semantic-context/semantic-model";
import { ensureReady, nowIso } from "./tools";

function facts(root: string): { facts: RepositoryFacts; index: GraphIndex } {
  const store = ensureReady(root);
  try {
    const graph = store.loadGraph();
    return { facts: { graph, claims: store.loadClaims(), evidence: store.loadEvidence() }, index: new GraphIndex(graph) };
  } finally {
    store.close();
  }
}

function normalizeChangeId(id: string): string {
  return kindOfSemanticId(id) === undefined ? semanticId("change", id) : id;
}

export interface SliceInput {
  changeId?: string;
  symbolRef?: string;
  claimRef?: string;
  maxNodes?: number;
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
  const id = normalizeChangeId(input.id);
  const contract = newChangeContract({
    id,
    statement: input.statement,
    lifecycle: input.draft === true ? "draft" : "active",
    provenance: "agent",
    serves: input.serves ?? [],
    preserves: input.preserves ?? [],
    requiresEvidence: input.requires ?? [],
    openUnknowns: input.unknowns ?? [],
    links: input.links ?? [],
    tags: input.tags ?? [],
    file: `.semctx/semantic/changes/${id}.sem`,
  });
  ensureSemanticGitignore(root);
  writeChangeFile(root, contract);
  writeActiveChange(root, contract);
  return contract;
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
  const id = normalizeChangeId(input.id);
  const { model } = loadModelWithWorking(root);
  const existing = model.changes.find((c) => c.id === id);
  if (existing === undefined) throw new Error(`no change contract "${id}" (open it first with semctx_change_open)`);
  const updated = applyChangePatch(existing, {
    ...(input.statement !== undefined ? { statement: input.statement } : {}),
    ...(input.status !== undefined ? { lifecycle: input.status } : {}),
    provenance: "agent",
    addServes: input.addServes ?? [],
    addPreserves: input.addPreserves ?? [],
    addRequires: input.addRequires ?? [],
    addUnknowns: input.addUnknowns ?? [],
    resolveUnknowns: input.resolveUnknowns ?? [],
    addLinks: input.addLinks ?? [],
    addTags: input.addTags ?? [],
  });
  writeChangeFile(root, updated);
  if (loadActiveChange(root)?.id === id) writeActiveChange(root, updated);
  return updated;
}

/** semctx_change_verify: compose verify diff with a change contract → VERIFIED/PARTIAL/BLOCKED/STALE. */
export function changeVerifyTool(root: string, input: { changeId: string; gitDiff?: string }): ChangeVerifyReport {
  const id = normalizeChangeId(input.changeId);
  const { model } = loadModelWithWorking(root);
  const contract = model.changes.find((c) => c.id === id);
  if (contract === undefined) throw new Error(`no change contract "${id}" (open it first with semctx_change_open)`);

  // facts() ensures the workspace is initialised + indexed before we read the config.
  const { facts: repoFacts, index } = facts(root);
  const config = loadConfig(root);
  const diffText = input.gitDiff !== undefined && input.gitDiff.trim().length > 0 ? input.gitDiff : currentGitDiff(root);
  const result = analyzeDiff({ index, claims: repoFacts.claims, config, diffText });
  const git: VerifyReportGitMeta = { base: null, head: "(mcp)", mergeBase: null, range: null };
  const verifyReport: VerifyReport = buildVerifyReport(result, git, config.blockingRules);

  return verifyChangeContract({ contract, model, facts: repoFacts, verifyReport, policy: resolveSemanticPolicy(config) });
}

/** semctx_semantic_inspect: resolve a semantic id, its incoming references and link resolution. */
export function semanticInspectTool(root: string, input: { id: string }): SemanticInspection {
  const { model } = loadModelWithWorking(root);
  return inspectSemantic(model, input.id, facts(root).facts);
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
export function changeCloseTool(root: string, input: { id: string; superseded?: boolean }): ChangeContract {
  const id = normalizeChangeId(input.id);
  const { model } = loadModelWithWorking(root);
  const change = model.changes.find((c) => c.id === id);
  if (change === undefined) throw new Error(`no change contract "${id}"`);
  const closed: ChangeContract = { ...change, lifecycle: input.superseded === true ? "superseded" : "verified" };
  writeChangeFile(root, closed);
  if (loadActiveChange(root)?.id === id) clearActiveChange(root);
  return closed;
}

function currentGitDiff(root: string): string {
  const proc = Bun.spawnSync(["git", "diff", "HEAD", "--relative", "--unified=0", "--no-color"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return proc.exitCode === 0 ? new TextDecoder().decode(proc.stdout) : "";
}
