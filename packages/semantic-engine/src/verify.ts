/**
 * Composed change verification (Plane A ∘ Plane B). Reuses the existing `verify diff` report
 * verbatim and folds in the authored change contract: preserved invariants, required evidence, open
 * unknowns, stale links. The verdict is never more optimistic than the data, and it never turns
 * PARTIAL into VERIFIED on its own — proving evidence requires an explicitly obtained status
 * (semctx stays static; running the test is the dynamic step). See docs/architecture/change-contracts.md.
 */

import { compareIds } from "@semantic-context/core";
import type { VerifyReport, SemanticPolicyConfig } from "@semantic-context/core";
import { GraphIndex } from "@semantic-context/context-engine";
import { SemanticIndex, PROVEN_STATUSES } from "@semantic-context/semantic-model";
import type { SemanticModel, ChangeContract, ChangeLifecycle } from "@semantic-context/semantic-model";
import type { RepositoryFacts } from "./links";
import { resolveRepositoryLinks } from "./links";

export const CHANGE_VERIFY_SCHEMA_VERSION = 1 as const;

export type SemanticVerdict = "VERIFIED" | "PARTIAL" | "BLOCKED" | "STALE";

export type PreservedState = "proved" | "unproven" | "untouched" | "contradicted" | "missing";

export interface PreservedInvariant {
  id: string;
  statement: string;
  critical: boolean;
  state: PreservedState;
  /** Graph ids the invariant maps onto (its footprint in Plane A). */
  footprint: string[];
}

export interface EvidenceState {
  id: string;
  statement: string;
  proved: boolean;
  status: string | "missing";
}

export interface UnknownState {
  id: string;
  statement: string;
  critical: boolean;
  present: boolean;
}

export type SemanticFindingSeverity = "warn" | "block" | "stale";

export type SemanticFindingKind =
  | "underlying_block"
  | "critical_invariant_unproven"
  | "invariant_unproven"
  | "invariant_contradicted"
  | "required_evidence_pending"
  | "open_unknown"
  | "critical_open_unknown"
  | "stale_link"
  | "dangling_reference"
  | "superseded_decision";

export interface SemanticFinding {
  kind: SemanticFindingKind;
  severity: SemanticFindingSeverity;
  message: string;
  refs: string[];
}

export interface ChangeVerifyReport {
  schemaVersion: typeof CHANGE_VERIFY_SCHEMA_VERSION;
  changeId: string;
  lifecycle: ChangeLifecycle;
  verdict: SemanticVerdict;
  underlying: VerifyReport;
  preserved: PreservedInvariant[];
  provedEvidence: EvidenceState[];
  pendingEvidence: EvidenceState[];
  openUnknowns: UnknownState[];
  stale: SemanticFinding[];
  findings: SemanticFinding[];
}

export interface VerifyChangeArgs {
  contract: ChangeContract;
  model: SemanticModel;
  facts: RepositoryFacts;
  verifyReport: VerifyReport;
  policy: SemanticPolicyConfig;
}

/** Map a semantic invariant onto Plane-A graph ids: its direct links plus symbols they constrain. */
function invariantFootprint(linkedRefs: readonly string[], index: GraphIndex): string[] {
  const ids = new Set<string>();
  for (const ref of linkedRefs) {
    if (!index.has(ref)) continue;
    ids.add(ref);
    // A linked repo invariant expands to the symbols it constrains (`constrained_by` edges point sym→inv).
    for (const edge of index.inEdges(ref, ["constrained_by"])) ids.add(edge.from);
  }
  return [...ids].sort(compareIds);
}

function underlyingBlockNodeIds(report: VerifyReport): Set<string> {
  const ids = new Set<string>();
  for (const f of report.findings) if (f.severity === "block") for (const id of f.nodeIds) ids.add(id);
  return ids;
}

function underlyingTouchedIds(report: VerifyReport): Set<string> {
  const ids = new Set<string>(report.changedSymbols.map((s) => s.id));
  for (const f of report.findings) for (const id of f.nodeIds) ids.add(id);
  return ids;
}

function intersects(a: readonly string[], b: ReadonlySet<string>): boolean {
  return a.some((x) => b.has(x));
}

