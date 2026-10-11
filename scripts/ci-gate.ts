import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { FOCUSED_TEST_TARGETS, ROUTING_TESTS, TEST_SHARDS, type CiLane } from "./ci-plan";
import { isTestShard } from "./verify-pr";

export interface CiCommand {
  label: string;
  argv: string[];
}

export function commandsForLane(lane: CiLane, base: string, targetExists: (path: string) => boolean): CiCommand[] {
  if (lane.shard !== "" && !(isTestShard(lane.shard)
    && Number(lane.shard.split("/")[1]) === TEST_SHARDS[lane.os])) {
    throw new Error("invalid test shard");
  }
  if (lane.profile === "contract") {
    if (lane.os !== "ubuntu-latest" || lane.targets !== "" || lane.smoke !== "false" || lane.shard !== "") {
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
      lane.shard === ""
        ? { label: "canonical full gate", argv: ["bun", "run", "verify:pr"] }
        : { label: `canonical full gate (test shard ${lane.shard})`,
          argv: ["bun", "run", "verify:pr", "--", "--test-shard", lane.shard] },
      ...(lane.smoke === "true"
        ? [{ label: "small worker equivalence smoke", argv: ["bun", "run", "bench:index-workers", "4", "2"] }]
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
    { label: "affected cross-platform tests", argv: ["bun", "test", "--timeout", "60000",
      ...(lane.shard === "" ? [] : [`--shard=${lane.shard}`]), ...targets] },
  ];
  if (targets.includes("plugins")) {
    commands.push({ label: "plugin runtime parity", argv: ["bun", "run", "plugin:check"] });
    commands.push({ label: "plugin Python routing regressions", argv: ["python", "scripts/verify-index-routing.py"] });
  }
  if (lane.smoke === "true") {
    commands.push({ label: "small worker equivalence smoke", argv: ["bun", "run", "bench:index-workers", "4", "2"] });
  }
  return commands;
}

export async function runCiGate(
  lane: CiLane,
  base: string,
  dependencies: {
    cwd?: string;
    run?: (argv: string[], cwd: string) => Promise<number>;
    log?: (message: string) => void;
    targetExists?: (path: string) => boolean;
  } = {},
): Promise<number> {
  const cwd = dependencies.cwd ?? process.cwd();
  const log = dependencies.log ?? console.log;
  const run = dependencies.run ?? (async (argv, directory) => {
    const child = Bun.spawn(argv, { cwd: directory, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return await child.exited;
  });
  const commands = commandsForLane(lane, base,
    dependencies.targetExists ?? ((path) => existsSync(resolve(cwd, path))));
  for (const command of commands) {
    const started = performance.now();
    log(`[ci-gate] START ${command.label}`);
    const exitCode = await run(command.argv, cwd);
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
    const lane: CiLane = {
      profile, os, targets: process.env.SEMCTX_CI_TARGETS ?? "", smoke, shard: process.env.SEMCTX_CI_SHARD ?? "",
    };
    process.exitCode = await runCiGate(lane, process.env.SEMCTX_VERIFY_BASE || "origin/main");
  } catch (error) {
    console.error(`[ci-gate] ERROR ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
