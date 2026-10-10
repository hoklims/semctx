#!/usr/bin/env bun
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { optionalProcessBoundRoot } from "./repository-root";
import { createSemctxServer } from "./server";
import { runBoundedCallFromArgv } from "./bounded-call";

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
export { controlHandoffExplainTool } from "./control-continuation-tools";
export { controlTargetProposeTool } from "./target-tools";
export { registerChangeAuthorizationVerifierTools } from "./change-authorization-verifier-tools";

/** Entry point: serve semctx over stdio, optionally pre-bound by SEMCTX_ROOT. */
export function main(): void {
  // A budgeted preflight child answers one request and exits; it never opens the stdio server.
  if (runBoundedCallFromArgv(process.argv)) return;
  const root = optionalProcessBoundRoot(process.env["SEMCTX_ROOT"]);
  // Inline diffs can exceed the SDK's 10 MiB default. Keep a finite wire-byte bound;
  // larger changes can still be read from Git without putting the diff on the wire.
  const maxBufferSize = 32 * 1024 * 1024;
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize });
  serveStdio(() => createSemctxServer(root), {
    legacy: "serve",
    transport,
    onerror: (error) => {
      if (error.message !== `ReadBuffer exceeded maximum size of ${maxBufferSize} bytes`) return;
      process.stderr.write("semctx MCP message exceeds 32 MiB; omit gitDiff to read the diff from Git.\n");
      // Release an oversized sender blocked on pipe backpressure as the SDK closes the wire.
      process.stdin.destroy();
    },
  });
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
