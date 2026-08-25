import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createDefaultConfig,
  createGlobSelectionConfig,
  type SemctxConfig,
} from "@semantic-context/core";
import {
  isInitialized,
  loadConfig,
  saveConfig,
  semctxDir as resolveSemctxDir,
} from "@semantic-context/repository-store";
import {
  initSemanticScaffold,
  loadSemanticModel,
  checkSemanticModel,
  type RepositoryFacts,
} from "@semantic-context/semantic-engine";
import {
  countTypeScriptFiles,
  discoverRepository,
  sourceLanguage,
  type DiscoveryResult,
  type IndexWorkerSelection,
  type TypeScriptParallelism,
} from "@semantic-context/ts-analyzer";
import { indexHealth } from "./index-health";
import { indexRepository, indexRepositoryAsync, type RepositoryIndex } from "./indexing";
import { openReadyRepository } from "./readiness";

/**
 * Bootstrap readiness — namespaced away from Plane C migration `READY`/`BLOCKED`
 * so agents never conflate workspace bootstrap with plan admission / execution authority.
 */
export type SetupVerdict = "SETUP_READY" | "SETUP_NOT_READY" | "SETUP_REFUSED";

/** Progress events for transports that want live phase output (CLI). MCP may ignore. */
export type SetupPhaseEvent =
  | { phase: "config"; detail: "written" | "kept" }
  | { phase: "semantic"; created: number }
  | { phase: "index"; stage: "start"; selectedFiles: number; selectedByLanguage: Record<string, number> }
  | { phase: "index"; stage: "done"; nodes: number; edges: number; claims: number }
  | { phase: "check"; ok: boolean; errors: number }
  | { phase: "analysis"; ready: boolean; coverageStatus?: string };

/** Options for repository bootstrap (CLI + MCP share this path). */
export interface SetupRepositoryOptions {
  /** Prefer a polyglot v2 glob selection when writing a fresh config. */
  polyglot?: boolean;
  /**
   * Capture timestamp for the index seal.
   * Prefer injecting an explicit ISO-8601 value (CLI/MCP) so ambient clock use stays at the transport edge.
   * When omitted, a wall-clock ISO string is used once for this run.
   */
  now?: string;
  /** Optional phase callback (CLI live progress). Never required for correctness. */
  onPhase?: (event: SetupPhaseEvent) => void;
  /** Async setup only: TypeScript worker selection. The synchronous API remains mono-core. */
  workers?: IndexWorkerSelection;
}

export interface SetupRepositoryReport {
  schemaVersion: 1;
  kind: "setup";
  repositoryRoot: string;
  configWritten: boolean;
  /**
   * Absolute path to the `.semctx/` workspace directory (`semctxDir(root)`).
   * Not the config file path — use repository-store `configPath(root)` for `…/config.json`.
   */
  semctxDir: string;
  alreadyInitialized: boolean;
  polyglot: boolean;
  sourceFiles: number;
  selectedFiles: number;
  selection: {
    configVersion: number;
    mode: string;
    selectedByLanguage: Record<string, number>;
    excluded: number;
    disabled: number;
    unsupported: number;
    failed: number;
  };
  nodes: number;
  edges: number;
  claims: number;
  freshnessSeal: unknown;
  /** Operational telemetry only; excluded from the graph and freshness seal. */
  parallelism?: TypeScriptParallelism;
  indexHealth: {
    binding: unknown;
    freshness: unknown;
    coverage: unknown;
    workspaceDiagnostics: readonly unknown[];
    reasonSummary: readonly unknown[];
  };
  semanticFilesCreated: number;
  gitignore: "create" | "update" | "present";
  check: { ok: boolean; nodes: number; changes: number; errors: number };
  setupReady: boolean;
  analysisReady: boolean;
  /** SETUP_READY only when check.ok && analysisReady. Distinct from Plane C READY. */
  verdict: "SETUP_READY" | "SETUP_NOT_READY";
}

/**
 * Domain policy refuse codes (structured success path — not MCP catalogue error codes).
 * Keep MCP tool descriptions and TOOL_OUTPUT_SCHEMAS in lockstep with this union.
 */
export type SetupRefuseReasonCode = "POLYGLOT_REQUIRES_CONFIG_V2";

