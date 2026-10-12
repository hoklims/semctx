/**
 * `semctx migrate anchors` — one-shot rewrite of deprecated line-bearing symbol anchors.
 *
 * This command is **scheduled for deletion**. It exists to carry one population of anchors across
 * the line-independent identity change (HOK-79), and it is removed in the release that retires
 * `LEGACY_SYMBOL_ANCHOR_SUPPORT`. It is not a general facility for rewriting authored intent, and
 * it refuses outright once compatibility is retired.
 *
 * Dry by default. Both the dry run and the apply refuse an index that cannot speak for the working
 * tree, and the apply writes only when the whole run is clean: a single refused anchor anywhere
 * leaves every file byte-identical.
 */

import { SemctxError } from "@semantic-context/core";
import { withStore } from "../store";
import {
  anchorMigrationAuthority,
  applyConfigMigration,
  fingerprintRepositoryFacts,
  planConfigMigration,
  restoreConfigMigration,
} from "@semantic-context/app-services";
import {
  migrateAnchors,
  refusedAuthority,
  type AnchorMigrationReport,
  type RepositoryFacts,
} from "@semantic-context/semantic-engine";
import type { ConfigMigrationReportV1 } from "@semantic-context/control-model";
import type { ParsedArgs } from "../args";
import { flagBool, flagString } from "../args";
import { info, json, c, fail } from "../output";

export const MIGRATE_HELP = `semctx migrate — one-shot rewrites of authored coordinates and explicit config migration

Usage: semctx migrate anchors [--apply] [--format text|json]
       semctx migrate config --proposal <repository-relative-json> [--format text|json]
       semctx migrate config --proposal <repository-relative-json> --apply --plan <sha256> [--format text|json]
       semctx migrate config --restore <run-id> [--format text|json]

  anchors    rewrite deprecated line-bearing 'sym:<kind>:<path>:<name>:<line>' links to their
             canonical, line-independent form. Dry by default. An anchor that matches several
             symbols, or none, is refused — and a single refusal anywhere leaves the entire run
             untouched. Requires a fresh, sealed, correctly bound index.

  This subcommand is temporary: it is removed in the release that retires support for
  line-bearing anchors, and refuses to run once that support is gone.

  config     explicit v1 -> v2 configuration migration (ADR 0028). Dry by default: shows the
             selection diff and a plan digest, writes nothing. '--apply --plan <sha256>' applies
             only that exact plan, after an exact backup of the current config.json. '--restore
             <run-id>' restores a previously applied run, including after a process interruption.
`;

/** Human-readable repair for each way an index can fail to authorize a rewrite. */
const AUTHORITY_HELP: Record<string, string> = {
  INDEX_ABSENT: "run 'semctx index' first",
  INDEX_BINDING_INVALID: "the store's Plane-A binding does not match its contents; re-index",
  INDEX_STALE: "the index no longer describes the working tree; re-index",
  INDEX_UNSEALED: "the current state is unsealed; re-index",
  INDEX_SCHEMA_UNNORMALIZED: "the store predates the current index binding; re-index",
  INDEX_GENERATION_DRIFTED:
    "the index was rebuilt while this command was running, or cannot say which build it is; re-run",
  LEGACY_SUPPORT_REMOVED: "line-bearing anchors are no longer supported; this command is obsolete",
};

