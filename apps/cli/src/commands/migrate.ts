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
import { openStore } from "@semantic-context/repository-store";
import { anchorMigrationAuthority, fingerprintRepositoryFacts } from "@semantic-context/app-services";
import {
  migrateAnchors,
  refusedAuthority,
  type AnchorMigrationReport,
  type RepositoryFacts,
} from "@semantic-context/semantic-engine";
import type { ParsedArgs } from "../args";
import { flagBool, flagString } from "../args";
import { info, json, c } from "../output";

export const MIGRATE_HELP = `semctx migrate — one-shot rewrites of authored coordinates

Usage: semctx migrate anchors [--apply] [--format text|json]

  anchors    rewrite deprecated line-bearing 'sym:<kind>:<path>:<name>:<line>' links to their
             canonical, line-independent form. Dry by default. An anchor that matches several
             symbols, or none, is refused — and a single refusal anywhere leaves the entire run
             untouched. Requires a fresh, sealed, correctly bound index.

  This subcommand is temporary: it is removed in the release that retires support for
  line-bearing anchors, and refuses to run once that support is gone.
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
  const store = openStore(root);
  try {
    if (!store.isIndexed()) {
      throw new SemctxError("REPO_NOT_INDEXED", "run 'semctx index' before migrating anchors");
    }
    return { graph: store.loadGraph(), claims: store.loadClaims(), evidence: store.loadEvidence() };
  } finally {
    store.close();
  }
}

export function runMigrate(root: string, args: ParsedArgs): number {
  const sub = args.positionals[1];
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
