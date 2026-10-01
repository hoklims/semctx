/** Canonical, exhaustive test scheduler for the repository suite roots. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

export const SUITE_ROOTS = ["packages", "apps", "plugins", "scripts"] as const;
export const MAX_PARALLEL_WORKERS = 4;

/** Tests that build/install artifacts or have timing-sensitive process coordination share mutable state. */
export const SERIAL_TEST_FILES = [
  "apps/cli/test/package-runtime.test.ts",
  "apps/cli/test/plugin-status-attestation.test.ts",
  "packages/app-services/test/index-lifecycle-concurrency.test.ts",
  "plugins/claude-code/test/guard.test.ts",
  "plugins/plugin-build.test.ts",
  "scripts/test/impact-pilot.test.ts",
] as const;

const TEST_FILE_PATTERN = "**/*{.test,_test,.spec,_spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}";

export function parallelWorkers(cores: number = availableParallelism()): number {
  return Math.max(1, Math.min(cores, MAX_PARALLEL_WORKERS));
}

export function discoverTestFiles(repositoryRoot: string, roots: readonly string[] = SUITE_ROOTS): string[] {
  const glob = new Bun.Glob(TEST_FILE_PATTERN);
  const files: string[] = [];
  for (const root of roots) {
    if (!existsSync(join(repositoryRoot, root))) continue;
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

export function summarizeJunitReport(xml: string): JunitSummary {
  const files = new Map<string, number>();
  for (const match of xml.matchAll(/<testcase\b[^>]*?\bfile="([^"]*)"/g)) {
    const file = decodeXmlAttribute(match[1]!).replaceAll("\\", "/").replace(/^\.\//, "");
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
  label: "parallel" | "serial";
  argv: string[];
  report: string;
  expected: string[];
}

export function testPasses(
  inventory: readonly string[],
  reportDirectory: string,
  workers: number = parallelWorkers(),
  serialFiles: readonly string[] = SERIAL_TEST_FILES,
): TestPass[] {
  const serialSet = new Set(serialFiles);
  const parallel = inventory.filter((file) => !serialSet.has(file));
  const serial = inventory.filter((file) => serialSet.has(file));
  const command = (report: string): string[] => [
    process.execPath,
    "test",
    "--timeout",
    "60000",
    "--reporter=junit",
    `--reporter-outfile=${report}`,
  ];
  const parallelReport = join(reportDirectory, "parallel.xml");
  const serialReport = join(reportDirectory, "serial.xml");
  const passes: TestPass[] = [
    {
      label: "parallel",
      report: parallelReport,
      expected: parallel,
      argv: [...command(parallelReport), `--parallel=${workers}`, ...parallel.map((file) => `./${file}`)],
    },
    {
      label: "serial",
      report: serialReport,
      expected: serial,
      argv: [...command(serialReport), ...serial.map((file) => `./${file}`)],
    },
  ];
  return passes.filter((pass) => pass.expected.length > 0);
}

export interface PassResult {
  label: string;
  expected: readonly string[];
  reported: ReadonlyMap<string, number>;
}

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

export function declaredFileProblems(
  inventory: readonly string[],
  declared: readonly string[] = SERIAL_TEST_FILES,
): string[] {
  const inventorySet = new Set(inventory);
  return declared
    .filter((file) => !inventorySet.has(file))
    .map((file) => `serial file is not in the test-file inventory: ${file}`);
}

export interface PassOutcome {
  exitCode: number;
  summary?: JunitSummary;
  reportError?: string;
}

export function evaluateSuite(
  inventory: readonly string[],
  passes: readonly TestPass[],
  outcomes: readonly PassOutcome[],
  declaredSerialFiles: readonly string[] = SERIAL_TEST_FILES,
): { exitCode: number; problems: string[] } {
  const problems = declaredFileProblems(inventory, declaredSerialFiles);
  if (outcomes.length !== passes.length) problems.push("scheduler did not return every pass outcome");
  for (let index = 0; index < passes.length; index += 1) {
    const pass = passes[index]!;
    const outcome = outcomes[index];
    if (outcome === undefined) continue;
    if (outcome.exitCode !== 0) problems.push(`${pass.label} child exited ${outcome.exitCode}`);
    if (outcome.reportError !== undefined) problems.push(`${pass.label} report: ${outcome.reportError}`);
    if (outcome.summary?.failures) problems.push(`${pass.label} report contains ${outcome.summary.failures} failure(s)`);
  }
  const summariesReady = outcomes.length === passes.length && outcomes.every((outcome) => outcome.summary !== undefined);
  if (summariesReady) {
    problems.push(...completenessProblems(inventory, passes.map((pass, index) => ({
      label: pass.label,
      expected: pass.expected,
      reported: outcomes[index]!.summary!.files,
    }))));
  }
  return { exitCode: problems.length === 0 ? 0 : 1, problems };
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

async function runPass(pass: TestPass, repositoryRoot: string): Promise<PassOutcome> {
  try {
    const child = Bun.spawn(pass.argv, { cwd: repositoryRoot, stdout: "inherit", stderr: "inherit" });
    const exitCode = await child.exited;
    try {
      return { exitCode, summary: summarizeJunitReport(readFileSync(pass.report, "utf8")) };
    } catch (error) {
      return { exitCode, reportError: error instanceof Error ? error.message : String(error) };
    }
  } catch (error) {
    return { exitCode: 1, reportError: `child launch failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function main(
  repositoryRoot: string = process.cwd(),
  serialFiles: readonly string[] = SERIAL_TEST_FILES,
): Promise<number> {
  const inventory = discoverTestFiles(repositoryRoot);
  const reportDirectory = mkdtempSync(join(tmpdir(), "semctx-test-suite-"));
  try {
    const passes = testPasses(inventory, reportDirectory, parallelWorkers(), serialFiles);
    const outcomes: PassOutcome[] = [];
    for (const pass of passes) {
      console.log(`[test-suite] START ${pass.label} pass (${pass.expected.length} files)`);
      outcomes.push(await runPass(pass, repositoryRoot));
    }
    const verdict = evaluateSuite(inventory, passes, outcomes, serialFiles);
    for (const problem of verdict.problems) console.error(`[test-suite] FAIL  ${problem}`);
    const summaries = outcomes.flatMap((outcome) => outcome.summary === undefined ? [] : [outcome.summary]);
    console.log(
      `[test-suite] ${summaries.reduce((sum, summary) => sum + summary.files.size, 0)}/${inventory.length} test files reported; `
        + `${summaries.reduce((sum, summary) => sum + summary.tests, 0)} tests, `
        + `${summaries.reduce((sum, summary) => sum + summary.skipped, 0)} skipped, `
        + `${summaries.reduce((sum, summary) => sum + summary.failures, 0)} failed`,
    );
    return verdict.exitCode;
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exitCode = await main();
