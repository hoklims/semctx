import { afterEach, describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod-v4";
import { MCP_RESULT_MAX_BYTES, ToolRegistrar } from "../src/tool-contract";

// Claude Code disconnects a stdio server that writes more than 16 MB without a JSON-RPC message
// boundary, and every later call of the session then fails with "Connection closed". A result
// that would cross the transport bound must come back as a typed catalogue error instead.
describe("MCP result byte bound", () => {
  let server: McpServer | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    await server?.close();
    server = undefined;
    client = undefined;
  });

  async function connect(blobBytes: number): Promise<Client> {
    server = new McpServer({ name: "semctx-bound", version: "1" });
    new ToolRegistrar(server).registerTool(
      "semctx_inspect",
      { inputSchema: {}, outputSchema: z.object({ blob: z.string() }).strict() },
      () => ({ content: [{ type: "text", text: JSON.stringify({ blob: "x".repeat(blobBytes) }) }] }),
    );
    client = new Client({ name: "semctx-bound-client", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }

  test("an oversized result is a typed RESPONSE_TOO_LARGE error, never a raw 16 MB line", async () => {
    const connected = await connect(MCP_RESULT_MAX_BYTES);
    const response = await connected.callTool({ name: "semctx_inspect", arguments: {} });
    expect(response.isError).toBe(true);
    expect(JSON.parse((response.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(4 * 1024);
  });

  test("a result within the bound is returned unchanged", async () => {
    const connected = await connect(1024);
    const response = await connected.callTool({ name: "semctx_inspect", arguments: {} });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toEqual({ blob: "x".repeat(1024) });
  });

  test("the bound leaves room for the JSON-RPC envelope under the 16 MB host limit", () => {
    expect(MCP_RESULT_MAX_BYTES).toBeLessThanOrEqual(12 * 1024 * 1024);
  });
});