export function verifyChangeContract(args: VerifyChangeArgs): ChangeVerifyReport {
  const { contract, model, facts, verifyReport, policy } = args;
  const semIndex = new SemanticIndex(model);
  const graphIndex = new GraphIndex(facts.graph);
  const criticalTags = new Set(policy.criticalInvariantTags);
  const findings: SemanticFinding[] = [];
  const stale: SemanticFinding[] = [];

  const blockNodeIds = underlyingBlockNodeIds(verifyReport);
  const touchedIds = underlyingTouchedIds(verifyReport);

  // --- underlying verdict
  if (verifyReport.verdict === "BLOCK") {
    findings.push({ kind: "underlying_block", severity: "block", message: `verify diff returned BLOCK (${verifyReport.summary.blockCount} blocking finding(s))`, refs: [] });
  }

  // --- preserved invariants
  const preserved: PreservedInvariant[] = [];
  for (const invId of [...contract.preserves].sort(compareIds)) {
    const node = semIndex.node(invId);
    if (node === undefined || node.kind !== "invariant") {
      preserved.push({ id: invId, statement: "(not declared)", critical: false, state: "missing", footprint: [] });
      const finding: SemanticFinding = { kind: "dangling_reference", severity: "stale", message: `preserved invariant "${invId}" is not declared in the semantic model`, refs: [invId] };
      findings.push(finding);
      stale.push(finding);
      continue;
    }
    const critical = node.tags.some((t) => criticalTags.has(t));
    const footprint = invariantFootprint(node.repositoryLinks.map((l) => l.ref), graphIndex);
    let state: PreservedState;
    if (node.status === "contradicted") {
      state = "contradicted";
      findings.push({ kind: "invariant_contradicted", severity: "block", message: `preserved invariant "${invId}" is marked contradicted`, refs: [invId] });
    } else if (intersects(footprint, blockNodeIds)) {
      state = "unproven";
      if (critical) findings.push({ kind: "critical_invariant_unproven", severity: "block", message: `critical invariant "${invId}" is touched by the change with no covering test`, refs: [invId, ...footprint] });
      else if (policy.requireProofForActiveChange && contract.lifecycle === "active") findings.push({ kind: "invariant_unproven", severity: "warn", message: `invariant "${invId}" is touched with no covering test`, refs: [invId, ...footprint] });
    } else if (intersects(footprint, touchedIds)) {
      state = "proved";
    } else {
      state = "untouched";
    }
    preserved.push({ id: invId, statement: node.statement, critical, state, footprint });
  }

  // --- superseded decisions that justify a preserved invariant
  const preservedSet = new Set(contract.preserves);
  const supersededTargets = new Set<string>();
  for (const n of model.nodes) for (const rel of n.relations) if (rel.kind === "supersedes") supersededTargets.add(rel.to);
  for (const decision of semIndex.nodesOfKind("decision")) {
    const justifiesPreserved = decision.relations.some((r) => r.kind === "justifies" && preservedSet.has(r.to));
    const isSuperseded = supersededTargets.has(decision.id) || decision.status === "contradicted" || decision.status === "stale";
    if (justifiesPreserved && isSuperseded) {
      findings.push({ kind: "superseded_decision", severity: policy.supersededDecisionSeverity === "block" ? "block" : "warn", message: `active change relies on superseded/contradicted decision "${decision.id}"`, refs: [decision.id] });
    }
  }

  // --- required evidence
  const provedEvidence: EvidenceState[] = [];
  const pendingEvidence: EvidenceState[] = [];
  for (const evId of [...contract.requiresEvidence].sort(compareIds)) {
    const node = semIndex.node(evId);
    if (node === undefined) {
      pendingEvidence.push({ id: evId, statement: "(not declared)", proved: false, status: "missing" });
      const finding: SemanticFinding = { kind: "dangling_reference", severity: "stale", message: `required evidence "${evId}" is not declared in the semantic model`, refs: [evId] };
      findings.push(finding);
      stale.push(finding);
      continue;
    }
    const proved = PROVEN_STATUSES.has(node.status);
    const state: EvidenceState = { id: evId, statement: node.statement, proved, status: node.status };
    if (proved) provedEvidence.push(state);
    else {
      pendingEvidence.push(state);
      findings.push({ kind: "required_evidence_pending", severity: "warn", message: `required evidence "${evId}" is not yet proven (status: ${node.status})`, refs: [evId] });
    }
  }

  // --- open unknowns
  const openUnknowns: UnknownState[] = [];
  for (const unkId of [...contract.openUnknowns].sort(compareIds)) {
    const node = semIndex.node(unkId);
    const critical = node !== undefined && node.tags.some((t) => criticalTags.has(t));
    openUnknowns.push({ id: unkId, statement: node?.statement ?? "(not declared)", critical, present: node !== undefined });
    if (critical) findings.push({ kind: "critical_open_unknown", severity: "block", message: `critical unknown "${unkId}" remains open`, refs: [unkId] });
    else findings.push({ kind: "open_unknown", severity: policy.openUnknownSeverity === "block" ? "block" : "warn", message: `open unknown "${unkId}" is unresolved`, refs: [unkId] });
  }

  // --- stale links affecting this change or the nodes it references
  const scopeIds = new Set<string>([contract.id, ...contract.preserves, ...contract.requiresEvidence, ...contract.serves, ...contract.openUnknowns]);
  const linkReport = resolveRepositoryLinks(model, facts);
  for (const s of linkReport.staleLinks) {
    if (!scopeIds.has(s.ownerId)) continue;
    const finding: SemanticFinding = { kind: "stale_link", severity: "stale", message: `link ${s.link.kind} "${s.link.ref}" on "${s.ownerId}" no longer resolves (${s.reason ?? "unresolved"})`, refs: [s.ownerId, s.link.ref] };
    findings.push(finding);
    stale.push(finding);
  }

  const verdict = computeVerdict(findings);

  return {
    schemaVersion: CHANGE_VERIFY_SCHEMA_VERSION,
    changeId: contract.id,
    lifecycle: contract.lifecycle,
    verdict,
    underlying: verifyReport,
    preserved,
    provedEvidence,
    pendingEvidence,
    openUnknowns,
    stale,
    findings: findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || compareIds(a.kind, b.kind)),
  };
}

function severityRank(s: SemanticFindingSeverity): number {
  return s === "block" ? 0 : s === "stale" ? 1 : 2;
}

/** Precedence: BLOCKED > STALE > PARTIAL > VERIFIED. Never optimistic beyond the findings. */
function computeVerdict(findings: readonly SemanticFinding[]): SemanticVerdict {
  if (findings.some((f) => f.severity === "block")) return "BLOCKED";
  if (findings.some((f) => f.severity === "stale")) return "STALE";
  if (findings.some((f) => f.severity === "warn")) return "PARTIAL";
  return "VERIFIED";
}

/** Map a composite semantic verdict onto the change lifecycle it implies. */
export function lifecycleForVerdict(verdict: SemanticVerdict): ChangeLifecycle {
  switch (verdict) {
    case "VERIFIED":
      return "verified";
    case "PARTIAL":
      return "partial";
    case "BLOCKED":
      return "blocked";
    case "STALE":
      return "stale";
  }
}