/** Canonical polyglot-vs-v1 refuse code (shared with MCP metadata). */
export const SETUP_POLYGLOT_V1_REFUSE_REASON_CODE: SetupRefuseReasonCode =
  "POLYGLOT_REQUIRES_CONFIG_V2";

/** Single source of truth for the polyglot-on-non-v2 refusal reason string. */
export const SETUP_POLYGLOT_V1_REFUSE_REASON =
  "polyglot does not overwrite an existing v1 config; migrate .semctx/config.json explicitly to config version 2";

/** Single source of truth for migration guidance on polyglot-on-non-v2 refuse. */
export const SETUP_POLYGLOT_V1_REFUSE_NEXT_STEPS: readonly string[] = [
  "Open .semctx/config.json and migrate to config version 2 (polyglot / glob selection), or remove .semctx/ and re-run setup with polyglot on a fresh workspace",
  "Do not pass polyglot:true against a v1 workspace expecting an in-place overwrite",
  "After migration, re-run setup without expecting config overwrite of authored .sem files",
];

export interface SetupRefusedReport {
  schemaVersion: 1;
  kind: "setup_refused";
  repositoryRoot: string;
  reasonCode: SetupRefuseReasonCode;
  reason: string;
  configVersion: number;
  polyglot: boolean;
  alreadyInitialized: true;
  setupReady: false;
  analysisReady: false;
  verdict: "SETUP_REFUSED";
  /** Safe migration guidance for agents/hosts. */
  nextSteps: string[];
}

export type SetupResult = SetupRepositoryReport | SetupRefusedReport;

/** Inputs for the pure polyglot-vs-config-version policy evaluator. */
export interface EvaluatePolyglotSetupPolicyInput {
  repositoryRoot: string;
  /** Whether the caller requested polyglot v2 glob selection. */
  polyglot: boolean;
  /** Whether `.semctx/` already exists (config will not be overwritten). */
  alreadyInitialized: boolean;
  /**
   * Loaded config version. Required when `alreadyInitialized` is true and policy
   * may refuse; ignored when not initialized or polyglot is off.
   */
  configVersion: number;
}

/**
 * Pure polyglot-vs-config-version policy: owns the predicate and the full
 * `SetupRefusedReport` payload. Transports (CLI, MCP preflight, MCP confirm)
 * must call this instead of reconstructing reason / verdict / nextSteps.
 *
 * Returns `null` when setup may proceed; never performs I/O.
 */
export function evaluatePolyglotSetupPolicy(
  input: EvaluatePolyglotSetupPolicyInput,
): SetupRefusedReport | null {
  if (!input.polyglot || !input.alreadyInitialized) return null;
  if (input.configVersion === 2) return null;
  return buildPolyglotRequiresConfigV2Report(input.repositoryRoot, input.configVersion);
}

/** Inputs for the pure SETUP_READY readiness formula (testable conjuncts). */
export interface ComputeSetupReadinessInput {
  bindingStatus: "valid" | "invalid" | "absent";
  canRunHighRiskControl: boolean;
  coverageStatus: "complete" | "partial" | "insufficient";
  checkOk: boolean;
}

/**
 * Pure agent bootstrap readiness: owns the analysisReady ∧ setupReady ∧ verdict
 * formula used by `setupRepository`. Extracted so each conjunct has a falsifying
 * unit case (integration fixtures couple binding invalid → coverage insufficient).
 */
export function computeSetupReadiness(input: ComputeSetupReadinessInput): {
  analysisReady: boolean;
  setupReady: boolean;
  verdict: "SETUP_READY" | "SETUP_NOT_READY";
} {
  const analysisReady =
    input.bindingStatus === "valid"
    && input.canRunHighRiskControl
    && input.coverageStatus !== "insufficient";
  const setupReady = input.checkOk && analysisReady;
  return {
    analysisReady,
    setupReady,
    verdict: setupReady ? "SETUP_READY" : "SETUP_NOT_READY",
  };
}

/**
 * Construct the complete polyglot-on-non-v2 refusal report.
 * Prefer `evaluatePolyglotSetupPolicy` at call sites; exported for tests/parity.
 */
