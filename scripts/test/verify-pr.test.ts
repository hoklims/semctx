import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseVerifyArgs,
  runVerification,
  verificationSteps,
  type CommandRunner,
} from "../verify-pr";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString().trim();
}

function repository(): { cwd: string; base: string } {
  const cwd = mkdtempSync(join(tmpdir(), "semctx-verify-pr-"));
  temporaryDirectories.push(cwd);
  git(cwd, "init", "--quiet");
  git(cwd, "config", "user.email", "verify-pr@example.invalid");
  git(cwd, "config", "user.name", "verify-pr test");
  writeFileSync(join(cwd, "tracked.txt"), "initial\n");
  git(cwd, "add", "tracked.txt");
  git(cwd, "commit", "--quiet", "-m", "initial");
  return { cwd, base: git(cwd, "rev-parse", "HEAD") };
}

function gitOnlyRunner(commands: string[][]): CommandRunner {
  return async (argv, cwd) => {
    commands.push([...argv]);
    if (argv[0] !== "git") return 0;
    return Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" }).exitCode;
  };
}

describe("argument parsing and command construction", () => {
  test("uses the environment base, CLI override, and default in precedence order", () => {
    expect(parseVerifyArgs([], {})).toEqual({ base: "origin/main", skipDiff: false });
    expect(parseVerifyArgs([], { SEMCTX_VERIFY_BASE: "" })).toEqual({
      base: "origin/main",
      skipDiff: false,
    });
    expect(parseVerifyArgs([], { SEMCTX_VERIFY_BASE: "upstream/trunk" })).toEqual({
      base: "upstream/trunk",
      skipDiff: false,
    });
    expect(parseVerifyArgs(["--base", "release"], { SEMCTX_VERIFY_BASE: "ignored" })).toEqual({
      base: "release",
      skipDiff: false,
    });
  });

  test("rejects unknown and incomplete arguments", () => {
    expect(() => parseVerifyArgs(["--wat"], {})).toThrow("unknown argument: --wat");
    expect(() => parseVerifyArgs(["--base"], {})).toThrow("--base requires a non-empty ref");
    expect(() => parseVerifyArgs(["--base", ""], {})).toThrow("--base requires a non-empty ref");
  });

  test("keeps a base containing spaces in one argv element", () => {
    const [step] = verificationSteps({ base: "ref with spaces", skipDiff: false });
    expect(step?.argv).toEqual(["git", "diff", "--check", "ref with spaces...HEAD"]);
  });

  test("skip-diff removes the diff commands", () => {
    const steps = verificationSteps({ base: "origin/main", skipDiff: true });
    expect(steps.map((step) => step.argv)).toEqual([
      ["bun", "run", "quality"],
      ["python", "-m", "compileall", "-q", "benchmarks/change-impact-eval/scripts"],
      ["python", "benchmarks/change-impact-eval/scripts/smoke_test.py"],
      ["bun", "run", "plugin:check"],
      ["bun", "run", "test"],
    ]);
  });
});

describe("execution", () => {
  test("fails before every command and lists non-ignored untracked paths", async () => {
    const { cwd, base } = repository();
    writeFileSync(join(cwd, "untracked file.txt"), "new\n");
    const commands: string[][] = [];
    const logs: string[] = [];

    const exitCode = await runVerification(
      { base, skipDiff: false },
      { cwd, run: gitOnlyRunner(commands), log: (message) => logs.push(message) },
    );

    expect(exitCode).toBe(1);
    expect(commands).toEqual([]);
    expect(logs).toContain('[verify:pr]   "untracked file.txt"');
  });

  test("ignores files excluded by gitignore", async () => {
    const { cwd, base } = repository();
    writeFileSync(join(cwd, ".gitignore"), "ignored.txt\n");
    git(cwd, "add", ".gitignore");
    git(cwd, "commit", "--quiet", "-m", "ignore generated file");
    writeFileSync(join(cwd, "ignored.txt"), "generated\n");
    const commands: string[][] = [];

    const exitCode = await runVerification(
      { base, skipDiff: false },
      { cwd, run: gitOnlyRunner(commands), log: () => undefined },
    );

    expect(exitCode).toBe(0);
    expect(commands[0]).toEqual(["git", "diff", "--check", `${base}...HEAD`]);
  });

  test("skip-diff also skips untracked-file detection", async () => {
    const commands: string[][] = [];
    let listCalls = 0;

    const exitCode = await runVerification(
      { base: "origin/main", skipDiff: true },
      {
        cwd: "ignored",
        run: async (argv) => {
          commands.push([...argv]);
          return 0;
        },
        listUntracked: async () => {
          listCalls += 1;
          return { exitCode: 0, paths: ["would-fail.txt"] };
        },
        log: () => undefined,
      },
    );

    expect(exitCode).toBe(0);
    expect(listCalls).toBe(0);
    expect(commands[0]).toEqual(["bun", "run", "quality"]);
  });

  test("runs in canonical order and stops at the first failure with its exit code", async () => {
    const commands: string[][] = [];
    const logs: string[] = [];
    const exitCode = await runVerification(
      { base: "origin/main", skipDiff: true },
      {
        cwd: "ignored",
        log: (message) => logs.push(message),
        run: async (argv) => {
          commands.push([...argv]);
          return commands.length === 2 ? 17 : 0;
        },
      },
    );

    expect(exitCode).toBe(17);
    expect(commands).toEqual([
      ["bun", "run", "quality"],
      ["python", "-m", "compileall", "-q", "benchmarks/change-impact-eval/scripts"],
    ]);
    expect(logs.at(-1)).toBe("[verify:pr] FAIL  Python compileall (exit 17)");
  });

  test("passes clean committed, staged, and unstaged changes", async () => {
    const { cwd, base } = repository();
    writeFileSync(join(cwd, "tracked.txt"), "clean committed\n");
    git(cwd, "commit", "--quiet", "-am", "clean committed");
    writeFileSync(join(cwd, "staged.txt"), "clean staged\n");
    git(cwd, "add", "staged.txt");
    writeFileSync(join(cwd, "tracked.txt"), "clean unstaged\n");
    const commands: string[][] = [];

    const exitCode = await runVerification(
      { base, skipDiff: false },
      { cwd, run: gitOnlyRunner(commands), log: () => undefined },
    );

    expect(exitCode).toBe(0);
    expect(commands.slice(0, 3)).toEqual([
      ["git", "diff", "--check", `${base}...HEAD`],
      ["git", "diff", "--cached", "--check"],
      ["git", "diff", "--check"],
    ]);
  });

  test.each([
    ["committed", (cwd: string) => {
      writeFileSync(join(cwd, "tracked.txt"), "bad committed  \n");
      git(cwd, "commit", "--quiet", "-am", "bad committed");
    }, 1],
    ["staged", (cwd: string) => {
      writeFileSync(join(cwd, "tracked.txt"), "bad staged  \n");
      git(cwd, "add", "tracked.txt");
    }, 2],
    ["unstaged", (cwd: string) => {
      writeFileSync(join(cwd, "tracked.txt"), "bad unstaged  \n");
    }, 3],
  ] as const)("fails on %s whitespace and does not continue", async (_kind, arrange, expectedCalls) => {
    const { cwd, base } = repository();
    arrange(cwd);
    const commands: string[][] = [];

    const exitCode = await runVerification(
      { base, skipDiff: false },
      { cwd, run: gitOnlyRunner(commands), log: () => undefined },
    );

    expect(exitCode).not.toBe(0);
    expect(commands).toHaveLength(expectedCalls);
  });
});
