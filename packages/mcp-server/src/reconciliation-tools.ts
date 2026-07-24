/**
 * Thin Plane C MCP adapters over the shared reconciliation application boundary.
 *
 * These functions do not discover Git refs, mutate the repository, or grant
 * execution authority. Validation and reason precedence remain owned by the
 * shared application/control contracts.
 */

import { isAbsolute, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  BuildPlanningBundleCommandV1Schema,
  buildPlanningBundle,
  reconcileWorkingTree,
  type BuildPlanningBundleCommandV1,
} from "@semantic-context/app-services/reconciliation";
import {
  ReconcileWorkingTreeInputV1Schema,
  serializeControlReport,
  type PlanningBundleV1,
  type ReconcileDiffReportV1,
  type ReconcileWorkingTreeInputV1,
} from "@semantic-context/control-model/reconciliation";

const REPOSITORY_ROOT = z.string().min(1).refine(
  isAbsolute,
  "repositoryRoot must be absolute",
).describe(
  "absolute repository root; required on every call so plugin-cache launch directories cannot become implicit targets",
);

interface TextResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function controlPlanChangeTool(
  root: string,
  command: BuildPlanningBundleCommandV1,
): PlanningBundleV1 {
  return buildPlanningBundle(root, command);
}

export function controlReconcileDiffTool(
  root: string,
  input: ReconcileWorkingTreeInputV1,
): ReconcileDiffReportV1 {
  return reconcileWorkingTree(root, input);
}

/** Register the issue #27 read-only MCP tools from their narrow authority closure. */
export function registerReconciliationTools(
  server: McpServer,
  boundRoot: string,
): void {
  server.registerTool(
    "semctx_control_plan_change",
    {
      title: "Compile a semantic planning bundle",
      description:
        "Read-only compilation of a versioned pre-edit TaskEnvelope and SemanticChangeSet from explicit Plane A/B bindings. Returns the canonical shared PlanningBundle with executionAuthority \"none\"; it never applies or schedules edits.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        command: BuildPlanningBundleCommandV1Schema,
      },
    },
    async ({ repositoryRoot, command }) => {
      try {
        return canonical(controlPlanChangeTool(
          requestRoot(boundRoot, repositoryRoot),
          command as BuildPlanningBundleCommandV1,
        ));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "semctx_control_reconcile_diff",
    {
      title: "Reconcile the current diff with a planning bundle",
      description:
        "Read-only reconciliation of the current HEAD/worktree against one strict, versioned PlanningBundle. Returns the shared canonical report and never accepts caller-selected Git refs, applies patches, or grants execution authority.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        repositoryRoot: REPOSITORY_ROOT,
        input: ReconcileWorkingTreeInputV1Schema,
      },
    },
    async ({ repositoryRoot, input }) => {
      try {
        return canonical(controlReconcileDiffTool(
          requestRoot(boundRoot, repositoryRoot),
          input as ReconcileWorkingTreeInputV1,
        ));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

function requestRoot(_boundRoot: string, repositoryRoot: string): string {
  return resolve(repositoryRoot);
}

function canonical(value: unknown): TextResult {
  return { content: [{ type: "text", text: serializeControlReport(value) }] };
}

function errorResult(error: unknown): TextResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}
