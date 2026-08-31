import { McpServer } from "@modelcontextprotocol/server";
import packageJson from "../package.json";
import type { ZodType, ZodTypeDef } from "zod";
import { z } from "zod-v4";
import { isAbsolute } from "node:path";
import { prepareTaskTool, inspectTool, verifyChangeTool } from "./tools";
import {
  semanticSliceTool,
  semanticCheckTool,
  changeOpenTool,
  changeUpdateTool,
  changeVerifyTool,
  changeCloseTool,
  semanticInspectTool,
  handoffTool,
  resumeTool,
} from "./semantic-tools";
import {
  controlAgentLifecycleTool,
  controlArchitectureComparisonTool,
  controlAuthorizeDeletionTool,
  controlAuthorityTool,
  controlAuthorizeStepTool,
  controlAuthorizeTransitionTool,
  controlExplainWhyTool,
  controlGraphTool,
  controlImpactTool,
  indexHealthTool,
  controlPlanTool,
  controlRefinementCoverageTool,
  controlStatusTool,
  controlTraceTool,
  controlTraversalTool,
} from "./control-tools";
import {
  registerReconciliationTools,
} from "./reconciliation-tools";
import { registerControlHandoffTools } from "./control-handoff-tools";
import { registerTargetTools } from "./target-tools";
import { registerChangeAuthorizationVerifierTools } from "./change-authorization-verifier-tools";
import {
  AgentLifecycleCheckpointRequestV1Schema,
  AttestationRequestV1Schema,
  ArchitectureDeltaSchema,
  ArchitectureSnapshotSchema,
  ExecutionStateSchema,
  MigrationPlanSchema,
  MigrationStateSchema,
  MigrationStepSchema,
  ProofObligationSchema,
  QualifiedCoordinateIdSchema,
  RiskLevelSchema,
  RollbackPlanSchema,
  SemanticLevelSchema,
  Sha256HashSchema,
  TraversalDirectionSchema,
  type ArchitectureDelta,
  type ArchitectureSnapshot,
  type AgentLifecycleCheckpointRequestV1,
  type QualifiedCoordinateId,
  type SemanticLevel,
} from "@semantic-context/control-model";
import { mcpSchema } from "./schema-boundary";
import { createRepositoryRootResolver } from "./repository-root";
import { ToolRegistrar, type ToolRegistrarOptions } from "./tool-contract";
import { registerControlExplorerApp } from "./control-explorer-app";
import { cliCompatibilityTool } from "./cli-compatibility-tools";
import { SETUP_POLYGLOT_INPUT_DESCRIPTION, setupTool } from "./setup-tools";

const MCP_ATTESTATION_REQUEST_V1 = mcpSchema(AttestationRequestV1Schema);
const MCP_AGENT_LIFECYCLE_CHECKPOINT_REQUEST_V1 = mcpSchema(
  AgentLifecycleCheckpointRequestV1Schema,
).refine(
  (request) => AgentLifecycleCheckpointRequestV1Schema.safeParse(request).success,
  "invalid agent lifecycle checkpoint request",
);
const MCP_ARCHITECTURE_DELTA = mcpSchema(ArchitectureDeltaSchema);
const MCP_ARCHITECTURE_SNAPSHOT = mcpSchema(ArchitectureSnapshotSchema);
// The recursive control-model schema is intentionally exported as ZodTypeAny.
// Quarantine that erased type at the existing Zod 3 -> Zod 4 schema boundary.
const MCP_EXECUTION_STATE = mcpSchema(
  ExecutionStateSchema as unknown as ZodType<unknown, ZodTypeDef, unknown>,
);
const MCP_MIGRATION_PLAN = mcpSchema(MigrationPlanSchema);
const MCP_MIGRATION_STATE = mcpSchema(MigrationStateSchema);
const MCP_MIGRATION_STEP = mcpSchema(MigrationStepSchema);
const MCP_PROOF_OBLIGATION = mcpSchema(ProofObligationSchema);
const MCP_QUALIFIED_COORDINATE_ID = mcpSchema(QualifiedCoordinateIdSchema);
const MCP_RISK_LEVEL = mcpSchema(RiskLevelSchema);
const MCP_ROLLBACK_PLAN = mcpSchema(RollbackPlanSchema);
const MCP_SEMANTIC_LEVEL = mcpSchema(SemanticLevelSchema);
const MCP_SHA256_HASH = mcpSchema(Sha256HashSchema);
const MCP_TRAVERSAL_DIRECTION = mcpSchema(TraversalDirectionSchema);

