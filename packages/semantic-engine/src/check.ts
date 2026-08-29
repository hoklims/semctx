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
  "DURABLE_ANCHOR_IS_TRANSIENT",
  "DEPRECATED_SYMBOL_ANCHOR",
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

/**
 * A durable intent anchored on a coordinate that is only meant to be durable for one change.
 *
 * `sym:` names a declaration as it exists today. A goal, an invariant or a decision outlives any
 * particular declaration, so anchoring one on `sym:` guarantees a future false staleness the author
 * will read as a real break. `inv:`, `cap:` and `contract:` are named by the author and survive a
 * rewrite. A `change` or an `evidence` record is short-lived by construction and keeps `sym:`.
 *
 * This is a warning, not an error: the anchor still resolves, and turning it into an error would
 * make every pre-existing model unverifiable at once.
 */
export interface AnchorDoctrineFinding {
  code: "DURABLE_ANCHOR_IS_TRANSIENT" | "DEPRECATED_SYMBOL_ANCHOR";
  severity: "warning";
  ownerId: string;
  ownerKind: string;
  ref: string;
  message: string;
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
  /** Additive: consumers that predate the anchor doctrine ignore this field. */
  anchorFindings: AnchorDoctrineFinding[];
  graphIndexed: boolean;
  counts: { nodes: number; changes: number; errors: number; warnings: number };
}

/** Node kinds whose intent is meant to outlive any single declaration. */
const DURABLE_INTENT_KINDS: ReadonlySet<string> = new Set(["goal", "invariant", "decision"]);

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
  const linkReport = graphIndexed && facts !== undefined ? resolveRepositoryLinks(model, facts) : undefined;
  const staleLinks = linkReport?.staleLinks ?? [];
  const anchorFindings = collectAnchorFindings(model, linkReport?.legacyAnchors ?? []);

  const diagnosticErrors = diagnostics.filter((d) => d.severity === "error").length;
  const lifecycleErrors = lifecycleFindings.filter((finding) => finding.severity === "error").length;
  const lifecycleWarnings = lifecycleFindings.filter((finding) => finding.severity === "warning").length;
  const warnings = diagnostics.filter((d) => d.severity === "warning").length
    + lifecycleWarnings
    + anchorFindings.length;
  const reasonSet = new Set<SemanticCheckReasonCode>();
  if (diagnosticErrors > 0) reasonSet.add("SEMANTIC_DSL_INVALID");
  if (duplicateIds.length > 0) reasonSet.add("DUPLICATE_SEMANTIC_ID");
  if (invalidIds.length > 0) reasonSet.add("INVALID_SEMANTIC_ID");
  if (danglingReferences.length > 0) reasonSet.add("DANGLING_SEMANTIC_REFERENCE");
  if (staleLinks.length > 0) reasonSet.add("STALE_REPOSITORY_LINK");
  for (const finding of anchorFindings) reasonSet.add(finding.code);
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
    anchorFindings,
    graphIndexed,
    counts: { nodes: model.nodes.length, changes: model.changes.length, errors, warnings },
  };
}

/**
 * Doctrine is applied to the model, not to the index: a durable goal anchored on `sym:` is wrong
 * whether or not that symbol currently resolves. The deprecation finding is the opposite — it needs
 * the index, because only resolution knows an anchor survived on the legacy form.
 */
function collectAnchorFindings(
  model: SemanticModel,
  legacyAnchors: readonly LinkResolution[],
): AnchorDoctrineFinding[] {
  const findings: AnchorDoctrineFinding[] = [];
  for (const node of model.nodes) {
    if (!DURABLE_INTENT_KINDS.has(node.kind)) continue;
    for (const link of node.repositoryLinks) {
      if (link.kind !== "symbol") continue;
      findings.push({
        code: "DURABLE_ANCHOR_IS_TRANSIENT",
        severity: "warning",
        ownerId: node.id,
        ownerKind: node.kind,
        ref: link.ref,
        message: `${node.kind} "${node.id}" anchors on a symbol coordinate (${link.ref}); durable intent should anchor on inv:, cap: or contract:`,
      });
    }
  }
  for (const anchor of legacyAnchors) {
    findings.push({
      code: "DEPRECATED_SYMBOL_ANCHOR",
      severity: "warning",
      ownerId: anchor.ownerId,
      ownerKind: "link",
      ref: anchor.link.ref,
      message: `"${anchor.ownerId}" resolves only through the deprecated line-bearing anchor ${anchor.link.ref}; run 'semctx migrate anchors'`,
    });
  }
  return findings.sort(
    (left, right) =>
      reasonRank(left.code) - reasonRank(right.code)
      || compareIds(left.ownerId, right.ownerId)
      || compareIds(left.ref, right.ref),
  );
}

function reasonRank(code: SemanticCheckReasonCode): number {
  return SEMANTIC_CHECK_REASON_ORDER.indexOf(code);
}
