/**
 * Deterministic, idempotent formatter for the `.sem` DSL. Canonical output: fixed field order,
 * repeated-key multi-value form (most diff-friendly), relation targets sorted by code unit. A round
 * trip `format(parse(format(x))) === format(x)` holds for any well-formed model.
 */

import { compareIds } from "@semantic-context/core";
import { SEMANTIC_RELATION_KINDS, repositoryLinkToRef } from "@semantic-context/semantic-model";
import type { SemanticModel, SemanticNode, ChangeContract, SemanticRelationKind } from "@semantic-context/semantic-model";

const INDENT = "  ";

function sorted(values: readonly string[]): string[] {
  return [...values].sort(compareIds);
}

function line(key: string, value: string): string {
  return `${INDENT}${key}: ${value}`;
}

function commonTail(node: SemanticNode | ChangeContract): string[] {
  const out: string[] = [];
  for (const ref of sorted(node.repositoryLinks.map(repositoryLinkToRef))) out.push(line("link", ref));
  for (const tag of sorted(node.tags)) out.push(line("tag", tag));
  const meta = node.metadata ?? {};
  for (const key of Object.keys(meta).sort(compareIds)) out.push(line("meta", `${key}=${meta[key] ?? ""}`));
  return out;
}

export function formatNode(node: SemanticNode): string {
  const lines: string[] = [`${node.kind} ${node.id}`];
  lines.push(line("statement", node.statement));
  lines.push(line("status", node.status));
  lines.push(line("provenance", node.provenance));
  const byKind = new Map<SemanticRelationKind, string[]>();
  for (const rel of node.relations) {
    const list = byKind.get(rel.kind);
    if (list === undefined) byKind.set(rel.kind, [rel.to]);
    else if (!list.includes(rel.to)) list.push(rel.to);
  }
  for (const kind of SEMANTIC_RELATION_KINDS) {
    const targets = byKind.get(kind);
    if (targets === undefined) continue;
    for (const to of sorted(targets)) lines.push(line(kind, to));
  }
  lines.push(...commonTail(node));
  return lines.join("\n");
}

export function formatChange(change: ChangeContract): string {
  const lines: string[] = [`change ${change.id}`];
  lines.push(line("statement", change.statement));
  lines.push(line("status", change.lifecycle));
  lines.push(line("provenance", change.provenance));
  for (const to of sorted(change.serves)) lines.push(line("serves", to));
  for (const to of sorted(change.preserves)) lines.push(line("preserves", to));
  for (const to of sorted(change.requiresEvidence)) lines.push(line("requires_evidence", to));
  for (const to of sorted(change.openUnknowns)) lines.push(line("unknown", to));
  lines.push(...commonTail(change));
  return lines.join("\n");
}

/** Format a whole model into one canonical `.sem` document (truth nodes then change contracts). */
export function formatModel(model: SemanticModel): string {
  const blocks: string[] = [];
  for (const node of [...model.nodes].sort((a, b) => compareIds(a.id, b.id))) blocks.push(formatNode(node));
  for (const change of [...model.changes].sort((a, b) => compareIds(a.id, b.id))) blocks.push(formatChange(change));
  return blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n`;
}
