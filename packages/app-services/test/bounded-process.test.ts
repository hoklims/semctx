import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { ControlStatusPreflightReportSchema, ControlStatusTimeoutReportSchema } from "@semantic-context/control-model";
import { controlStatusTimeout, runProcessWithinBudget } from "../src";

const bun = process.execPath;

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

  test("a grandchild that keeps the pipes open cannot delay the deadline", async () => {
    const script = "Bun.spawn([process.execPath, '-e', 'await Bun.sleep(30_000)'], { stdout: 'inherit', stderr: 'inherit' }); await Bun.sleep(30_000);";
    const started = performance.now();
    const outcome = await runProcessWithinBudget([bun, "-e", script], { cwd: tmpdir(), budgetMs: 500 });
    expect(outcome.kind).toBe("timeout");
    expect(performance.now() - started).toBeLessThan(3_000);
  });
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
});