export function buildPolyglotRequiresConfigV2Report(
  repositoryRoot: string,
  configVersion: number,
): SetupRefusedReport {
  return {
    schemaVersion: 1,
    kind: "setup_refused",
    repositoryRoot,
    reasonCode: SETUP_POLYGLOT_V1_REFUSE_REASON_CODE,
    reason: SETUP_POLYGLOT_V1_REFUSE_REASON,
    configVersion,
    polyglot: true,
    alreadyInitialized: true,
    setupReady: false,
    analysisReady: false,
    verdict: "SETUP_REFUSED",
    nextSteps: [...SETUP_POLYGLOT_V1_REFUSE_NEXT_STEPS],
  };
}

/** Layout-aware default config: monorepos also index package sources. */
function smartConfig(root: string, polyglot: boolean): SemctxConfig {
  if (polyglot) return createGlobSelectionConfig(root);
  const hasPackages = existsSync(join(root, "packages"));
  return {
    ...createDefaultConfig(root),
    include: hasPackages ? ["packages/*/src/**/*.ts", "src/**/*.ts"] : ["src/**/*.ts"],
  };
}

function resolveIndexedAt(now: string | undefined): string {
  if (now !== undefined) return now;
  return new Date().toISOString();
}

interface PreparedSetupRepository {
  kind: "prepared";
  root: string;
  polyglot: boolean;
  onPhase: SetupRepositoryOptions["onPhase"];
  already: boolean;
  configWritten: boolean;
  config: SemctxConfig;
  discovery: DiscoveryResult;
  fileCount: number;
  selectedCount: number;
  selectedByLanguage: Record<string, number>;
  semanticFilesCreated: number;
  gitignore: "create" | "update" | "present";
}

/**
 * One-shot repository bootstrap: config + semantic scaffold + graph index + validation.
 *
 * Idempotent and non-destructive for existing config / authored `.sem` files.
 * Shared by the CLI (`semctx setup`) and the plugin MCP tool (`semctx_setup`) so agents
 * do not need a global package install.
 *
 * Policy refusals (e.g. polyglot on v1 config) return `kind: "setup_refused"` instead of
 * throwing, so transports can fail closed with structured guidance.
 */
export function setupRepository(
  root: string,
  options: SetupRepositoryOptions = {},
): SetupResult {
  const prepared = prepareSetupRepository(root, options);
  if (prepared.kind === "setup_refused") return prepared;
  return completeSetupRepository(prepared, indexRepository(root, resolveIndexedAt(options.now)));
}

/** Async CLI setup path; additive so existing in-process setup callers remain synchronous. */
export async function setupRepositoryAsync(
  root: string,
  options: SetupRepositoryOptions = {},
): Promise<SetupResult> {
  const prepared = prepareSetupRepository(root, options);
  if (prepared.kind === "setup_refused") return prepared;
  const indexed = await indexRepositoryAsync(root, resolveIndexedAt(options.now), options.workers ?? "auto");
  return completeSetupRepository(prepared, indexed);
}

function prepareSetupRepository(
  root: string,
  options: SetupRepositoryOptions,
): PreparedSetupRepository | SetupRefusedReport {
  const polyglot = options.polyglot === true;
  const onPhase = options.onPhase;
  const already = isInitialized(root);
  let configWritten = false;

  if (!already) {
    saveConfig(root, smartConfig(root, polyglot));
    configWritten = true;
  }

  const config = loadConfig(root);
  const refused = evaluatePolyglotSetupPolicy({
    repositoryRoot: root,
    polyglot,
    alreadyInitialized: already,
    configVersion: config.version,
  });
  if (refused !== null) {
    return refused;
  }

  onPhase?.({ phase: "config", detail: configWritten ? "written" : "kept" });

  const scaffold = initSemanticScaffold(root, {});
  const created = scaffold.plan.filter((p) => p.action === "create").length;
  onPhase?.({ phase: "semantic", created });

  const discovery = discoverRepository(config);
  const fileCount = countTypeScriptFiles(config);
  const selectedCount = discovery.files.length;
  const selectedByLanguage = Object.fromEntries(
    ["typescript", "python", "markdown", "sql"].map((language) => [
      language,
      discovery.files.filter(
        (file) => (file.language ?? sourceLanguage(file.relPath)) === language,
      ).length,
    ]),
  );
  onPhase?.({
    phase: "index",
    stage: "start",
    selectedFiles: selectedCount,
    selectedByLanguage,
  });

  return {
    kind: "prepared",
    root,
    polyglot,
    onPhase,
    already,
    configWritten,
    config,
    discovery,
    fileCount,
    selectedCount,
    selectedByLanguage,
    semanticFilesCreated: created,
    gitignore: scaffold.gitignore.action,
  };
}

