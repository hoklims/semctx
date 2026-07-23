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

export const SEMANTIC_CHECK_REASON_ORDER = [
  "SEMANTIC_DSL_INVALID",
  "DUPLICATE_SEMANTIC_ID",
  "INVALID_SEMANTIC_ID",
  "DANGLING_SEMANTIC_REFERENCE",
  "STALE_REPOSITORY_LINK",
  "ACTIVE_CHANGE_POINTER_INVALID",
  "ACTIVE_CHANGE_POINTER_MISSING",
  "ACTIVE_CHANGE_POINTER_MISMATCH",
  "ACTIVE_CHANGE_OBSOLETE",
  "EVIDENCE_BASELINE_INVALID",
  "EVIDENCE_BASELINE_STALE",
] as const;

export type SemanticCheckReasonCode = (typeof SEMANTIC_CHECK_REASON_ORDER)[number];

export interface SemanticLifecycleFinding {
  code: Extract<
    SemanticCheckReasonCode,
    | "ACTIVE_CHANGE_POINTER_INVALID"
    | "ACTIVE_CHANGE_POINTER_MISSING"
    | "ACTIVE_CHANGE_POINTER_MISMATCH"
    | "ACTIVE_CHANGE_OBSOLETE"
    | "EVIDENCE_BASELINE_INVALID"
    | "EVIDENCE_BASELINE_STALE"
  >;
  severity: "error" | "warning";
  message: string;
  subjectIds: string[];
}

export interface CheckReport {
  schemaVersion: 1;
  kind: "semantic_check";
  ok: boolean;
  reasonCodes: SemanticCheckReasonCode[];
  diagnostics: Diagnostic[];
  duplicateIds: string[];
  invalidIds: InvalidId[];
  danglingReferences: DanglingReference[];
  staleLinks: LinkResolution[];
  lifecycleFindings: SemanticLifecycleFinding[];
  graphIndexed: boolean;
  counts: { nodes: number; changes: number; errors: number; warnings: number };
}

export interface CheckArgs {
  model: SemanticModel;
  diagnostics: Diagnostic[];
  duplicateIds: string[];
  facts?: RepositoryFacts | undefined;
  graphIndexed: boolean;
  lifecycleFindings?: SemanticLifecycleFinding[];
}

export function checkSemanticModel(args: CheckArgs): CheckReport {
  const { model, diagnostics, duplicateIds, facts, graphIndexed } = args;
  const lifecycleFindings = [...(args.lifecycleFindings ?? [])].sort(
    (a, b) => reasonRank(a.code) - reasonRank(b.code) || compareIds(a.subjectIds.join("\0"), b.subjectIds.join("\0")),
  );

  const invalidIds: InvalidId[] = [];
  for (const node of model.nodes) if (!isValidSemanticId(node.kind, node.id)) invalidIds.push({ id: node.id, kind: node.kind });
  for (const change of model.changes) if (!isValidSemanticId("change", change.id)) invalidIds.push({ id: change.id, kind: "change" });
  invalidIds.sort((a, b) => compareIds(a.id, b.id));

  const danglingReferences = findDanglingReferences(model);
  const staleLinks = graphIndexed && facts !== undefined ? resolveRepositoryLinks(model, facts).staleLinks : [];

  const diagnosticErrors = diagnostics.filter((d) => d.severity === "error").length;
  const lifecycleErrors = lifecycleFindings.filter((finding) => finding.severity === "error").length;
  const lifecycleWarnings = lifecycleFindings.filter((finding) => finding.severity === "warning").length;
  const warnings = diagnostics.filter((d) => d.severity === "warning").length + lifecycleWarnings;
  const reasonSet = new Set<SemanticCheckReasonCode>();
  if (diagnosticErrors > 0) reasonSet.add("SEMANTIC_DSL_INVALID");
  if (duplicateIds.length > 0) reasonSet.add("DUPLICATE_SEMANTIC_ID");
  if (invalidIds.length > 0) reasonSet.add("INVALID_SEMANTIC_ID");
  if (danglingReferences.length > 0) reasonSet.add("DANGLING_SEMANTIC_REFERENCE");
  if (staleLinks.length > 0) reasonSet.add("STALE_REPOSITORY_LINK");
  for (const finding of lifecycleFindings) reasonSet.add(finding.code);
  const reasonCodes = [...reasonSet].sort((a, b) => reasonRank(a) - reasonRank(b));
  const errors = diagnosticErrors
    + duplicateIds.length
    + invalidIds.length
    + danglingReferences.length
    + staleLinks.length
    + lifecycleErrors;
  const ok =
    !hasErrors(diagnostics) &&
    duplicateIds.length === 0 &&
    invalidIds.length === 0 &&
    danglingReferences.length === 0 &&
    staleLinks.length === 0 &&
    lifecycleErrors === 0;

  return {
    schemaVersion: 1,
    kind: "semantic_check",
    ok,
    reasonCodes,
    diagnostics,
    duplicateIds,
    invalidIds,
    danglingReferences,
    staleLinks,
    lifecycleFindings,
    graphIndexed,
    counts: { nodes: model.nodes.length, changes: model.changes.length, errors, warnings },
  };
}

function reasonRank(code: SemanticCheckReasonCode): number {
  return SEMANTIC_CHECK_REASON_ORDER.indexOf(code);
}
