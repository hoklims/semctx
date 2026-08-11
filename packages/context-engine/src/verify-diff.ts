import { normalizePath, compareIds, SemctxError, tierOf } from "@semantic-context/core";
import { normalizeObservedDiffPath } from "@semantic-context/control-model/reconciliation";
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
  VerifyReportSymbol,
} from "@semantic-context/core";
import { GraphIndex } from "./graph-index";
import type { CoChange } from "./co-change";

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
  impactedConsumers: ImpactedConsumers[];
}

/** An impacted exported symbol and the in-repo nodes that depend on it. */
export interface ImpactedConsumers {
  symbol: RepositoryNode;
  consumers: RepositoryNode[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const RENAME_PATH_RE = /^rename (from|to) (.+)$/u;
const UNIFIED_DIFF_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z| [+-]\d{4})?$/u;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const utf8Encoder = new TextEncoder();

function decodeGitPath(raw: string): string {
  if (!raw.startsWith("\"")) return raw;
  if (!raw.endsWith("\"") || raw.length < 2) {
    throw new SemctxError("INVALID_TASK_INPUT", "unterminated quoted Git path");
  }
  const bytes: number[] = [];
  const body = raw.slice(1, -1);
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!;
    if (character !== "\\") {
      const codePoint = body.codePointAt(index)!;
      const literal = String.fromCodePoint(codePoint);
      bytes.push(...utf8Encoder.encode(literal));
      if (literal.length === 2) index += 1;
      continue;
    }
    const escaped = body[++index];
    if (escaped === undefined) {
      throw new SemctxError("INVALID_TASK_INPUT", "invalid quoted Git path escape");
    }
    if (/[0-7]/u.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/u.test(body[index + 1] ?? "")) {
        octal += body[++index];
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    const simple: Record<string, number> = {
      a: 0x07,
      b: 0x08,
      t: 0x09,
      n: 0x0a,
      v: 0x0b,
      f: 0x0c,
      r: 0x0d,
      "\"": 0x22,
      "\\": 0x5c,
    };
    const value = simple[escaped];
    if (value === undefined) {
      throw new SemctxError("INVALID_TASK_INPUT", "unsupported quoted Git path escape", {
        escape: escaped,
      });
    }
    bytes.push(value);
  }
  try {
    return utf8Decoder.decode(Uint8Array.from(bytes));
  } catch {
    throw new SemctxError("INVALID_TASK_INPUT", "quoted Git path is not valid UTF-8");
  }
}

function stripFileHeaderMetadata(raw: string): string {
  let pathEnd = raw.indexOf("\t");
  if (raw.startsWith("\"")) {
    pathEnd = -1;
    for (let index = 1; index < raw.length; index += 1) {
      if (raw[index] === "\\") {
        index += 1;
        continue;
      }
      if (raw[index] === "\"") {
        pathEnd = index + 1;
        break;
      }
    }
    if (pathEnd === -1) return raw;
  }
  if (pathEnd === -1) return raw;
  const metadata = raw.slice(pathEnd);
  if (metadata.length === 0) return raw.slice(0, pathEnd);
  if (!metadata.startsWith("\t") || !UNIFIED_DIFF_TIMESTAMP_RE.test(metadata.slice(1))) {
    throw new SemctxError(
      "INVALID_TASK_INPUT",
      "invalid unified diff file header metadata",
      { metadata },
    );
  }
  return raw.slice(0, pathEnd);
}

function parseFileHeaderPath(
  line: string,
  marker: "--- " | "+++ ",
  side: "a/" | "b/",
): { matched: boolean; path?: string } {
  if (!line.startsWith(marker)) return { matched: false };
  const rawWithMetadata = line.slice(marker.length);
  const expectedPrefix = rawWithMetadata.startsWith(side)
    || rawWithMetadata.startsWith(`"${side}`)
    || rawWithMetadata === "/dev/null"
    || rawWithMetadata.startsWith("/dev/null\t");
  if (!expectedPrefix) return { matched: false };
  const raw = stripFileHeaderMetadata(rawWithMetadata);
  if (raw === "/dev/null") return { matched: true };
  const decoded = decodeGitPath(raw);
  if (!decoded.startsWith(side)) {
    throw new SemctxError("INVALID_TASK_INPUT", "Git diff file header has the wrong side prefix");
  }
  return {
    matched: true,
    path: normalizeObservedDiffPath(decoded.slice(side.length)),
  };
}

interface ActiveDiffHunk {
  oldLines: number;
  newLines: number;
  oldConsumed: number;
  newConsumed: number;
}

interface ParsedUnifiedDiff {
  scopePaths: string[];
  files: DiffFile[];
}

function hunkIsComplete(hunk: ActiveDiffHunk): boolean {
  return hunk.oldConsumed >= hunk.oldLines && hunk.newConsumed >= hunk.newLines;
}

/**
 * Parse scope paths and changed-file hunks in one stateful pass. File metadata is
 * recognized only outside an active hunk, so source lines that resemble `---` /
 * `+++` headers cannot invent scope. Explicit Git blocks that never expose a
 * canonical header or rename are rejected instead of silently becoming no-op diffs.
 */
function parseUnifiedDiffStructure(diffText: string): ParsedUnifiedDiff {
  const paths = new Set<string>();
  const files: DiffFile[] = [];
  let pendingOldHeader: { path?: string } | undefined;
  let current: DiffFile | undefined;
  let activeHunk: ActiveDiffHunk | undefined;
  let pendingRenameFrom: string | undefined;
  let sawFileOrHunkMarker = false;
  let explicitBlockOpen = false;
  let explicitBlockHasCanonicalPath = false;

  const addScopePath = (path: string | undefined): void => {
    if (path === undefined) return;
    paths.add(path);
    if (explicitBlockOpen) explicitBlockHasCanonicalPath = true;
  };

  const assertExplicitBlockScoped = (): void => {
    if (explicitBlockOpen && !explicitBlockHasCanonicalPath) {
      throw new SemctxError(
        "INVALID_TASK_INPUT",
        "unified diff block has no canonical paths",
      );
    }
  };

  const failInvalidFileHeader = (): never => {
    throw new SemctxError(
      "INVALID_TASK_INPUT",
      "invalid or unpaired unified diff file header",
    );
  };

  const failInvalidRename = (): never => {
    throw new SemctxError(
      "INVALID_TASK_INPUT",
      "invalid or unpaired unified diff rename metadata",
    );
  };

  for (const line of diffText.split(/\r?\n/u)) {
    if (activeHunk !== undefined && hunkIsComplete(activeHunk)) {
      activeHunk = undefined;
    }
    if (activeHunk !== undefined) {
      if (line === "\\ No newline at end of file") continue;
      const prefix = line[0];
      if (prefix === " ") {
        activeHunk.oldConsumed += 1;
        activeHunk.newConsumed += 1;
        continue;
      }
      if (prefix === "-") {
        activeHunk.oldConsumed += 1;
        continue;
      }
      if (prefix === "+") {
        activeHunk.newConsumed += 1;
        continue;
      }
      // A truncated synthetic hunk may be followed by a new structural marker.
      // End the hunk and process that marker below; real Git hunks reach their
      // declared counters before this branch.
      activeHunk = undefined;
    }

    if (pendingOldHeader !== undefined) {
      const newHeader = parseFileHeaderPath(line, "+++ ", "b/");
      if (newHeader.matched) {
        addScopePath(pendingOldHeader.path);
        addScopePath(newHeader.path);
        current = newHeader.path === undefined
          ? undefined
          : { filePath: normalizePath(newHeader.path), hunks: [], wholeFile: false };
        if (current !== undefined) files.push(current);
        pendingOldHeader = undefined;
        sawFileOrHunkMarker = true;
        continue;
      }
      failInvalidFileHeader();
    }

    if (line.startsWith("diff --git ")) {
      if (pendingRenameFrom !== undefined) failInvalidRename();
      assertExplicitBlockScoped();
      explicitBlockOpen = true;
      explicitBlockHasCanonicalPath = false;
      current = undefined;
      sawFileOrHunkMarker = true;
      continue;
    }

    const renameMatch = RENAME_PATH_RE.exec(line);
    if (renameMatch?.[1] !== undefined && renameMatch[2] !== undefined) {
      if (!explicitBlockOpen) failInvalidRename();
      const renamePath = normalizeObservedDiffPath(decodeGitPath(renameMatch[2]));
      if (renameMatch[1] === "from") {
        if (pendingRenameFrom !== undefined) failInvalidRename();
        pendingRenameFrom = renamePath;
      } else {
        if (pendingRenameFrom === undefined) failInvalidRename();
        addScopePath(pendingRenameFrom);
        addScopePath(renamePath);
        pendingRenameFrom = undefined;
      }
      current = undefined;
      sawFileOrHunkMarker = true;
      continue;
    }

    const oldHeader = parseFileHeaderPath(line, "--- ", "a/");
    if (oldHeader.matched) {
      pendingOldHeader = { path: oldHeader.path };
      current = undefined;
      sawFileOrHunkMarker = true;
      continue;
    }

    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      failInvalidFileHeader();
    }
    if (line.startsWith("@@")) {
      sawFileOrHunkMarker = true;
    }
    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch !== null) {
      const oldStart = Number(hunkMatch[1] ?? "0");
      const oldLines = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
      const newStart = Number(hunkMatch[3] ?? "0");
      const newLines = hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]);
      if (current !== undefined) {
        current.hunks.push({ oldStart, oldLines, newStart, newLines });
      }
      activeHunk = {
        oldLines,
        newLines,
        oldConsumed: 0,
        newConsumed: 0,
      };
    }
  }

  if (pendingOldHeader !== undefined) failInvalidFileHeader();
  if (pendingRenameFrom !== undefined) failInvalidRename();
  assertExplicitBlockScoped();
  if (paths.size === 0 && sawFileOrHunkMarker && diffText.trim().length > 0) {
    throw new SemctxError(
      "INVALID_TASK_INPUT",
      "unified diff contains file or hunk markers but no canonical paths",
    );
  }
  return {
    scopePaths: [...paths].sort(),
    files,
  };
}

