import { SemctxError } from "@semantic-context/core";
import { closeChange, normalizeChangeId, openChange, updateChange, verifyAuthoredChange } from "@semantic-context/app-services";
import { changeFilePath, loadModelWithWorking, type ChangeVerifyReport } from "@semantic-context/semantic-engine";
import { renderChange } from "@semantic-context/semantic-dsl";
import type { ChangeContract, ChangeLifecycle } from "@semantic-context/semantic-model";
import { isChangeLifecycle } from "@semantic-context/semantic-model";
import { verifySourceFromArgs } from "./verify";
import type { ParsedArgs } from "../args";
import { flagBool, flagString } from "../args";
import { info, heading, success, warn, fail, json, c } from "../output";

const CHANGE_HELP = `semctx change — proof-carrying change contracts

Usage: semctx change <subcommand> <id> [options]

  open <id>      open a change contract (defaults to lifecycle 'active'; --draft to stage)
      --statement "<text>" --serves <ids> --preserves <ids> --requires <ids>
      --unknown <ids> --link <refs> --tag <tags>   (comma-separated lists)
  update <id>    patch a change contract (additive)
      --statement --status <non-verified-lifecycle> --serves --preserves --requires --unknown
      --resolve-unknown <ids> --link --tag   (resolution requires proved_by evidence)
  inspect <id>   show a change contract
  verify <id>    compose 'verify diff' with the contract -> VERIFIED|PARTIAL|BLOCKED|STALE
      --base <ref> --head <ref> --staged --from-file <f> --format text|json --fail-on block|partial|none
  close <id>     derive verified after a fresh composed check (or --superseded)
`;

