import { afterEach, describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { cliCompatibilityTool } from "../src/cli-compatibility-tools";
import { createSemctxServer } from "../src/server";
import { TOOL_OUTPUT_SCHEMAS } from "../src/tool-output-schemas";

describe("CLI compatibility MCP transport", () => {
  let server: McpServer | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    await server?.close();
  });

  test("projects the shared report without exposing the executable path", () => {
    const report = cliCompatibilityTool(() => ({
      found: true,
      path: "C:\\private\\bin\\semctx.cmd",
      version: "0.1.16",
      requiredVersion: "0.1.17",
      compatible: false,
      reason: "CLI_VERSION_MISMATCH",
      upgradeCommand: "bun install -g semctx@0.1.17",
    }));

    expect(report).toEqual({
      schemaVersion: 1,
      kind: "cli_compatibility",
      found: true,
      version: "0.1.16",
      requiredVersion: "0.1.17",
      compatible: false,
      reason: "CLI_VERSION_MISMATCH",
      upgradeCommand: "bun install -g semctx@0.1.17",
    });
    expect(report).not.toHaveProperty("path");
  });

  test("registers one read-only tool with validated structured output", async () => {
    server = createSemctxServer(process.cwd());
    client = new Client({ name: "semctx-cli-compatibility-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "semctx_cli_compatibility");
    expect(tool?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tool?.inputSchema.required).toContain("repositoryRoot");

    const response = await client.callTool({
      name: "semctx_cli_compatibility",
      arguments: { repositoryRoot: process.cwd() },
    });
    expect(response.isError).not.toBe(true);
    expect(
      TOOL_OUTPUT_SCHEMAS.semctx_cli_compatibility.safeParse(response.structuredContent).success,
    ).toBe(true);
    const text = response.content.find((item) => item.type === "text")?.text;
    expect(text).toBeDefined();
    expect(JSON.parse(text ?? "null")).toEqual(response.structuredContent);
    expect(response.structuredContent).not.toHaveProperty("path");
  });
});
