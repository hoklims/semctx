import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { prepareTaskTool, inspectTool, verifyChangeTool } from "./tools";

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

  return server;
}
