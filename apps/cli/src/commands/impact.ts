import { resolve } from "node:path";
import { SemctxError, type ChangeImpactReport, type ImpactTarget } from "@semantic-context/core";
import { runChangeImpact, type ChangeImpactRequest } from "@semantic-context/app-services";
import type { ParsedArgs } from "../args";
import { flagBool, flagString } from "../args";
import { c, heading, info, json } from "../output";
import { replaceLocalReportFile } from "../report-output";

type Format = "text" | "json";

/** Only diffs semctx computes itself: a supplied diff could never be bound to the index. */
export function impactSourceFromArgs(args: ParsedArgs): ChangeImpactRequest {
  if (flagString(args, "from-file") !== undefined) {
    throw new SemctxError(
      "INVALID_TASK_INPUT",
      "--from-file is not supported: change impact joins the index only with a diff semctx computed itself",
    );
  }
  const base = flagString(args, "base");
  const head = flagString(args, "head");
  const staged = flagBool(args, "staged");
  if (base !== undefined && staged) {
    throw new SemctxError("INVALID_TASK_INPUT", "--base and --staged are mutually exclusive");
  }
  if (base !== undefined) return head === undefined ? { kind: "range", base } : { kind: "range", base, head };
  const kind = staged ? "staged" as const : "working-tree" as const;
  return head === undefined ? { kind } : { kind, head };
}

function resolveFormat(args: ParsedArgs): Format {
  const explicit = flagString(args, "format");
  if (explicit === undefined) return flagBool(args, "json") ? "json" : "text";
  if (explicit !== "text" && explicit !== "json") {
    throw new SemctxError("INVALID_TASK_INPUT", `--format must be text|json, got "${explicit}"`, { format: explicit });
  }
  return explicit;
}

function renderTier(title: string, targets: readonly ImpactTarget[] | null): void {
  heading(`${title} (${targets === null ? "not computed" : targets.length})`);
  if (targets === null || targets.length === 0) {
    info(c.dim(targets === null ? "  unknown: the index binding is broken" : "  none found (not a statement of absence)"));
    return;
  }
  for (const target of targets) {
    const where = target.file === undefined ? "" : c.dim(` ${target.file}`);
    info(`  ${target.name}${where} ${c.dim(`[${target.reason}, d=${target.distance}]`)}`);
  }
}

function renderText(report: ChangeImpactReport): void {
  const { analysis, subject } = report;
  heading(`Change impact (${subject.source}${subject.base === null ? "" : ` ${subject.base}..${subject.head}`})`);
  info(`  binding    : ${analysis.binding.status}${analysis.binding.rangeSide === null ? "" : ` (${analysis.binding.rangeSide} side)`}`);
  if (analysis.binding.breaks.length > 0) info(`  breaks     : ${analysis.binding.breaks.join(", ")}`);
  info(`  confidence : ${analysis.confidence.level} (${analysis.confidence.reasons.join(", ")})`);
  info(`  blast      : ${report.blastRadius.scope}${report.blastRadius.complete ? "" : " (reach incomplete)"}`);
  info(`  semantic   : ${analysis.semanticLayer}`);

  heading(`Changed (${report.changes.files.length} files)`);
  for (const file of report.changes.files) info(`  ${file.path} ${c.dim(`[${file.status}]`)}`);
  for (const unit of report.changes.units ?? []) {
    const marker = unit.behavioral ? c.yellow("*") : c.dim("-");
    info(`  ${marker} ${unit.kind} ${unit.names.join(", ") || unit.file}`);
  }
  renderTier("Directly affected", report.directlyAffected);
  renderTier("Transitively affected", report.transitivelyAffected);
  renderTier("Possibly affected (structural link only)", report.possiblyAffected);
  if ((report.exposedClaims ?? []).length > 0) {
    heading("Exposed claims");
    for (const claim of report.exposedClaims ?? []) info(`  ${claim.id} ${c.dim(`[${claim.source}, ${claim.exposure}]`)}`);
  }
  if (report.surfaces !== null) {
    heading("Surfaces");
    for (const surface of report.surfaces) info(`  ${surface.name}: ${surface.exposure}`);
  }
  if (report.unresolved.length > 0) {
    heading("Unresolved (where the modeled reach stops)");
    for (const gap of report.unresolved) {
      const at = gap.file ?? gap.nodeId;
      info(`  ${c.dim("?")} ${gap.code}${at === undefined ? "" : ` ${at}`} ${c.dim(`— ${gap.detail}`)}`);
    }
  }
  info(c.dim("\nNothing absent from these tiers is shown to be unaffected. semctx decides no proof, test or gate."));
}

/** `semctx impact diff` — what a change can affect, through which link, and where the reach stops. */
export function runImpactDiff(root: string, args: ParsedArgs): number {
  const format = resolveFormat(args);
  const source = impactSourceFromArgs(args);
  const surfaces = flagString(args, "surfaces");
  const outputPath = flagString(args, "output");
  const report = runChangeImpact(root, source, surfaces === undefined ? {} : { surfacesPath: resolve(process.cwd(), surfaces) });
  if (outputPath !== undefined) {
    replaceLocalReportFile(resolve(process.cwd(), outputPath), `${JSON.stringify(report, null, 2)}\n`, root);
  }
  if (format === "json") json(report);
  else renderText(report);
  // Informational by construction: a broken binding or an incomplete reach is data, not a failure.
  return 0;
}
