import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createGlobSelectionConfig, type SemctxConfigV2 } from "@semantic-context/core";
import { fingerprintRepositoryFacts, indexHealthView, indexRepository, type IndexHealthReportV2 } from "@semantic-context/app-services";
import { initWorkspace, openReader } from "@semantic-context/repository-store";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

/**
 * One real stdio MCP child process, connected once, must observe an index rebuilt by a SEPARATE
 * Bun process without ever being reconnected or restarted — the same session has to see stale
 * facts replaced by fresh ones on its next request, not a cached first response.
 */

const REPO_ROOT = process.cwd();
const MCP_TIMEOUT_MS = 60_000;
const roots: string[] = [];

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

function gitOutput(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function commitAll(root: string, message: string): void {
  git(root, "add", "-A");
  git(root, "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "commit", "-q", "-m", message);
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeFile(root: string, relPath: string, content: string): void {
  const absPath = join(root, ...relPath.split("/"));
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, "utf8");
}

function v2Config(root: string): SemctxConfigV2 {
  return { ...createGlobSelectionConfig(root), include: ["src/**/*.ts"] };
}

function ignoreSemctx(root: string): void {
  writeFileSync(join(root, ".gitignore"), ".semctx/\n", "utf8");
}

function stdioEnvironment(overrides: Record<string, string>): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return Object.assign(environment, overrides);
}

/** Rebuild is deliberately performed by a SEPARATE process, importing the same production source. */
function rebuildChildSource(): string {
  return `
    import { indexRepository } from "./packages/app-services/src/indexing.ts";
    const root = process.argv[1];
    const indexedAt = process.argv[2];
    indexRepository(root, indexedAt);
  `;
}

function rebuildInSeparateChild(root: string, indexedAt: string): void {
  const result = Bun.spawnSync(
    [process.execPath, "-e", rebuildChildSource(), root, indexedAt],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe", timeout: MCP_TIMEOUT_MS / 2 },
  );
  if (result.exitCode !== 0) {
    throw new Error(`rebuild child failed: ${new TextDecoder().decode(result.stderr)}`);
  }
}

interface TextToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

function jsonText<T = Record<string, unknown>>(result: TextToolResult): T {
  expect(result.isError).not.toBe(true);
  const text = result.content.find((item) => item.type === "text")?.text;
  if (text === undefined) throw new Error("missing MCP text result");
  return JSON.parse(text) as T;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("persistent MCP process observes an out-of-process index rebuild", () => {
  test(
    "the same connected stdio session sees the old symbol replaced by the new one after a separate rebuild",
    async () => {
      const root = tempRoot("semctx-persistent-mcp-");
      ignoreSemctx(root);
      git(root, "init", "-q", "-b", "main");
      writeFile(root, "src/old.ts", ["export function oldSymbol(): number {", "  return 1;", "}", ""].join("\n"));
      commitAll(root, "fixture with old symbol");
      initWorkspace(root, v2Config(root));

      const capturedAtOld = "2026-09-01T09:00:00.000Z";
      indexRepository(root, capturedAtOld);
      const headBefore = gitOutput(root, "rev-parse", "HEAD");

      // The real SOURCE MCP entrypoint (not the packaged plugin transport), unbound: repositoryRoot
      // is supplied explicitly on every call rather than pinned via SEMCTX_ROOT.
      const entrypoint = resolve(import.meta.dir, "../src/index.ts");
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [entrypoint],
        cwd: REPO_ROOT,
        env: stdioEnvironment({ SEMCTX_ROOT: "" }),
        stderr: "inherit",
      });
      const client = new Client({ name: "semctx-persistent-refresh-test", version: "0.1.0" });

      try {
        await client.connect(transport);
        const persistentPid = transport.pid;
        expect(persistentPid).toBeNumber();
        expect(persistentPid).not.toBe(process.pid);

        const oldInspect = jsonText(await client.callTool({
          name: "semctx_inspect",
          arguments: { repositoryRoot: root, query: "oldSymbol", kind: "symbol" },
        }) as TextToolResult);
        const oldMatched = (oldInspect["matchedNodes"] as Array<{ name?: string }> | undefined) ?? [];
        expect(oldMatched.some((node) => node.name === "oldSymbol")).toBe(true);

        const oldHealthResponse = await client.callTool({
          name: "semctx_index_health",
          arguments: { repositoryRoot: root },
        });
        expect(oldHealthResponse.isError).not.toBe(true);
        const oldHealth = oldHealthResponse.structuredContent as IndexHealthReportV2;
        expect(oldHealth.capturedAt).toBe(capturedAtOld);
        expect(oldHealth.binding?.status).toBe("valid");
        expect(oldHealth).toEqual(indexHealthView(root));

        const readerBefore = openReader(root);
        const indexedCommitBefore = readerBefore.getMeta("indexed_commit");
        const graphHashBefore = readerBefore.getMeta("indexed_repository_graph_hash");
        const computedHashBefore = fingerprintRepositoryFacts({ graph: readerBefore.loadGraph(), evidence: readerBefore.loadEvidence(), claims: readerBefore.loadClaims() });
        readerBefore.close();
        expect(indexedCommitBefore).toBe(headBefore);
        expect(graphHashBefore).toBe(computedHashBefore);

        // Mutually exclusive source change, committed to a new HEAD.
        rmSync(join(root, "src", "old.ts"));
        writeFile(root, "src/new.ts", ["export function newSymbol(): number {", "  return 2;", "}", ""].join("\n"));
        commitAll(root, "swap to new symbol");
        const headAfter = gitOutput(root, "rev-parse", "HEAD");
        expect(headAfter).not.toBe(headBefore);

        const capturedAtNew = "2026-09-01T09:05:00.000Z";
        rebuildInSeparateChild(root, capturedAtNew);

        const readerAfter = openReader(root);
        const indexedCommitAfter = readerAfter.getMeta("indexed_commit");
        const graphHashAfter = readerAfter.getMeta("indexed_repository_graph_hash");
        const computedHashAfter = fingerprintRepositoryFacts({ graph: readerAfter.loadGraph(), evidence: readerAfter.loadEvidence(), claims: readerAfter.loadClaims() });
        readerAfter.close();
        expect(indexedCommitAfter).toBe(headAfter);
        expect(indexedCommitAfter).not.toBe(indexedCommitBefore);
        expect(graphHashAfter).not.toBe(graphHashBefore);
        expect(graphHashAfter).toBe(computedHashAfter);

        // Same client, same transport, same child process — no reconnect, no restart.
        const newInspectOld = jsonText(await client.callTool({
          name: "semctx_inspect",
          arguments: { repositoryRoot: root, query: "oldSymbol", kind: "symbol" },
        }) as TextToolResult);
        const newMatchedOld = (newInspectOld["matchedNodes"] as Array<{ name?: string }> | undefined) ?? [];
        expect(newMatchedOld.some((node) => node.name === "oldSymbol")).toBe(false);

        const newInspectNew = jsonText(await client.callTool({
          name: "semctx_inspect",
          arguments: { repositoryRoot: root, query: "newSymbol", kind: "symbol" },
        }) as TextToolResult);
        const newMatchedNew = (newInspectNew["matchedNodes"] as Array<{ name?: string }> | undefined) ?? [];
        expect(newMatchedNew.some((node) => node.name === "newSymbol")).toBe(true);

        const newHealthResponse = await client.callTool({
          name: "semctx_index_health",
          arguments: { repositoryRoot: root },
        });
        expect(newHealthResponse.isError).not.toBe(true);
        const newHealth = newHealthResponse.structuredContent as IndexHealthReportV2;
        expect(newHealth.capturedAt).toBe(capturedAtNew);
        expect(newHealth.capturedAt).not.toBe(oldHealth.capturedAt);
        expect(newHealth.binding?.status).toBe("valid");
        expect(newHealth).toEqual(indexHealthView(root));
        expect(transport.pid).toBe(persistentPid);
      } finally {
        await client.close();
        await transport.close();
      }
    },
    MCP_TIMEOUT_MS,
  );
});
