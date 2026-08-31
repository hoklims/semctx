import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { resolve } from "node:path";

const MODERN_STDIO_TIMEOUT_MS = 60_000;

function stdioEnvironment(overrides: Record<string, string>): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return Object.assign(environment, overrides);
}

function stdioTransport(repositoryRoot: string): StdioClientTransport {
  const entrypoint = resolve(import.meta.dir, "../src/index.ts");
  return new StdioClientTransport({
    command: "bun",
    args: [entrypoint],
    cwd: repositoryRoot,
    env: stdioEnvironment({ SEMCTX_ROOT: repositoryRoot }),
    stderr: "pipe",
  });
}

describe("MCP dual-era stdio negotiation", () => {
  test(
    "negotiates 2026-07-28 and publishes private catalogue cache hints",
    async () => {
      const repositoryRoot = resolve(import.meta.dir, "../../..");
      const transport = stdioTransport(repositoryRoot);
      const client = new Client(
        { name: "semctx-modern-stdio-test", version: "0.1.0" },
        {
          versionNegotiation: {
            mode: { pin: "2026-07-28" },
            probe: { timeoutMs: 10_000 },
          },
        },
      );

      try {
        await client.connect(transport);
        const discovery = client.getDiscoverResult() as
          | { ttlMs?: number; cacheScope?: string }
          | undefined;
        const result = await client.listTools();
        const cacheable = result as typeof result & {
          ttlMs?: number;
          cacheScope?: string;
        };
        const toolResult = await client.callTool({
          name: "semctx_semantic_check",
          arguments: { repositoryRoot },
        });
        const nonCacheableToolResult = toolResult as typeof toolResult & {
          ttlMs?: number;
          cacheScope?: string;
        };

        expect(discovery?.ttlMs).toBe(300_000);
        expect(discovery?.cacheScope).toBe("private");
        expect(result.tools).toHaveLength(38);
        expect(result.tools.some((tool) => tool.name === "semctx_index_health")).toBe(true);
        expect(result.tools.some((tool) => tool.name === "semctx_cli_compatibility")).toBe(true);
        expect(cacheable.ttlMs).toBe(300_000);
        expect(cacheable.cacheScope).toBe("private");
        expect(nonCacheableToolResult.ttlMs).toBeUndefined();
        expect(nonCacheableToolResult.cacheScope).toBeUndefined();
      } finally {
        await client.close();
      }
    },
    MODERN_STDIO_TIMEOUT_MS,
  );

  test(
    "continues to serve the 2025-era stdio handshake",
    async () => {
      const repositoryRoot = resolve(import.meta.dir, "../../..");
      const transport = stdioTransport(repositoryRoot);
      const client = new Client(
        { name: "semctx-legacy-stdio-test", version: "0.1.0" },
        { versionNegotiation: { mode: "legacy" } },
      );

      try {
        await client.connect(transport);
        const result = await client.listTools();
        const invalid = await client.callTool({
          name: "semctx_semantic_check",
          arguments: { repositoryRoot: "." },
        });
        const serialized =
          invalid.content.find((item) => item.type === "text")?.text ?? "";

        expect(result.tools).toHaveLength(38);
        expect(result.tools.some((tool) => tool.name === "semctx_index_health")).toBe(true);
        expect(result.tools.some((tool) => tool.name === "semctx_cli_compatibility")).toBe(true);
        expect(result.tools.some((tool) => tool.name === "semctx_control_explorer")).toBe(true);
        expect(invalid.isError).toBe(true);
        expect(invalid.structuredContent).toBeUndefined();
        expect(JSON.parse(serialized)).toEqual({
          code: "INVALID_ARGUMENTS",
          error: "Tool arguments are invalid",
        });
      } finally {
        await client.close();
      }
    },
    MODERN_STDIO_TIMEOUT_MS,
  );

  test(
    "serves the same canonical failure for read-only and writer tools over 2026 stdio",
    async () => {
      const repositoryRoot = resolve(import.meta.dir, "../../..");
      const missingRoot = resolve(
        repositoryRoot,
        "__missing_modern_stdio_repository__",
      );
      const transport = stdioTransport(repositoryRoot);
      const client = new Client(
        { name: "semctx-modern-stdio-error-test", version: "0.1.0" },
        {
          versionNegotiation: {
            mode: { pin: "2026-07-28" },
            probe: { timeoutMs: 10_000 },
          },
        },
      );

      try {
        await client.connect(transport);
        const readOnlyError = await client.callTool({
          name: "semctx_control_status",
          arguments: { repositoryRoot: missingRoot },
        });
        const writerError = await client.callTool({
          name: "semctx_change_open",
          arguments: {
            repositoryRoot: missingRoot,
            id: "change.stdio-error-contract",
            statement: "Exercise the shared stdio error boundary.",
          },
        });
        const text = readOnlyError.content.find(
          (item) => item.type === "text",
        );
        const payload = JSON.parse(
          text?.type === "text" ? text.text : "{}",
        ) as { code?: unknown; error?: unknown };
        const serialized = text?.type === "text" ? text.text : "";

        expect(readOnlyError.isError).toBe(true);
        expect(readOnlyError.structuredContent).toBeUndefined();
        expect(writerError.isError).toBe(true);
        expect(writerError.structuredContent).toBeUndefined();
        expect(writerError.content).toEqual(readOnlyError.content);
        expect(payload.code).toBe("REPOSITORY_ROOT_UNAVAILABLE");
        expect(typeof payload.error).toBe("string");
        expect((payload.error as string).length).toBeLessThanOrEqual(512);
        expect(payload.error).toContain("repository root");
        expect(serialized).not.toContain(missingRoot);
      } finally {
        await client.close();
      }
    },
    MODERN_STDIO_TIMEOUT_MS,
  );

  test(
    "bounds invalid tool input behind the canonical 2026 stdio envelope",
    async () => {
      const repositoryRoot = resolve(import.meta.dir, "../../..");
      const transport = stdioTransport(repositoryRoot);
      const client = new Client(
        { name: "semctx-modern-stdio-input-error-test", version: "0.1.0" },
        {
          versionNegotiation: {
            mode: { pin: "2026-07-28" },
            probe: { timeoutMs: 10_000 },
          },
        },
      );

      try {
        await client.connect(transport);
        const result = await client.callTool({
          name: "semctx_control_impact",
          arguments: {
            repositoryRoot,
            sourceIds: Array.from(
              { length: 1_000 },
              () => ({ invalid: true }),
            ),
          },
        });
        const serialized =
          result.content.find((item) => item.type === "text")?.text ?? "";

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
        expect(serialized.length).toBeLessThanOrEqual(4_096);
        expect(JSON.parse(serialized)).toEqual({
          code: "INVALID_ARGUMENTS",
          error: "Tool arguments are invalid",
        });
      } finally {
        await client.close();
      }
    },
    MODERN_STDIO_TIMEOUT_MS,
  );

  test(
    "handshakes when SEMCTX_ROOT is an unexpanded host placeholder",
    async () => {
      const repositoryRoot = resolve(import.meta.dir, "../../..");
      const entrypoint = resolve(import.meta.dir, "../src/index.ts");
      const transport = new StdioClientTransport({
        command: "bun",
        args: [entrypoint],
        cwd: repositoryRoot,
        env: stdioEnvironment({ SEMCTX_ROOT: "${CLAUDE_PROJECT_DIR}" }),
        stderr: "pipe",
      });
      const client = new Client(
        { name: "semctx-unexpanded-root-stdio-test", version: "0.1.0" },
        {
          versionNegotiation: {
            mode: { pin: "2026-07-28" },
            probe: { timeoutMs: 10_000 },
          },
        },
      );

      try {
        await client.connect(transport);
        const result = await client.listTools();
        const check = await client.callTool({
          name: "semctx_semantic_check",
          arguments: { repositoryRoot },
        });

        expect(result.tools.length).toBeGreaterThan(0);
        expect(result.tools.some((tool) => tool.name === "semctx_semantic_check")).toBe(
          true,
        );
        expect(check.isError).not.toBe(true);
      } finally {
        await client.close();
      }
    },
    MODERN_STDIO_TIMEOUT_MS,
  );
});
