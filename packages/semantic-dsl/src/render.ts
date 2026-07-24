/**
 * Human-facing rendering of semantic nodes — a *view*, never the canonical form. Symbols
 * (◇ □ ⊳ Δ ⊢ ? ⊥ ≈ →) are decorative: an ASCII projection is always available and no glyph is ever
 * required to parse, compile or query. Deterministic (relations/links sorted by code unit).
 */

import { compareIds } from "@semantic-context/core";
import { repositoryLinkToRef } from "@semantic-context/semantic-model";
import type { SemanticModel, SemanticNode, ChangeContract, SemanticNodeKind } from "@semantic-context/semantic-model";

export type Notation = "symbols" | "ascii";

const GLYPH: Record<SemanticNodeKind, string> = {
  goal: "◇", // ◇
  invariant: "□", // □
  decision: "⊳", // ⊳
  assumption: "~",
  unknown: "?",
  change: "Δ", // Δ
  evidence: "⊢", // ⊢
};

const ASCII_LABEL: Record<SemanticNodeKind, string> = {
  goal: "[goal]",
  invariant: "[invariant]",
  decision: "[decision]",
  assumption: "[assumption]",
  unknown: "[unknown]",
  change: "[change]",
  evidence: "[evidence]",
};

const UNKNOWN_GLYPH = "?";
const ARROW = (n: Notation): string => (n === "symbols" ? "→" : "->"); // →

function head(kind: SemanticNodeKind, id: string, status: string, n: Notation): string {
  return n === "symbols" ? `${GLYPH[kind]} ${id}  [${status}]` : `${ASCII_LABEL[kind]} ${id} (${status})`;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort(compareIds);
}

export function renderNode(node: SemanticNode, notation: Notation): string {
  const lines: string[] = [head(node.kind, node.id, node.status, notation)];
  const label = node.kind === "invariant" ? "rule" : "statement";
  lines.push(`  ${label}: ${node.statement}`);
  const rels = [...node.relations].sort((a, b) => compareIds(a.kind, b.kind) || compareIds(a.to, b.to));
  for (const rel of rels) lines.push(`  ${ARROW(notation)} ${rel.kind} ${rel.to}`);
  for (const ref of sorted(node.repositoryLinks.map(repositoryLinkToRef))) lines.push(`  ${notation === "symbols" ? "↳" : "->"} link ${ref}`);
  if (node.tags.length > 0) lines.push(`  # ${sorted(node.tags).join(", ")}`);
  return lines.join("\n");
}

export function renderChange(change: ChangeContract, notation: Notation): string {
  const lines: string[] = [head("change", change.id, change.lifecycle, notation)];
  lines.push(`  statement: ${change.statement}`);
  if (change.targetBinding !== undefined) {
    lines.push(`  target ${change.targetBinding.targetId} ${change.targetBinding.revision} ${change.targetBinding.artifactHash}`);
  }
  for (const to of sorted(change.serves)) lines.push(`  ${ARROW(notation)} serves ${to}`);
  for (const to of sorted(change.preserves)) lines.push(`  ${ARROW(notation)} preserves ${to}`);
  for (const to of sorted(change.requiresEvidence)) lines.push(`  ${ARROW(notation)} requires_evidence ${to}`);
  for (const to of sorted(change.openUnknowns)) lines.push(`  ${UNKNOWN_GLYPH} ${to}`);
  for (const ref of sorted(change.repositoryLinks.map(repositoryLinkToRef))) lines.push(`  ${notation === "symbols" ? "↳" : "->"} link ${ref}`);
  if (change.tags.length > 0) lines.push(`  # ${sorted(change.tags).join(", ")}`);
  return lines.join("\n");
}

/** Render a whole model (truth nodes then change contracts), deterministically ordered. */
export function renderModel(model: SemanticModel, notation: Notation): string {
  const blocks: string[] = [];
  for (const node of [...model.nodes].sort((a, b) => compareIds(a.id, b.id))) blocks.push(renderNode(node, notation));
  for (const change of [...model.changes].sort((a, b) => compareIds(a.id, b.id))) blocks.push(renderChange(change, notation));
  return blocks.join("\n\n");
}
