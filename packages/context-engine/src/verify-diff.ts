import { normalizePath, compareIds, tierOf } from "@semantic-context/core";
import type {
  SemctxConfig,
  Claim,
  RepositoryNode,
  VerdictLevel,
  BlockingCondition,
  BlockingRule,
  VerifyReport,
  VerifyReportFinding,
  VerifyReportLocation,
} from "@semantic-context/core";
import { GraphIndex } from "./graph-index";

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface DiffFile {
  filePath: string;
  hunks: DiffHunk[];
  /** true when the whole file was added/removed (map the entire file). */
  wholeFile: boolean;
}

export interface VerifyFinding {
  rule: BlockingCondition;
  severity: "warn" | "block";
  message: string;
  nodeIds: string[];
}

export interface VerifyResult {
  verdict: VerdictLevel;
  changedFiles: string[];
  impactedNodes: RepositoryNode[];
  impactedClaims: Claim[];
  impactedInvariants: Claim[];
  impactedContracts: Claim[];
  recommendedTests: RepositoryNode[];
  contradictions: Claim[];
  unknowns: string[];
  findings: VerifyFinding[];
}

const OLD_FILE_RE = /^--- (?:a\/(.+)|\/dev\/null)\s*$/;
const NEW_FILE_RE = /^\+\+\+ (?:b\/(.+)|\/dev\/null)\s*$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified git diff into changed files and BOTH old-side and new-side line ranges.
 * A `+++ b/...` line is only treated as a file header when it immediately follows a
 * `--- a/...` (or `--- /dev/null`) header, so added content that looks like `+++ b/x` is
 * not misparsed as a phantom file.
 */
export function parseUnifiedDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let sawOldHeader = false;
  for (const line of diffText.split(/\r?\n/)) {
    if (OLD_FILE_RE.test(line)) {
      sawOldHeader = true;
      continue;
    }
    const newMatch = NEW_FILE_RE.exec(line);
    if (newMatch !== null && sawOldHeader) {
      sawOldHeader = false;
      const path = newMatch[1];
      if (path === undefined) {
        current = undefined; // +++ /dev/null => file deleted
        continue;
      }
      current = { filePath: normalizePath(path), hunks: [], wholeFile: false };
      files.push(current);
      continue;
    }
    sawOldHeader = false;
    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch !== null && current !== undefined) {
      const oldStart = Number(hunkMatch[1] ?? "0");
      const oldLines = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
      const newStart = Number(hunkMatch[3] ?? "0");
      const newLines = hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]);
      current.hunks.push({ oldStart, oldLines, newStart, newLines });
    }
  }
  return files;
}

function nodeLineRange(node: RepositoryNode): { start: number; end: number } | undefined {
  let start: number | undefined;
  let end: number | undefined;
  for (const ref of node.evidence) {
    if (ref.startLine !== undefined) start = start === undefined ? ref.startLine : Math.min(start, ref.startLine);
    const refEnd = ref.endLine ?? ref.startLine;
    if (refEnd !== undefined) end = end === undefined ? refEnd : Math.max(end, refEnd);
  }
  if (start === undefined) return undefined;
  return { start, end: end ?? start };
}

function hunkTouchesRange(hunk: DiffHunk, range: { start: number; end: number }): boolean {
  // Node line ranges come from HEAD (old-side) evidence, so the old-side window is the
  // primary test — this catches pure deletions (new-side count 0). The new-side window is
  // unioned in to catch modifications and near-insertions.
  const oldEnd = hunk.oldStart + Math.max(hunk.oldLines, 1) - 1;
  const newEnd = hunk.newStart + Math.max(hunk.newLines, 1) - 1;
  const oldOverlap = hunk.oldStart <= range.end && oldEnd >= range.start;
  const newOverlap = hunk.newStart <= range.end && newEnd >= range.start;
  return oldOverlap || newOverlap;
}

function isTested(index: GraphIndex, nodeId: string): boolean {
  return index.outEdges(nodeId, ["tested_by"]).length > 0;
}

