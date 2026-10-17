import { gitEnvironment, processLimits, runProcessWithinBudget, VERIFICATION_STEP_BUDGET_MS } from "../plugins/shared/hooks/process-budget.mjs";
export interface VerifyOptions {
  base: string;
  skipDiff: boolean;
  /** `index/count` slice of the test files, run by one CI runner; absent runs every file. */
  testShard?: string;
}

/** Recorded per-file durations that let `--shard` balance runners by time instead of file count. */
export const TEST_TIMINGS = "scripts/ci-test-timings.json";

export function isTestShard(value: string): boolean {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
  return match !== null && Number(match[1]) <= Number(match[2]);
}

export interface VerificationStep {
  label: string;
  argv: string[];
}

export type CommandRunner = (argv: string[], cwd: string) => Promise<number>;
export type UntrackedFileLister = (
  cwd: string,
) => Promise<{ exitCode: number; paths: string[] }>;
export type Log = (message: string) => void;

export function parseVerifyArgs(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): VerifyOptions {
  let base = env.SEMCTX_VERIFY_BASE || "origin/main";
  let skipDiff = false;
  let testShard: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--skip-diff") {
      skipDiff = true;
      continue;
    }
    if (argument === "--test-shard") {
      const value = args[index + 1];
      if (value === undefined || !isTestShard(value)) {
        throw new Error("--test-shard requires index/count with 1 <= index <= count");
      }
      testShard = value;
      index += 1;
      continue;
    }
    if (argument === "--base") {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error("--base requires a non-empty ref");
      }
      base = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument ?? ""}`);
  }

  return testShard === undefined ? { base, skipDiff } : { base, skipDiff, testShard };
}

export function verificationSteps(options: VerifyOptions): VerificationStep[] {
  const diffSteps: VerificationStep[] = options.skipDiff
    ? []
    : [
        {
          label: `diff hygiene: ${options.base}...HEAD`,
          argv: ["git", "diff", "--check", `${options.base}...HEAD`],
        },
        {
          label: "diff hygiene: staged",
          argv: ["git", "diff", "--cached", "--check"],
        },
        {
          label: "diff hygiene: unstaged",
          argv: ["git", "diff", "--check"],
        },
      ];

  return [
    ...diffSteps,
    { label: "compatibility declarations", argv: ["bun", "scripts/compatibility.ts"] },
    { label: "documentation integrity", argv: ["bun", "scripts/documentation-integrity.ts"] },
    { label: "quality", argv: ["bun", "run", "quality"] },
    {
      label: "Python compileall",
      argv: ["python", "-m", "compileall", "-q", "benchmarks/change-impact-eval/scripts"],
    },
    {
      label: "Python smoke",
      argv: ["python", "benchmarks/change-impact-eval/scripts/smoke_test.py"],
    },
    {
      label: "index routing recovery regressions",
      argv: ["python", "scripts/verify-index-routing.py"],
    },
    { label: "plugin parity", argv: ["bun", "run", "plugin:check"] },
    options.testShard === undefined
      ? { label: "tests", argv: ["bun", "run", "test"] }
      : {
          label: `tests (shard ${options.testShard})`,
          argv: ["bun", "run", "test", `--shard=${options.testShard}`, `--timings=${TEST_TIMINGS}`],
        },
  ];
}

export async function spawnCommand(argv: string[], cwd: string, budgetMs = VERIFICATION_STEP_BUDGET_MS): Promise<number> {
  const outcome = await runProcessWithinBudget(argv, { cwd, budgetMs, stdin: "inherit", inheritOutput: true });
  if (outcome.kind === "timeout") {
    console.error("PROCESS_TIMEOUT: verification step budget exhausted");
    return 124;
  }
  return outcome.exitCode;
}

export const listUntrackedFiles: UntrackedFileLister = async (cwd) => {
  // Imported by the contributor bootstrap helper: built-ins and the budget helper only, so this
  // works before `bun install`.
  const limits = processLimits();
  const child = Bun.spawnSync(["git", "ls-files", "--others", "--exclude-standard", "-z"], {
    cwd, stdout: "pipe", stderr: "pipe", env: gitEnvironment(), ...limits,
  });
  if (child.exitedDueToTimeout || child.exitedDueToMaxBuffer
    || child.stdout.byteLength >= limits.maxBuffer || child.stderr.byteLength >= limits.maxBuffer) {
    throw new Error(`${child.exitedDueToTimeout ? "PROCESS_TIMEOUT" : "PROCESS_OUTPUT_LIMIT"}: Git capture refused`);
  }
  const output = new TextDecoder().decode(child.stdout);
  const exitCode = child.exitCode;
  return {
    exitCode,
    paths: output.split("\0").filter((path) => path.length > 0),
  };
};

export async function runVerification(
  options: VerifyOptions,
  dependencies: {
    cwd?: string;
    run?: CommandRunner;
    listUntracked?: UntrackedFileLister;
    log?: Log;
  } = {},
): Promise<number> {
  const cwd = dependencies.cwd ?? process.cwd();
  const run = dependencies.run ?? spawnCommand;
  const listUntracked = dependencies.listUntracked ?? listUntrackedFiles;
  const log = dependencies.log ?? console.log;

  if (!options.skipDiff) {
    const label = "diff hygiene: untracked files";
    log(`[verify:pr] START ${label}`);
    const result = await listUntracked(cwd);
    if (result.exitCode !== 0) {
      log(`[verify:pr] FAIL  ${label} (exit ${result.exitCode})`);
      return result.exitCode;
    }
    if (result.paths.length > 0) {
      log("[verify:pr] FAIL  non-ignored untracked files must be staged or removed:");
      for (const path of result.paths) {
        log(`[verify:pr]   ${JSON.stringify(path)}`);
      }
      return 1;
    }
    log(`[verify:pr] PASS  ${label}`);
  }

  for (const step of verificationSteps(options)) {
    log(`[verify:pr] START ${step.label}`);
    const exitCode = await run(step.argv, cwd);
    if (exitCode !== 0) {
      log(`[verify:pr] FAIL  ${step.label} (exit ${exitCode})`);
      return exitCode;
    }
    log(`[verify:pr] PASS  ${step.label}`);
  }

  log("[verify:pr] PASS  all checks");
  return 0;
}

export async function main(
  args: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  try {
    return await runVerification(parseVerifyArgs(args, env));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[verify:pr] ERROR ${message}`);
    return 2;
  }
}

if (import.meta.main) {
  // Keep this path for existing contributor integrations. Policy and execution now live in Rust;
  // the exported legacy functions remain a differential reference for their contract tests.
  const child = Bun.spawn([
    "cargo", "run", "--manifest-path", "tools/gates/Cargo.toml", "--locked", "--release", "--",
    "verify-pr", ...process.argv.slice(2),
  ], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  process.exitCode = await child.exited;
}