function renderText(report: AnchorMigrationReport): void {
  if (report.authority.status !== "authorized") {
    info(c.bold("migrate anchors — refused"));
    info("  the index cannot authorize a rewrite of authored files:");
    for (const reason of report.authority.reasons) {
      info(`    ${c.red(reason)} — ${AUTHORITY_HELP[reason] ?? "re-index"}`);
    }
    info("  nothing was read for migration and nothing was written.");
    return;
  }

  const { counts } = report;
  info(report.applied ? c.bold("migrate anchors — applied") : c.bold("migrate anchors — dry run"));
  info(`  rewritten        : ${counts.rewritten}`);
  info(`  already canonical: ${counts.alreadyCanonical}`);
  info(`  refused          : ${counts.refused}`);
  info(`  files changed    : ${counts.filesChanged}`);

  for (const file of report.files) {
    const interesting = file.outcomes.filter((outcome) => outcome.status !== "already_canonical");
    if (interesting.length === 0) continue;
    info("");
    info(c.bold(file.file));
    for (const outcome of interesting) {
      if (outcome.status === "rewritten") {
        info(`  ${outcome.line}: ${outcome.from}`);
        info(`  ${" ".repeat(String(outcome.line).length)}  -> ${outcome.to}`);
      } else if (outcome.status === "refused") {
        info(c.dim(`  ${outcome.line}: ${outcome.ref}`));
        info(`     refused (${outcome.reasonCode})`);
        for (const candidate of outcome.candidates) info(`       candidate: ${candidate}`);
      }
    }
  }

  if (report.hasRefusals) {
    info("");
    info("A refusal quarantines the whole run: no file was written.");
    info("Re-anchor the refused links by hand, then run 'semctx migrate anchors --apply' again.");
  } else if (!report.applied && counts.rewritten > 0) {
    info("");
    info("Re-run with --apply to write these changes.");
  }
}

function loadFacts(root: string): RepositoryFacts {
  return withStore(root, (store) => {
    if (!store.isIndexed()) {
      throw new SemctxError("REPO_NOT_INDEXED", "run 'semctx index' before migrating anchors");
    }
    return { graph: store.loadGraph(), claims: store.loadClaims(), evidence: store.loadEvidence() };
  });
}

const CONFIG_MIGRATION_REFUSAL_HELP: Record<string, string> = {
  INVALID_INPUT: "the current config, the proposal file or the plan digest is missing, unreadable, or fails validation",
  POLICY_CHANGE_REJECTED: "the proposal changes a field other than version/include/exclude/selectionMode/languages",
  STALE_PLAN: "the repository, its authored .sem files or verification-state.json changed since this plan digest was computed; re-run without --apply and retry",
  ACTIVE_MIGRATION: "another config migration is running against this repository right now; retry shortly",
  RECOVERY_REQUIRED: "a published run is not yet restored; restore it (command below) before any new apply",
  INVALID_ARTIFACT: "the run id, its manifest or stored artifacts, or an authored .sem / verification-state entry failed validation",
  DIVERGENT_CONFIG: "current config.json matches neither the run's before nor after bytes, so it was left as is",
};

function restoreCommand(runId: string): string {
  return `semctx migrate config --restore ${runId}`;
}

/** One line per required action — the same list the JSON report carries in `requiredActions`. */
function renderRequiredActions(report: ConfigMigrationReportV1): void {
  for (const action of report.requiredActions) {
    if (action === "RESTORE_RUN" && report.runId !== null) info(`  next: ${restoreCommand(report.runId)}`);
    if (action === "REBUILD_INDEX") info("  next: rebuild the index: semctx index");
    if (action === "RERUN_VERIFICATION") {
      info("  next: re-run verification (for example: semctx index --record); earlier proof is not restamped");
    }
  }
}

