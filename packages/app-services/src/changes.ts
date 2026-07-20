import { SemctxError } from "@semantic-context/core";
import { loadConfig } from "@semantic-context/repository-store";
import {
  applyChangePatch,
  assertUnknownResolutionsProven,
  clearActiveChange,
  ensureSemanticGitignore,
  loadActiveChange,
  loadModelWithWorking,
  newChangeContract,
  resolveSemanticPolicy,
  verifyChangeContract,
  writeActiveChange,
  writeChangeFile,
  type ChangeVerifyReport,
  type RepositoryFacts,
} from "@semantic-context/semantic-engine";
import {
  isValidSemanticId,
  kindOfSemanticId,
  semanticId,
  type ChangeContract,
  type ChangeLifecycle,
  type SemanticProvenance,
} from "@semantic-context/semantic-model";
import { runVerify, type VerifySource } from "./verify";
import { openReadyRepository } from "./readiness";

export interface OpenChangeCommand {
  id: string;
  statement: string;
  provenance: SemanticProvenance;
  lifecycle?: "draft" | "active";
  serves?: string[];
  preserves?: string[];
  requiresEvidence?: string[];
  openUnknowns?: string[];
  links?: string[];
  tags?: string[];
}

export interface UpdateChangeCommand {
  id: string;
  provenance: SemanticProvenance;
  statement?: string;
  lifecycle?: ChangeLifecycle;
  addServes?: string[];
  addPreserves?: string[];
  addRequires?: string[];
  addUnknowns?: string[];
  resolveUnknowns?: string[];
  addLinks?: string[];
  addTags?: string[];
}

export function normalizeChangeId(id: string): string {
  const normalized = kindOfSemanticId(id) === undefined ? semanticId("change", id) : id;
  if (!isValidSemanticId("change", normalized)) {
    throw new SemctxError("INVALID_TASK_INPUT", `invalid change id: ${id}`);
  }
  return normalized;
}

function requireChange(root: string, rawId: string): { id: string; change: ChangeContract; model: ReturnType<typeof loadModelWithWorking>["model"] } {
  const id = normalizeChangeId(rawId);
  const { model } = loadModelWithWorking(root);
  const change = model.changes.find((candidate) => candidate.id === id);
  if (change === undefined) throw new SemctxError("INVALID_TASK_INPUT", `no change contract "${id}"`);
  return { id, change, model };
}

function repositoryFacts(root: string): RepositoryFacts {
  const store = openReadyRepository(root);
  try {
    return { graph: store.loadGraph(), claims: store.loadClaims(), evidence: store.loadEvidence() };
  } finally {
    store.close();
  }
}

export function openChange(root: string, command: OpenChangeCommand): ChangeContract {
  const id = normalizeChangeId(command.id);
  const contract = newChangeContract({
    id,
    statement: command.statement,
    lifecycle: command.lifecycle ?? "active",
    provenance: command.provenance,
    serves: command.serves ?? [],
    preserves: command.preserves ?? [],
    requiresEvidence: command.requiresEvidence ?? [],
    openUnknowns: command.openUnknowns ?? [],
    links: command.links ?? [],
    tags: command.tags ?? [],
    file: `.semctx/semantic/changes/${id}.sem`,
  });
  ensureSemanticGitignore(root);
  writeChangeFile(root, contract);
  writeActiveChange(root, contract);
  return contract;
}

export function updateChange(root: string, command: UpdateChangeCommand): ChangeContract {
  const { id, change, model } = requireChange(root, command.id);
  if (command.lifecycle === "verified") {
    throw new SemctxError(
      "INVALID_TASK_INPUT",
      "verified is proof-derived; use 'semctx change close' or use semctx_change_close after composed verification passes",
    );
  }
  assertUnknownResolutionsProven(model, command.resolveUnknowns ?? []);
  const updated = applyChangePatch(change, {
    ...(command.statement !== undefined ? { statement: command.statement } : {}),
    ...(command.lifecycle !== undefined ? { lifecycle: command.lifecycle } : {}),
    provenance: command.provenance,
    addServes: command.addServes ?? [],
    addPreserves: command.addPreserves ?? [],
    addRequires: command.addRequires ?? [],
    addUnknowns: command.addUnknowns ?? [],
    resolveUnknowns: command.resolveUnknowns ?? [],
    addLinks: command.addLinks ?? [],
    addTags: command.addTags ?? [],
  });
  writeChangeFile(root, updated);
  if (loadActiveChange(root)?.id === id) writeActiveChange(root, updated);
  return updated;
}

export function verifyAuthoredChange(root: string, rawId: string, source: VerifySource): ChangeVerifyReport {
  const { change, model } = requireChange(root, rawId);
  const underlying = runVerify(root, source).report;
  return verifyChangeContract({
    contract: change,
    model,
    facts: repositoryFacts(root),
    verifyReport: underlying,
    policy: resolveSemanticPolicy(loadConfig(root)),
  });
}

export function closeChange(root: string, command: { id: string; superseded?: boolean; source?: VerifySource }): ChangeContract {
  const { id, change } = requireChange(root, command.id);
  const lifecycle: ChangeLifecycle = command.superseded === true ? "superseded" : "verified";
  if (lifecycle === "verified") {
    const report = verifyAuthoredChange(root, id, command.source ?? { kind: "working-tree" });
    if (report.verdict !== "VERIFIED") {
      throw new SemctxError("INVALID_TASK_INPUT", `cannot close "${id}" as verified: composed verification is ${report.verdict}`, {
        changeId: id,
        verdict: report.verdict,
      });
    }
  }
  const closed = { ...change, lifecycle };
  writeChangeFile(root, closed);
  if (loadActiveChange(root)?.id === id) clearActiveChange(root);
  return closed;
}
