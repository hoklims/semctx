/** Change-contract lifecycle helpers (Section 4.4). Pure: transformations return new contracts. */

import { PROVEN_STATUSES, repositoryLinkFromRef } from "@semantic-context/semantic-model";
import type { ChangeContract, ChangeLifecycle, ChangeTargetBindingV1, SemanticModel, SemanticProvenance, RepositoryLink } from "@semantic-context/semantic-model";
import { SemctxError } from "@semantic-context/core";

export interface NewChangeInput {
  id: string;
  statement: string;
  lifecycle?: ChangeLifecycle;
  provenance?: SemanticProvenance;
  serves?: string[];
  preserves?: string[];
  requiresEvidence?: string[];
  openUnknowns?: string[];
  links?: string[];
  tags?: string[];
  file?: string;
  targetBinding?: ChangeTargetBindingV1;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))];
}

function toLinks(refs: readonly string[]): RepositoryLink[] {
  const map = new Map<string, RepositoryLink>();
  for (const ref of refs) {
    const link = repositoryLinkFromRef(ref);
    map.set(`${link.kind}:${link.ref}`, link);
  }
  return [...map.values()];
}

export function newChangeContract(input: NewChangeInput): ChangeContract {
  const change: ChangeContract = {
    id: input.id,
    statement: input.statement,
    lifecycle: input.lifecycle ?? "draft",
    provenance: input.provenance ?? "author",
    sourceRefs: input.file !== undefined ? [{ file: input.file, line: 1 }] : [],
    serves: uniqueStrings(input.serves ?? []),
    preserves: uniqueStrings(input.preserves ?? []),
    requiresEvidence: uniqueStrings(input.requiresEvidence ?? []),
    openUnknowns: uniqueStrings(input.openUnknowns ?? []),
    repositoryLinks: toLinks(input.links ?? []),
    tags: uniqueStrings(input.tags ?? []),
  };
  if (input.targetBinding !== undefined) change.targetBinding = { ...input.targetBinding };
  return change;
}

export interface ChangePatch {
  statement?: string;
  lifecycle?: ChangeLifecycle;
  provenance?: SemanticProvenance;
  addServes?: string[];
  addPreserves?: string[];
  addRequires?: string[];
  addUnknowns?: string[];
  resolveUnknowns?: string[];
  addLinks?: string[];
  addTags?: string[];
  /** Set an authored target binding, or pass null to remove it explicitly. */
  targetBinding?: ChangeTargetBindingV1 | null;
}

function mergeList(current: readonly string[], add?: readonly string[], remove?: readonly string[]): string[] {
  const set = new Set(current);
  for (const value of uniqueStrings(add ?? [])) set.add(value);
  for (const value of remove ?? []) set.delete(value);
  return [...set];
}

/** Apply an additive patch to a change contract, returning a new contract. */
export function applyChangePatch(change: ChangeContract, patch: ChangePatch): ChangeContract {
  const linkMap = new Map<string, RepositoryLink>();
  for (const link of change.repositoryLinks) linkMap.set(`${link.kind}:${link.ref}`, link);
  for (const link of toLinks(patch.addLinks ?? [])) linkMap.set(`${link.kind}:${link.ref}`, link);
  const updated: ChangeContract = {
    ...change,
    statement: patch.statement ?? change.statement,
    lifecycle: patch.lifecycle ?? change.lifecycle,
    provenance: patch.provenance ?? change.provenance,
    serves: mergeList(change.serves, patch.addServes),
    preserves: mergeList(change.preserves, patch.addPreserves),
    requiresEvidence: mergeList(change.requiresEvidence, patch.addRequires),
    openUnknowns: mergeList(change.openUnknowns, patch.addUnknowns, patch.resolveUnknowns),
    repositoryLinks: [...linkMap.values()],
    tags: mergeList(change.tags, patch.addTags),
  };
  const targetBinding = patch.targetBinding === undefined ? change.targetBinding : patch.targetBinding ?? undefined;
  if (targetBinding === undefined) delete updated.targetBinding;
  else updated.targetBinding = { ...targetBinding };
  return updated;
}

/** Require an auditable proved_by edge before an authored unknown can be removed from a change. */
export function assertUnknownResolutionsProven(model: SemanticModel, unknownIds: readonly string[]): void {
  const nodes = new Map(model.nodes.map((node) => [node.id, node]));
  for (const unknownId of uniqueStrings(unknownIds)) {
    const unknown = nodes.get(unknownId);
    const proven =
      unknown?.kind === "unknown" &&
      unknown.relations.some((relation) => {
        if (relation.kind !== "proved_by") return false;
        const evidence = nodes.get(relation.to);
        return evidence?.kind === "evidence" && PROVEN_STATUSES.has(evidence.status);
      });
    if (!proven) {
      throw new SemctxError(
        "INVALID_TASK_INPUT",
        `cannot resolve unknown "${unknownId}" without a proved_by relation to proved evidence`,
        { unknownId },
      );
    }
  }
}

export const TERMINAL_LIFECYCLES: ReadonlySet<ChangeLifecycle> = new Set<ChangeLifecycle>(["verified", "superseded"]);

export function isTerminalLifecycle(lifecycle: ChangeLifecycle): boolean {
  return TERMINAL_LIFECYCLES.has(lifecycle);
}