function renderConfigMigrationText(report: ConfigMigrationReportV1): void {
  if (report.status === "REFUSED") {
    info(c.bold(`migrate config ${report.operation} — refused`));
    for (const reason of report.reasons) {
      info(`  ${c.red(reason)} — ${CONFIG_MIGRATION_REFUSAL_HELP[reason] ?? "see docs/adr/0028"}`);
    }
    for (const dir of report.abandonedPreparations) {
      info(c.dim(`  unpublished preparation left in place (never auto-removed): ${dir}`));
    }
    // Only a plan is write-free. An apply/restore took the lock (creating the coordinator database),
    // and a run id means that run is published and config.json may already hold its bytes.
    if (report.runId !== null) {
      info(`  run id              : ${report.runId}`);
      info("  this run is published under .semctx/config-migrations/runs/ and not restored; config.json may already have been rewritten.");
    } else if (report.operation === "plan") {
      info("  nothing was written.");
    } else {
      info("  config.json was not modified; .semctx/config-migrations/coordinator.db may have been created for the lock (kept).");
    }
    renderRequiredActions(report);
    return;
  }

  info(c.bold(`migrate config ${report.operation} — ${report.status.toLowerCase()}`));
  if (report.planDigest !== null) info(`  plan digest        : ${report.planDigest}`);
  if (report.runId !== null) info(`  run id              : ${report.runId}`);
  if (report.plan !== null) {
    const { selectionDiff, authoredInventory, verificationState } = report.plan;
    const totalSelected = selectionDiff.added.length + selectionDiff.unchanged.length;
    info(`  selection added     : ${selectionDiff.added.length}`);
    for (const path of selectionDiff.added) info(`    + ${path}`);
    info(`  selection removed   : ${selectionDiff.removed.length}`);
    for (const path of selectionDiff.removed) info(`    - ${path}`);
    info(`  selection unchanged : ${selectionDiff.unchanged.length}`);
    if (totalSelected === 0) info(`  ${c.red("resulting selection is EMPTY")} — no files would be selected`);
    info("  (full selection diff, authored inventory and verification-state in --format json)");
    info(`  authored .sem files : ${authoredInventory.length}`);
    info(`  verification-state  : ${verificationState.present ? "present" : "absent"}`);
  }
  for (const dir of report.abandonedPreparations) {
    info(c.dim(`  unpublished preparation left in place (never auto-removed): ${dir}`));
  }
  if (report.operation === "plan" && report.status === "PLANNED") {
    info("");
    info(`Re-run with --apply --plan ${report.planDigest} to write this migration.`);
  }
  if (report.operation === "apply" && report.status === "APPLIED") {
    info("");
    info(`Applied as run ${report.runId}; undo with: ${restoreCommand(report.runId as string)}`);
    info("This command never re-indexes or restamps proof:");
  }
  if (report.operation === "restore" && report.status === "RESTORED") {
    info("");
    info(`Restored run ${report.runId}. This command never re-indexes or restamps proof:`);
  }
  renderRequiredActions(report);
}

const CONFIG_MIGRATION_ALLOWED_FLAGS = new Set(["proposal", "apply", "plan", "restore", "format", "dry-run", "root"]);