const CHANGE_LIFECYCLE = z.enum(["draft", "active", "partial", "blocked", "stale", "superseded"]);
const REPOSITORY_ROOT = z.string().min(1).refine(isAbsolute, "repositoryRoot must be absolute").describe(
  "absolute repository root; required on every call so plugin-cache launch directories cannot become implicit targets",
);

interface TextResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
}

function ok(value: unknown): TextResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Build the semctx MCP server bound to a repository root. */
export function createSemctxServer(
  root?: string,
  options: ToolRegistrarOptions = {},
): McpServer {
  const rootResolver = createRepositoryRootResolver(root);
  const server = new McpServer(
    { name: "semctx", version: packageJson.version },
    {
      cacheHints: {
        "tools/list": { ttlMs: 300_000, cacheScope: "private" },
        "server/discover": { ttlMs: 300_000, cacheScope: "private" },
      },
    },
  );
  const tools = new ToolRegistrar(server, options);

  // --- Primary tool: change-impact analysis + verdict. Deterministic, marker-independent.
  tools.registerTool(
    "semctx_verify_change",
    {
      title: "Verify a change (impact + verdict)",
      description:
        "PRIMARY TOOL. Analyse a unified git diff (or the current one if omitted) for its semantic blast radius: impacted symbols, exported contracts and annotated invariants at risk, the tests that cover the changed code, touched contradictions, unknowns, and a PASS/WARN/BLOCK verdict with findings — each traced to file+line evidence. Deterministic: no LLM, no network. Use this before committing a change.",
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        gitDiff: z.string().optional().describe("a unified diff; if omitted, the current 'git diff HEAD' is used"),
      },
    },
    ({ repositoryRoot, gitDiff }) =>
      ok(verifyChangeTool(rootResolver.resolve(repositoryRoot), gitDiff !== undefined ? { gitDiff } : {})),
  );

  tools.registerTool(
    "semctx_inspect",
    {
      title: "Inspect the repository graph",
      description:
        "Inspect the deterministic repository graph around a query: matched nodes, related claims (by authority), relations, contradictory/deprecated sources (non-normative), and files to read.",
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        query: z.string().min(1).describe("symbol name, capability slug, or free text"),
        kind: z
          .enum(["symbol", "capability", "invariant", "contract", "test", "document", "any"])
          .optional()
          .describe("restrict the search to a node kind"),
      },
    },
    ({ repositoryRoot, query, kind }) =>
      ok(inspectTool(rootResolver.resolve(repositoryRoot), kind !== undefined ? { query, kind } : { query })),
  );

  // --- Experimental: task -> ContextPack retriever. NOT a code-search replacement (ADR 0005).
  tools.registerTool(
    "semctx_prepare_task",
    {
      title: "Prepare task context (experimental)",
      description:
        "EXPERIMENTAL — not a code-search replacement (ADR 0005): on un-annotated code this retriever is outperformed by plain content search, so do not rely on it to find the files a task touches. Compiles a task into a ContextPack (hard constraints, claims, justified reads, impact paths, tests, contradictions) over the deterministic graph. Useful mainly on repos with rich @markers; prefer semctx_verify_change for change analysis.",
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        task: z.string().min(1).describe("the coding task in natural language"),
        mode: z
          .enum(["bugfix", "feature", "refactor", "audit", "performance", "security", "migration"])
          .optional()
          .describe("optional task mode; inferred from the text when omitted"),
      },
    },
    async ({ repositoryRoot, task, mode }) =>
      ok(await prepareTaskTool(rootResolver.resolve(repositoryRoot), mode !== undefined ? { task, mode } : { task })),
  );

  // --- Workspace bootstrap (plugin-native; no global package install required).
  tools.registerTool(
    "semctx_setup",
    {
      title: "Bootstrap repository workspace",
      description:
        "PLUGIN-NATIVE SETUP. Initialise .semctx/ (config + semantic scaffold + deterministic graph index + validation) without a global semctx package. Default is dry preflight (confirm omitted/false). Set confirm:true only after the user authorises writes. Idempotent for existing config and authored .sem files. After confirm:true, treat as agent success ONLY when kind==='setup' AND verdict==='SETUP_READY'. Domain outcomes setup_refused (verdict SETUP_REFUSED, e.g. polyglot on v1) and SETUP_NOT_READY are ordinary schema-valid structured results (isError false per ADR 0012) — agents must read kind/verdict, not isError. Catalogue isError is reserved for true transport/input failures without structured setup bodies. Verdict values are namespaced SETUP_* so they never mean Plane C migration READY. Prefer this over shelling out to `semctx setup` when the plugin MCP is available.",
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        confirm: z
          .boolean()
          .optional()
          .describe("must be true to write .semctx/ and index; false/omitted returns a dry preflight only"),
        polyglot: z
          .boolean()
          .optional()
          .describe(SETUP_POLYGLOT_INPUT_DESCRIPTION),
      },
    },
    ({ repositoryRoot, confirm, polyglot }) => {
      // Domain refuse / NOT_READY are schema-valid bodies (ADR 0012). Catalogue errors
      // (e.g. CONFIG_INVALID from loadConfig during polyglot preflight) still throw.
      return ok(setupTool(rootResolver.resolve(repositoryRoot), {
        ...(confirm !== undefined ? { confirm } : {}),
        ...(polyglot !== undefined ? { polyglot } : {}),
        now: new Date().toISOString(),
      }));
    },
  );

  // --- Semantic layer (Plane B): authored intent, invariants, decisions, evidence, change contracts.
  tools.registerTool(
    "semctx_semantic_check",
    {
      title: "Check semantic integrity and lifecycle",
      description:
        "Read-only versioned semantic check. Reports canonical reason codes for malformed or stale authored state, repository links, active-change pointers, obsolete contracts, and verification baselines. Returns the same report as `semctx semantic check --json`.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: { repositoryRoot: REPOSITORY_ROOT },
    },
    ({ repositoryRoot }) => ok(semanticCheckTool(rootResolver.resolve(repositoryRoot))),
  );

  tools.registerTool(
    "semctx_semantic_slice",
    {
      title: "Semantic slice (bounded context capsule)",
      description:
        "Produce a compact, deterministic capsule of authored semantic truth — intentions, invariants, decisions, linked symbols/claims, obtained evidence, open unknowns, safety constraints and next proofs — for an EXPLICIT scope. NOT code search: pass a change id and/or a repository symbol/claim ref; it never guesses relevance from free text. Bounded by maxNodes; every line points to a source; absent items are shown as unknown.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        changeId: z.string().optional().describe("a change contract id (change.*) to slice around"),
        symbolRef: z.string().optional().describe("a repository graph id (e.g. sym:.., inv:..) whose linked semantic nodes seed the slice"),
        claimRef: z.string().optional().describe("a repository claim id (claim:..) whose linked semantic nodes seed the slice"),
        maxNodes: z.number().int().positive().optional().describe("node cap (default 60)"),
      },
    },
    ({ repositoryRoot, changeId, symbolRef, claimRef, maxNodes }) =>
      ok(semanticSliceTool(rootResolver.resolve(repositoryRoot), { ...(changeId !== undefined ? { changeId } : {}), ...(symbolRef !== undefined ? { symbolRef } : {}), ...(claimRef !== undefined ? { claimRef } : {}), ...(maxNodes !== undefined ? { maxNodes } : {}) })),
  );

  tools.registerTool(
    "semctx_change_open",
    {
      title: "Open a change contract",
      description:
        "Open a proof-carrying change contract before/while modifying code: declare the goal it serves, the invariants it must preserve, the evidence it requires, and the unknowns still open. Authored as provenance=agent, versioned in .semctx/semantic/changes/, and set as the active change. Defaults to lifecycle 'active'.",
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        id: z.string().min(1).describe("change id (change.*; a bare slug is namespaced automatically)"),
        statement: z.string().min(1).describe("what the change does, in one line"),
        serves: z.array(z.string()).optional().describe("goal ids this change serves"),
        preserves: z.array(z.string()).optional().describe("invariant ids this change must preserve"),
        requires: z.array(z.string()).optional().describe("evidence ids this change requires as proof"),
        unknowns: z.array(z.string()).optional().describe("unknown ids that remain open"),
        links: z.array(z.string()).optional().describe("repository links (sym:.., file:.., etc.)"),
        tags: z.array(z.string()).optional().describe("free-form tags"),
        draft: z.boolean().optional().describe("open as draft instead of active"),
      },
    },
    (input) => ok(changeOpenTool(rootResolver.resolve(input.repositoryRoot), input)),
  );

  tools.registerTool(
    "semctx_change_update",
    {
      title: "Update a change contract",
      description:
        "Additively patch a change contract: refine its non-verified lifecycle, add served goals, preserved invariants, required evidence, open unknowns, links or tags. Resolving an unknown requires its authored node to have a proved_by relation to evidence in a proven status. The verified lifecycle is derived only by semctx_change_close after composed verification.",
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        id: z.string().min(1),
        statement: z.string().optional(),
        status: CHANGE_LIFECYCLE.optional(),
        addServes: z.array(z.string()).optional(),
        addPreserves: z.array(z.string()).optional(),
        addRequires: z.array(z.string()).optional(),
        addUnknowns: z.array(z.string()).optional(),
        resolveUnknowns: z.array(z.string()).optional(),
        addLinks: z.array(z.string()).optional(),
        addTags: z.array(z.string()).optional(),
      },
    },
    (input) => ok(changeUpdateTool(rootResolver.resolve(input.repositoryRoot), input)),
  );

  tools.registerTool(
    "semctx_change_verify",
    {
      title: "Verify a change contract (composed)",
      description:
        "Compose semctx_verify_change with the change contract: run the deterministic impact analysis, then check preserved invariants, required evidence, open unknowns and stale links. Returns VERIFIED / PARTIAL / BLOCKED / STALE — never more optimistic than the data, and never turns PARTIAL into VERIFIED on its own (running tests and updating evidence status is your job). Use after editing and after semctx_verify_change.",
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        changeId: z.string().min(1).describe("the change contract to verify"),
        gitDiff: z.string().optional().describe("a unified diff; if omitted, the current 'git diff HEAD' is used"),
      },
    },
    ({ repositoryRoot, changeId, gitDiff }) =>
      ok(changeVerifyTool(rootResolver.resolve(repositoryRoot), gitDiff !== undefined ? { changeId, gitDiff } : { changeId })),
  );

  tools.registerTool(
    "semctx_change_close",
    {
      title: "Close a change contract",
      description:
        "Close a change as superseded, or derive lifecycle 'verified' only after a fresh composed verification returns VERIFIED. A PARTIAL, BLOCKED, or STALE result fails closed and does not mutate the contract.",
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        id: z.string().min(1).describe("the change contract id"),
        superseded: z.boolean().optional().describe("close as superseded without claiming verification"),
        gitDiff: z.string().optional().describe("a unified diff; if omitted, the current 'git diff HEAD' is used"),
      },
    },
    ({ repositoryRoot, id, superseded, gitDiff }) => ok(changeCloseTool(rootResolver.resolve(repositoryRoot), {
      id,
      ...(superseded !== undefined ? { superseded } : {}),
      ...(gitDiff !== undefined ? { gitDiff } : {}),
    })),
  );

  tools.registerTool(
    "semctx_semantic_inspect",
    {
      title: "Inspect a semantic id",
      description:
        "Inspect a single authored semantic node or change contract: its declaration, who references it, and how its repository links resolve (including stale links). Read-only.",
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        id: z.string().min(1).describe("a semantic id (goal.* / invariant.* / decision.* / change.* / …)"),
      },
    },
    ({ repositoryRoot, id }) => ok(semanticInspectTool(rootResolver.resolve(repositoryRoot), { id })),
  );

  tools.registerTool(
    "semctx_handoff",
    {
      title: "Capture a handoff capsule",
      description:
        "Capture the working delta (active change, touched invariants, obtained/pending proofs, open unknowns, explored links, next validations) into a compact capsule, before a context compaction or an agent handoff. Persisted locally in .semctx/working/.",
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        note: z.string().optional().describe("an optional free-text note to carry across the handoff"),
      },
    },
    ({ repositoryRoot, note }) =>
      ok(handoffTool(rootResolver.resolve(repositoryRoot), note !== undefined ? { note } : {})),
  );

  tools.registerTool(
    "semctx_resume",
    {
      title: "Resume from a handoff capsule",
      description:
        "Re-emit the last handoff capsule (or one rebuilt from the active change) so a fresh agent context can rehydrate the semantic state: what change is active, which invariants to preserve, what is proven, what remains open.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: { repositoryRoot: REPOSITORY_ROOT },
    },
    ({ repositoryRoot }) => ok(resumeTool(rootResolver.resolve(repositoryRoot))),
  );

  // --- Control plane (Plane C): read-only coordinates and fail-closed migration planning.
  tools.registerTool(
    "semctx_index_health",
    {
      title: "Check shared index health",
      description:
        "Read-only Plane-A index health report. Returns the exact shared binding, freshness, coverage, candidate outcome, workspace diagnostic, and reason data; freshness and coverage remain separate dimensions.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: { repositoryRoot: REPOSITORY_ROOT },
    },
    ({ repositoryRoot }) =>
      ok(indexHealthTool(rootResolver.resolve(repositoryRoot))),
  );

  tools.registerTool(
    "semctx_cli_compatibility",
    {
      title: "Check global CLI compatibility",
      description:
        "Read-only offline advisory comparing the plugin/MCP runtime version with the global semctx CLI. It never installs, contacts a registry, blocks MCP-only workflows, or grants execution authority.",
      inputSchema: { repositoryRoot: REPOSITORY_ROOT },
    },
    ({ repositoryRoot }) => {
      rootResolver.resolve(repositoryRoot);
      return ok(cliCompatibilityTool());
    },
  );

  tools.registerTool(
    "semctx_control_status",
    {
      title: "Check control-plane freshness",
      description:
        "Read-only preflight returning FRESH, DIRTY_KNOWN, STALE, or UNSEALED. High-risk control operations fail closed on STALE or UNSEALED inputs.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: { repositoryRoot: REPOSITORY_ROOT },
    },
    ({ repositoryRoot }) => ok(controlStatusTool(rootResolver.resolve(repositoryRoot))),
  );

  tools.registerTool(
    "semctx_control_agent_lifecycle",
    {
      title: "Record an advisory agent lifecycle checkpoint",
      description:
        "Read-only advisory lifecycle checkpoint in shadow mode. It records stage presence and caller-observed coordinate identifiers, evaluates neither outcomes nor admissibility, blocks nothing, collects no source content, and grants no execution authority.",
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        request: MCP_AGENT_LIFECYCLE_CHECKPOINT_REQUEST_V1,
      },
      strictInput: true,
    },
    ({ repositoryRoot, request }) =>
      ok(controlAgentLifecycleTool(
        rootResolver.resolve(repositoryRoot),
        request as AgentLifecycleCheckpointRequestV1,
      )),
  );

  tools.registerTool(
    "semctx_control_authority",
    {
      title: "Report the authority a change altitude requires",
      description:
        "Read-only required-altitude policy: L0-L1 autonomous, L2 constrained, L3 reviewed plan and rollback, L4-L6 explicit human authority. "
        + "Reports the regime and its obligations; it never grants execution, and a STALE or UNSEALED preflight withdraws autonomous write at every altitude.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        requiredAltitude: z.union([
          z.literal(0), z.literal(1), z.literal(2), z.literal(3),
          z.literal(4), z.literal(5), z.literal(6),
        ]).describe("Abstraction altitude the change requires (L0 syntax through L6 strategy)."),
      },
    },
    ({ repositoryRoot, requiredAltitude }) =>
      ok(controlAuthorityTool(rootResolver.resolve(repositoryRoot), requiredAltitude)),
  );

  tools.registerTool(
    "semctx_control_trace",
    {
      title: "Trace semantic coordinates",
      description:
        "Read-only, deterministic and bounded traversal between repository/semantic coordinates and L0-L6. Does not initialize, index, or mutate the repository.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        sourceId: MCP_QUALIFIED_COORDINATE_ID.describe("qualified coordinate id: repo:<id> or semantic:<id>"),
        targetLevel: MCP_SEMANTIC_LEVEL.optional().describe("target semantic level; defaults to L6 for lift and L0 for lower"),
        direction: MCP_TRAVERSAL_DIRECTION.optional().describe("lift (default) or lower"),
        maxDepth: z.number().int().min(0).max(100).optional(),
        maxResults: z.number().int().min(1).max(10_000).optional(),
      },
    },
    ({ repositoryRoot, sourceId, targetLevel, direction, maxDepth, maxResults }) =>
      ok(controlTraceTool(rootResolver.resolve(repositoryRoot), {
        sourceId: sourceId as QualifiedCoordinateId,
        ...(targetLevel !== undefined ? { targetLevel: targetLevel as SemanticLevel } : {}),
        ...(direction !== undefined ? { direction } : {}),
        ...(maxDepth !== undefined ? { maxDepth } : {}),
        ...(maxResults !== undefined ? { maxResults } : {}),
      })),
  );

  tools.registerTool(
    "semctx_control_graph",
    {
      title: "Read the typed coordinate graph",
      description: "Read-only Plane-C coordinate graph v2 with structural and typed refinement edges kept separate.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: { repositoryRoot: REPOSITORY_ROOT },
    },
    ({ repositoryRoot }) => ok(controlGraphTool(rootResolver.resolve(repositoryRoot))),
  );

  tools.registerTool(
    "semctx_control_traversal",
    {
      title: "Traverse typed refinement",
      description: "Read-only bounded lower/lift traversal using explicit levels and proof-carrying refinement relations.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        sourceId: z.union([MCP_QUALIFIED_COORDINATE_ID, MCP_SHA256_HASH]),
        targetLevel: MCP_SEMANTIC_LEVEL,
        direction: MCP_TRAVERSAL_DIRECTION,
        maxDepth: z.number().int().min(0).max(100).optional(),
        maxResults: z.number().int().min(1).max(10_000).optional(),
      },
    },
    ({ repositoryRoot, sourceId, targetLevel, direction, maxDepth, maxResults }) =>
      ok(controlTraversalTool(rootResolver.resolve(repositoryRoot), {
        sourceId: sourceId as QualifiedCoordinateId | `sha256:${string}`,
        targetLevel: targetLevel as SemanticLevel,
        direction,
        ...(maxDepth !== undefined ? { maxDepth } : {}),
        ...(maxResults !== undefined ? { maxResults } : {}),
      })),
  );

  tools.registerTool(
    "semctx_control_refinement_coverage",
    {
      title: "Report refinement coverage",
      description: "Read-only typed refinement coverage with load-bearing evidence, missing levels, and explicit empty causes.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        sourceId: z.union([MCP_QUALIFIED_COORDINATE_ID, MCP_SHA256_HASH]),
        targetLevel: MCP_SEMANTIC_LEVEL,
        direction: MCP_TRAVERSAL_DIRECTION,
        sourceSeal: MCP_SHA256_HASH.optional(),
        indexSeal: MCP_SHA256_HASH.optional(),
        maxDepth: z.number().int().min(0).max(100).optional(),
        maxResults: z.number().int().min(1).max(10_000).optional(),
      },
    },
    ({ repositoryRoot, sourceId, targetLevel, direction, sourceSeal, indexSeal, maxDepth, maxResults }) =>
      ok(controlRefinementCoverageTool(rootResolver.resolve(repositoryRoot), {
        sourceId: sourceId as QualifiedCoordinateId | `sha256:${string}`,
        targetLevel: targetLevel as SemanticLevel,
        direction,
        ...(sourceSeal === undefined ? {} : { sourceSeal: sourceSeal as `sha256:${string}` }),
        ...(indexSeal === undefined ? {} : { indexSeal: indexSeal as `sha256:${string}` }),
        ...(maxDepth !== undefined ? { maxDepth } : {}),
        ...(maxResults !== undefined ? { maxResults } : {}),
      })),
  );

  tools.registerTool(
    "semctx_control_impact",
    {
      title: "Report structural impact",
      description: "Read-only impact over dependency/data/contract/import edges; typed refinement edges never manufacture impact.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        sourceIds: z.array(MCP_QUALIFIED_COORDINATE_ID).min(1),
        maxDepth: z.number().int().min(0).max(100).optional(),
        maxResults: z.number().int().min(1).max(10_000).optional(),
      },
    },
    ({ repositoryRoot, sourceIds, maxDepth, maxResults }) =>
      ok(controlImpactTool(rootResolver.resolve(repositoryRoot), {
        sourceIds: sourceIds as QualifiedCoordinateId[],
        ...(maxDepth !== undefined ? { maxDepth } : {}),
        ...(maxResults !== undefined ? { maxResults } : {}),
      })),
  );

  tools.registerTool(
    "semctx_control_explain_why",
    {
      title: "Explain authored rationale",
      description: "Read-only explanation using authored rationale only; proximity, imports, and generated text are excluded.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        sourceId: MCP_QUALIFIED_COORDINATE_ID,
        maxDepth: z.number().int().min(0).max(100).optional(),
        maxResults: z.number().int().min(1).max(10_000).optional(),
      },
    },
    ({ repositoryRoot, sourceId, maxDepth, maxResults }) =>
      ok(controlExplainWhyTool(rootResolver.resolve(repositoryRoot), {
        sourceId: sourceId as QualifiedCoordinateId,
        ...(maxDepth !== undefined ? { maxDepth } : {}),
        ...(maxResults !== undefined ? { maxResults } : {}),
      })),
  );

  tools.registerTool(
    "semctx_control_compare_architecture",
    {
      title: "Compare architecture snapshots",
      description: "Read-only deterministic comparison of the current sealed snapshot with an explicit target.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        target: MCP_ARCHITECTURE_SNAPSHOT,
      },
    },
    ({ repositoryRoot, target }) =>
      ok(controlArchitectureComparisonTool(
        rootResolver.resolve(repositoryRoot),
        target as ArchitectureSnapshot,
      )),
  );

  tools.registerTool(
    "control_authorize_transition",
    {
      title: "Report transition authorization",
      description: "Read-only authorization report. Resolves attestation references from the sealed index and never executes a transition.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        fromState: MCP_MIGRATION_STATE,
        toState: MCP_MIGRATION_STATE,
        risk: MCP_RISK_LEVEL,
        subject: z.string().min(1),
        planningCommit: z.string().min(1),
        evaluatedAt: z.string().datetime({ offset: true }),
        proofObligations: z.array(MCP_PROOF_OBLIGATION),
        rollback: MCP_ROLLBACK_PLAN.optional(),
        changesL4Invariant: z.boolean(),
        attestationRequests: z.array(MCP_ATTESTATION_REQUEST_V1),
      },
    },
    ({ repositoryRoot, ...input }) =>
      ok(controlAuthorizeTransitionTool(rootResolver.resolve(repositoryRoot), input)),
  );

  tools.registerTool(
    "control_authorize_step",
    {
      title: "Report step authorization",
      description: "Read-only authorization report for an exact planned step. It never executes or schedules the step.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        plan: MCP_MIGRATION_PLAN,
        step: MCP_MIGRATION_STEP,
        executionState: MCP_EXECUTION_STATE,
        evaluatedAt: z.string().datetime({ offset: true }),
        attestationRequests: z.array(MCP_ATTESTATION_REQUEST_V1),
      },
    },
    ({ repositoryRoot, ...input }) =>
      ok(controlAuthorizeStepTool(
        rootResolver.resolve(repositoryRoot),
        input as unknown as Parameters<typeof controlAuthorizeStepTool>[1],
      )),
  );

  tools.registerTool(
    "control_authorize_deletion",
    {
      title: "Report deletion authorization",
      description: "Read-only deletion authorization report. It exposes no deletion or mutation capability.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        subject: z.string().min(1),
        planningCommit: z.string().min(1),
        evaluatedAt: z.string().datetime({ offset: true }),
        attestationRequests: z.array(MCP_ATTESTATION_REQUEST_V1),
      },
    },
    ({ repositoryRoot, ...input }) =>
      ok(controlAuthorizeDeletionTool(rootResolver.resolve(repositoryRoot), input)),
  );

  tools.registerTool(
    "semctx_control_plan",
    {
      title: "Compile a migration plan",
      description:
        "Read-only fail-closed migration planning. Without an explicit target architecture the result is BLOCKED with target_architecture_missing; no step is executed.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        changeId: z.string().min(1).describe("an authored change contract id"),
        target: MCP_ARCHITECTURE_SNAPSHOT.optional().describe("explicit target architecture snapshot"),
        delta: MCP_ARCHITECTURE_DELTA.optional().describe("optional delta that must correspond to current and target snapshot ids"),
      },
    },
    ({ repositoryRoot, changeId, target, delta }) =>
      ok(controlPlanTool(rootResolver.resolve(repositoryRoot), {
        changeId,
        ...(target !== undefined ? { target: target as ArchitectureSnapshot } : {}),
        ...(delta !== undefined ? { delta: delta as ArchitectureDelta } : {}),
      })),
  );

  registerReconciliationTools(tools, rootResolver);
  registerControlHandoffTools(tools, rootResolver);
  registerTargetTools(tools, rootResolver);
  registerControlExplorerApp(server, tools, rootResolver);
  registerChangeAuthorizationVerifierTools(tools);

  return server;
}
