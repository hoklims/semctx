import { readFileSync } from "node:fs";
import { SemctxError, type VerifyReport } from "@semantic-context/core";
import { loadConfig } from "@semantic-context/repository-store";
import { discoverRepository, isPathSelected } from "@semantic-context/ts-analyzer";
import {
  GraphIndex,
  analyzeDiff,
  buildVerifyReport,
  computeCoChanges,
  parseUnifiedDiffScopePaths,
  parseNameStatusLog,
  type CoChange,
  type VerifyReportGitMeta,
  type VerifyResult,
} from "@semantic-context/context-engine";
import { openReadyRepository } from "./readiness";
import { indexHealth, type IndexHealthReportV1 } from "./index-health";
import { controlStatus } from "./control";
import {
  readUnresolvedReferenceBinding,
  type UnresolvedReferenceBindingReason,
} from "./unresolved-references";
import { CONTROL_INDEX_SNAPSHOT_META_KEY, parseIndexedControlSnapshot } from "./freshness";
import type { ControlFreshnessReason } from "@semantic-context/control-model";

/**
 * `head` names the commit the analysed post-image belongs to. It is optional everywhere and means
 * different things by kind: for the Git-backed kinds it selects and labels the ref (default `HEAD`),
 * and semctx itself computes the diff against the resolved object id, so the attribution is proved
 * by construction. For `file` and `provided` it is a caller *assertion* about hunks semctx did not
 * compute: it labels the source and is checked against the indexed commit, but it never demonstrates
 * that the analysed content came from that commit. Those sources stay diagnostic either way.
 */
export type VerifySource =
  | { kind: "working-tree"; head?: string }
  | { kind: "staged"; head?: string }
  | { kind: "range"; base: string; head?: string }
  | { kind: "file"; path: string; head?: string }
  | { kind: "provided"; diffText: string; head?: string };

export interface VerifyComputation {
  result: VerifyResult;
  report: VerifyReport;
  git: VerifyReportGitMeta;
  coChanges: CoChange[];
}

/**
 * Provenance of the analysed post-image, and how it was obtained.
 *
 * `commits` carries resolved object ids, never refs: an OID cannot be moved under the analysis, so
 * the commit that selected the hunks is the same commit the gate compares the index against. More
 * than one entry means the caller named a head that is not the one the diff was taken against,
 * which is itself a coordinate break — no index can be bound to both. Only semctx's own `git diff`
 * produces this kind, which is what makes the attribution a proof rather than a claim.
 *
 * `declared` carries the same resolved object ids for a diff semctx did *not* compute. Resolving the
 * ref proves the ref exists; it proves nothing about where the analysed bytes came from. A caller
 * can name any commit alongside any post-image, so this kind is diagnostic and never authorizes.
 *
 * `absent` is a diff semctx did not compute and the caller did not attribute (`--from-file` or MCP
 * text with no `--head`). Nothing ties those hunks to any repository state, so no conclusion drawn
 * from them can authorize either.
 */
type SourceIdentity =
  | { kind: "absent" }
  | { kind: "declared"; commits: readonly string[] }
  | { kind: "commits"; commits: readonly string[] };

const ABSENT_IDENTITY: SourceIdentity = { kind: "absent" };

interface ResolvedVerifySource {
  diffText: string | null;
  git: VerifyReportGitMeta;
  includeCoChanges: boolean;
  identity: SourceIdentity;
  /** Frozen object id the co-change history is walked from; refs are never re-read after capture. */
  coChangeHead: string | null;
}

type VerifyCaptureBarrier = () => void;

let verifyCaptureBarrierForTesting: VerifyCaptureBarrier | undefined;

/**
 * Internal deterministic injection point between ref resolution and hunk capture. Intentionally
 * absent from the package root exports so production consumers cannot depend on test orchestration.
 */
export function __setVerifyCaptureBarrierForTesting(barrier: VerifyCaptureBarrier | undefined): void {
  verifyCaptureBarrierForTesting = barrier;
}

