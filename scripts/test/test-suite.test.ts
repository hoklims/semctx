import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  completenessProblems,
  declaredFileProblems,
  discoverTestFiles,
  evaluateSuite,
  MAX_PARALLEL_WORKERS,
  parallelWorkers,
  SERIAL_TEST_FILES,
  summarizeJunitReport,
  testPasses,
  type JunitSummary,
  type PassOutcome,
  type TestPass,
} from "../test-suite";

const repositoryRoot = resolve(import.meta.dir, "../..");
const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(files: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-test-suite-test-"));
  temporaryRoots.push(root);
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  return root;
}

function summary(files: readonly string[], options: Partial<Omit<JunitSummary, "files">> = {}): JunitSummary {
  return {
    files: new Map(files.map((file) => [file, 1])),
    tests: options.tests ?? files.length,
    failures: options.failures ?? 0,
    skipped: options.skipped ?? 0,
  };
}

function fixture(): { inventory: string[]; passes: TestPass[]; outcomes: PassOutcome[]; serial: string[] } {
  const inventory = ["packages/core/test/a.test.ts", "scripts/test/serial.test.ts"];
  const directory = tree([]);
  const passes = testPasses(inventory, directory, 2, [inventory[1]!]);
  const outcomes = [
    { exitCode: 0, summary: summary([inventory[0]!]) },
    { exitCode: 0, summary: summary([inventory[1]!]) },
  ];
  return { inventory, passes, outcomes, serial: [inventory[1]!] };
}

describe("test-file inventory and scheduling", () => {
  test("discovers every supported test filename under the roots in stable order", () => {
    const root = tree([
      "packages/core/test/z.test.ts",
      "packages/core/test/a_spec.js",
      "apps/cli/test/run_test.mts",
      "plugins/p/test/view.spec.tsx",
      "scripts/test/helper.ts",
      "packages/core/node_modules/x/hidden.test.ts",
    ]);
    expect(discoverTestFiles(root)).toEqual([
      "apps/cli/test/run_test.mts",
      "packages/core/test/a_spec.js",
      "packages/core/test/z.test.ts",
      "plugins/p/test/view.spec.tsx",
    ]);
  });

  test("passes contain an explicit, sorted, exhaustive partition and bounded worker count", () => {
    const inventory = discoverTestFiles(repositoryRoot);
    const passes = testPasses(inventory, "reports", 3);
    expect(passes.map((pass) => pass.expected).flat().sort()).toEqual(inventory);
    expect(new Set(passes.map((pass) => pass.expected).flat()).size).toBe(inventory.length);
    expect(passes[0]!.argv).toContain("--parallel=3");
    expect(passes[0]!.argv).not.toContain("packages");
    expect(passes[1]!.expected).toEqual([...SERIAL_TEST_FILES]);
    expect(MAX_PARALLEL_WORKERS).toBe(4);
    expect([0, 1, 3, 24].map((cores) => parallelWorkers(cores))).toEqual([1, 1, 3, 4]);
    expect(declaredFileProblems(inventory)).toEqual([]);
  });

  test("remains opt-in while the canonical package test command stays unchanged", () => {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts.test).toBe("bun test --timeout 60000 packages apps plugins scripts");
  });
});

describe("JUnit evidence", () => {
  test("normalizes file paths and reads failures and skips", () => {
    const report = '<testsuites tests="2" failures="1" skipped="1">'
      + '<testcase file="./packages\\core\\test\\a.test.ts" />'
      + '<testcase file="scripts/test/a&amp;b.test.ts" /></testsuites>';
    const parsed = summarizeJunitReport(report);
    expect([...parsed.files]).toEqual([
      ["packages/core/test/a.test.ts", 1],
      ["scripts/test/a&b.test.ts", 1],
    ]);
    expect(parsed).toMatchObject({ tests: 2, failures: 1, skipped: 1 });
  });

  test("rejects reports without canonical totals", () => {
    expect(() => summarizeJunitReport("<testsuites></testsuites>")).toThrow("JUnit report has no tests total");
  });
});

describe("fail-closed verdict", () => {
  test("accepts only a complete, clean partition", () => {
    const value = fixture();
    expect(evaluateSuite(value.inventory, value.passes, value.outcomes, value.serial)).toEqual({ exitCode: 0, problems: [] });
    expect(completenessProblems(value.inventory, value.passes.map((pass, index) => ({
      label: pass.label,
      expected: pass.expected,
      reported: value.outcomes[index]!.summary!.files,
    })))).toEqual([]);
  });

  test("rejects an omitted or deselected file", () => {
    const value = fixture();
    value.outcomes[0] = { exitCode: 0, summary: summary([], { tests: 0 }) };
    expect(evaluateSuite(value.inventory, value.passes, value.outcomes, value.serial)).toEqual({
      exitCode: 1,
      problems: ["not executed: packages/core/test/a.test.ts"],
    });
  });

  test("accepts a visible platform skip when its file is still reported", () => {
    const value = fixture();
    value.outcomes[0] = { exitCode: 0, summary: summary([value.inventory[0]!], { skipped: 1 }) };
    expect(evaluateSuite(value.inventory, value.passes, value.outcomes, value.serial))
      .toEqual({ exitCode: 0, problems: [] });
  });

  test("rejects child failure, crash, timeout and unreadable report evidence", () => {
    for (const exitCode of [1, 3, 124]) {
      const value = fixture();
      value.outcomes[0] = { exitCode, reportError: "report missing after child termination" };
      const verdict = evaluateSuite(value.inventory, value.passes, value.outcomes, value.serial);
      expect(verdict.exitCode).toBe(1);
      expect(verdict.problems).toContain(`parallel child exited ${exitCode}`);
      expect(verdict.problems).toContain("parallel report: report missing after child termination");
    }
  });

  test("rejects duplicate and out-of-pass reports", () => {
    const value = fixture();
    value.outcomes[0] = { exitCode: 0, summary: summary(value.inventory) };
    const verdict = evaluateSuite(value.inventory, value.passes, value.outcomes, value.serial);
    expect(verdict.problems).toContain(`executed twice: ${value.inventory[1]}`);
    expect(verdict.problems).toContain(`ran in the parallel pass: ${value.inventory[1]}`);
  });
});
