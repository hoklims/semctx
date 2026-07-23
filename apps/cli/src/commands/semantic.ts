import { SemctxError } from "@semantic-context/core";
import { checkSemanticState } from "@semantic-context/app-services";
import { openStore } from "@semantic-context/repository-store";
import {
  initSemanticScaffold,
  loadModelWithWorking,
  loadActiveChange,
  formatSemanticFiles,
  inspectSemantic,
  sliceSemanticModel,
  renderSlice,
  captureHandoff,
  readHandoff,
  renderHandoffMarkdown,
  buildHandoffCapsule,
  handoffMarkdownPath,
  type RepositoryFacts,
} from "@semantic-context/semantic-engine";
import { renderNode, renderChange, type Notation } from "@semantic-context/semantic-dsl";
import type { ParsedArgs } from "../args";
import { flagBool, flagString } from "../args";
import { info, heading, success, warn, fail, json, c, nowIso } from "../output";

const SEMANTIC_HELP = `semctx semantic — authored semantic layer (Plane B)

Usage: semctx semantic <subcommand> [options]

  init [--dry-run --force]          scaffold .semctx/semantic/ (versioned) + working dir + gitignore
  check                             validate the model: diagnostics, refs, and stale links (exit 1 on failure)
  inspect <semantic-id>             show a node/change, who references it, and link resolution
  render <semantic-id> --notation symbols|ascii   render a node/change as a human view
  format [--write]                  canonicalise .sem files (dry by default; --write applies)
  slice [--change <id>] [--symbol <ref>] [--claim <ref>] [--max-nodes N] [--format agent|ascii|symbols|json]
  handoff [--note "<text>"]         capture the working delta into .semctx/working/ (anti-compaction)
  resume                            re-emit the last handoff capsule (or one from the active change)
`;

function loadFacts(root: string): { facts: RepositoryFacts | undefined; indexed: boolean } {
  const store = openStore(root);
  const indexed = store.isIndexed();
  if (!indexed) {
    store.close();
    return { facts: undefined, indexed: false };
  }
  const facts: RepositoryFacts = { graph: store.loadGraph(), claims: store.loadClaims(), evidence: store.loadEvidence() };
  store.close();
  return { facts, indexed };
}

export function runSemantic(root: string, args: ParsedArgs): number {
  const sub = args.positionals[1];
  switch (sub) {
    case "init":
      return semanticInit(root, args);
    case "check":
      return semanticCheck(root, args);
    case "inspect":
      return semanticInspect(root, args);
    case "render":
      return semanticRender(root, args);
    case "format":
      return semanticFormat(root, args);
    case "slice":
      return semanticSlice(root, args);
    case "handoff":
      return semanticHandoff(root, args);
    case "resume":
      return semanticResume(root, args);
    default:
      info(SEMANTIC_HELP);
      return sub === undefined || flagBool(args, "help") ? 0 : 2;
  }
}

function semanticInit(root: string, args: ParsedArgs): number {
  const dryRun = flagBool(args, "dry-run");
  const { plan, gitignore } = initSemanticScaffold(root, { force: flagBool(args, "force"), dryRun });
  if (flagBool(args, "json")) {
    json({ dryRun, plan, gitignore });
    return 0;
  }
  heading(dryRun ? "semantic init — preview (dry run)" : "semantic init");
  for (const p of plan) {
    const mark = p.action === "create" ? c.green("create ") : p.action === "overwrite" ? c.yellow("overwrite") : c.dim("skip    ");
    info(`  ${mark} ${p.file}`);
  }
  info(`  ${gitignore.action === "present" ? c.dim("present ") : c.green(gitignore.action.padEnd(8))} ${gitignore.path}  ${c.dim("(tracks .semctx/semantic/)")}`);
  info("");
  if (dryRun) info(c.dim("Dry run — nothing written."));
  else {
    success("semantic layer initialised");
    info(c.dim("Next: edit .semctx/semantic/*.sem, then run 'semctx semantic check'"));
  }
  return 0;
}

function semanticCheck(root: string, args: ParsedArgs): number {
  const report = checkSemanticState(root);
  const indexed = report.graphIndexed;

  if (flagBool(args, "json")) {
    json(report);
    return report.ok ? 0 : 1;
  }

  heading("semantic check");
  info(`  nodes: ${report.counts.nodes}  changes: ${report.counts.changes}  indexed: ${indexed ? "yes" : c.dim("no (run 'semctx index' to check links)")}`);
  for (const d of report.diagnostics) {
    const tag = d.severity === "error" ? c.red("error") : c.yellow("warn ");
    info(`  ${tag} ${d.file}:${d.line}:${d.column} ${d.message}`);
  }
  for (const id of report.duplicateIds) info(`  ${c.red("error")} duplicate id declared in more than one file: ${id}`);
  for (const iv of report.invalidIds) info(`  ${c.red("error")} id "${iv.id}" does not match its kind "${iv.kind}"`);
  for (const dr of report.danglingReferences) info(`  ${c.red("error")} ${dr.ownerId} ${dr.field} -> ${dr.ref} (not declared)`);
  for (const s of report.staleLinks) info(`  ${c.red("stale")} ${s.ownerId} link ${s.link.ref} (${s.reason})`);
  for (const finding of report.lifecycleFindings) {
    const subjects = finding.subjectIds.length > 0 ? ` [${finding.subjectIds.join(", ")}]` : "";
    const tag = finding.severity === "error" ? c.red("error") : c.yellow("warn ");
    info(`  ${tag} ${finding.code}${subjects}: ${finding.message}`);
  }
  info("");
  if (report.ok) {
    success("semantic model is consistent");
    return 0;
  }
  fail("semantic model has issues");
  return 1;
}

