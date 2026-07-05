/** Change-contract lifecycle helpers (Section 4.4). Pure: transformations return new contracts. */

import { repositoryLinkFromRef } from "@semantic-context/semantic-model";
import type { ChangeContract, ChangeLifecycle, SemanticProvenance, RepositoryLink } from "@semantic-context/semantic-model";

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
  return {
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
  return {
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
}

export const TERMINAL_LIFECYCLES: ReadonlySet<ChangeLifecycle> = new Set<ChangeLifecycle>(["verified", "superseded"]);

export function isTerminalLifecycle(lifecycle: ChangeLifecycle): boolean {
  return TERMINAL_LIFECYCLES.has(lifecycle);
}
