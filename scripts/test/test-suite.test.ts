import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  completenessProblems,
  discoverTestFiles,
  MAX_PARALLEL_WORKERS,
  parallelWorkers,
  SEQUENTIAL_TEST_FILES,
  SUITE_ROOTS,
  summarizeJunitReport,
  testPasses,
} from "../test-suite";

const repo = resolve(import.meta.dir, "../..");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tree(files: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-test-suite-"));
  roots.push(root);
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  return root;
}

const REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4" assertions="9" failures="1" skipped="1" time="1.5">
  <testsuite name="packages\\core\\test\\ids.test.ts" file="packages\\core\\test\\ids.test.ts" tests="3" failures="1" skipped="1">
    <testsuite name="ids" file="packages\\core\\test\\ids.test.ts" tests="3" failures="1" skipped="1">
      <testcase name="a" classname="ids" time="0.1" file="packages\\core\\test\\ids.test.ts" assertions="2" />
      <testcase name="b" classname="ids" time="0.1" file="packages\\core\\test\\ids.test.ts" assertions="0"><skipped /></testcase>
      <testcase name="c" classname="ids" time="0.1" file="packages\\core\\test\\ids.test.ts" assertions="1"><failure type="AssertionError" /></testcase>
    </testsuite>
  </testsuite>
  <testsuite name="scripts/test/a&amp;b.test.ts" file="scripts/test/a&amp;b.test.ts" tests="1" failures="0" skipped="0">
    <testcase name="d" classname="" time="0.1" file="scripts/test/a&amp;b.test.ts" assertions="6" />
  </testsuite>
</testsuites>
`;

describe("test-file inventory", () => {
  test("finds Bun's test-file names under the suite roots and nowhere else", () => {
    const root = tree([
      "packages/core/test/ids.test.ts",
      "packages/core/src/ids.ts",
      "packages/core/node_modules/dependency/index.test.ts",
      "apps/cli/test/run_test.js",
      "plugins/claude-code/test/hooks.spec.mts",
      "scripts/test/build_spec.tsx",
      "examples/sample/test/app.test.ts",
    ]);
    expect(discoverTestFiles(root)).toEqual([
      "apps/cli/test/run_test.js",
      "packages/core/test/ids.test.ts",
      "plugins/claude-code/test/hooks.spec.mts",
      "scripts/test/build_spec.tsx",
    ]);
  });

  test("includes this test file in the repository inventory", () => {
    expect(discoverTestFiles(repo)).toContain("scripts/test/test-suite.test.ts");
  });
});

describe("JUnit report", () => {
  test("counts test cases per file, with normalized and decoded paths", () => {
    const summary = summarizeJunitReport(REPORT);
    expect([...summary.files]).toEqual([
      ["packages/core/test/ids.test.ts", 3],
      ["scripts/test/a&b.test.ts", 1],
    ]);
    expect(summary).toMatchObject({ tests: 4, failures: 1, skipped: 1 });
  });

  test("rejects a report without totals", () => {
    expect(() => summarizeJunitReport("<testsuites name=\"bun test\"></testsuites>")).toThrow("JUnit report has no tests total");
  });
});

describe("completeness", () => {
  const inventory = ["apps/cli/test/run.test.ts", "packages/core/test/ids.test.ts", "scripts/test/slow.test.ts"];
  const sequentialFiles = ["scripts/test/slow.test.ts"];
  const reported = (...files: string[]): Map<string, number> => new Map(files.map((file) => [file, 1]));
  const parallel = reported("apps/cli/test/run.test.ts", "packages/core/test/ids.test.ts");
  const sequential = reported("scripts/test/slow.test.ts");

  test("accepts two passes that partition the inventory", () => {
    expect(completenessProblems(inventory, parallel, sequential, sequentialFiles)).toEqual([]);
  });

  test("names a discovered file that neither pass reported", () => {
    expect(completenessProblems(inventory, reported("apps/cli/test/run.test.ts"), sequential, sequentialFiles))
      .toEqual(["not executed: packages/core/test/ids.test.ts"]);
  });

  test("names a file that was not discovered", () => {
    expect(completenessProblems(inventory, reported(...parallel.keys(), "apps/cli/test/extra.test.ts"), sequential, sequentialFiles))
      .toEqual(["not in the test-file inventory: apps/cli/test/extra.test.ts"]);
  });

  test("keeps time-sensitive files out of the parallel pass", () => {
    expect(completenessProblems(inventory, reported(...parallel.keys(), "scripts/test/slow.test.ts"), reported(), sequentialFiles))
      .toEqual(["ran in the parallel pass: scripts/test/slow.test.ts"]);
    expect(completenessProblems(inventory, reported(...parallel.keys(), "scripts/test/slow.test.ts"), sequential, sequentialFiles))
      .toEqual(["executed twice: scripts/test/slow.test.ts", "ran in the parallel pass: scripts/test/slow.test.ts"]);
  });

  test("keeps the sequential pass to its declared files", () => {
    expect(completenessProblems(inventory, reported("apps/cli/test/run.test.ts"), reported(...sequential.keys(), "packages/core/test/ids.test.ts"), sequentialFiles))
      .toEqual(["ran in the sequential pass: packages/core/test/ids.test.ts"]);
  });

  test("rejects a declared sequential file that no longer exists", () => {
    expect(completenessProblems(inventory, parallel, sequential, [...sequentialFiles, "scripts/test/gone.test.ts"]))
      .toEqual(["sequential file is not in the test-file inventory: scripts/test/gone.test.ts"]);
  });

  test("every declared sequential file exists in the repository", () => {
    expect(completenessProblems(discoverTestFiles(repo), new Map(), new Map()).filter((problem) => problem.startsWith("sequential file")))
      .toEqual([]);
  });
});

describe("canonical command", () => {
  test("runs every suite root with the canonical timeout, in two passes with JUnit reports", () => {
    const [parallelPass, sequentialPass] = testPasses("reports");
    expect(parallelPass!.label).toBe("parallel");
    expect(parallelPass!.argv.slice(1)).toEqual([
      "test",
      "--timeout",
      "60000",
      `--parallel=${parallelWorkers()}`,
      ...SEQUENTIAL_TEST_FILES.map((file) => `--path-ignore-patterns=${file}`),
      "--reporter=junit",
      `--reporter-outfile=${parallelPass!.report}`,
      "packages",
      "apps",
      "plugins",
      "scripts",
    ]);
    expect(sequentialPass!.label).toBe("sequential");
    expect(sequentialPass!.argv.slice(1)).toEqual([
      "test",
      "--timeout",
      "60000",
      "--reporter=junit",
      `--reporter-outfile=${sequentialPass!.report}`,
      ...SEQUENTIAL_TEST_FILES.map((file) => `./${file}`),
    ]);
    expect(SUITE_ROOTS).toEqual(["packages", "apps", "plugins", "scripts"]);
  });

  test("caps parallel workers at the hosted runners' load", () => {
    expect(MAX_PARALLEL_WORKERS).toBe(4);
    expect([1, 3, 4, 24].map((cores) => parallelWorkers(cores))).toEqual([1, 3, 4, 4]);
  });

  test("is what bun run test executes", () => {
    const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts.test).toBe("bun scripts/test-suite.ts");
  });
});
