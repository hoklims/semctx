import { processLimits, runProcessWithinBudget, VERIFICATION_STEP_BUDGET_MS } from "../plugins/shared/hooks/process-budget.mjs";
/**
 * A new contributor's first check (ADR 0022): portable, read-only by default, and never a
 * substitute for `bun run verify:pr`.
 *
 *   bun scripts/contributor.ts inspect        — read-only prerequisite diagnosis (default)
 *   bun scripts/contributor.ts check <scope>  — a real, bounded, existing test (see scopes.ts)
 *   bun scripts/contributor.ts recipe         — a red/fix/green demonstration in a temp witness
 *   bun scripts/contributor.ts full [args...] — delegates unchanged to `bun scripts/verify-pr.ts`
 *
 * Every command accepts `--json` (except `full`, which just forwards its own args) to also print
 * a `contributor_check` schema v1 object — see scripts/contributor/report.ts. This helper cannot
 * diagnose its own bootstrap requirement: Bun must already be installed and on `PATH` before this
 * file can execute at all. See docs/contributing/first-check.md.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import cliPackage from "../apps/cli/package.json";
import rootPackage from "../package.json";
import { parseVerifyArgs } from "./verify-pr";
import {
  evaluateBunRuntime,
  evaluateJsDependencies,
  evaluatePythonInterpreter,
  evaluatePythonTool,
  parseRequirementsQualityPins,
  type PrerequisiteResult,
} from "./contributor/inspect";
import {
  CONTRIBUTOR_CHECK_SCOPES,
  runContributorCheck,
  type CapturedCommand,
  type CapturingCommandRunner,
} from "./contributor/check";
import { runRegressionRecipe } from "./contributor/regression-recipe";
import { buildContributorCheckReport } from "./contributor/report";

export const REPOSITORY_ROOT = resolve(import.meta.dir, "..");

// --- Argument parsing -----------------------------------------------------------------------

export type ContributorCommand =
  | { readonly kind: "inspect"; readonly json: boolean }
  | { readonly kind: "check"; readonly scope: string; readonly json: boolean }
  | { readonly kind: "full"; readonly passthrough: readonly string[]; readonly json: boolean }
  | { readonly kind: "recipe"; readonly json: boolean };

export function parseContributorArgs(args: readonly string[]): ContributorCommand {
  const [first, ...rest] = args;

  if (first === undefined || first === "inspect" || first === "--json") {
    if (rest.some(a => a !== "--json")) throw new Error("inspect accepts only --json");
    return { kind: "inspect", json: first === "--json" || rest.includes("--json") };
  }
  if (first === "check") {
    const scope = rest.find((argument) => argument !== "--json");
    if (scope === undefined) {
      throw new Error(
        `check requires a scope name, e.g. "check core". Known scopes: ${CONTRIBUTOR_CHECK_SCOPES.map((s) => s.name).join(", ")}`,
      );
    }
    if (rest.filter(a => a !== "--json").length !== 1 || scope.startsWith("--")) throw new Error("check accepts one scope and optional --json");
    return { kind: "check", scope, json: rest.includes("--json") };
  }
  if (first === "recipe") {
    if (rest.some(a => a !== "--json")) throw new Error("recipe accepts only --json");
    return { kind: "recipe", json: rest.includes("--json") };
  }
  if (first === "full") {
    const passthrough = rest.filter(a => a !== "--json");
    if (parseVerifyArgs(passthrough).skipDiff) throw new Error("full requires diff hygiene; --skip-diff cannot produce full verification");
    return { kind: "full", passthrough, json: rest.includes("--json") };
  }
  throw new Error(`unknown command: ${first}`);
}

// --- Real process/filesystem access (the only impure section) --------------------------------

const realCapturingRunner = async (argv: readonly string[], cwd: string): Promise<CapturedCommand> => {
  const outcome = await runProcessWithinBudget(argv, { cwd, budgetMs: VERIFICATION_STEP_BUDGET_MS });
  if (outcome.kind === "timeout") return { code: 124, output: "PROCESS_TIMEOUT: contributor check budget exhausted" };
  return { code: outcome.exitCode, output: `${outcome.stdout}${outcome.stderr}` };
};

function probePythonTool(id: string, requiredVersion: string): PrerequisiteResult {
  const which = Bun.which(id);
  if (which === null) {
    return evaluatePythonTool({
      id,
      label: `${id} (Python quality tool)`,
      requiredVersion,
      which: null,
      queryOk: false,
      rawVersion: null,
    });
  }
  const result = Bun.spawnSync([which, "--version"], { stdout: "pipe", stderr: "pipe", ...processLimits(10_000) });
  return evaluatePythonTool({
    id,
    label: `${id} (Python quality tool)`,
    requiredVersion,
    which,
    queryOk: result.exitCode === 0,
    rawVersion: `${result.stdout.toString()}${result.stderr.toString()}`,
  });
}

function gatherPrerequisites(): PrerequisiteResult[] {
  const bun = evaluateBunRuntime({ version: Bun.version, requiredRange: cliPackage.engines.bun });

  const nodeModulesPresent = existsSync(join(REPOSITORY_ROOT, "node_modules"));
  const checkedPackages = Object.keys(rootPackage.devDependencies);
  const versions: Record<string, string> = {};
  const missingPackages = checkedPackages.filter(name => {
    try {
      const installed: unknown = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "node_modules", name, "package.json"), "utf8"));
      if (typeof installed !== "object" || installed === null || !("version" in installed) || typeof installed.version !== "string") return true;
      versions[name] = installed.version; return false;
    } catch { return true; }
  });
  const jsDependencies = evaluateJsDependencies({ nodeModulesPresent, checkedPackages, missingPackages, versions });

  const rustPin = /^channel\s*=\s*"(\d+\.\d+\.\d+)"/m.exec(
    readFileSync(join(REPOSITORY_ROOT, "rust-toolchain.toml"), "utf8"),
  )?.[1];
  if (rustPin === undefined) throw new Error("rust-toolchain.toml must declare an exact Rust channel");
  const rustTools = ["rustc", "cargo"].map(id => {
    const which = Bun.which(id);
    const probe = which === null ? null : Bun.spawnSync([which, "--version"], { stdout: "pipe", stderr: "pipe", ...processLimits(10_000) });
    const result = evaluatePythonTool({ id, label: id, requiredVersion: rustPin, which,
      queryOk: probe?.exitCode === 0, rawVersion: probe === null ? null : `${probe.stdout.toString()}${probe.stderr.toString()}` });
    return { ...result, required: `${id} ${rustPin}`, detail: `${result.status === "ok" ? "Matches" : "Does not establish"} the pinned toolchain in rust-toolchain.toml.`,
      recovery: result.status === "ok" ? null : `Install rustup, then run rustup toolchain install ${rustPin} --profile minimal --component rustfmt --component clippy` };
  });

  const pythonPath = Bun.which("python");
  const pythonProbe = pythonPath === null ? null : Bun.spawnSync([pythonPath, "--version"], { stdout: "pipe", stderr: "pipe", ...processLimits(10_000) });
  const pythonInterpreter = evaluatePythonInterpreter({ which: pythonPath, queryOk: pythonProbe?.exitCode === 0, rawVersion: pythonProbe === null ? null : `${pythonProbe.stdout.toString()}${pythonProbe.stderr.toString()}` });

  const pins = parseRequirementsQualityPins(
    readFileSync(join(REPOSITORY_ROOT, "requirements-quality.txt"), "utf8"),
  );
  const pythonTools = Object.keys(pins).map((id) => probePythonTool(id, pins[id] ?? "unknown"));

  return [bun, jsDependencies, ...rustTools, pythonInterpreter, ...pythonTools];
}

// --- Command implementations -------------------------------------------------------------------

function printPrerequisites(prerequisites: readonly PrerequisiteResult[]): void {
  for (const item of prerequisites) {
    console.log(`[contributor] ${item.status.toUpperCase().padEnd(12)} ${item.label}`);
    console.log(`[contributor]   required: ${item.required}`);
    console.log(`[contributor]   observed: ${item.observed ?? "none"}`);
    console.log(`[contributor]   ${item.detail}`);
    if (item.recovery !== null) console.log(`[contributor]   recovery: ${item.recovery}`);
  }
}

async function runInspect(json: boolean): Promise<number> {
  const started = performance.now();
  const prerequisites = gatherPrerequisites();
  const durationMs = performance.now() - started;
  const ok = prerequisites.every((item) => item.status === "ok");

  if (!json) {
    console.log("[contributor] inspect — read-only. Bun itself must already run for this to print anything.");
    printPrerequisites(prerequisites);
    console.log(
      ok
        ? "[contributor] every checked prerequisite is satisfied. Next: `bun scripts/contributor.ts check <scope>`, then `bun run verify:pr` before a PR."
        : "[contributor] one or more prerequisites are not satisfied — apply the recovery command(s) above, then re-run inspect.",
    );
  }

  const report = buildContributorCheckReport({
    command: "inspect",
    classification: "read-only",
    argv: [process.execPath, "scripts/contributor.ts", "inspect"],
    scope: null,
    covers: ["local machine prerequisites (Bun version, JS install state, Python quality tools)"],
    omits: ["every real test, typecheck, lint and the full verify:pr gate"],
    ok,
    exitCode: ok ? 0 : 1,
    durationMs,
    reasons: prerequisites.filter((item) => item.status !== "ok").map((item) => `${item.id}:${item.status}`),
    prerequisites,
  });
  if (json) console.log(JSON.stringify(report, null, 2));
  return report.exitCode;
}

async function runCheckCommand(scope: string, json: boolean): Promise<number> {
  const outcome = await runContributorCheck(scope, {
    cwd: REPOSITORY_ROOT,
    run: realCapturingRunner,
    pathExists: (path) => existsSync(join(REPOSITORY_ROOT, path)),
    now: () => performance.now(),
    log: (message) => { if (!json) console.log(message); },
  });

  if (!json) {
    console.log(
      "[contributor] this is a targeted result, not full-gate completeness — run `bun run verify:pr` before opening or updating a PR.",
    );
  }

  const report = buildContributorCheckReport({
    command: "check",
    classification: "targeted",
    argv: outcome.argv,
    scope: outcome.scope,
    covers: outcome.covers,
    omits: outcome.omits,
    ok: outcome.ok,
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
    reasons: outcome.reasons,
    prerequisites: [],
  });
  if (json) console.log(JSON.stringify(report, null, 2));
  return report.exitCode;
}

async function runRecipeCommand(json: boolean): Promise<number> {
  const started = performance.now();
  const outcome = await runRegressionRecipe({
    repositoryRoot: REPOSITORY_ROOT,
    readTextFile: (path) => readFileSync(path, "utf8"),
    makeTemporaryDirectory: () => mkdtempSync(join(tmpdir(), "semctx-contributor-recipe-")),
    makeDirectory: (path) => mkdirSync(path, { recursive: true }),
    writeTextFile: (path, contents) => writeFileSync(path, contents),
    removeDirectory: (path) => rmSync(path, { recursive: true, force: true }),
    joinPath: (...segments) => join(...segments),
    run: realCapturingRunner,
    now: () => performance.now(),
    log: (message) => { if (!json) console.log(message); },
  });
  const durationMs = performance.now() - started;

  if (!json) {
    console.log(`[contributor] recipe target: ${outcome.targetFunction}`);
    console.log(`[contributor] recipe test:   ${outcome.targetTest}`);
    console.log(
      `[contributor] setup ${outcome.setupDurationMs.toFixed(1)}ms · red ${outcome.red.durationMs.toFixed(1)}ms (exit ${outcome.red.exitCode}) · green ${outcome.green.durationMs.toFixed(1)}ms (exit ${outcome.green.exitCode})`,
    );
    console.log(
      outcome.ok
        ? "[contributor] PASS  the temporary witness broke on the mutation and passed once reverted — a real red/fix/green cycle."
        : `[contributor] FAIL  ${outcome.reasons.join(", ")}`,
    );
  }

  const report = buildContributorCheckReport({
    command: "recipe",
    recipe: outcome,
    classification: "recipe",
    argv: outcome.red.argv,
    scope: null,
    covers: [outcome.targetFunction, outcome.targetTest],
    omits: ["every other package", "typecheck, lint and the full verify:pr gate"],
    ok: outcome.ok,
    exitCode: outcome.ok ? 0 : 1,
    durationMs,
    reasons: outcome.reasons,
    prerequisites: [],
  });
  if (json) console.log(JSON.stringify(report, null, 2));
  return report.exitCode;
}

export async function runFullCommand(passthrough: readonly string[], json: boolean, run: CapturingCommandRunner = realCapturingRunner): Promise<number> {
  const options = parseVerifyArgs([...passthrough]);
  if (options.skipDiff) throw new Error("full requires diff hygiene");
  const argv = [process.execPath, "scripts/verify-pr.ts", ...passthrough];
  const started = performance.now();
  const result = await run(argv, REPOSITORY_ROOT);
  const ok = result.code === 0 && /^\[verify:pr\] PASS {2}all checks\s*$/m.test(Bun.stripANSI(result.output));
  const exitCode = result.code !== 0 ? result.code : ok ? 0 : 1;
  const report = buildContributorCheckReport({
    command: "full", classification: "full", argv, scope: null,
    covers: ["canonical scripts/verify-pr.ts, including diff hygiene"], omits: [], ok, exitCode,
    durationMs: performance.now() - started, reasons: ok ? [] : ["FULL_GATE_FAILED_OR_INCOMPLETE"], prerequisites: [],
  });
  if (json) { process.stderr.write(result.output); console.log(JSON.stringify(report, null, 2)); }
  else process.stdout.write(result.output);
  return exitCode;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let command: ContributorCommand;
  try {
    command = parseContributorArgs(argv);
  } catch (error) {
    console.error(`[contributor] ERROR ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  switch (command.kind) {
    case "inspect":
      return runInspect(command.json);
    case "check":
      return runCheckCommand(command.scope, command.json);
    case "recipe":
      return runRecipeCommand(command.json);
    case "full":
      return runFullCommand(command.passthrough, command.json);
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
