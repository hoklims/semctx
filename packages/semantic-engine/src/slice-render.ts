/** Render a `SemanticSlice` as a compact, deterministic capsule (agent/ascii/symbols text). */

import { repositoryLinkToRef } from "@semantic-context/semantic-model";
import type { SemanticNode } from "@semantic-context/semantic-model";
import type { SemanticSlice } from "./slice";

export type SliceNotation = "symbols" | "ascii";

const GLYPH: Record<string, string> = { goal: "◇", invariant: "□", decision: "⊳", assumption: "~", unknown: "?", evidence: "⊢", change: "Δ" };

function bullet(node: SemanticNode, notation: SliceNotation): string {
  const glyph = notation === "symbols" ? `${GLYPH[node.kind] ?? "-"} ` : "";
  const links = node.repositoryLinks.length > 0 ? `  (links: ${node.repositoryLinks.map(repositoryLinkToRef).join(", ")})` : "";
  return `  - ${glyph}${node.id} — ${node.statement} [${node.status}]${links}`;
}

function section(title: string, lines: string[]): string[] {
  if (lines.length === 0) return [`## ${title}`, "  (none)"];
  return [`## ${title}`, ...lines];
}

export function renderSlice(slice: SemanticSlice, notation: SliceNotation = "symbols"): string {
  const scopeParts: string[] = [];
  if (slice.scope.changeId !== undefined) scopeParts.push(`change=${slice.scope.changeId}`);
  if (slice.scope.symbolRef !== undefined) scopeParts.push(`symbol=${slice.scope.symbolRef}`);
  if (slice.scope.claimRef !== undefined) scopeParts.push(`claim=${slice.scope.claimRef}`);
  scopeParts.push(`maxNodes=${slice.scope.maxNodes}`);

  const out: string[] = [];
  out.push(`# Semantic slice — scope: ${scopeParts.join(", ") || "(empty)"}  (truncated: ${slice.truncated ? "yes" : "no"})`);
  out.push("");

  out.push(...section("Intentions", slice.intentions.map((n) => bullet(n, notation))));
  out.push(...section("Invariants", slice.invariants.map((n) => bullet(n, notation))));
  out.push(...section("Relevant decisions", slice.decisions.map((n) => bullet(n, notation))));
  out.push(...section("Active assumptions", slice.assumptions.map((n) => bullet(n, notation))));
  out.push(
    ...section(
      "Change contracts",
      slice.changes.map((c) => `  - ${notation === "symbols" ? "Δ " : ""}${c.id} — ${c.statement} [${c.lifecycle}]`),
    ),
  );
  out.push(...section("Linked symbols & claims", slice.linkedRepository.map((l) => `  - ${l.kind} ${repositoryLinkToRef(l)}`)));
  out.push(...section("Evidence obtained", slice.evidence.map((n) => bullet(n, notation))));
  out.push(...section("Open unknowns", slice.openUnknowns.map((n) => bullet(n, notation))));
  out.push(...section("Forbidden / safety constraints", slice.safetyConstraints.map((n) => bullet(n, notation))));
  out.push(...section("Next expected proofs", slice.nextProofs.map((id) => `  - ${id}`)));

  return out.join("\n");
}
