import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig, VerifyReportSchema } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";
import { __setVerifyAnalysisBarrierForTesting, resolveSource } from "../src/verify";

const roots: string[] = [];
const SOURCE = { kind: "range", base: "refs/heads/verification-base" } as const;
function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}
function repository() {
  const root = mkdtempSync(join(tmpdir(), "semctx-range-coordinate-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  writeFileSync(join(root, "src/main.ts"), "export function main() { return 1; }\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "."); git(root, "commit", "-q", "-m", "first ancestor");
  const first = git(root, "rev-parse", "HEAD");
  git(root, "commit", "-q", "--allow-empty", "-m", "same-tree successor");
  const second = git(root, "rev-parse", "HEAD");
  expect(first).not.toBe(second);
  expect(git(root, "rev-parse", `${first}^{tree}`)).toBe(git(root, "rev-parse", `${second}^{tree}`));
  git(root, "update-ref", SOURCE.base, first);
  git(root, "update-ref", "refs/heads/unrelated", first);
  writeFileSync(join(root, "src/added.ts"), "export function added() { return 2; }\n");
  git(root, "add", "src/added.ts"); git(root, "commit", "-q", "-m", "pure addition head");
  initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"] });
  indexRepository(root, "2026-10-12T00:00:00.000Z");
  return { root, first, second };
}
function assertCurrentHead(report: ReturnType<typeof runVerify>["report"]) {
  expect(VerifyReportSchema.safeParse(report).success).toBe(true);
  expect(report.analysisAdmission?.binding.status).toBe("valid");
  expect(report.analysisAdmission?.indexFreshness.verdict).toBe("FRESH");
  expect(report.analysisAdmission?.changeCoverage.analyzed).toContain("src/added.ts");
  expect(report.analysisAdmission?.reasons).not.toContain("QUALIFIED_BASE_RECOVERY_UNSUPPORTED");
}
afterEach(() => {
  __setVerifyAnalysisBarrierForTesting(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("qualified range rejects merge-base coordinate drift despite identical diff bytes", () => {
  const { root, first, second } = repository();
  const before = resolveSource(root, SOURCE, false);
  __setVerifyAnalysisBarrierForTesting(() => git(root, "update-ref", SOURCE.base, second));
  const observed = runVerify(root, SOURCE);
  const after = resolveSource(root, SOURCE, false);
  assertCurrentHead(observed.report);
  expect(before.diffText).toBe(after.diffText);
  expect(before.identity).toEqual(after.identity);
  expect(before.git.mergeBase).toBe(first);
  expect(after.git.mergeBase).toBe(second);
  expect(observed.report.mergeBase).toBe(first);
  expect(observed.report.analysisAdmission?.identity.baseCommit).toBe(first);
  console.info(JSON.stringify({ before: before.git, after: after.git, report: observed.report }));
  expect(observed.report.analysisAdmission?.reasons).toContain("CHECK_INPUT_CHANGED");
  expect(observed.report.analysisAdmission?.checkFreshness.status).toBe("changed");
  expect(observed.report.analysisAdmission?.status).toBe("rejected");
  expect(observed.result.verdict).toBe("BLOCK");
}, 60_000);

test("qualified range keeps unchanged merge-base coordinates admitted", () => {
  const { root, first } = repository();
  const observed = runVerify(root, SOURCE);
  assertCurrentHead(observed.report);
  expect(observed.report.mergeBase).toBe(first);
  expect(observed.report.analysisAdmission?.status).toBe("admitted");
  expect(observed.report.analysisAdmission?.checkFreshness.status).toBe("current");
  expect(observed.report.analysisAdmission?.reasons).not.toContain("CHECK_INPUT_CHANGED");
  expect(observed.result.verdict).not.toBe("BLOCK");
}, 60_000);

test("moving an unrelated ref does not refuse a stable qualified range", () => {
  const { root, first, second } = repository();
  __setVerifyAnalysisBarrierForTesting(() => git(root, "update-ref", "refs/heads/unrelated", second));
  const observed = runVerify(root, SOURCE);
  assertCurrentHead(observed.report);
  expect(observed.report.mergeBase).toBe(first);
  expect(observed.report.analysisAdmission?.status).toBe("admitted");
  expect(observed.report.analysisAdmission?.checkFreshness.status).toBe("current");
  expect(observed.report.analysisAdmission?.reasons).not.toContain("CHECK_INPUT_CHANGED");
  expect(observed.result.verdict).not.toBe("BLOCK");
}, 60_000);
