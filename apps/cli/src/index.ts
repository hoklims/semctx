#!/usr/bin/env bun
import { isSemctxError } from "@semantic-context/core";
import { parseArgs, flagString, flagBool, type ParsedArgs } from "./args";
import { fail, info, c } from "./output";
import { runInit } from "./commands/init";
import { runIndex } from "./commands/index-cmd";
import { runTaskCreate } from "./commands/task";
import { runContextPrepare } from "./commands/context";
import { runVerifyDiff } from "./commands/verify";
import { runInspect } from "./commands/inspect";
import { runBenchCmd } from "./commands/bench";
import { runDoctor } from "./commands/doctor";

const HELP = `semctx — repository change-impact analyzer

Usage: semctx <command> [options]

Core:
  init [--preset github-claude]    initialise .semctx/ (db + config)
      --dry-run --force            preview / overwrite existing files
      --with-github-action --with-claude-code --with-devcontainer   preset extras
  index [--json]                   analyse the repo -> deterministic graph
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

Experimental (task -> ContextPack retriever; not a code-search replacement, see ADR 0005):
  task create --from-file <file>   create a TaskFrame (also: --text "...", --mode <m>)
  context prepare [<task-id>]      compile a ContextPack (--json to emit JSON)
  bench [--suite <file>]           measure ContextPack quality against golden expectations

Global options:
  --root <path>   repository root (default: current directory)
  --json          machine-readable output
`;

function resolveRoot(args: ParsedArgs): string {
  return flagString(args, "root") ?? process.cwd();
}

async function dispatch(args: ParsedArgs): Promise<number> {
  const command = args.positionals[0];
  const root = resolveRoot(args);

  if (command === undefined) {
    info(HELP);
    return 1;
  }
  if (command === "help" || flagBool(args, "help")) {
    info(HELP);
    return 0;
  }

  switch (command) {
    case "init":
      return runInit(root, args);
    case "index":
      return runIndex(root, args);
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
    case "doctor":
      return runDoctor(root, args);
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
      process.exit(1);
    }
    fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  }
}

void main();
