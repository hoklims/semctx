import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSemctxServer } from "../src/server";

describe("semctx MCP tool metadata", () => {
  let server: McpServer | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    await server?.close();
  });

  test("marks only materially read-only workflow tools as read-only", async () => {
    server = createSemctxServer(process.cwd());
    client = new Client({ name: "semctx-metadata-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    expect(byName.has("semctx_change_close")).toBe(true);

    for (const tool of tools) {
      const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      const properties = schema.properties ?? {};
      expect(properties["repositoryRoot"]).toBeDefined();
      expect(schema.required ?? []).toContain("repositoryRoot");
    }

    for (const name of [
      "semctx_semantic_check",
      "semctx_semantic_slice",
      "semctx_resume",
      "semctx_control_status",
      "semctx_control_trace",
      "semctx_control_plan",
      "semctx_control_plan_change",
      "semctx_control_reconcile_diff",
    ]) {
      expect(byName.get(name)?.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }

    expect(byName.get("semctx_change_open")?.annotations?.readOnlyHint).not.toBe(true);
    expect(byName.get("semctx_change_update")?.annotations?.readOnlyHint).not.toBe(true);
    expect(byName.get("semctx_change_close")?.annotations?.readOnlyHint).not.toBe(true);
    expect(byName.get("semctx_handoff")?.annotations?.readOnlyHint).not.toBe(true);

    const invalidRoot = await client.callTool({
      name: "semctx_verify_change",
      arguments: { repositoryRoot: ".", gitDiff: "" },
    });
    expect(invalidRoot.isError).toBe(true);
    expect(JSON.stringify(invalidRoot.content)).toContain("repositoryRoot must be absolute");

    const invalidReconciliation = await client.callTool({
      name: "semctx_control_reconcile_diff",
      arguments: {
        repositoryRoot: process.cwd(),
        input: {
          schemaVersion: 1,
          planningBundle: {},
          base: "HEAD~1",
        },
      },
    });
    expect(invalidReconciliation.isError).toBe(true);
  });
});