function semanticInspect(root: string, args: ParsedArgs): number {
  const id = args.positionals[2];
  if (id === undefined) throw new SemctxError("INVALID_TASK_INPUT", "usage: semctx semantic inspect <semantic-id>");
  const { model } = loadModelWithWorking(root);
  const { facts } = loadFacts(root);
  const inspection = inspectSemantic(model, id, facts);
  if (flagBool(args, "json")) {
    json(inspection);
    return inspection.found ? 0 : 1;
  }
  if (!inspection.found) {
    fail(`no semantic node or change with id "${id}"`);
    return 1;
  }
  const owner = inspection.node ?? inspection.change;
  heading(`${id}`);
  if (inspection.node !== undefined) info(renderNode(inspection.node, "symbols"));
  else if (inspection.change !== undefined) info(renderChange(inspection.change, "symbols"));
  if (inspection.incoming.length > 0) {
    heading("Referenced by");
    for (const ref of inspection.incoming) info(`  ${ref.from} (${ref.field})`);
  }
  if (inspection.linkResolutions.length > 0) {
    heading("Repository links");
    for (const r of inspection.linkResolutions) info(`  ${r.resolved ? c.green("ok   ") : c.red("stale")} ${r.link.kind} ${r.link.ref}${r.reason !== undefined ? c.dim(`  (${r.reason})`) : ""}`);
  }
  void owner;
  return 0;
}

function semanticRender(root: string, args: ParsedArgs): number {
  const id = args.positionals[2];
  if (id === undefined) throw new SemctxError("INVALID_TASK_INPUT", "usage: semctx semantic render <semantic-id> --notation symbols|ascii");
  const notation: Notation = flagString(args, "notation") === "ascii" ? "ascii" : "symbols";
  const { model } = loadModelWithWorking(root);
  const node = model.nodes.find((n) => n.id === id);
  const change = model.changes.find((cc) => cc.id === id);
  if (node === undefined && change === undefined) {
    fail(`no semantic node or change with id "${id}"`);
    return 1;
  }
  info(node !== undefined ? renderNode(node, notation) : renderChange(change!, notation));
  return 0;
}

function semanticFormat(root: string, args: ParsedArgs): number {
  const write = flagBool(args, "write");
  const outcomes = formatSemanticFiles(root, write);
  if (flagBool(args, "json")) {
    json({ write, outcomes });
    return 0;
  }
  heading(write ? "semantic format" : "semantic format — preview (pass --write to apply)");
  for (const o of outcomes) {
    const mark = o.skipped ? c.dim("skip    ") : o.changed ? (write ? c.green("formatted") : c.yellow("would fmt")) : c.dim("ok      ");
    info(`  ${mark} ${o.file}`);
  }
  const changed = outcomes.filter((o) => o.changed).length;
  info("");
  if (!write && changed > 0) info(c.dim(`${changed} file(s) would change. Canonical form omits comments; comment-only files are left as-is.`));
  else success(write ? `formatted ${changed} file(s)` : "already canonical");
  return 0;
}

function semanticSlice(root: string, args: ParsedArgs): number {
  const { model } = loadModelWithWorking(root);
  const maxNodesRaw = flagString(args, "max-nodes");
  const scope = {
    ...(flagString(args, "change") !== undefined ? { changeId: flagString(args, "change") } : {}),
    ...(flagString(args, "symbol") !== undefined ? { symbolRef: flagString(args, "symbol") } : {}),
    ...(flagString(args, "claim") !== undefined ? { claimRef: flagString(args, "claim") } : {}),
    ...(maxNodesRaw !== undefined && Number.isFinite(Number(maxNodesRaw)) ? { maxNodes: Number(maxNodesRaw) } : {}),
  };
  const slice = sliceSemanticModel(model, scope);
  const format = flagString(args, "format") ?? "agent";
  if (format === "json") {
    json(slice);
    return 0;
  }
  const notation = format === "ascii" ? "ascii" : "symbols";
  info(renderSlice(slice, notation));
  return 0;
}

function semanticHandoff(root: string, args: ParsedArgs): number {
  const { model } = loadModelWithWorking(root);
  const note = flagString(args, "note");
  const capsule = captureHandoff({ root, now: nowIso(), model, activeChange: loadActiveChange(root), ...(note !== undefined ? { note } : {}) });
  if (flagBool(args, "json")) {
    json(capsule);
    return 0;
  }
  info(renderHandoffMarkdown(capsule));
  info(c.dim(`written -> ${handoffMarkdownPath(root)}`));
  return 0;
}

function semanticResume(root: string, args: ParsedArgs): number {
  let capsule = readHandoff(root);
  if (capsule === undefined) {
    const { model } = loadModelWithWorking(root);
    const active = loadActiveChange(root);
    if (active === undefined) {
      warn("no handoff on record and no active change; nothing to resume");
      return 0;
    }
    capsule = buildHandoffCapsule({ root, now: nowIso(), model, activeChange: active });
  }
  if (flagBool(args, "json")) {
    json(capsule);
    return 0;
  }
  info(renderHandoffMarkdown(capsule));
  return 0;
}
