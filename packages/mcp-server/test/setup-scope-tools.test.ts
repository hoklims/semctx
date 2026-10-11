import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { planSetupRepository } from "@semantic-context/app-services";
import { setupTool, isSetupAgentSuccess } from "../src/setup-tools";
import { TOOL_OUTPUT_SCHEMAS } from "../src/tool-output-schemas";

const roots: string[] = [];
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
    { proposedIncludes: ["domains/\u202efile.ts"] },
    { roots: [{ ...preflight.scope!.roots[0], root: "domains/\u2028sample" }] },
    { roots: [{ ...preflight.scope!.roots[0], samplePaths: ["domains/\u2066sample.ts"] }] },
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