function list(args: ParsedArgs, name: string): string[] {
  const raw = flagString(args, name);
  if (raw === undefined) return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function requireId(args: ParsedArgs, verb: string): string {
  const id = args.positionals[2];
  if (id === undefined) throw new SemctxError("INVALID_TASK_INPUT", `usage: semctx change ${verb} <id>`);
  return normalizeChangeId(id);
}

function findChange(root: string, id: string): ChangeContract | undefined {
  const { model } = loadModelWithWorking(root);
  return model.changes.find((c2) => c2.id === id);
}

export function runChange(root: string, args: ParsedArgs): number {
  const sub = args.positionals[1];
  switch (sub) {
    case "open":
      return changeOpen(root, args);
    case "update":
      return changeUpdate(root, args);
    case "inspect":
      return changeInspect(root, args);
    case "verify":
      return changeVerify(root, args);
    case "close":
      return changeClose(root, args);
    default:
      info(CHANGE_HELP);
      return sub === undefined || flagBool(args, "help") ? 0 : 2;
  }
}

function changeOpen(root: string, args: ParsedArgs): number {
  const id = requireId(args, "open");
  const lifecycle: ChangeLifecycle = flagBool(args, "draft") ? "draft" : "active";
  const contract = openChange(root, {
    id,
    statement: flagString(args, "statement") ?? "TODO: describe the change",
    lifecycle,
    provenance: "author",
    serves: list(args, "serves"),
    preserves: list(args, "preserves"),
    requiresEvidence: list(args, "requires"),
    openUnknowns: list(args, "unknown"),
    links: list(args, "link"),
    tags: list(args, "tag"),
  });
  if (flagBool(args, "json")) {
    json({ opened: id, lifecycle, file: changeFilePath(root, id), contract });
    return 0;
  }
  success(`opened change ${c.bold(id)} [${lifecycle}]`);
  info(renderChange(contract, "symbols"));
  info(c.dim(`\nNext: semctx semantic slice --change ${id} --format agent`));
  return 0;
}

function changeUpdate(root: string, args: ParsedArgs): number {
  const id = requireId(args, "update");
  const statusRaw = flagString(args, "status");
  if (statusRaw !== undefined && !isChangeLifecycle(statusRaw)) {
    throw new SemctxError("INVALID_TASK_INPUT", `--status must be a change lifecycle (draft|active|verified|partial|blocked|stale|superseded), got "${statusRaw}"`);
  }
  const updated = updateChange(root, {
    id,
    provenance: "author",
    ...(flagString(args, "statement") !== undefined ? { statement: flagString(args, "statement") } : {}),
    ...(statusRaw !== undefined ? { lifecycle: statusRaw as ChangeLifecycle } : {}),
    addServes: list(args, "serves"),
    addPreserves: list(args, "preserves"),
    addRequires: list(args, "requires"),
    addUnknowns: list(args, "unknown"),
    resolveUnknowns: list(args, "resolve-unknown"),
    addLinks: list(args, "link"),
    addTags: list(args, "tag"),
  });
  if (flagBool(args, "json")) {
    json({ updated: id, contract: updated });
    return 0;
  }
  success(`updated change ${c.bold(id)}`);
  info(renderChange(updated, "symbols"));
  return 0;
}

function changeInspect(root: string, args: ParsedArgs): number {
  const id = requireId(args, "inspect");
  const change = findChange(root, id);
  if (change === undefined) {
    fail(`no change contract "${id}"`);
    return 1;
  }
  if (flagBool(args, "json")) {
    json(change);
    return 0;
  }
  heading(id);
  info(renderChange(change, "symbols"));
  return 0;
}

function changeVerify(root: string, args: ParsedArgs): number {
  const id = requireId(args, "verify");
  const change = findChange(root, id);
  if (change === undefined) {
    fail(`no change contract "${id}" (open it first)`);
    return 1;
  }
  const composed = verifyAuthoredChange(root, id, verifySourceFromArgs(args));

  if (flagString(args, "format") === "json" || flagBool(args, "json")) {
    json(composed);
    return exitForVerdict(composed.verdict, args);
  }
  renderComposed(composed);
  return exitForVerdict(composed.verdict, args);
}

function changeClose(root: string, args: ParsedArgs): number {
  const id = requireId(args, "close");
  const change = findChange(root, id);
  if (change === undefined) {
    fail(`no change contract "${id}"`);
    return 1;
  }
  const superseded = flagBool(args, "superseded");
  const closed = closeChange(root, { id, superseded, source: verifySourceFromArgs(args) });
  const lifecycle = closed.lifecycle;
  if (flagBool(args, "json")) {
    json({ closed: id, lifecycle });
    return 0;
  }
  success(`closed change ${c.bold(id)} [${lifecycle}]`);
  return 0;
}

function exitForVerdict(verdict: ChangeVerifyReport["verdict"], args: ParsedArgs): number {
  const failOn = flagString(args, "fail-on") ?? "block";
  if (failOn === "none") return 0;
  if (verdict === "BLOCKED" || verdict === "STALE") return 3;
  if (verdict === "PARTIAL" && failOn === "partial") return 3;
  return 0;
}

const G = { change: "Δ", inv: "□", proof: "⊢", unknown: "?" };

function renderComposed(r: ChangeVerifyReport): void {
  const color = r.verdict === "VERIFIED" ? c.green : r.verdict === "PARTIAL" ? c.yellow : c.red;
  heading(`${G.change} ${r.changeId}  [${r.lifecycle}]`);
  info(`  underlying verify diff: ${r.underlying.verdict}`);

  const preserved = r.preserved.filter((p) => p.state === "proved" || p.state === "untouched");
  heading("preserved");
  if (preserved.length === 0) info(c.dim("  (none)"));
  for (const p of preserved) info(`  ${G.inv} ${p.id} ${c.dim(`[${p.state}]`)}`);

  const atRisk = r.preserved.filter((p) => p.state === "unproven" || p.state === "contradicted" || p.state === "missing");
  if (atRisk.length > 0) {
    heading("at risk");
    for (const p of atRisk) info(`  ${c.red(G.inv)} ${p.id} ${c.dim(`[${p.state}${p.critical ? ", critical" : ""}]`)}`);
  }

  heading("proved");
  if (r.provedEvidence.length === 0) info(c.dim("  (none)"));
  for (const e of r.provedEvidence) info(`  ${G.proof} ${e.id} ${c.dim(`[${e.status}]`)}`);

  if (r.pendingEvidence.length > 0) {
    heading("pending proof");
    for (const e of r.pendingEvidence) info(`  ${c.yellow(G.proof)} ${e.id} ${c.dim(`[${e.status}]`)}`);
  }

  if (r.openUnknowns.length > 0) {
    heading("partial");
    for (const u of r.openUnknowns) info(`  ${G.unknown} ${u.id}${u.critical ? c.red(" (critical)") : ""}`);
  }

  if (r.stale.length > 0) {
    heading("stale");
    for (const s of r.stale) info(`  ${c.red("~")} ${s.message}`);
  }

  info("");
  info(`verdict: ${color(r.verdict)}`);
  if (r.verdict === "PARTIAL") {
    const remaining = [...r.pendingEvidence.map((e) => e.id), ...r.openUnknowns.map((u) => u.id)];
    warn(`unproven / open: ${remaining.join(", ") || "(policy)"}`);
  } else if (r.verdict === "BLOCKED") fail("blocking findings present — do not conclude done");
  else if (r.verdict === "STALE") fail("semantic links have drifted — re-link before trusting the verdict");
}
