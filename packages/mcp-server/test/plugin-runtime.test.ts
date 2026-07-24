import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository } from "@semantic-context/app-services";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";

const repoRoot = resolve(import.meta.dir, "../../..");
const pluginDist = resolve(repoRoot, "plugins/semctx-control/dist");
const temporary: string[] = [];

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("packaged MCP runtime", () => {
  test("starts outside the checkout and targets an explicit Codex repository root", async () => {
    const cache = mkdtempSync(resolve(tmpdir(), "semctx-plugin-cache-"));
    const target = mkdtempSync(resolve(tmpdir(), "semctx-plugin-target-"));
    temporary.push(cache, target);
    const packagedDist = resolve(cache, "dist");
    cpSync(pluginDist, packagedDist, { recursive: true });
    const bundle = resolve(packagedDist, "semctx-mcp.js");
    const runtime = readFileSync(bundle, "utf8");
    expect(runtime).not.toContain(JSON.stringify(repoRoot).slice(1, -1));
    expect(runtime).not.toMatch(/typescript@[^"']+node_modules[^"']+typescript[^"']+lib/);
    cpSync(SAMPLE_REPO, target, { recursive: true, filter: (src) => !src.includes(".semctx") && !src.includes("node_modules") });
    git(target, "init");
    initWorkspace(target);
    git(target, "add", ".");
    git(target, "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "commit", "-m", "fixture");
    indexRepository(target, "2026-07-20T00:00:00.000Z");

    const environment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    delete environment["SEMCTX_ROOT"];
    const transport = new StdioClientTransport({ command: "bun", args: [bundle], cwd: cache, env: environment, stderr: "pipe" });
    const client = new Client({ name: "semctx-packaged-runtime-test", version: "0.1.0" });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(26);
      expect(tools.some((tool) => tool.name === "semctx_semantic_check")).toBe(true);
      expect(tools.some((tool) => tool.name === "semctx_change_close")).toBe(true);
      expect(tools.some((tool) => tool.name === "semctx_control_plan_change")).toBe(true);
      expect(tools.some((tool) => tool.name === "semctx_control_reconcile_diff")).toBe(true);
      expect(tools.some((tool) => tool.name === "control_authorize_transition")).toBe(true);
      expect(tools.some((tool) => tool.name === "control_authorize_step")).toBe(true);
      expect(tools.some((tool) => tool.name === "control_authorize_deletion")).toBe(true);
      const status = await client.callTool({
        name: "semctx_control_status",
        arguments: { repositoryRoot: target },
      });
      expect(status.isError).not.toBe(true);
      if (!Array.isArray(status.content)) throw new Error("MCP status content must be an array");
      const statusBlock = status.content[0];
      if (typeof statusBlock !== "object" || statusBlock === null || !("type" in statusBlock)) {
        throw new Error("MCP status must contain a typed content block");
      }
      const statusPayload = JSON.parse(
        statusBlock.type === "text" && "text" in statusBlock && typeof statusBlock.text === "string"
          ? statusBlock.text
          : "{}",
      );
      expect(statusPayload.verdict).toBe("FRESH");
      const response = await client.callTool({
        name: "semctx_verify_change",
        arguments: { repositoryRoot: target, gitDiff: "diff --git a/noop.ts b/noop.ts" },
      });
      expect(response.isError).not.toBe(true);
      if (!Array.isArray(response.content)) throw new Error("MCP response content must be an array");
      const first = response.content[0];
      if (typeof first !== "object" || first === null || !("type" in first)) {
        throw new Error("MCP response must contain a typed content block");
      }
      expect(first?.type).toBe("text");
      const payload = JSON.parse(first.type === "text" && "text" in first && typeof first.text === "string" ? first.text : "{}");
      expect(payload.schemaVersion).toBe(1);
      expect(payload.head).toBe("(provided)");
    } finally {
      await client.close();
    }
  });
});
