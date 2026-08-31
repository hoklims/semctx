#!/usr/bin/env bun
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { optionalProcessBoundRoot } from "./repository-root";
import { createSemctxServer } from "./server";

export { createSemctxServer } from "./server";
export { prepareTaskTool, inspectTool, verifyChangeTool } from "./tools";
export type { PrepareTaskResult } from "./tools";
export {
  controlBindScopeTool,
  controlFrameTaskTool,
  controlPlanChangeTool,
  controlReconcileDiffTool,
} from "./reconciliation-tools";
export {
  controlHandoffTool,
  controlResumeHandoffTool,
} from "./control-handoff-tools";
export { controlTargetProposeTool } from "./target-tools";
export { registerChangeAuthorizationVerifierTools } from "./change-authorization-verifier-tools";

/** Entry point: serve semctx over stdio, optionally pre-bound by SEMCTX_ROOT. */
export function main(): void {
  const root = optionalProcessBoundRoot(process.env["SEMCTX_ROOT"]);
  serveStdio(() => createSemctxServer(root), { legacy: "serve" });
  // stderr, so it never corrupts the stdio JSON-RPC channel.
  process.stderr.write(
    root === undefined
      ? "semctx MCP server ready (root: pin-on-first-request)\n"
      : `semctx MCP server ready (root: ${root})\n`,
  );
}

if (import.meta.main) {
  main();
}
