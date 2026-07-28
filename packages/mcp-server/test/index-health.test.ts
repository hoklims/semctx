import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexHealth } from "@semantic-context/app-services";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { indexHealthTool } from "../src/control-tools";
import { createSemctxServer } from "../src/server";

describe("index-health MCP transport", () => {
  let root: string | undefined;
  let server: McpServer | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    await server?.close();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
    server = undefined;
    client = undefined;
  });

  test("the wrapper returns the exact shared application-service report", () => {
    root = mkdtempSync(join(tmpdir(), "semctx-index-health-wrapper-"));
    const expected = indexHealth(root);

    expect(indexHealthTool(root)).toEqual(expected);
    expect(JSON.stringify(indexHealthTool(root))).toBe(JSON.stringify(expected));
  });

  test("lists read-only metadata and returns the same report through MCP", async () => {
    root = mkdtempSync(join(tmpdir(), "semctx-index-health-mcp-"));
    server = createSemctxServer(process.cwd());
    client = new Client({ name: "semctx-index-health-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "semctx_index_health");
    expect(tool?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    const schema = tool?.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties?.["repositoryRoot"]).toBeDefined();
    expect(schema.required).toContain("repositoryRoot");

    const response = await client.callTool({
      name: "semctx_index_health",
      arguments: { repositoryRoot: root },
    });
    expect(response.isError).not.toBe(true);
    if (!Array.isArray(response.content)) {
      throw new Error("expected MCP content blocks");
    }
    const block = response.content[0];
    if (block?.type !== "text") throw new Error("expected a text result");
    expect(JSON.parse(block.text)).toEqual(indexHealth(root));
  });

  test("rejects a relative repositoryRoot", async () => {
    server = createSemctxServer(process.cwd());
    client = new Client({ name: "semctx-index-health-root-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const response = await client.callTool({
      name: "semctx_index_health",
      arguments: { repositoryRoot: "." },
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toContain(
      "repositoryRoot must be absolute",
    );
  });
});
