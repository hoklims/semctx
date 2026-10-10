import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlStatusExplained, indexHealthView, indexRepository } from "@semantic-context/app-services";
import { initWorkspace } from "@semantic-context/repository-store";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { boundedControlStatus, boundedIndexHealth } from "../src/bounded-call";
import { createSemctxServer } from "../src/server";
import { TOOL_OUTPUT_SCHEMAS } from "../src/tool-output-schemas";

let root: string;

function git(args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "semctx-bounded-preflight-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "package.json"), '{"name":"bounded","version":"1.0.0","type":"module"}\n');
  writeFileSync(join(root, "src/a.ts"), "export const a = (x: number): number => x + 1;\n");
  git(["init", "-q"]);
  git(["add", "--", "package.json", "src"]);
  git(["-c", "user.name=bounded", "-c", "user.email=bounded@example.test", "commit", "-qm", "init"]);
  initWorkspace(root);
  indexRepository(root, "2026-10-09T00:00:00.000Z");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("budgeted MCP preflights", () => {
  test("a finished status is the in-process explained status, schema-valid", async () => {
    const bounded = await boundedControlStatus(root, 60_000);
    expect(bounded).toEqual(controlStatusExplained(root));
    expect(TOOL_OUTPUT_SCHEMAS.semctx_control_status.safeParse(bounded).success).toBe(true);
  }, 90_000);

  test("a finished index health is the in-process V2 view, schema-valid", async () => {
    const bounded = await boundedIndexHealth(root, {}, 60_000);
    expect(bounded).toEqual(indexHealthView(root));
    expect(TOOL_OUTPUT_SCHEMAS.semctx_index_health.safeParse(bounded).success).toBe(true);
  }, 90_000);

  test("a status past its budget is a typed TIMEOUT within the budget, not a hung or closed call", async () => {
    const started = performance.now();
    const report = await boundedControlStatus(root, 50);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(report).toMatchObject({ verdict: "TIMEOUT", canRunHighRiskControl: false, reasons: ["STATUS_BUDGET_EXCEEDED"], freshnessSeal: null });
    expect(TOOL_OUTPUT_SCHEMAS.semctx_control_status.safeParse(report).success).toBe(true);
  });

  test("an index health past its budget is a typed timeout that reports nothing as healthy", async () => {
    const report = await boundedIndexHealth(root, {}, 50);
    expect(report).toMatchObject({ kind: "index_health", status: "timeout", reason: "HEALTH_BUDGET_EXCEEDED" });
    expect(TOOL_OUTPUT_SCHEMAS.semctx_index_health.safeParse(report).success).toBe(true);
  });

  test("child errors keep their public catalogue code", async () => {
    const failure = await boundedIndexHealth(root, { cursor: "x" }, 60_000).then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({ code: "INVALID_TASK_INPUT" });
  }, 90_000);

  test("the MCP tools answer consecutive and concurrent calls with typed verdicts", async () => {
    const server = createSemctxServer(root);
    const client = new Client({ name: "semctx-bounded", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tooSmall = await client.callTool({ name: "semctx_control_status", arguments: { repositoryRoot: root, budgetMs: 10 } });
      expect(tooSmall.isError).toBe(true);
      const [health, status] = await Promise.all([
        client.callTool({ name: "semctx_index_health", arguments: { repositoryRoot: root, budgetMs: 60_000 } }),
        client.callTool({ name: "semctx_control_status", arguments: { repositoryRoot: root, budgetMs: 60_000 } }),
      ]);
      expect(health.isError).not.toBe(true);
      expect(status.isError).not.toBe(true);
      expect(status.structuredContent).toEqual(controlStatusExplained(root));
      expect((status.structuredContent as { explanation: unknown[] }).explanation).toBeArray();
      const again = await client.callTool({ name: "semctx_control_status", arguments: { repositoryRoot: root } });
      expect(again.structuredContent).toEqual(status.structuredContent);
    } finally {
      await client.close();
      await server.close();
    }
  }, 120_000);
});
