import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig, VerifyReportSchema } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";

const roots: string[] = [];
const ADAPTER = join(import.meta.dir, "../../github-action/src/adapter.mjs");
function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("deleted invariant keeps a base file anchor without inventing a head line or symbol", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-lost-guard-location-"));
  roots.push(root); mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  writeFileSync(join(root, "src/money.ts"), "/** @invariant nonnegative: stays nonnegative */\nexport function clamp() { return 1; }\n");
  writeFileSync(join(root, "src/helper.ts"), "export function helper() { return 1; }\n");
  git(root, "init", "-q", "-b", "main"); git(root, "add", "."); git(root, "commit", "-q", "-m", "guarded base");
  initWorkspace(root, createDefaultConfig(root));
  git(root, "checkout", "-q", "-b", "remove"); git(root, "rm", "-q", "src/money.ts"); git(root, "commit", "-q", "-m", "removed guard");
  indexRepository(root, "2026-10-12T00:00:00.000Z");
  const { result, report } = runVerify(root, { kind: "range", base: "main" });
  expect(result.verdict).toBe("BLOCK");
  expect(VerifyReportSchema.safeParse(report).success).toBe(true);
  const finding = report.findings.find((entry) => entry.rule === "invariant_touched_without_test")!;
  expect(finding).toBeDefined();
  expect(finding.locations).toEqual([{ file: "src/money.ts" }]);
  expect(finding.message).toContain("base");
  expect(report.changedSymbols).not.toEqual(expect.arrayContaining([expect.objectContaining({ file: "src/money.ts" })]));
  const reportPath = join(root, "report.json"); writeFileSync(reportPath, JSON.stringify(report));
  const adapter = Bun.spawnSync([process.execPath, ADAPTER, reportPath], { stdout: "pipe", stderr: "pipe", env: { ...process.env, INPUT_FAIL_ON: "block", INPUT_REQUIRE_QUALIFIED: "false" } });
  expect(adapter.exitCode).toBe(1);
  const output = new TextDecoder().decode(adapter.stdout);
  expect(output).toContain("file=src/money.ts");
  expect(output).not.toContain(",line=");
}, 60_000);
