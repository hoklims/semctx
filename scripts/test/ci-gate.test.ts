import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandsForLane, runCiGate, spawnCiCommand } from "../ci-gate";
import type { CiLane } from "../ci-plan";
import { TEST_TIMINGS } from "../verify-pr";

const lane = (
  profile: CiLane["profile"], os: CiLane["os"], targets = "", smoke: CiLane["smoke"] = "false", shard = "",
): CiLane => ({ profile, os, targets, smoke, shard });

/**
 * The killed child's working directory can stay locked for a moment on Windows. Cleanup retries and
 * never throws, so it can neither fail its test nor replace the assertion that did.
 */
async function removeDirectory(path: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      await Bun.sleep(50);
    }
  }
}

describe("CI gate runner", () => {
  test("kills a stalled command within its budget while retaining captured report output", async () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-ci-budget-"));
    try {
      const started = performance.now();
      const code = await spawnCiCommand([
        process.execPath, "--eval", 'console.log("partial report"); process.on("SIGTERM", () => {}); await Bun.sleep(1500);',
      ], root, "report.json", 200);
      expect(code).toBe(124);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(readFileSync(join(root, "report.json"), "utf8")).toBe("partial report\n");
    } finally {
      await removeDirectory(root);
    }
  });

  test("captures a worker report in a fresh cwd whose nested output directory does not exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-ci-fresh-report-"));
    const stdoutFile = ".semctx/multicore-index.json";
    const report = '{"schemaVersion":2,"childExecuted":true}\n';
    try {
      const outcome = await spawnCiCommand([
        process.execPath, "--eval", 'console.log(JSON.stringify({schemaVersion:2,childExecuted:true}));',
      ], root, stdoutFile).then(
        (exitCode) => ({ exitCode }),
        (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
      );
      expect(outcome).toEqual({ exitCode: 0 });
      expect(readFileSync(join(root, stdoutFile), "utf8")).toBe(report);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("captures complete subprocess stdout without stderr or gate logs, replacing a previous report", async () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-ci-report-"));
    const report = '{"schemaVersion":2,"payload":"' + "x".repeat(100_000) + '"}\n';
    try {
      writeFileSync(join(root, "report.json"), "stale report".repeat(20_000));
      const code = await spawnCiCommand([
        process.execPath, "--eval",
        'console.log(JSON.stringify({schemaVersion:2,payload:"x".repeat(100_000)})); console.error("stderr stays in logs");',
      ], root, "report.json");
      expect(code).toBe(0);
      expect(readFileSync(join(root, "report.json"), "utf8")).toBe(report);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("report capture preserves a subprocess failure and refuses an unwritable destination", async () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-ci-report-failure-"));
    try {
      expect(await spawnCiCommand([process.execPath, "--eval", "process.exit(19)"], root, "report.json"))
        .toBe(19);
      expect(readFileSync(join(root, "report.json"), "utf8")).toBe("");
      writeFileSync(join(root, "blocked"), "not a directory");
      expect(spawnCiCommand([process.execPath, "--eval", "process.exit(0)"], root, "blocked/report.json"))
        .rejects.toThrow();
      expect(spawnCiCommand([process.execPath, "--eval", "process.exit(0)"], root, "."))
        .rejects.toThrow();
      expect(spawnCiCommand([join(root, "missing-executable")], root, "report.json"))
        .rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("contract lane runs diff, compatibility, documentation, static quality and routing regressions", () => {
    const commands = commandsForLane(lane("contract", "ubuntu-latest"), "base-sha", () => true);
    expect(commands.map((command) => command.label)).toEqual([
      "diff hygiene", "compatibility", "documentation", "quality", "routing regressions",
    ]);
    expect(commands[0]?.argv).toEqual(["git", "diff", "--check", "base-sha...HEAD"]);
    expect(commands.at(-1)?.argv).toContain("./scripts/test/governance-files.test.ts");
  });

  test("full lane invokes the unchanged canonical gate; smoke is added only when selected", () => {
    expect(commandsForLane(lane("full", "ubuntu-latest"), "base", () => true).map((command) => command.argv))
      .toEqual([["bun", "run", "verify:pr"]]);
    expect(commandsForLane(lane("full", "ubuntu-latest", "", "true"), "base", () => true).at(-1)?.argv)
      .toEqual(["bun", "run", "bench:index-workers", "4", "2"]);
  });

  test("focused lane rejects unknown or missing targets and executes plugin parity", () => {
    expect(() => commandsForLane(lane("focused", "windows-latest", ""), "base", () => true)).toThrow();
    expect(() => commandsForLane(lane("focused", "windows-latest", "arbitrary"), "base", () => true)).toThrow();
    expect(() => commandsForLane(lane("focused", "windows-latest", "apps/cli/test"), "base", () => false)).toThrow();
    expect(commandsForLane(lane("focused", "macos-15", "plugins"), "base", () => true).map((command) => command.argv))
      .toEqual([
        ["bun", "test", "--timeout", "60000", "./plugins"],
        ["bun", "run", "plugin:check"],
        ["python", "scripts/verify-index-routing.py"],
      ]);
    expect(() => commandsForLane(lane("focused", "ubuntu-latest", "plugins"), "base", () => true)).toThrow();
  });

  test("a test shard narrows only the test files of the canonical gate or the focused suite", () => {
    expect(commandsForLane(lane("full", "windows-latest", "", "true", "3/4"), "base", () => true).map((command) => command.argv))
      .toEqual([
        ["bun", "run", "verify:pr", "--", "--test-shard", "3/4"],
        ["bun", "run", "bench:index-workers", "4", "2"],
      ]);
    expect(commandsForLane(lane("focused", "macos-15", "plugins", "false", "2/2"), "base", () => true).map((command) => command.argv))
      .toEqual([
        ["bun", "test", "--timeout", "60000", "--shard=2/2", "--timings=scripts/ci-test-timings.json", "./plugins"],
        ["bun", "run", "plugin:check"],
        ["python", "scripts/verify-index-routing.py"],
      ]);
  });

  test("shard balancing reads recorded durations keyed by the files the suite discovers", async () => {
    const timings = await Bun.file(TEST_TIMINGS).json() as { version: number; files: Record<string, number> };
    expect(timings.version).toBe(1);
    const recorded = Object.keys(timings.files);
    expect(recorded.length).toBeGreaterThan(100);
    expect(recorded.every((path) => /^(packages|apps|plugins|scripts)\/[^\\]+\.test\.ts$/.test(path))).toBe(true);
    expect(Object.values(timings.files).every((ms) => Number.isInteger(ms) && ms >= 0)).toBe(true);
  });

  test("refuses malformed shards, a shard count other than the host's, and a sharded contract lane", () => {
    for (const shard of ["0/4", "5/4", "1/3", "a/4", "1/4/4", " 1/4", "1/04"]) {
      expect(() => commandsForLane(lane("full", "windows-latest", "", "false", shard), "base", () => true))
        .toThrow("invalid test shard");
    }
    expect(() => commandsForLane(lane("contract", "ubuntu-latest", "", "false", "1/2"), "base", () => true))
      .toThrow("invalid contract lane");
  });

  test("propagates a failed command without running later commands", async () => {
    const observed: string[][] = [];
    const code = await runCiGate(lane("contract", "ubuntu-latest"), "base", {
      cwd: "unused", targetExists: () => true, log: () => undefined,
      run: async (argv) => { observed.push(argv); return observed.length === 2 ? 19 : 0; },
    });
    expect(code).toBe(19);
    expect(observed).toHaveLength(2);
  });

  test.each(["ubuntu-latest", "windows-latest", "macos-15"] as const)(
    "%s smoke captures only the benchmark and propagates its exit status", async (os) => {
      const captures: (string | undefined)[] = [];
      const code = await runCiGate(lane("full", os, "", "true"), "base", {
        cwd: "unused", log: () => undefined,
        run: async (_argv, _cwd, stdoutFile) => {
          captures.push(stdoutFile);
          return stdoutFile === undefined ? 0 : 19;
        },
      });
      expect(captures).toEqual([undefined, ".semctx/multicore-index.json"]);
      expect(code).toBe(19);
    },
  );
});


test("routing and focused paths exclude nested authority copies", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-test-target-closure-"));
  try {
    const makeTest = (relative: string, marker: string): void => {
      const target = join(root, relative);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, `import {test,expect} from "bun:test"; test("meaningful target test",()=>{expect(3*3).toBe(9); console.log(${JSON.stringify(marker)});});\n`);
    };
    const routing = commandsForLane(lane("contract", "ubuntu-latest"), "base", () => true).at(-1)!;
    for (const path of routing.argv.slice(4)) {
      const relative = path.replace(/^\.\//, "");
      makeTest(relative, `OWNED_TARGET:${relative}`);
      makeTest(`docs/research/cases/authority/${relative}`, "FOREIGN_TEST_EXECUTED:routing-copy");
    }
    makeTest("plugins/owned.test.ts", "OWNED_TARGET:plugins");
    makeTest("docs/research/cases/authority/plugins/foreign.test.ts", "FOREIGN_TEST_EXECUTED:plugin-copy");
    for (const command of [routing, commandsForLane(lane("focused", "windows-latest", "plugins"), "base", () => true)[0]!]) {
      const child = Bun.spawnSync([process.execPath, ...command.argv.slice(1)], {
        cwd: root, stdout: "pipe", stderr: "pipe", timeout: 10_000, maxBuffer: 1024 * 1024,
      });
      const output = `${child.stdout.toString()}\n${child.stderr.toString()}`;
      expect(child.exitedDueToTimeout).toBe(false);
      expect(child.exitCode).toBe(0);
      expect(output).toContain("OWNED_TARGET:");
      expect(output).not.toContain("FOREIGN_TEST_EXECUTED");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
