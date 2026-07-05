/** Aggregate model integrity for `semctx semantic check`: DSL diagnostics + refs + stale links. */

import { compareIds } from "@semantic-context/core";
import { isValidSemanticId } from "@semantic-context/semantic-model";
import type { SemanticModel } from "@semantic-context/semantic-model";
import type { Diagnostic } from "@semantic-context/semantic-dsl";
import { hasErrors } from "@semantic-context/semantic-dsl";
import type { RepositoryFacts, LinkResolution, DanglingReference } from "./links";
import { resolveRepositoryLinks, findDanglingReferences } from "./links";

export interface InvalidId {
  id: string;
  kind: string;
}

export interface CheckReport {
  ok: boolean;
  diagnostics: Diagnostic[];
  duplicateIds: string[];
  invalidIds: InvalidId[];
  danglingReferences: DanglingReference[];
  staleLinks: LinkResolution[];
  graphIndexed: boolean;
  counts: { nodes: number; changes: number; errors: number; warnings: number };
}

export interface CheckArgs {
  model: SemanticModel;
  diagnostics: Diagnostic[];
  duplicateIds: string[];
  facts?: RepositoryFacts | undefined;
  graphIndexed: boolean;
}

export function checkSemanticModel(args: CheckArgs): CheckReport {
  const { model, diagnostics, duplicateIds, facts, graphIndexed } = args;

  const invalidIds: InvalidId[] = [];
  for (const node of model.nodes) if (!isValidSemanticId(node.kind, node.id)) invalidIds.push({ id: node.id, kind: node.kind });
  for (const change of model.changes) if (!isValidSemanticId("change", change.id)) invalidIds.push({ id: change.id, kind: "change" });
  invalidIds.sort((a, b) => compareIds(a.id, b.id));

  const danglingReferences = findDanglingReferences(model);
  const staleLinks = graphIndexed && facts !== undefined ? resolveRepositoryLinks(model, facts).staleLinks : [];

  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.filter((d) => d.severity === "warning").length;
  const ok =
    !hasErrors(diagnostics) &&
    duplicateIds.length === 0 &&
    invalidIds.length === 0 &&
    danglingReferences.length === 0 &&
    staleLinks.length === 0;

  return {
    ok,
    diagnostics,
    duplicateIds,
    invalidIds,
    danglingReferences,
    staleLinks,
    graphIndexed,
    counts: { nodes: model.nodes.length, changes: model.changes.length, errors, warnings },
  };
}
