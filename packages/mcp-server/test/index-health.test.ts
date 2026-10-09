import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { indexHealthView, indexRepository } from "@semantic-context/app-services";
import { initWorkspace } from "@semantic-context/repository-store";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod-v4";
import { indexHealthTool } from "../src/control-tools";
import { createSemctxServer } from "../src/server";
import { ToolRegistrar } from "../src/tool-contract";

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
    const expected = indexHealthView(root);

    expect(indexHealthTool(root)).toEqual(expected);
    expect(JSON.stringify(indexHealthTool(root))).toBe(JSON.stringify(expected));
  });

  test("bounds the MCP response on 1,000 synthetic files and keeps later calls available", async () => {
    root = mkdtempSync(join(tmpdir(), "semctx-index-health-bounded-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), '{"name":"synth","version":"1.0.0","type":"module"}\n');
    for (let index = 0; index < 1_000; index += 1) {
      writeFileSync(join(root, `src/m${index}.ts`), `export const value${index} = (x: number): number => x + ${index};\n`);
    }
    for (const args of [
      ["init", "-q"],
      ["add", "--", "package.json", "src"],
      ["-c", "user.name=synth", "-c", "user.email=synth@example.test", "commit", "-qm", "init"],
    ]) {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    }
    initWorkspace(root);
    indexRepository(root, "2026-10-08T00:00:00.000Z");
    server = createSemctxServer(root);
    client = new Client({ name: "semctx-size-regression", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({ name: "semctx_index_health", arguments: { repositoryRoot: root } });
    expect(response.isError).not.toBe(true);
    expect(Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: 2, result: response }))).toBeLessThanOrEqual(256 * 1024);
    expect(response.structuredContent).toMatchObject({
      schemaVersion: 2,
      coverage: { candidates: 1_001, analyzed: 1_000, status: "partial" },
      page: null,
    });
    expect((await client.callTool({ name: "semctx_control_status", arguments: { repositoryRoot: root } })).isError).not.toBe(true);
    for (const mode of ["legacy", { pin: "2026-07-28" }] as const) {
      const stdioClient = new Client({ name: "semctx-bounded-stdio", version: "1" }, {
        versionNegotiation: { mode },
      });
      const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [resolve(import.meta.dir, "../src/index.ts")],
        cwd: root,
        env: { ...environment, SEMCTX_ROOT: root },
        stderr: "pipe",
      });
      try {
        await stdioClient.connect(transport);
        const summary = await stdioClient.callTool({ name: "semctx_index_health", arguments: { repositoryRoot: root } });
        expect(summary.isError).not.toBe(true);
        expect(summary.structuredContent).toEqual(response.structuredContent);
        const page = await stdioClient.callTool({ name: "semctx_index_health", arguments: { repositoryRoot: root, section: "evaluations", limit: 100 } });
        expect(page.isError).not.toBe(true);
        expect(Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: 3, result: page }))).toBeLessThanOrEqual(256 * 1024);
        expect(page.structuredContent).toEqual(indexHealthView(root, { section: "evaluations", limit: 100 }));
        const data = page.structuredContent as { page: { nextCursor: string } };
        const next = await stdioClient.callTool({ name: "semctx_index_health", arguments: {
          repositoryRoot: root, section: "evaluations", cursor: data.page.nextCursor, limit: 100,
        } });
        expect(next.isError).not.toBe(true);
        expect(next.structuredContent).toEqual(indexHealthView(root, { section: "evaluations", cursor: data.page.nextCursor, limit: 100 }));
        expect((await stdioClient.callTool({ name: "semctx_control_status", arguments: { repositoryRoot: root } })).isError).not.toBe(true);
      } finally {
        await stdioClient.close();
      }
    }
  }, 60_000);

  test("lists read-only metadata and returns the same report through MCP", async () => {
    root = mkdtempSync(join(tmpdir(), "semctx-index-health-mcp-"));
    server = createSemctxServer(root);
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
    type ObjectSchema = {
      properties?: Record<string, { description?: string; const?: unknown }>;
      required?: string[];
    };
    // The V2 summary and the typed budget timeout are the two advertised result shapes.
    const variants = (tool?.outputSchema as { anyOf?: ObjectSchema[] }).anyOf ?? [];
    expect(variants).toHaveLength(2);
    const outputSchema = variants.find((variant) => variant.properties?.["binding"] !== undefined)!;
    const timeoutSchema = variants.find((variant) => variant.properties?.["budget"] !== undefined)!;
    expect(timeoutSchema.properties?.["status"]?.const).toBe("timeout");
    expect(timeoutSchema.required).toEqual(expect.arrayContaining(["status", "reason", "budget", "remedy"]));
    expect(schema.properties?.["repositoryRoot"]).toBeDefined();
    expect(schema.required).toContain("repositoryRoot");
    expect(outputSchema.properties?.["binding"]?.description).toContain(
      "integrity binding",
    );
    expect(outputSchema.properties?.["freshness"]?.description).toContain(
      "separately from analysis coverage",
    );
    expect(outputSchema.properties?.["coverage"]?.description).toContain(
      "does not imply freshness or authority",
    );
    expect(outputSchema.required).toContain("evaluations");

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
    const expected = indexHealthView(root);
    expect(block.text).toContain("Index health: blocked");
    expect(block.text).toContain("structuredContent");
    expect(block.text.length).toBeLessThan(512);
    expect(() => JSON.parse(block.text)).toThrow();
    expect(response.structuredContent).toEqual(expected);
  });

  test("rejects an unavailable root through the sanitized registrar boundary", async () => {
    root = mkdtempSync(join(tmpdir(), "semctx-index-health-root-"));
    server = createSemctxServer(root);
    client = new Client({ name: "semctx-index-health-root-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const unavailableRoot = resolve(root, "__private_missing_repository__");
    const response = await client.callTool({
      name: "semctx_index_health",
      arguments: { repositoryRoot: unavailableRoot },
    });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toBeUndefined();
    const serialized = response.content.find((item) => item.type === "text")?.text;
    expect(serialized).toBe(JSON.stringify({
      code: "REPOSITORY_ROOT_UNAVAILABLE",
      error: "repository root does not exist or is not accessible",
    }));
    expect(serialized).not.toContain(unavailableRoot);
  });

  test.each([
    { character: "x", structured: false }, { character: "\"", structured: false },
    { character: "💾", structured: false }, { character: "💾", structured: true },
  ])("enforces the final UTF-8 result budget for %p", async ({ character, structured }) => {
    server = new McpServer({ name: "semctx-response-budget", version: "1" });
    const registrar = new ToolRegistrar(server);
    registrar.registerTool("semctx_index_health", {
      inputSchema: {},
      outputSchema: z.object({ payload: z.string() }),
    }, () => {
      const payload = { payload: character.repeat(300_000) };
      return structured
        ? { structuredContent: payload, content: [{ type: "text", text: "Brief result" }] }
        : { content: [{ type: "text", text: JSON.stringify(payload) }] };
    });
    client = new Client({ name: "semctx-response-budget-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({ name: "semctx_index_health", arguments: {} });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toBeUndefined();
    expect(response.content).toEqual([{ type: "text", text: JSON.stringify({
      code: "INDEX_HEALTH_RESPONSE_TOO_LARGE",
      error: "Index health summary or detail entry exceeds the response byte limit; use CLI index-health --json for the full report",
    }) }]);
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(1_024);
  });

  test("validates the supplied structured health result without replacing it with JSON text", async () => {
    server = new McpServer({ name: "semctx-health-result-validation", version: "1" });
    const registrar = new ToolRegistrar(server);
    registrar.registerTool("semctx_index_health", {
      inputSchema: {},
      outputSchema: z.object({ value: z.string() }),
    }, () => ({ structuredContent: { value: 42 }, content: [{ type: "text", text: '{"value":"valid"}' }] }));
    client = new Client({ name: "semctx-health-result-validation-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({ name: "semctx_index_health", arguments: {} });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toBeUndefined();
    expect(response.content).toEqual([{ type: "text", text: '{"code":"INVALID_OUTPUT","error":"Tool output did not match its public contract"}' }]);
  });

  test.each([
    { section: "unknown" }, { section: "candidates", limit: 101 },
    { section: "candidates", limit: 0 }, { section: "candidates", limit: 1.5 },
    { cursor: "invalid" }, { limit: 1 },
    { section: "candidates", cursor: "invalid" },
  ])("rejects invalid detail requests with bounded catalogue errors: %p", async (request) => {
    root = mkdtempSync(join(tmpdir(), "semctx-index-health-input-"));
    server = createSemctxServer(root);
    client = new Client({ name: "semctx-index-health-input", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({ name: "semctx_index_health", arguments: { repositoryRoot: root, ...request } });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(1_024);
  });
});