function crossVerifyCaptureBarrier(): void {
  const barrier = verifyCaptureBarrierForTesting;
  verifyCaptureBarrierForTesting = undefined;
  barrier?.();
}

function git(root: string, args: string[]): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return {
    code: proc.exitCode ?? 1,
    out: new TextDecoder().decode(proc.stdout),
    err: new TextDecoder().decode(proc.stderr),
  };
}

function validateRef(ref: string, role: "base" | "head"): void {
  if (ref.startsWith("-")) {
    throw new SemctxError("GIT_ERROR", `invalid ${role} ref "${ref}": refs must not start with "-"`, { [role]: ref });
  }
}

function requireRef(root: string, ref: string, role: "base" | "head"): string {
  validateRef(ref, role);
  const resolved = git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`, "--"]);
  if (resolved.code === 0) return resolved.out.trim();
  if (role === "base") {
    throw new SemctxError(
      "GIT_BASE_UNAVAILABLE",
      `base ref "${ref}" is not available locally. In CI, check out with full history (fetch-depth: 0); semctx never fetches implicitly.`,
      { base: ref },
    );
  }
  throw new SemctxError("GIT_ERROR", `head ref "${ref}" does not exist locally.`, { head: ref });
}

/** Identity a caller attributed to a diff semctx did not compute. Declared or nothing: defaulting it
 *  to `HEAD` would manufacture a provenance the caller never claimed. The ref is still resolved, so
 *  an unresolvable head fails loudly and a wrong one is still named as a coordinate break — but the
 *  result is `declared`, because resolving a ref cannot show that these hunks came from it. */
function declaredIdentity(root: string, head: string | undefined): SourceIdentity {
  if (head === undefined) return ABSENT_IDENTITY;
  return { kind: "declared", commits: [requireRef(root, head, "head")] };
}

function resolveSource(root: string, source: VerifySource, dryRun: boolean): ResolvedVerifySource {
  if (source.kind === "provided") {
    const identity = declaredIdentity(root, source.head);
    return {
      diffText: dryRun ? null : source.diffText,
      git: {
        base: null,
        head: identity.kind === "declared" ? identity.commits[0]! : "(provided)",
        mergeBase: null,
        range: null,
      },
      includeCoChanges: false,
      identity,
      coChangeHead: null,
    };
  }
  if (source.kind === "file") {
    const identity = declaredIdentity(root, source.head);
    return {
      diffText: dryRun ? null : readFileSync(source.path, "utf8"),
      git: {
        base: null,
        head: identity.kind === "declared" ? identity.commits[0]! : "(from-file)",
        mergeBase: null,
        range: null,
      },
      includeCoChanges: false,
      identity,
      coChangeHead: null,
    };
  }
  const head = source.head ?? "HEAD";
  validateRef(head, "head");
  if (source.kind === "range") {
    // Resolve both endpoints to object ids first, then compute merge-base and diff from those ids
    // alone. A branch that moves after this point cannot re-associate the hunks with another commit.
    const baseSha = requireRef(root, source.base, "base");
    const headSha = requireRef(root, head, "head");
    const meta = (mergeBase: string): VerifyReportGitMeta => ({
      base: source.base,
      head,
      mergeBase,
      range: `${mergeBase.slice(0, 12)}..${headSha.slice(0, 12)}`,
    });
    const identity: SourceIdentity = { kind: "commits", commits: [headSha] };
    crossVerifyCaptureBarrier();
    const merge = git(root, ["merge-base", "--", baseSha, headSha]);
    if (merge.code !== 0 || merge.out.trim() === "") {
      throw new SemctxError("GIT_ERROR", `could not compute a merge-base between "${source.base}" and "${head}"`, { stderr: merge.err.trim() });
    }
    const mergeBase = merge.out.trim();
    if (dryRun) return { diffText: null, git: meta(mergeBase), includeCoChanges: true, identity, coChangeHead: headSha };
    const diff = git(root, ["diff", "--relative", "--unified=0", "--no-color", mergeBase, headSha, "--"]);
    if (diff.code !== 0) throw new SemctxError("GIT_ERROR", "git diff failed", { stderr: diff.err.trim() });
    return { diffText: diff.out, git: meta(mergeBase), includeCoChanges: true, identity, coChangeHead: headSha };
  }
  const meta: VerifyReportGitMeta = { base: null, head, mergeBase: null, range: null };
  if (dryRun) {
    // A dry run computes no hunks, so it freezes nothing — but a head the caller named and Git
    // cannot resolve is still an error the caller must see before planning around it.
    if (source.head !== undefined) requireRef(root, source.head, "head");
    return { diffText: null, git: meta, includeCoChanges: true, identity: ABSENT_IDENTITY, coChangeHead: null };
  }
  // Freeze the anchors *before* capturing hunks. `git diff [--staged] <oid>` then measures the
  // working tree or index against that exact commit rather than against whatever `HEAD` points at
  // by the time the process reaches the diff.
  const headSha = requireRef(root, head, "head");
  const checkedOutSha = requireRef(root, "HEAD", "head");
  crossVerifyCaptureBarrier();
  const args = source.kind === "staged"
    ? ["diff", "--staged", "--relative", "--unified=0", "--no-color", headSha, "--"]
    : ["diff", "--relative", "--unified=0", "--no-color", headSha, "--"];
  const diff = git(root, args);
  if (diff.code !== 0) throw new SemctxError("GIT_ERROR", "git diff failed (is this a git repository?)", { stderr: diff.err.trim() });
  // The checked-out commit is load-bearing too: the working tree it materialized is the post-image.
  // A caller naming a different head has already broken the coordinate system it reports against.
  const identity: SourceIdentity = { kind: "commits", commits: [...new Set([headSha, checkedOutSha])] };
  return { diffText: diff.out, git: meta, includeCoChanges: true, identity, coChangeHead: headSha };
}

function historicalCoChanges(root: string, files: readonly string[], head: string): CoChange[] {
  if (files.length === 0) return [];
  const log = git(root, ["log", "--no-merges", "--name-status", "--find-renames", "--format=%x1e", "-n", "400", head, "--"]);
  return log.code === 0 ? computeCoChanges(parseNameStatusLog(log.out), files) : [];
}

export function planVerify(root: string, source: VerifySource): VerifyReportGitMeta {
  return resolveSource(root, source, true).git;
}

function applyAnalysisHealthPreflight(
  result: VerifyResult,
  changedScopePaths: readonly string[],
  health: IndexHealthReportV1,
  currentCandidates: ReturnType<typeof discoverRepository>["candidates"],
  isCurrentlySelected: (path: string) => boolean,
): VerifyResult {
  const persistedByPath = new Map(health.candidates.map((candidate) => [candidate.path, candidate]));
  const evaluationsByCandidate = new Map<string, typeof health.evaluations.decisions>();
  for (const decision of health.evaluations.decisions) {
    const group = evaluationsByCandidate.get(decision.candidateIdentity) ?? [];
    evaluationsByCandidate.set(decision.candidateIdentity, [...group, decision]);
  }
  const currentByPath = new Map(currentCandidates.map((candidate) => [candidate.relPath, candidate]));
  const blockingPaths: string[] = [];
  const partialNegativePaths: string[] = [];

  for (const path of changedScopePaths) {
    const persisted = persistedByPath.get(path);
    const current = currentByPath.get(path);
    const selectedNow =
      current?.selectionDecision === "selected"
      || (current === undefined && isCurrentlySelected(path));
    const wasSelected = persisted?.selectionDecision === "selected";
    if (!selectedNow && !wasSelected) continue;
    const evaluations = persisted === undefined
      ? []
      : evaluationsByCandidate.get(persisted.candidateIdentity) ?? [];
    const hasLoadBearingGateFailure =
      evaluations.length === 0
      || evaluations.some((decision) =>
        decision.decisionKind === "pre_subject"
        || decision.gates.discoveryAndScope === "failed"
        || decision.gates.bindingAndIntegrity === "failed"
        || decision.gates.currentFreshness === "failed"
        || decision.gates.capabilityMatch === "failed"
        || decision.gates.taskRelativeAuthority === "failed");

    if (
      health.binding.status !== "valid"
      || !health.freshness.canRunHighRiskControl
      || persisted === undefined
      || persisted.analysisOutcome !== "analyzed"
      || hasLoadBearingGateFailure
    ) {
      blockingPaths.push(path);
      continue;
    }
    if (
      evaluations.some((decision) =>
        decision.decisionKind === "exact_subject"
        && decision.gates.negativeCompleteness === "failed")
      || !persisted.negativeEvidenceEligible
      || persisted.analysisReasons.length > 0
    ) {
      partialNegativePaths.push(path);
    }
  }

  const findings = [...result.findings];
  const unknowns = [...result.unknowns];
  const nodeIdsFor = (paths: readonly string[]): string[] => {
    const selected = new Set(paths);
    return result.impactedNodes
      .filter((node) => node.filePath !== undefined && selected.has(node.filePath))
      .map((node) => node.id);
  };

  if (blockingPaths.length > 0) {
    const paths = [...new Set(blockingPaths)].sort();
    findings.push({
      rule: "analysis_scope_incomplete",
      severity: "block",
      message: `selected changed scope lacks a current admissible analyzer: ${paths.join(", ")}`,
      nodeIds: nodeIdsFor(paths),
    });
    unknowns.push(
      `Analysis is insufficient for selected changed scope: ${paths.join(", ")}. Re-index after resolving disabled, unsupported, failed, stale, or invalid binding state.`,
    );
  }
  if (partialNegativePaths.length > 0) {
    const paths = [...new Set(partialNegativePaths)].sort();
    findings.push({
      rule: "analysis_scope_incomplete",
      severity: "warn",
      message: `Plane-A analysis is partial for negative impact/test conclusions: ${paths.join(", ")}`,
      nodeIds: nodeIdsFor(paths),
    });
    unknowns.push(
      `No complete negative reference, dependency, test-link, or impact conclusion is available for: ${paths.join(", ")}.`,
    );
  }

  return {
    ...result,
    verdict: findings.some((finding) => finding.severity === "block")
      ? "BLOCK"
      : findings.some((finding) => finding.severity === "warn")
        ? "WARN"
        : "PASS",
    findings,
    unknowns: [...new Set(unknowns)],
  };
}

/** A reason the index binding could not be proven. Local to this gate: it extends the public
 *  freshness vocabulary with the source-identity break only `verify` can observe, without widening
 *  `ControlFreshnessReason`, which is a published enum with its own ordering contract. */
type IndexBindingBreak =
  | ControlFreshnessReason
  | "SOURCE_IDENTITY_ABSENT"
  | "SOURCE_IDENTITY_UNPROVEN"
  | "ANALYZED_COMMIT_MISMATCH"
  | "FRESHNESS_PROBE_FAILED"
  | `UNRESOLVED_REFERENCE_${UnresolvedReferenceBindingReason}`;

/**
 * Admissibility of every freshness reason for an impact conclusion. Impacted nodes are a join
 * between line ranges frozen at indexing time (`nodeLineRange` over stored evidence) and hunks
 * measured against the analysed source, so a reason is admissible only when it provably leaves both
 * sides of that join intact.
 *
 * Exhaustive by type, and that is the point: a new `ControlFreshnessReason` is a compile error here
 * rather than a silently authorizing verdict. `breaking` is the default a reader should assume —
 * every `admissible` entry carries the argument that earns it.
 */
const INDEX_BINDING_ADMISSIBILITY: Readonly<Record<ControlFreshnessReason, "admissible" | "breaking">> = {
  // No binding proof exists at all. Repairable by `semctx index`, so blocking cannot deadlock.
  REPOSITORY_NOT_INITIALIZED: "breaking",
  REPOSITORY_NOT_INDEXED: "breaking",
  INDEX_SNAPSHOT_MISSING: "breaking",
  INDEX_SNAPSHOT_INVALID: "breaking",
  STORE_SCHEMA_UNAVAILABLE: "breaking",
  // The binding exists and contradicts the source being analysed.
  REPOSITORY_ROOT_MISMATCH: "breaking",
  HEAD_MISMATCH: "breaking",
  REPOSITORY_GRAPH_MISMATCH: "breaking",
  STORE_SCHEMA_MISMATCH: "breaking",
  // No commit was captured on either side, so nothing states which source state the stored line
  // ranges belong to. A repository semctx cannot place in Git history is a repository whose impact
  // conclusions have no anchor, and an unanchored conclusion never authorizes.
  GIT_STATE_UNAVAILABLE: "breaking",
  // Analysing an uncommitted diff is the normal case: the working tree differing from the indexed
  // state is what `verify diff` exists to measure, not a coordinate break.
  WORKING_DIFF_MISMATCH: "admissible",
  WORKING_TREE_DIRTY: "admissible",
  ANALYSIS_INPUT_MISMATCH: "admissible",
  // Authored Plane-B state. It leaves every Plane-A line range intact, and blocking would refuse
  // the very `verify diff --record` that repairs a stale evidence baseline while `semctx index`
  // refuses to run against one — the two would deadlock.
  SEMANTIC_MODEL_INVALID: "admissible",
  SEMANTIC_LIFECYCLE_INVALID: "admissible",
  SEMANTIC_MODEL_MISMATCH: "admissible",
  // Same tool, different build metadata: no stored line range moves.
  TOOL_VERSION_MISMATCH: "admissible",
};

function withUnknown(result: VerifyResult, unknown: string): VerifyResult {
  return { ...result, unknowns: [...new Set([...result.unknowns, unknown])] };
}

function refuseImpact(result: VerifyResult, breaks: readonly IndexBindingBreak[]): VerifyResult {
  const reasons = [...new Set(breaks)].join(", ");
  return {
    ...result,
    verdict: "BLOCK",
    findings: [
      ...result.findings,
      {
        rule: "index_binding_stale",
        severity: "block",
        message: `impact was computed against an index bound to a different source state: ${reasons}`,
        nodeIds: [],
      },
    ],
    unknowns: [...new Set([
      ...result.unknowns,
      `No impact conclusion holds while the index binding is broken (${reasons}). Re-run \`semctx index\`, then verify again.`,
    ])],
  };
}

