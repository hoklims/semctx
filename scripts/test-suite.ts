/**
 * Canonical test suite (HOK-822). Runs every test file under the suite roots. On Windows, most of
 * them run in parallel Bun workers, then the time-sensitive files alone and in sequence; elsewhere
 * one sequential pass runs them all. Fails unless the JUnit reports together account for exactly
 * the test files found on disk, each file once: a file skipped by a worker, a pass or an ignore
 * pattern cannot pass as a smaller green run.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

export const SUITE_ROOTS = ["packages", "apps", "plugins", "scripts"] as const;

/**
 * Bun's spawnSync can lose a child's exit on Linux and macOS and spin until the test budget
 * expires (oven-sh/bun#34069, open in 1.4.2; fix proposed in oven-sh/bun#40078). Parallel workers
 * multiply that exposure: CI hit it on both, reproduced under WSL, and never on Windows. Until a
 * fixed Bun is pinned, only Windows runs the parallel pass.
 */
export function runsInParallel(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

/**
 * Bun defaults to one worker per core. At 24 workers, tests that spawn git or Bun ran three to five
 * times slower than alone and broke their own 15 s budgets; at 4 or 8 they kept at least twice
 * their observed time. The hosted runners have 3 or 4 vCPUs, so a local run keeps their load.
 */
export const MAX_PARALLEL_WORKERS = 4;

export function parallelWorkers(cores: number = availableParallelism()): number {
  return Math.max(1, Math.min(cores, MAX_PARALLEL_WORKERS));
}

/**
 * Run alone, after the parallel pass. Their explicit per-test budgets were exceeded under parallel
 * load on 2026-09-23 (guard, plugin build), or HOK-822 names them as time-sensitive (attestation
 * flood and delay, impact pilot, index lifecycle concurrency).
 */
export const SEQUENTIAL_TEST_FILES = [
  "apps/cli/test/plugin-status-attestation.test.ts",
  "packages/app-services/test/index-lifecycle-concurrency.test.ts",
  "plugins/claude-code/test/guard.test.ts",
  "plugins/plugin-build.test.ts",
  "scripts/test/impact-pilot.test.ts",
] as const;

/** Bun's default test-file names; a file Bun would run but this misses fails as unexpected. */
const TEST_FILE_PATTERN = "**/*{.test,_test,.spec,_spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}";

export function discoverTestFiles(repositoryRoot: string, roots: readonly string[] = SUITE_ROOTS): string[] {
  const glob = new Bun.Glob(TEST_FILE_PATTERN);
  const files: string[] = [];
  for (const root of roots) {
    for (const path of glob.scanSync({ cwd: join(repositoryRoot, root) })) {
      const normalized = `${root}/${path.replaceAll("\\", "/")}`;
      if (!normalized.split("/").includes("node_modules")) files.push(normalized);
    }
  }
  return files.sort();
}

export interface JunitSummary {
  files: Map<string, number>;
  tests: number;
  failures: number;
  skipped: number;
}

/** Test cases per file, read from the `file` attribute Bun writes on every testcase. */
export function summarizeJunitReport(xml: string): JunitSummary {
  const files = new Map<string, number>();
  for (const match of xml.matchAll(/<testcase\b[^>]*?\bfile="([^"]*)"/g)) {
    const file = decodeXmlAttribute(match[1]!).replaceAll("\\", "/");
    files.set(file, (files.get(file) ?? 0) + 1);
  }
  const totals = /<testsuites\b[^>]*>/.exec(xml)?.[0] ?? "";
  return {
    files,
    tests: numericAttribute(totals, "tests"),
    failures: numericAttribute(totals, "failures"),
    skipped: numericAttribute(totals, "skipped"),
  };
}

export interface TestPass {
  label: "parallel" | "sequential";
  argv: string[];
  report: string;
  /** The inventory files this pass must report, and no others. */
  expects(inventory: readonly string[]): string[];
}