function completeSetupRepository(
  prepared: PreparedSetupRepository,
  indexed: RepositoryIndex,
): SetupRepositoryReport {
  const {
    root,
    polyglot,
    onPhase,
    already,
    configWritten,
    config,
    discovery,
    fileCount,
    selectedCount,
    selectedByLanguage,
    semanticFilesCreated,
    gitignore,
  } = prepared;
  const { analysis, claims, freshnessSeal, parallelism } = indexed;
  const reader = openReadyRepository(root);
  let facts: RepositoryFacts;
  try {
    facts = {
      graph: reader.loadGraph(),
      claims: reader.loadClaims(),
      evidence: reader.loadEvidence(),
    };
  } finally {
    reader.close();
  }
  onPhase?.({
    phase: "index",
    stage: "done",
    nodes: analysis.graph.nodes.length,
    edges: analysis.graph.edges.length,
    claims: claims.length,
  });

  const loaded = loadSemanticModel(root);
  const check = checkSemanticModel({
    model: loaded.model,
    diagnostics: loaded.diagnostics,
    duplicateIds: loaded.duplicateIds,
    facts,
    graphIndexed: true,
  });
  onPhase?.({ phase: "check", ok: check.ok, errors: check.counts.errors });

  const health = indexHealth(root);
  // Fail-closed for every config version (including legacy v1). SETUP_READY is the
  // agent/MCP success gate and must not short-circuit past insufficient coverage or
  // an index that cannot run high-risk control. CLI exit codes use the same signal.
  const coverageStatus =
    typeof health.coverage === "object" && health.coverage !== null && "status" in health.coverage
      ? String((health.coverage as { status: string }).status)
      : "insufficient";
  const readiness = computeSetupReadiness({
    bindingStatus: health.binding.status,
    canRunHighRiskControl: health.freshness.canRunHighRiskControl,
    coverageStatus: coverageStatus as "complete" | "partial" | "insufficient",
    checkOk: check.ok,
  });
  const { analysisReady, setupReady } = readiness;
  onPhase?.({
    phase: "analysis",
    ready: analysisReady,
    ...(coverageStatus !== undefined ? { coverageStatus } : {}),
  });

  return {
    schemaVersion: 1,
    kind: "setup",
    repositoryRoot: root,
    configWritten,
    semctxDir: resolveSemctxDir(root),
    alreadyInitialized: already,
    polyglot,
    sourceFiles: fileCount,
    selectedFiles: selectedCount,
    selection: {
      configVersion: config.version,
      mode: config.version === 2 ? config.selectionMode : "legacy-v1",
      selectedByLanguage,
      excluded: discovery.candidates.filter((candidate) => candidate.selectionDecision === "excluded").length,
      disabled: discovery.candidates.filter((candidate) => candidate.analysisOutcome === "disabled").length,
      unsupported: discovery.candidates.filter((candidate) => candidate.analysisOutcome === "unsupported").length,
      failed: discovery.candidates.filter((candidate) => candidate.analysisOutcome === "failed").length,
    },
    nodes: analysis.graph.nodes.length,
    edges: analysis.graph.edges.length,
    claims: claims.length,
    freshnessSeal,
    ...(parallelism === undefined ? {} : { parallelism }),
    indexHealth: {
      binding: health.binding,
      freshness: health.freshness,
      coverage: health.coverage,
      workspaceDiagnostics: health.workspace?.diagnostics ?? ([] as const),
      reasonSummary: health.reasonSummary,
    },
    semanticFilesCreated,
    gitignore,
    check: {
      ok: check.ok,
      nodes: check.counts.nodes,
      changes: check.counts.changes,
      errors: check.counts.errors,
    },
    setupReady,
    analysisReady,
    verdict: readiness.verdict,
  };
}
