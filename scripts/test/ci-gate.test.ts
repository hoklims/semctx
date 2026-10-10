import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandsForLane, runCiGate, spawnCiCommand } from "../ci-gate";
import type { CiLane } from "../ci-plan";

const lane = (profile: CiLane["profile"], os: CiLane["os"], targets = "", smoke: CiLane["smoke"] = "false"): CiLane =>
  ({ profile, os, targets, smoke });

describe("CI gate runner", () => {
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
    expect(commands.at(-1)?.argv).toContain("scripts/test/governance-files.test.ts");
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
        ["bun", "test", "--timeout", "60000", "plugins"],
        ["bun", "run", "plugin:check"],
        ["python", "scripts/verify-index-routing.py"],
      ]);
    expect(() => commandsForLane(lane("focused", "ubuntu-latest", "plugins"), "base", () => true)).toThrow();
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