/**
 * Refuse an impact verdict computed against an index that is not provably bound to the exact source
 * the diff was taken from. Fail-closed in both directions: an unproven binding blocks, and the
 * commit carrying the coordinates must be the commit the diff was analysed against.
 */
function applyIndexBindingGate(
  root: string,
  store: ReturnType<typeof openReadyRepository>,
  result: VerifyResult,
  identity: SourceIdentity,
): VerifyResult {
  const breaks: IndexBindingBreak[] = [];
  // A diff nobody attributed to a commit cannot be joined with line ranges frozen at one. This is
  // checked before the freshness probe so it stands on its own: a perfectly FRESH index still
  // proves nothing about hunks that belong to no known source state.
  if (identity.kind === "absent") breaks.push("SOURCE_IDENTITY_ABSENT");
  // A caller-declared head is an assertion about hunks semctx did not compute, so it is exactly as
  // strong as the caller. Naming the indexed commit alongside an arbitrary post-image would
  // otherwise satisfy every check below and certify a join the caller alone vouched for.
  if (identity.kind === "declared") breaks.push("SOURCE_IDENTITY_UNPROVEN");

  // Independent of the freshness probe on purpose: the record's tie to the index it describes is a
  // property of the store, and it must fail closed even if the probe itself is healthy.
  const registry = readUnresolvedReferenceBinding(store);
  if (registry.status === "unbound") breaks.push(`UNRESOLVED_REFERENCE_${registry.reason}`);

  // Read the indexed commit from the persisted snapshot rather than from the freshness seal. The
  // seal is withheld whenever any input is unsealed — including reasons this gate deliberately
  // admits — while the commit the index was built at is a stored fact that survives all of them.
  // `HEAD_MISMATCH` still covers drift of the checked-out HEAD through the freshness path.
  let indexedCommit: string | null | undefined;
  try {
    indexedCommit = parseIndexedControlSnapshot(store.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY))?.headCommit;
  } catch {
    indexedCommit = undefined;
  }
  // Applied to a declared identity too: a caller who also names the wrong commit gets that named
  // separately, so the two failures stay distinguishable and neither hides the other.
  if (
    identity.kind !== "absent"
    && (
      indexedCommit === undefined
      || indexedCommit === null
      || identity.commits.some((commit) => commit !== indexedCommit)
    )
  ) {
    breaks.push("ANALYZED_COMMIT_MISMATCH");
  }

  let freshness;
  try {
    freshness = controlStatus(root);
  } catch {
    // The probe annotates the verification rather than driving it, so it must not throw through —
    // but a binding that cannot be probed is a binding that is not proven, and an unproven binding
    // never authorizes an impact conclusion.
    return refuseImpact(result, [...breaks, "FRESHNESS_PROBE_FAILED"]);
  }

  breaks.push(
    ...freshness.reasons.filter((reason) => INDEX_BINDING_ADMISSIBILITY[reason] === "breaking"),
  );
  if (breaks.length > 0) return refuseImpact(result, breaks);

  if (!freshness.canRunHighRiskControl) {
    const detail = freshness.reasons.length > 0 ? `${freshness.verdict}: ${freshness.reasons.join(", ")}` : freshness.verdict;
    return withUnknown(result, `Could not confirm index binding (${detail}); impact is reported without a freshness proof.`);
  }
  return result;
}

