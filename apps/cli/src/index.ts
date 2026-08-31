#!/usr/bin/env bun
import { isSemctxError } from "@semantic-context/core";
import packageJson from "../package.json";
import { parseArgs, flagString, flagBool, type ParsedArgs } from "./args";
import { fail, info, c } from "./output";
import { runSetupAsync } from "./commands/setup";
import { runInit } from "./commands/init";
import { runIndexAsync } from "./commands/index-cmd";
import { runTaskCreate } from "./commands/task";
import { runContextPrepare } from "./commands/context";
import { runVerifyDiff } from "./commands/verify";
import { runInspect } from "./commands/inspect";
import { runBenchCmd } from "./commands/bench";
import { runDoctor } from "./commands/doctor";
import { runSemantic } from "./commands/semantic";
import { runChange } from "./commands/change";
import { runControl } from "./commands/control";
import { runStatus } from "./commands/status";
import { runIndexHealth } from "./commands/index-health";
import { runInstall } from "./commands/install";
import { runPluginStatus } from "./commands/plugin-status";
import { runMigrate } from "./commands/migrate";

const HELP = `semctx — repository change-impact analyzer (v${packageJson.version})

Usage: semctx <command> [options]

Core:
  install [--host auto|codex|claude|all]
                                  install/update detected agent plugins + setup this Git repository
      --skip-setup --dry-run       machine-only install / preview without changing anything
  plugin-status [--json]           repository vs stable vs marketplace snapshot vs installed
                                   cache vs session; never mutates plugin delivery state, no
                                   network by default (--attest is the one opt-in exception)
      --host auto|codex|claude|all  auto omits an absent host; naming one keeps it in the answer
      --attest                      ask the canonical public repository what 'stable' is now, in an
                                    isolated store no local Git config can redirect (non-mutating,
                                    deadline-bounded and acceptance-capped; UNKNOWN offline)
  setup [--preset github-claude]   one command: config + index + semantic scaffold + check (idempotent)
      --polyglot                    create a new workspace with config v2 glob selection
      --workers auto|N              TypeScript workers (default: 1; auto is evidence-gated by platform)
  init [--preset github-claude]    initialise .semctx/ (db + config)
      --polyglot                    opt into config v2 glob selection + TS/Python analyzers
      --dry-run --force            preview / overwrite existing files
      --with-github-action --with-claude-code --with-devcontainer   preset extras
  index [--json] [--workers auto|N]
                                   analyse the repo -> deterministic graph (default: 1; auto is evidence-gated by platform)
  index-health [--json]            report index binding, freshness, and analysis coverage
  verify diff [options]            analyse a git range -> impact + PASS/WARN/BLOCK
      --base <ref>                   compare against <ref> (real merge-base; required in CI)
      --head <ref>                   head ref (default: HEAD)
      --staged | --from-file <f>     analyse the staged diff, or a unified diff file
      --format text|json|github      output format (default: text; json = versioned contract)
      --fail-on block|warn|none      exit non-zero on this level or worse (default: block)
      --output <path>                write the JSON report atomically
      --record                       record the verification state (for the Claude Code guarded hook)
      --dry-run                      show the resolved range + config; no analysis, no writes
  inspect symbol|capability <q>    inspect the graph around a symbol or capability
  doctor                           workspace health check
  status [--json]                  control freshness preflight (FRESH/DIRTY_KNOWN/STALE/UNSEALED)

Semantic layer (authored intent, invariants, decisions, evidence, change contracts):
  semantic <init|check|inspect|render|format|slice|handoff|resume>
  change   <open|update|inspect|verify|close> <id>

Control plane (bounded semantic coordination and migration planning):
  control trace <qualified-id> [--to 0..6] [--direction lift|lower] [--json]
  control graph|traversal|coverage|impact|explain-why|compare-architecture [options] [--json]
  control authorize-transition|authorize-step|authorize-deletion --input <query.json> [--json]
  control plan <change-id> [--target <snapshot.json>] [--delta <delta.json>] [--json]
  control target-propose --input <proposal.json> [--json]
  control bind-scope <change-id> --task-id <task-id> [--input <bindings.json>] [--json]
  control plan-change <change-id> --task-id <task-id> --input <planner.json> [--json]
  control reconcile-diff <input.json> [--json]
      reconciliation is read-only, accepts no Git refs, and grants no execution authority
  control handoff <input.json> [--json]
  control resume-handoff <capsule-hash> [--json]
      deterministic Control Handoff v2 capture/resume; no execution authority
  control verify-authorization <request.json> [--json]
      offline, host-independent verification of a ChangeAuthorizationCapsuleV1; read-only

Migration (one-shot, temporary; see 'semctx migrate' for details):
  migrate anchors [--apply] [--format text|json]
      rewrite deprecated line-bearing symbol anchors to their canonical form

Experimental (task -> ContextPack retriever; not a code-search replacement, see ADR 0005):
  task create --from-file <file>   create a TaskFrame (also: --text "...", --mode <m>)
  context prepare [<task-id>]      compile a ContextPack (--json to emit JSON)
  bench [--suite <file>]           measure ContextPack quality against golden expectations

Global options:
  --root <path>   repository root (default: current directory)
  --json          machine-readable output
  --version       print the CLI version and exit
`;

