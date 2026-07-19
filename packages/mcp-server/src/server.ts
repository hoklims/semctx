import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { prepareTaskTool, inspectTool, verifyChangeTool } from "./tools";
import {
  semanticSliceTool,
  changeOpenTool,
  changeUpdateTool,
  changeVerifyTool,
  semanticInspectTool,
  handoffTool,
  resumeTool,
} from "./semantic-tools";
import { controlPlanTool, controlTraceTool } from "./control-tools";
import {
  ArchitectureDeltaSchema,
  ArchitectureSnapshotSchema,
  QualifiedCoordinateIdSchema,
  SemanticLevelSchema,
  TraversalDirectionSchema,
  type ArchitectureDelta,
  type ArchitectureSnapshot,
  type QualifiedCoordinateId,
  type SemanticLevel,
} from "@semantic-context/control-model";

const CHANGE_LIFECYCLE = z.enum(["draft", "active", "verified", "partial", "blocked", "stale", "superseded"]);

interface TextResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function ok(value: unknown): TextResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(err: unknown): TextResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

/** Build the semctx MCP server bound to a repository root. */
export function createSemctxServer(root: string): McpServer {
  const server = new McpServer({ name: "semctx", version: "0.1.0" });

  // --- Primary tool: change-impact analysis + verdict. Deterministic, marker-independent.
  server.registerTool(
    "semctx_verify_change",
    {
      title: "Verify a change (impact + verdict)",
      description:
        "PRIMARY TOOL. Analyse a unified git diff (or the current one if omitted) for its semantic blast radius: impacted symbols, exported contracts and annotated invariants at risk, the tests that cover the changed code, touched contradictions, unknowns, and a PASS/WARN/BLOCK verdict with findings — each traced to file+line evidence. Deterministic: no LLM, no network. Use this before committing a change.",
      inputSchema: {
        gitDiff: z.string().optional().describe("a unified diff; if omitted, the current 'git diff HEAD' is used"),
      },
    },
    async ({ gitDiff }) => {
      try {
        return ok(verifyChangeTool(root, gitDiff !== undefined ? { gitDiff } : {}));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "semctx_inspect",
    {
      title: "Inspect the repository graph",
      description:
        "Inspect the deterministic repository graph around a query: matched nodes, related claims (by authority), relations, contradictory/deprecated sources (non-normative), and files to read.",
      inputSchema: {
        query: z.string().min(1).describe("symbol name, capability slug, or free text"),
        kind: z
          .enum(["symbol", "capability", "invariant", "contract", "test", "document", "any"])
          .optional()
          .describe("restrict the search to a node kind"),
      },
    },
    async ({ query, kind }) => {
      try {
        return ok(inspectTool(root, kind !== undefined ? { query, kind } : { query }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // --- Experimental: task -> ContextPack retriever. NOT a code-search replacement (ADR 0005).
  server.registerTool(
    "semctx_prepare_task",
    {
      title: "Prepare task context (experimental)",
      description:
        "EXPERIMENTAL — not a code-search replacement (ADR 0005): on un-annotated code this retriever is outperformed by plain content search, so do not rely on it to find the files a task touches. Compiles a task into a ContextPack (hard constraints, claims, justified reads, impact paths, tests, contradictions) over the deterministic graph. Useful mainly on repos with rich @markers; prefer semctx_verify_change for change analysis.",
      inputSchema: {
        task: z.string().min(1).describe("the coding task in natural language"),
        mode: z
          .enum(["bugfix", "feature", "refactor", "audit", "performance", "security", "migration"])
          .optional()
          .describe("optional task mode; inferred from the text when omitted"),
      },
    },
    async ({ task, mode }) => {
      try {
        return ok(await prepareTaskTool(root, mode !== undefined ? { task, mode } : { task }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // --- Semantic layer (Plane B): authored intent, invariants, decisions, evidence, change contracts.
  server.registerTool(
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
        changeId: z.string().optional().describe("a change contract id (change.*) to slice around"),
        symbolRef: z.string().optional().describe("a repository graph id (e.g. sym:.., inv:..) whose linked semantic nodes seed the slice"),
        claimRef: z.string().optional().describe("a repository claim id (claim:..) whose linked semantic nodes seed the slice"),
        maxNodes: z.number().int().positive().optional().describe("node cap (default 60)"),
      },
    },
    async ({ changeId, symbolRef, claimRef, maxNodes }) => {
      try {
        return ok(semanticSliceTool(root, { ...(changeId !== undefined ? { changeId } : {}), ...(symbolRef !== undefined ? { symbolRef } : {}), ...(claimRef !== undefined ? { claimRef } : {}), ...(maxNodes !== undefined ? { maxNodes } : {}) }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "semctx_change_open",
    {
      title: "Open a change contract",
      description:
        "Open a proof-carrying change contract before/while modifying code: declare the goal it serves, the invariants it must preserve, the evidence it requires, and the unknowns still open. Authored as provenance=agent, versioned in .semctx/semantic/changes/, and set as the active change. Defaults to lifecycle 'active'.",
      inputSchema: {
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
    async (input) => {
      try {
        return ok(changeOpenTool(root, input));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "semctx_change_update",
    {
      title: "Update a change contract",
      description:
        "Additively patch a change contract: refine the statement/lifecycle, add served goals, preserved invariants, required evidence, open unknowns, resolve unknowns, add links or tags. Use to record progress (e.g. resolve an unknown once proven).",
      inputSchema: {
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
    async (input) => {
      try {
        return ok(changeUpdateTool(root, input));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "semctx_change_verify",
    {
      title: "Verify a change contract (composed)",
      description:
        "Compose semctx_verify_change with the change contract: run the deterministic impact analysis, then check preserved invariants, required evidence, open unknowns and stale links. Returns VERIFIED / PARTIAL / BLOCKED / STALE — never more optimistic than the data, and never turns PARTIAL into VERIFIED on its own (running tests and updating evidence status is your job). Use after editing and after semctx_verify_change.",
      inputSchema: {
        changeId: z.string().min(1).describe("the change contract to verify"),
        gitDiff: z.string().optional().describe("a unified diff; if omitted, the current 'git diff HEAD' is used"),
      },
    },
    async ({ changeId, gitDiff }) => {
      try {
        return ok(changeVerifyTool(root, gitDiff !== undefined ? { changeId, gitDiff } : { changeId }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "semctx_semantic_inspect",
    {
      title: "Inspect a semantic id",
      description:
        "Inspect a single authored semantic node or change contract: its declaration, who references it, and how its repository links resolve (including stale links). Read-only.",
      inputSchema: { id: z.string().min(1).describe("a semantic id (goal.* / invariant.* / decision.* / change.* / …)") },
    },
    async ({ id }) => {
      try {
        return ok(semanticInspectTool(root, { id }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "semctx_handoff",
    {
      title: "Capture a handoff capsule",
      description:
        "Capture the working delta (active change, touched invariants, obtained/pending proofs, open unknowns, explored links, next validations) into a compact capsule, before a context compaction or an agent handoff. Persisted locally in .semctx/working/.",
      inputSchema: { note: z.string().optional().describe("an optional free-text note to carry across the handoff") },
    },
    async ({ note }) => {
      try {
        return ok(handoffTool(root, note !== undefined ? { note } : {}));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
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
      inputSchema: {},
    },
    async () => {
      try {
        return ok(resumeTool(root));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // --- Control plane (Plane C): read-only coordinates and fail-closed migration planning.
  server.registerTool(
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
        sourceId: QualifiedCoordinateIdSchema.describe("qualified coordinate id: repo:<id> or semantic:<id>"),
        targetLevel: SemanticLevelSchema.optional().describe("target semantic level; defaults to L6 for lift and L0 for lower"),
        direction: TraversalDirectionSchema.optional().describe("lift (default) or lower"),
        maxDepth: z.number().int().min(0).max(100).optional(),
        maxResults: z.number().int().min(1).max(10_000).optional(),
      },
    },
    async ({ sourceId, targetLevel, direction, maxDepth, maxResults }) => {
      try {
        return ok(controlTraceTool(root, {
          sourceId: sourceId as QualifiedCoordinateId,
          ...(targetLevel !== undefined ? { targetLevel: targetLevel as SemanticLevel } : {}),
          ...(direction !== undefined ? { direction } : {}),
          ...(maxDepth !== undefined ? { maxDepth } : {}),
          ...(maxResults !== undefined ? { maxResults } : {}),
        }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
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
        changeId: z.string().min(1).describe("an authored change contract id"),
        target: ArchitectureSnapshotSchema.optional().describe("explicit target architecture snapshot"),
        delta: ArchitectureDeltaSchema.optional().describe("optional delta that must correspond to current and target snapshot ids"),
      },
    },
    async ({ changeId, target, delta }) => {
      try {
        return ok(controlPlanTool(root, {
          changeId,
          ...(target !== undefined ? { target: target as ArchitectureSnapshot } : {}),
          ...(delta !== undefined ? { delta: delta as ArchitectureDelta } : {}),
        }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}
