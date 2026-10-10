import { closeSync, existsSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { FOCUSED_TEST_TARGETS, ROUTING_TESTS, type CiLane } from "./ci-plan";

export interface CiCommand {
  label: string;
  argv: string[];
  stdoutFile?: string;
}

export async function spawnCiCommand(argv: string[], cwd: string, stdoutFile?: string): Promise<number> {
  const outputPath = stdoutFile === undefined ? undefined : resolve(cwd, stdoutFile);
  const descriptor = outputPath === undefined ? undefined : openSync(outputPath, "w");
  let exitCode: number;
  try {
    const child = Bun.spawn(argv, { cwd, stdin: "inherit", stdout: descriptor ?? "inherit", stderr: "inherit" });
    exitCode = await child.exited;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (outputPath !== undefined) process.stdout.write(await Bun.file(outputPath).text());
  return exitCode;
}

const WORKER_SMOKE: CiCommand = {
  label: "small worker equivalence smoke",
  argv: ["bun", "run", "bench:index-workers", "4", "2"],
  stdoutFile: ".semctx/multicore-index.json",
};

export function commandsForLane(lane: CiLane, base: string, targetExists: (path: string) => boolean): CiCommand[] {
  if (lane.profile === "contract") {
    if (lane.os !== "ubuntu-latest" || lane.targets !== "" || lane.smoke !== "false") {
      throw new Error("invalid contract lane");
    }
    return [
      { label: "diff hygiene", argv: ["git", "diff", "--check", `${base}...HEAD`] },
      { label: "compatibility", argv: ["bun", "scripts/compatibility.ts"] },
      { label: "documentation", argv: ["bun", "scripts/documentation-integrity.ts"] },
      { label: "quality", argv: ["bun", "run", "quality"] },
      { label: "routing regressions", argv: ["bun", "test", "--timeout", "60000", ...ROUTING_TESTS] },
    ];
  }
  if (lane.profile === "full") {
    if (lane.targets !== "") throw new Error("full lane cannot specify focused targets");
    return [
      { label: "canonical full gate", argv: ["bun", "run", "verify:pr"] },
      ...(lane.smoke === "true"
        ? [WORKER_SMOKE]
        : []),
    ];
  }
  if (lane.profile !== "focused" || !["windows-latest", "macos-15"].includes(lane.os)) {
    throw new Error("unknown or invalid CI lane");
  }
  const targets = lane.targets.split(",");
  if (targets.length === 0 || targets.some((target) => !FOCUSED_TEST_TARGETS.has(target) || !targetExists(target))) {
    throw new Error("focused lane has an unknown or missing test target");
  }
  const commands: CiCommand[] = [
    { label: "affected cross-platform tests", argv: ["bun", "test", "--timeout", "60000", ...targets] },
  ];
  if (targets.includes("plugins")) {
    commands.push({ label: "plugin runtime parity", argv: ["bun", "run", "plugin:check"] });
    commands.push({ label: "plugin Python routing regressions", argv: ["python", "scripts/verify-index-routing.py"] });
  }
  if (lane.smoke === "true") {
    commands.push(WORKER_SMOKE);
  }
  return commands;
}

export async function runCiGate(
  lane: CiLane,
  base: string,
  dependencies: {
    cwd?: string;
    run?: (argv: string[], cwd: string, stdoutFile?: string) => Promise<number>;
    log?: (message: string) => void;
    targetExists?: (path: string) => boolean;
  } = {},
): Promise<number> {
  const cwd = dependencies.cwd ?? process.cwd();
  const log = dependencies.log ?? console.log;
  const run = dependencies.run ?? spawnCiCommand;
  const commands = commandsForLane(lane, base,
    dependencies.targetExists ?? ((path) => existsSync(resolve(cwd, path))));
  for (const command of commands) {
    const started = performance.now();
    log(`[ci-gate] START ${command.label}`);
    const exitCode = await run(command.argv, cwd, command.stdoutFile);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    if (exitCode !== 0) {
      log(`[ci-gate] FAIL  ${command.label} (exit ${exitCode}, ${seconds}s)`);
      return exitCode;
    }
    log(`[ci-gate] PASS  ${command.label} (${seconds}s)`);
  }
  return 0;
}

if (import.meta.main) {
  try {
    const profile = process.env.SEMCTX_CI_PROFILE;
    const os = process.env.SEMCTX_CI_OS;
    const smoke = process.env.SEMCTX_CI_SMOKE;
    if (profile !== "contract" && profile !== "full" && profile !== "focused") throw new Error("unknown CI profile");
    if (os !== "ubuntu-latest" && os !== "windows-latest" && os !== "macos-15") throw new Error("unknown CI OS");
    if (smoke !== "true" && smoke !== "false") throw new Error("invalid CI smoke flag");
    const lane: CiLane = { profile, os, targets: process.env.SEMCTX_CI_TARGETS ?? "", smoke };
    process.exitCode = await runCiGate(lane, process.env.SEMCTX_VERIFY_BASE || "origin/main");
  } catch (error) {
    console.error(`[ci-gate] ERROR ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
