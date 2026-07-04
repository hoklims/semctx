#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSemctxServer } from "./server";

export { createSemctxServer } from "./server";
export { prepareTaskTool, inspectTool, verifyChangeTool } from "./tools";
export type { PrepareTaskResult } from "./tools";

/** Entry point: serve semctx over stdio for the current (or SEMCTX_ROOT) repository. */
async function main(): Promise<void> {
  const root = process.env["SEMCTX_ROOT"] ?? process.cwd();
  const server = createSemctxServer(root);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr, so it never corrupts the stdio JSON-RPC channel.
  process.stderr.write(`semctx MCP server ready (root: ${root})\n`);
}

if (import.meta.main) {
  void main();
}