/** Every old/new path named by a unified diff, including deletions and pure renames. */
export function parseUnifiedDiffScopePaths(diffText: string): string[] {
  return parseUnifiedDiffStructure(diffText).scopePaths;
}

/**
 * Parse a unified git diff into changed files and BOTH old-side and new-side line ranges.
 * Scope and hunk parsing share the same state machine so the analysis and its
 * health preflight cannot disagree about which file headers are structural.
 */
export function parseUnifiedDiff(diffText: string): DiffFile[] {
  return parseUnifiedDiffStructure(diffText).files;
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

/**
 * For each impacted EXPORTED symbol, the in-repo nodes that depend on it. Two edge kinds are
 * followed, both structurally derived (no LLM): `calls` gives symbol-level callers, and `imports`
 * on the declaring module gives file-level importers. A symbol with no in-repo consumer is omitted.
 */
export function computeImpactedConsumers(
  index: GraphIndex,
  impactedNodes: readonly RepositoryNode[],
): ImpactedConsumers[] {
  const out: ImpactedConsumers[] = [];
  for (const node of impactedNodes) {
    if (node.exported !== true) continue;
    const consumerIds = new Set<string>();
    for (const e of index.inEdges(node.id, ["calls"])) consumerIds.add(e.from);
    for (const decl of index.inEdges(node.id, ["declares"])) {
      for (const imp of index.inEdges(decl.from, ["imports"])) consumerIds.add(imp.from);
    }
    consumerIds.delete(node.id);
    const consumers = [...consumerIds]
      .map((id) => index.node(id))
      .filter((n): n is RepositoryNode => n !== undefined)
      .sort((a, b) => compareIds(a.id, b.id));
    if (consumers.length === 0) continue;
    out.push({ symbol: node, consumers });
  }
  return out.sort((a, b) => compareIds(a.symbol.id, b.symbol.id));
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
    // Both are raised by app-services preflights over the whole analysis, not by a config rule over
    // impacted nodes, so neither can ever be selected here.
    analysis_scope_incomplete: [],
    index_binding_stale: [],
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
    impactedConsumers: computeImpactedConsumers(index, impactedNodes),
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
    case "analysis_scope_incomplete":
      return `changed scope lacks complete admissible analysis: ${names}`;
    case "index_binding_stale":
      return "impact was computed against an index bound to a different source state";
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
  coChanges: readonly CoChange[] = [],
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

  const toReportSymbol = (n: RepositoryNode): VerifyReportSymbol =>
    n.filePath === undefined
      ? { id: n.id, name: n.name, kind: n.kind }
      : { id: n.id, name: n.name, kind: n.kind, file: n.filePath };
  const impactedConsumers = result.impactedConsumers.map((c) => ({
    symbol: toReportSymbol(c.symbol),
    consumers: c.consumers.map(toReportSymbol),
  }));

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
    ...(impactedConsumers.length > 0 ? { impactedConsumers } : {}),
    ...(coChanges.length > 0
      ? {
          coChangedFiles: coChanges.map((c) => ({
            file: c.file,
            coChanged: c.coChanged.map((x) => ({ file: x.file, commits: x.commits })),
          })),
        }
      : {}),
    summary: {
      blockCount: findings.filter((f) => f.severity === "block").length,
      warnCount: findings.filter((f) => f.severity === "warn").length,
    },
  };
}