/** Analyse a diff against the graph: impacted nodes/claims, tests, verdict. */
export function analyzeDiff(args: {
  index: GraphIndex;
  claims: Claim[];
  config: SemctxConfig;
  diffText: string;
}): VerifyResult {
  const { index, claims, config } = args;
  const diffFiles = parseUnifiedDiff(args.diffText);
  const changedByFile = new Map<string, DiffFile>();
  for (const f of diffFiles) changedByFile.set(f.filePath, f);
  const changedFiles = [...changedByFile.keys()].sort();

  // Impacted nodes: any node in a changed file whose line range overlaps a hunk
  // (or the whole file when the node has no precise range).
  const candidates = impactedCandidates(index, changedFiles);
  const impactedNodeIds = new Set<string>();
  for (const node of candidates) {
    const file = node.filePath !== undefined ? changedByFile.get(node.filePath) : undefined;
    if (file === undefined) continue;
    const range = nodeLineRange(node);
    if (range === undefined || file.hunks.length === 0) {
      impactedNodeIds.add(node.id);
      continue;
    }
    if (file.hunks.some((h) => hunkTouchesRange(h, range))) impactedNodeIds.add(node.id);
  }

  const impactedNodes = [...impactedNodeIds]
    .map((id) => index.node(id))
    .filter((n): n is RepositoryNode => n !== undefined)
    .sort((a, b) => compareIds(a.id, b.id));

  const impactedClaims = claims
    .filter((c) => c.subjectNodeIds.some((id) => impactedNodeIds.has(id)))
    .sort((a, b) => compareIds(a.id, b.id));
  const impactedInvariants = impactedClaims.filter((c) => c.kind === "invariant");
  const impactedContracts = impactedClaims.filter((c) => c.kind === "contract");
  const contradictions = impactedClaims.filter(
    (c) => c.verificationStatus === "deprecated" || c.verificationStatus === "contradicted",
  );

  // Tests covering any symbol in a changed file (file-level test recommendation).
  const testIds = new Set<string>();
  for (const node of candidates) for (const e of index.outEdges(node.id, ["tested_by"])) testIds.add(e.to);
  const recommendedTests = [...testIds]
    .map((id) => index.node(id))
    .filter((n): n is RepositoryNode => n !== undefined && n.kind === "test")
    .sort((a, b) => compareIds(a.id, b.id));

  // Condition evaluators.
  const invariantConstrainedUntested = impactedNodes.filter(
    (n) => index.outEdges(n.id, ["constrained_by"]).length > 0 && !isTested(index, n.id),
  );
  const isExportedContract = (n: RepositoryNode): boolean =>
    (n.kind === "interface" || n.kind === "type") && n.exported === true;
  // A contract is *critical* (strict tier → BLOCK) only when its author tagged it so, via a
  // `critical`/`security` tag. Marker-driven and opt-in — never inferred.
  const isCriticalContract = (n: RepositoryNode): boolean =>
    isExportedContract(n) && (n.tags.includes("critical") || n.tags.includes("security"));
  const criticalContractsUntested = impactedNodes.filter((n) => isCriticalContract(n) && !isTested(index, n.id));
  const contractsUntested = impactedNodes.filter(
    (n) => isExportedContract(n) && !isCriticalContract(n) && !isTested(index, n.id),
  );
  const securityUntested = impactedNodes.filter(
    (n) => (n.tags.includes("security") || index.outEdges(n.id, ["related_to"]).some((e) => index.node(e.to)?.tags.includes("security"))) && !isTested(index, n.id),
  );

  const conditionNodes: Record<BlockingCondition, RepositoryNode[]> = {
    invariant_touched_without_test: invariantConstrainedUntested,
    critical_contract_changed_without_test: criticalContractsUntested,
    contract_changed_without_test: contractsUntested,
    contradiction_unresolved: contradictions.length > 0 ? impactedNodes.filter((n) => n.kind === "document") : [],
    security_surface_without_verification: securityUntested,
  };

  const findings: VerifyFinding[] = [];
  for (const rule of config.blockingRules) {
    const nodes = conditionNodes[rule.when];
    if (nodes.length === 0 && !(rule.when === "contradiction_unresolved" && contradictions.length > 0)) continue;
    findings.push({
      rule: rule.when,
      severity: rule.severity,
      message: describeCondition(rule.when, nodes, contradictions.length),
      nodeIds: nodes.map((n) => n.id),
    });
  }

  const unknowns = buildDiffUnknowns(impactedInvariants, invariantConstrainedUntested, changedFiles, index);

  const verdict: VerdictLevel = findings.some((f) => f.severity === "block")
    ? "BLOCK"
    : findings.some((f) => f.severity === "warn")
      ? "WARN"
      : "PASS";

  return {
    verdict,
    changedFiles,
    impactedNodes,
    impactedClaims,
    impactedInvariants,
    impactedContracts,
    recommendedTests,
    contradictions,
    unknowns,
    findings,
  };
}

function impactedCandidates(index: GraphIndex, changedFiles: readonly string[]): RepositoryNode[] {
  const fileSet = new Set(changedFiles);
  const kinds: RepositoryNode["kind"][] = ["function", "class", "interface", "type", "enum", "module", "test", "document", "migration"];
  const out: RepositoryNode[] = [];
  for (const kind of kinds) for (const node of index.nodesOfKind(kind)) if (node.filePath !== undefined && fileSet.has(node.filePath)) out.push(node);
  return out;
}

