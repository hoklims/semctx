import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { planSetupRepository } from "@semantic-context/app-services";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { DISCOVERY_CANDIDATE_REASONS } from "@semantic-context/ts-analyzer";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { setupTool, isSetupAgentSuccess } from "../src/setup-tools";
import { TOOL_OUTPUT_SCHEMAS } from "../src/tool-output-schemas";

const roots: string[] = [];
function qualifiedFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-scope-mcp-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "build"));
  writeFileSync(join(root, "src/index.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "build/generated.ts"), "export const generated = 1;\n");
  writeFileSync(join(root, ".gitignore"), "build/\n.semctx/\n");
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  }
  initWorkspace(root, {
    ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1",
    analysisProfile: "modelo-suite-static-v1", include: ["src/**/*.ts"],
    languages: { typescript: "on", javascript: "on" },
  });
  return root;
}

test("qualified setup scope validates actual ignored generated output through MCP", () => {
  const root = qualifiedFixture();
  const plan = planSetupRepository(root);
  if (plan.kind !== "setup_plan") throw new Error("unexpected refusal");
  const preflight = setupTool(root);
  if (preflight.kind !== "setup_preflight") throw new Error("unexpected response");
  expect(preflight.scope).toEqual(plan.scope);
  expect(preflight.scope?.reasonCounts).toContainEqual({ reason: "IGNORED_GENERATED_OUTPUT", count: 1 });
  expect(preflight.scope?.proposedIncludes).not.toContain("build/generated.ts");
  const cli = Bun.spawnSync([process.execPath, join(import.meta.dir, "../../../apps/cli/src/index.ts"), "setup", "--root", root, "--dry-run", "--json"], { stdout: "pipe", stderr: "pipe" });
  expect(cli.exitCode, new TextDecoder().decode(cli.stderr)).toBe(0);
  expect(JSON.parse(new TextDecoder().decode(cli.stdout)).scope).toEqual(preflight.scope);
  expect(TOOL_OUTPUT_SCHEMAS.semctx_setup.safeParse(preflight).success).toBe(true);
  const reasonCounts = DISCOVERY_CANDIDATE_REASONS.map((reason) => ({ reason, count: 1 }));
  expect(reasonCounts).toHaveLength(11);
  const scope = { ...preflight.scope!, reasonCounts, roots: preflight.scope!.roots.map((entry) => ({ ...entry, reasonCounts })) };
  const schema = TOOL_OUTPUT_SCHEMAS.semctx_setup;
  expect(schema.safeParse({ ...preflight, scope }).success).toBe(true);
  expect(schema.safeParse({ ...preflight, scope: { ...scope, reasonCounts: [...reasonCounts, reasonCounts[0]] } }).success).toBe(false);
  expect(schema.safeParse({ ...preflight, scope: { ...scope, roots: [{ ...scope.roots[0], reasonCounts: [...reasonCounts, reasonCounts[0]] }] } }).success).toBe(false);
  expect(schema.safeParse({ ...preflight, scope: { ...scope, reasonCounts: [{ reason: "UNKNOWN_REASON", count: 1 }] } }).success).toBe(false);
  expect(schema.safeParse({ ...preflight, scope: { ...scope, roots: [{ ...scope.roots[0], reasonCounts: [{ reason: "UNKNOWN_REASON", count: 1 }] }] } }).success).toBe(false);
});

test("qualified generated output survives MCP stdio preflight through an aliased root", async () => {
  const root = qualifiedFixture();
  const aliasParent = mkdtempSync(join(tmpdir(), "semctx-scope-mcp-"));
  roots.push(aliasParent);
  const requestedRoot = join(aliasParent, "repository");
  // Exercise canonicalization on every host, including macOS's /var -> /private/var.
  symlinkSync(root, requestedRoot, process.platform === "win32" ? "junction" : "dir");
  const client = new Client({ name: "semctx-scope-contract", version: "0.1.0" });
  try {
    const canonicalRoot = realpathSync.native(requestedRoot);
    expect(canonicalRoot).not.toBe(requestedRoot);
    await client.connect(new StdioClientTransport({
      command: "bun", args: [join(import.meta.dir, "../src/index.ts")],
      cwd: join(import.meta.dir, "../../.."), stderr: "pipe",
    }));
    const response = await client.callTool({ name: "semctx_setup", arguments: { repositoryRoot: requestedRoot } });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toEqual(setupTool(canonicalRoot));
  } finally {
    try {
      await client.close();
    } finally {
      unlinkSync(requestedRoot);
    }
  }
}, 30_000);
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(tmpdir(), "semctx-scope-mcp-"))) throw new Error("unsafe fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});
test("MCP preflight and confirm share scope without auto-confirm or readiness promotion", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-scope-mcp-"));
  roots.push(root);
  for (const file of ["apps/host/src/index.ts", "domains/sample/api/src/index.ts", "domains/sample/web/src/index.ts", "platform/shared/src/index.ts"]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "export const value = 1;\n");
  }
  const plan = planSetupRepository(root, { polyglot: true });
  if (plan.kind !== "setup_plan") throw new Error("unexpected refusal");
  const preflight = setupTool(root, { polyglot: true });
  if (preflight.kind !== "setup_preflight") throw new Error("unexpected response");
  expect(preflight.scope).toEqual(plan.scope);
  expect(preflight.next.arguments).not.toHaveProperty("confirm");
  expect(isSetupAgentSuccess(preflight)).toBe(false);
  expect(existsSync(join(root, ".semctx"))).toBe(false);
  const schema = TOOL_OUTPUT_SCHEMAS.semctx_setup;
  expect(schema.safeParse(preflight).success).toBe(true);
  const { scope: _scope, ...oldPayload } = preflight;
  expect(schema.safeParse(oldPayload).success).toBe(true);
  for (const patch of [
    { applyRequired: false }, { counts: { observed: -1, selected: 1, excluded: 3, unavailable: 0 } },
    { proposedIncludes: ["domains/**/*.ts"] }, { proposedIncludes: ["../outside.ts"] },
    { proposedIncludes: ["界".repeat(81) + ".ts"] }, { proposedIncludes: Array(21).fill("a.ts") },
    { roots: [{ ...preflight.scope!.roots[0], unexpected: true }] },
    { reasonCounts: [{ reason: "FAKE", count: 1 }] }, { sourceFamilies: ["typescript", "sql"] }, { extra: true },
  ]) expect(schema.safeParse({ ...preflight, scope: { ...preflight.scope, ...patch } }).success).toBe(false);
  expect(schema.safeParse({ ...preflight, next: { ...preflight.next, arguments: { ...preflight.next.arguments, confirm: true } } }).success).toBe(false);
  const complete = setupTool(root, { confirm: true, polyglot: true });
  if (complete.kind !== "setup") throw new Error("unexpected response");
  expect(complete.scope).toEqual(preflight.scope);
  expect(schema.safeParse(complete).success).toBe(true);
  expect(complete.selectedFiles).toBe(1);
  expect(complete.setupReady).toBe(false); // unsealed fixture stays not ready
  expect(isSetupAgentSuccess(complete)).toBe(false);
});