function resolveRoot(args: ParsedArgs): string {
  return flagString(args, "root") ?? process.cwd();
}

async function dispatch(args: ParsedArgs): Promise<number> {
  const command = args.positionals[0];
  const root = resolveRoot(args);

  // `--version` short-circuits only when it stands alone. Honouring it after a real command would
  // make `semctx verify diff --record --version` exit 0 without verifying anything — a fail-open in
  // a tool whose whole job is to gate.
  if (command === "version" || (command === undefined && flagBool(args, "version"))) {
    info(packageJson.version);
    return 0;
  }

  if (command === undefined) {
    info(HELP);
    // `--help` with no command is an explicit help request (exit 0); a bare invocation with no
    // command and no help flag is a usage error (exit 1).
    return flagBool(args, "help") ? 0 : 1;
  }
  const isAuthorizationVerification = command === "control" && args.positionals[1] === "verify-authorization";
  if (command === "help" || (flagBool(args, "help") && !isAuthorizationVerification)) {
    info(HELP);
    return 0;
  }

  switch (command) {
    case "install":
      return runInstall(root, args);
    case "plugin-status":
      return runPluginStatus(root, args);
    case "setup":
      return runSetupAsync(root, args);
    case "init":
      return runInit(root, args);
    case "index":
      return runIndexAsync(root, args);
    case "index-health":
      return runIndexHealth(root, args);
    case "task": {
      const sub = args.positionals[1];
      if (sub === "create") return runTaskCreate(root, args);
      fail(`unknown 'task' subcommand: ${sub ?? "(none)"} (expected: create)`);
      return 2;
    }
    case "context": {
      const sub = args.positionals[1];
      if (sub === "prepare") return runContextPrepare(root, args);
      fail(`unknown 'context' subcommand: ${sub ?? "(none)"} (expected: prepare)`);
      return 2;
    }
    case "inspect":
      return runInspect(root, args);
    case "bench":
      return runBenchCmd(root, args);
    case "verify": {
      const sub = args.positionals[1];
      if (sub === "diff") return runVerifyDiff(root, args);
      fail(`unknown 'verify' subcommand: ${sub ?? "(none)"} (expected: diff)`);
      return 2;
    }
    case "semantic":
      return runSemantic(root, args);
    case "change":
      return runChange(root, args);
    case "control":
      return runControl(root, args);
    case "status":
      return runStatus(root, args);
    case "doctor":
      return runDoctor(root, args);
    case "migrate":
      return runMigrate(root, args);
    default:
      fail(`unknown command: ${command}`);
      info(HELP);
      return 2;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  try {
    const code = await dispatch(args);
    process.exit(code);
  } catch (err) {
    if (isSemctxError(err)) {
      fail(`[${err.code}] ${err.message}`);
      if (Object.keys(err.details).length > 0) info(c.dim(JSON.stringify(err.details, null, 2)));
      process.exit(err.code === "CONTROL_INPUTS_UNSAFE" ? 3 : 1);
    }
    fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  }
}

void main();