export function testPasses(reportDirectory: string, platform: NodeJS.Platform = process.platform): TestPass[] {
  const command = (report: string): string[] =>
    [process.execPath, "test", "--timeout", "60000", "--reporter=junit", `--reporter-outfile=${report}`];
  const sequentialReport = join(reportDirectory, "sequential.xml");
  if (!runsInParallel(platform)) {
    return [{
      label: "sequential",
      report: sequentialReport,
      argv: [...command(sequentialReport), ...SUITE_ROOTS],
      expects: (inventory) => [...inventory],
    }];
  }
  const parallelReport = join(reportDirectory, "parallel.xml");
  const sequentialFiles = new Set<string>(SEQUENTIAL_TEST_FILES);
  return [
    {
      label: "parallel",
      report: parallelReport,
      argv: [
        ...command(parallelReport),
        `--parallel=${parallelWorkers()}`,
        ...SEQUENTIAL_TEST_FILES.map((file) => `--path-ignore-patterns=${file}`),
        ...SUITE_ROOTS,
      ],
      expects: (inventory) => inventory.filter((file) => !sequentialFiles.has(file)),
    },
    {
      label: "sequential",
      report: sequentialReport,
      argv: [...command(sequentialReport), ...SEQUENTIAL_TEST_FILES.map((file) => `./${file}`)],
      expects: (inventory) => inventory.filter((file) => sequentialFiles.has(file)),
    },
  ];
}

export interface PassResult {
  label: string;
  expected: readonly string[];
  reported: ReadonlyMap<string, number>;
}

/**
 * The passes must partition the inventory: every discovered file reported by exactly one pass,
 * each pass reporting exactly its expected files, and nothing outside the inventory reported.
 */
export function completenessProblems(inventory: readonly string[], results: readonly PassResult[]): string[] {
  const problems: string[] = [];
  const inventorySet = new Set(inventory);
  for (const file of inventory) {
    const reportedBy = results.filter((result) => result.reported.has(file)).length;
    if (reportedBy === 0) problems.push(`not executed: ${file}`);
    if (reportedBy > 1) problems.push(`executed twice: ${file}`);
  }
  for (const result of results) {
    const expected = new Set(result.expected);
    for (const file of [...result.reported.keys()].sort()) {
      if (!inventorySet.has(file)) problems.push(`not in the test-file inventory: ${file}`);
      else if (!expected.has(file)) problems.push(`ran in the ${result.label} pass: ${file}`);
    }
  }
  return problems;
}

/** A declared time-sensitive file that no longer exists would silently leave the partition. */
export function declaredFileProblems(inventory: readonly string[], declared: readonly string[] = SEQUENTIAL_TEST_FILES): string[] {
  const inventorySet = new Set(inventory);
  return declared
    .filter((file) => !inventorySet.has(file))
    .map((file) => `sequential file is not in the test-file inventory: ${file}`);
}

function numericAttribute(element: string, name: string): number {
  const value = new RegExp(`\\b${name}="(\\d+)"`).exec(element)?.[1];
  if (value === undefined) throw new Error(`JUnit report has no ${name} total`);
  return Number(value);
}

function decodeXmlAttribute(value: string): string {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function readReport(pass: TestPass): JunitSummary | undefined {
  try {
    return summarizeJunitReport(readFileSync(pass.report, "utf8"));
  } catch (error) {
    console.error(`[test-suite] FAIL  ${pass.label} pass left no readable JUnit report: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function main(): Promise<number> {
  const repositoryRoot = process.cwd();
  const inventory = discoverTestFiles(repositoryRoot);
  const reportDirectory = mkdtempSync(join(tmpdir(), "semctx-test-suite-"));
  try {
    const passes = testPasses(reportDirectory);
    const exitCodes: number[] = [];
    for (const pass of passes) {
      console.log(`[test-suite] START ${pass.label} pass`);
      const child = Bun.spawn(pass.argv, { cwd: repositoryRoot, stdout: "inherit", stderr: "inherit" });
      exitCodes.push(await child.exited);
    }
    const summaries = passes.map(readReport);
    if (summaries.some((summary) => summary === undefined)) return 1;
    const reports = summaries as JunitSummary[];
    const problems = [
      ...declaredFileProblems(inventory),
      ...completenessProblems(inventory, passes.map((pass, index) => ({
        label: pass.label,
        expected: pass.expects(inventory),
        reported: reports[index]!.files,
      }))),
    ];
    for (const problem of problems) console.error(`[test-suite] FAIL  ${problem}`);
    const total = (key: "tests" | "skipped" | "failures"): number => reports.reduce((sum, report) => sum + report[key], 0);
    const perPass = passes.map((pass, index) => `${reports[index]!.files.size} ${pass.label}`).join(", ");
    console.log(
      `[test-suite] ${reports.reduce((sum, report) => sum + report.files.size, 0)}/${inventory.length} test files reported `
        + `(${perPass}); ${total("tests")} tests, ${total("skipped")} skipped, ${total("failures")} failed`,
    );
    const failedPass = exitCodes.find((code) => code !== 0);
    if (failedPass !== undefined) return failedPass;
    return problems.length === 0 && total("failures") === 0 ? 0 : 1;
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
