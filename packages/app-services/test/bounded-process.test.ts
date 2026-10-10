import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStatusPreflightReportSchema, ControlStatusTimeoutReportSchema } from "@semantic-context/control-model";
import { controlStatusTimeout, runProcessWithinBudget } from "../src";

const bun = process.execPath;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runProcessWithinBudget", () => {
  test("a child that outlives its budget is stopped and answered as a timeout within the budget", async () => {
    const started = performance.now();
    const outcome = await runProcessWithinBudget([bun, "-e", "await Bun.sleep(30_000)"], { cwd: tmpdir(), budgetMs: 300 });
    const elapsed = performance.now() - started;
    expect(outcome.kind).toBe("timeout");
    expect(elapsed).toBeGreaterThanOrEqual(290);
    expect(elapsed).toBeLessThan(2_000);
  });

  test("a child that finishes in time returns its exit code and output", async () => {
    const outcome = await runProcessWithinBudget([bun, "-e", "process.stdout.write('{\"ok\":true}'); process.exit(3)"], { cwd: tmpdir(), budgetMs: 20_000 });
    expect(outcome).toMatchObject({ kind: "exited", exitCode: 3, stdout: '{"ok":true}' });
  });

  test("a grandchild cannot delay the deadline and does not outlive it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "semctx-bounded-tree-"));
    const pidFile = join(directory, "grandchild.pid");
    try {
      const script = [
        "const grandchild = Bun.spawn([process.execPath, '-e', 'await Bun.sleep(30_000)'], { stdout: 'inherit', stderr: 'inherit' });",
        `await Bun.write(${JSON.stringify(pidFile)}, String(grandchild.pid));`,
        "await Bun.sleep(30_000);",
      ].join(" ");
      const started = performance.now();
      const outcome = await runProcessWithinBudget([bun, "-e", script], { cwd: tmpdir(), budgetMs: 1_500 });
      expect(outcome.kind).toBe("timeout");
      expect(performance.now() - started).toBeLessThan(2_500);
      const grandchild = Number(readFileSync(pidFile, "utf8"));
      expect(Number.isSafeInteger(grandchild)).toBe(true);
      // The tree kill runs after the answer; it must complete promptly, not at the grandchild's leisure.
      const deadline = performance.now() + 3_000;
      while (alive(grandchild) && performance.now() < deadline) await Bun.sleep(50);
      expect(alive(grandchild)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("TIMEOUT preflight report", () => {
  test("is a typed, schema-valid status that authorizes nothing and names its reason", () => {
    const report = controlStatusTimeout(5_000, 5_012);
    expect(ControlStatusTimeoutReportSchema.parse(report)).toEqual(report);
    expect(ControlStatusPreflightReportSchema.safeParse(report).success).toBe(true);
    expect(report).toMatchObject({
      verdict: "TIMEOUT",
      canRunHighRiskControl: false,
      reasons: ["STATUS_BUDGET_EXCEEDED"],
      freshnessSeal: null,
      budget: { budgetMs: 5_000, elapsedMs: 5_012 },
    });
    expect(report.explanation[0]?.detail).toContain("5000 ms");
  });

  test("cannot claim a high-risk permission", () => {
    const forged = { ...controlStatusTimeout(5_000, 5_012), canRunHighRiskControl: true };
    expect(ControlStatusPreflightReportSchema.safeParse(forged).success).toBe(false);
  });

  test("cannot explain itself with a freshness reason it does not carry", () => {
    const report = controlStatusTimeout(5_000, 5_012);
    const forged = { ...report, explanation: [{ ...report.explanation[0], reason: "HEAD_MISMATCH" }] };
    expect(ControlStatusPreflightReportSchema.safeParse(forged).success).toBe(false);
  });
});