function describeCondition(condition: BlockingCondition, nodes: readonly RepositoryNode[], contradictionCount: number): string {
  const names = nodes.map((n) => n.name).join(", ");
  switch (condition) {
    case "invariant_touched_without_test":
      return `invariant-constrained code changed without a covering test: ${names}`;
    case "critical_contract_changed_without_test":
      return `critical exported contract changed without a covering test: ${names}`;
    case "contract_changed_without_test":
      return `exported contract changed without a covering test: ${names}`;
    case "contradiction_unresolved":
      return `change touches ${contradictionCount} unresolved contradiction(s)`;
    case "security_surface_without_verification":
      return `security surface changed without verification: ${names}`;
  }
}

function buildDiffUnknowns(
  impactedInvariants: readonly Claim[],
  untested: readonly RepositoryNode[],
  changedFiles: readonly string[],
  index: GraphIndex,
): string[] {
  const unknowns: string[] = [];
  if (changedFiles.length === 0) unknowns.push("No changes detected in the diff.");
  for (const inv of impactedInvariants) {
    if (inv.verificationStatus !== "tested") unknowns.push(`Impacted invariant is not test-backed: ${inv.statement}`);
  }
  for (const node of untested) {
    const invs = index.outEdges(node.id, ["constrained_by"]).map((e) => index.node(e.to)?.name).filter(Boolean);
    unknowns.push(`"${node.name}" is constrained by [${invs.join(", ")}] but has no test — behaviour under change is unverified.`);
  }
  return [...new Set(unknowns)];
}

const SYMBOL_KINDS: ReadonlySet<RepositoryNode["kind"]> = new Set<RepositoryNode["kind"]>([
  "function",
  "class",
  "interface",
  "type",
  "enum",
]);

export interface VerifyReportGitMeta {
  base: string | null;
  head: string;
  mergeBase: string | null;
  range: string | null;
}

/**
 * Project an internal VerifyResult into the stable, versioned VerifyReport (ADR 0008).
 * This is the single owned boundary between the engine and every external consumer.
 */
export function buildVerifyReport(
  result: VerifyResult,
  git: VerifyReportGitMeta,
  blockingRules: readonly BlockingRule[],
): VerifyReport {
  const tierByRule = new Map<BlockingCondition, "strict" | "advisory">();
  for (const rule of blockingRules) if (!tierByRule.has(rule.when)) tierByRule.set(rule.when, tierOf(rule));

  const nodeById = new Map(result.impactedNodes.map((n) => [n.id, n]));
  const locationsFor = (nodeIds: readonly string[]): VerifyReportLocation[] => {
    const locs: VerifyReportLocation[] = [];
    for (const id of nodeIds) {
      const node = nodeById.get(id);
      if (node?.filePath === undefined) continue;
      const range = nodeLineRange(node);
      locs.push(range === undefined ? { file: node.filePath } : { file: node.filePath, line: range.start });
    }
    return locs;
  };

  const findings: VerifyReportFinding[] = result.findings.map((f) => ({
    rule: f.rule,
    tier: tierByRule.get(f.rule) ?? (f.severity === "block" ? "strict" : "advisory"),
    severity: f.severity,
    message: f.message,
    nodeIds: f.nodeIds,
    locations: locationsFor(f.nodeIds),
  }));

  const claim = (c: Claim) => ({ statement: c.statement, kind: c.kind, verificationStatus: c.verificationStatus });

  return {
    schemaVersion: 1,
    verdict: result.verdict,
    base: git.base,
    head: git.head,
    mergeBase: git.mergeBase,
    range: git.range,
    changedFiles: result.changedFiles,
    changedSymbols: result.impactedNodes
      .filter((n) => SYMBOL_KINDS.has(n.kind))
      .map((n) => (n.filePath === undefined ? { id: n.id, name: n.name, kind: n.kind } : { id: n.id, name: n.name, kind: n.kind, file: n.filePath })),
    impactedContracts: result.impactedContracts.map(claim),
    impactedInvariants: result.impactedInvariants.map(claim),
    recommendedTests: result.recommendedTests.map((t) => (t.filePath === undefined ? { name: t.name } : { name: t.name, file: t.filePath })),
    contradictions: result.contradictions.map(claim),
    unknowns: result.unknowns,
    findings,
    summary: {
      blockCount: findings.filter((f) => f.severity === "block").length,
      warnCount: findings.filter((f) => f.severity === "warn").length,
    },
  };
}
