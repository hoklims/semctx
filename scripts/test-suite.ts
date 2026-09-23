/**
 * Canonical test suite (HOK-822). Runs every test file under the suite roots: most of them in
 * parallel Bun workers, then the time-sensitive files alone and in sequence. Fails unless the two
 * JUnit reports together account for exactly the test files found on disk, each file once: a file
 * skipped by a worker, a pass or an ignore pattern cannot pass as a smaller green run.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

export const SUITE_ROOTS = ["packages", "apps", "plugins", "scripts"] as const;

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

/**
 * The parallel and sequential reports must partition the inventory: every discovered file reported
 * by exactly one pass, the sequential pass reporting exactly its files, and nothing else reported.
 */
export function completenessProblems(
  inventory: readonly string[],
  parallel: ReadonlyMap<string, number>,
  sequential: ReadonlyMap<string, number>,
  sequentialFiles: readonly string[] = SEQUENTIAL_TEST_FILES,
): string[] {
  const problems: string[] = [];
  const inventorySet = new Set(inventory);
  const sequentialSet = new Set(sequentialFiles);
  for (const file of sequentialFiles) {
    if (!inventorySet.has(file)) problems.push(`sequential file is not in the test-file inventory: ${file}`);
  }
  for (const file of inventory) {
    const inParallel = parallel.has(file);
    const inSequential = sequential.has(file);
    if (!inParallel && !inSequential) problems.push(`not executed: ${file}`);
    if (inParallel && inSequential) problems.push(`executed twice: ${file}`);
    if (sequentialSet.has(file) && inParallel) problems.push(`ran in the parallel pass: ${file}`);
    if (!sequentialSet.has(file) && inSequential) problems.push(`ran in the sequential pass: ${file}`);
  }
  for (const file of [...new Set([...parallel.keys(), ...sequential.keys()])].sort()) {
    if (!inventorySet.has(file)) problems.push(`not in the test-file inventory: ${file}`);
  }
  return problems;
}

export interface TestPass {
  label: "parallel" | "sequential";
  argv: string[];
  report: string;
}

export function testPasses(reportDirectory: string): TestPass[] {
  const parallelReport = join(reportDirectory, "parallel.xml");
  const sequentialReport = join(reportDirectory, "sequential.xml");
  return [
    {
      label: "parallel",
      report: parallelReport,
      argv: [
        process.execPath,
        "test",
        "--timeout",
        "60000",
        `--parallel=${parallelWorkers()}`,
        ...SEQUENTIAL_TEST_FILES.map((file) => `--path-ignore-patterns=${file}`),
        "--reporter=junit",
        `--reporter-outfile=${parallelReport}`,
        ...SUITE_ROOTS,
      ],
    },
    {
      label: "sequential",
      report: sequentialReport,
      argv: [
        process.execPath,
        "test",
        "--timeout",
        "60000",
        "--reporter=junit",
        `--reporter-outfile=${sequentialReport}`,
        ...SEQUENTIAL_TEST_FILES.map((file) => `./${file}`),
      ],
    },
  ];
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
    const [parallel, sequential] = passes.map(readReport);
    if (parallel === undefined || sequential === undefined) return 1;
    const problems = completenessProblems(inventory, parallel.files, sequential.files);
    for (const problem of problems) console.error(`[test-suite] FAIL  ${problem}`);
    const failures = parallel.failures + sequential.failures;
    console.log(
      `[test-suite] ${parallel.files.size + sequential.files.size}/${inventory.length} test files reported `
        + `(${parallel.files.size} parallel, ${sequential.files.size} sequential); `
        + `${parallel.tests + sequential.tests} tests, ${parallel.skipped + sequential.skipped} skipped, ${failures} failed`,
    );
    const failedPass = exitCodes.find((code) => code !== 0);
    if (failedPass !== undefined) return failedPass;
    return problems.length === 0 && failures === 0 ? 0 : 1;
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