function runMigrateConfig(root: string, args: ParsedArgs): number {
  // The shared resolver falls back to `process.cwd()` for anything that is not a string (a bare
  // `--root`, parsed as boolean `true`) — silently reaching the service against the wrong
  // repository instead of refusing. A present `--root` must be a real, non-blank path.
  const rawRoot = args.flags.get("root");
  if (rawRoot !== undefined && (typeof rawRoot !== "string" || rawRoot.trim().length === 0)) {
    fail("migrate config --root requires a non-empty path value");
    return 2;
  }
  const unsupported = [...args.flags.keys()].filter((flag) => !CONFIG_MIGRATION_ALLOWED_FLAGS.has(flag));
  if (unsupported.length > 0) {
    fail(`migrate config: unsupported option(s): ${unsupported.map((flag) => `--${flag}`).join(", ")}`);
    return 2;
  }
  // The shared parser keeps the last value of a repeated option. For a command that can replace
  // config.json that is ambiguity, so every repeat is refused before any service call.
  if (args.duplicateFlags !== undefined) {
    fail(`migrate config: option(s) given more than once: ${args.duplicateFlags.map((flag) => `--${flag}`).join(", ")}`);
    return 2;
  }
  // A switch given a value ('--apply=false', '--dry-run true', '--apply <digest>') is ambiguous.
  for (const flag of ["apply", "dry-run"]) {
    const value = args.flags.get(flag);
    if (value !== undefined && value !== true) {
      fail(`migrate config --${flag} takes no value, got '${String(value)}'`);
      return 2;
    }
  }
  if (args.flags.get("format") === true) {
    fail("migrate config --format requires a value (text or json)");
    return 2;
  }
  if (args.positionals.length > 2) {
    fail(`migrate config: unexpected extra argument(s): ${args.positionals.slice(2).join(", ")}`);
    return 2;
  }

  const proposal = flagString(args, "proposal");
  const apply = flagBool(args, "apply");
  const plan = flagString(args, "plan");
  const restore = flagString(args, "restore");
  const format = flagString(args, "format");
  const dryRun = flagBool(args, "dry-run");

  if (format !== undefined && format !== "text" && format !== "json") {
    fail(`migrate config --format must be 'text' or 'json', got '${format}'`);
    return 2;
  }
  if (args.flags.has("proposal") && proposal === undefined) {
    fail("migrate config --proposal requires a value");
    return 2;
  }
  if (args.flags.has("plan") && plan === undefined) {
    fail("migrate config --plan requires a value");
    return 2;
  }
  if (args.flags.has("restore") && restore === undefined) {
    fail("migrate config --restore requires a run id value");
    return 2;
  }
  if (dryRun && apply) {
    fail("migrate config --dry-run cannot be combined with --apply");
    return 2;
  }

  if (restore !== undefined) {
    if (proposal !== undefined || apply || plan !== undefined || dryRun) {
      fail("migrate config --restore cannot be combined with --proposal, --apply, --plan or --dry-run");
      return 2;
    }
    const report = restoreConfigMigration(root, restore);
    if (format === "json") json(report); else renderConfigMigrationText(report);
    return report.status === "REFUSED" ? 1 : 0;
  }

  if (proposal === undefined) {
    fail("migrate config requires --proposal <repository-relative-json> (or --restore <run-id>)");
    return 2;
  }
  if (apply && plan === undefined) {
    fail("migrate config --apply requires --plan <sha256>");
    return 2;
  }
  if (!apply && plan !== undefined) {
    fail("migrate config --plan is only valid together with --apply");
    return 2;
  }

  const report = apply ? applyConfigMigration(root, proposal, plan as string) : planConfigMigration(root, proposal);
  if (format === "json") json(report); else renderConfigMigrationText(report);
  return report.status === "REFUSED" ? 1 : 0;
}

export function runMigrate(root: string, args: ParsedArgs): number {
  const sub = args.positionals[1];
  if (sub === "config") return runMigrateConfig(root, args);
  if (sub !== "anchors") {
    info(MIGRATE_HELP);
    return sub === undefined ? 0 : 1;
  }
  const apply = flagBool(args, "apply");
  // Recovery precedes every read used to authorize or plan a new migration. Calling the engine with
  // an intentionally refused empty plan exercises only its mandatory recovery gate; the real
  // authority and facts are then derived from the recovered tree below.
  const emptyFacts: RepositoryFacts = { graph: { nodes: [], edges: [] }, claims: [], evidence: [] };
  migrateAnchors(root, emptyFacts, {
    apply: false,
    authority: refusedAuthority(["INDEX_ABSENT"]),
  });
  const authority = anchorMigrationAuthority(root);
  // Facts are only read once the index has been shown able to speak for the tree; an unauthorized
  // run must not even produce a plan, because a plan reads as a finding.
  const facts: RepositoryFacts = authority.status === "authorized"
    ? loadFacts(root)
    : emptyFacts;
  const report = migrateAnchors(root, facts, {
    apply,
    authority,
    // The verdict came from the index, these facts came from the store, and the two reads are not
    // the same moment. Fingerprinting what was actually loaded is what lets the engine refuse a plan
    // built from one generation under a licence issued for another.
    factsIdentity: fingerprintRepositoryFacts(facts),
    // Re-derived, not reused: the window between planning and writing is exactly where an index
    // goes stale, and the proof that licensed the rewrite must still hold when it happens.
    revalidateAuthority: () => anchorMigrationAuthority(root),
  });

  if (flagString(args, "format") === "json") json(report);
  else renderText(report);

  // Failing closed is the point: CI must never read "migration done" over an anchor semctx
  // declined to rebind, nor over an index that could not authorize the rewrite.
  return report.authority.status !== "authorized" || report.hasRefusals ? 1 : 0;
}