/**
 * Re-read the indexed record of authored references that named an absent target. The gap was
 * observed while building the index this verdict is drawn from, so it belongs in the verdict: an
 * index that cannot say whether such a gap exists is itself an unknown, not a clean bill.
 */
function discloseUnresolvedReferences(
  store: ReturnType<typeof openReadyRepository>,
  result: VerifyResult,
): VerifyResult {
  const recorded = readUnresolvedReferenceBinding(store);
  if (recorded.status === "unbound") {
    return withUnknown(
      result,
      `This index's authored reference record is not bound to it (${recorded.reason}); whether an authored reference names an absent target is unknown. Re-run \`semctx index\`.`,
    );
  }
  if (recorded.references.length === 0) return result;
  const named = recorded.references
    .map((reference) => `${reference.from} -(${reference.kind})-> ${reference.missing}`)
    .join("; ");
  return withUnknown(
    result,
    `Authored references name targets this repository does not contain: ${named}.`,
  );
}

/** Shared CLI/MCP verification use case. Always returns the ADR-0008 report. */
export function runVerify(root: string, source: VerifySource): VerifyComputation {
  const store = openReadyRepository(root);
  try {
    const config = loadConfig(root);
    const resolved = resolveSource(root, source, false);
    const baseResult = analyzeDiff({
      index: new GraphIndex(store.loadGraph()),
      claims: store.loadClaims(),
      config,
      diffText: resolved.diffText ?? "",
    });
    const changedScopePaths = parseUnifiedDiffScopePaths(resolved.diffText ?? "");
    // Unconditional: the analysis-health preflight below only runs for `config.version === 2`, so a
    // v1 repository would otherwise carry no index-binding proof at all.
    const gated = discloseUnresolvedReferences(
      store,
      applyIndexBindingGate(root, store, baseResult, resolved.identity),
    );
    const result = config.version === 2
      ? applyAnalysisHealthPreflight(
          gated,
          changedScopePaths,
          indexHealth(root),
          discoverRepository(config).candidates,
          (path) => isPathSelected(config, path),
        )
      : gated;
    const coChanges = resolved.includeCoChanges && resolved.coChangeHead !== null
      ? historicalCoChanges(root, result.changedFiles, resolved.coChangeHead)
      : [];
    return { result, report: buildVerifyReport(result, resolved.git, config.blockingRules, coChanges), git: resolved.git, coChanges };
  } finally {
    store.close();
  }
}
