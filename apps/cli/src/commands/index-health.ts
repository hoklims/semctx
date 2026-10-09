import {
  INDEX_HEALTH_SECTIONS,
  indexHealth,
  indexHealthView,
  type IndexHealthReportV1,
  type IndexHealthReportV2,
  type IndexHealthViewRequest,
} from "@semantic-context/app-services";
import { canonicalJson, SemctxError } from "@semantic-context/core";
import type { ParsedArgs } from "../args";
import { flagBool } from "../args";
import { heading, info, json } from "../output";

function exitCode(report: IndexHealthReportV1 | IndexHealthReportV2): 0 | 2 | 3 {
  if (
    report.binding.status !== "valid"
    || !report.freshness.canRunHighRiskControl
  ) {
    return 3;
  }
  if (report.coverage.status === "complete") return 0;
  if (report.coverage.status === "partial") return 2;
  return 3;
}

function topReasons(reasons: readonly string[]): string {
  return reasons.length === 0 ? "none" : reasons.slice(0, 5).join(", ");
}

function viewRequest(args: ParsedArgs): IndexHealthViewRequest | undefined {
  const names = ["summary", "section", "cursor", "limit"];
  const duplicates = args.duplicateFlags?.filter((name) => names.includes(name)) ?? [];
  if (duplicates.length > 0) {
    throw new SemctxError("INVALID_TASK_INPUT", `duplicate index-health options: ${duplicates.map((name) => `--${name}`).join(", ")}`);
  }
  if (!names.some((name) => args.flags.has(name))) return undefined;
  if (!flagBool(args, "json")) {
    throw new SemctxError("INVALID_TASK_INPUT", "index-health --summary and --section require --json");
  }
  if (args.flags.has("summary") && !flagBool(args, "summary")) {
    throw new SemctxError("INVALID_TASK_INPUT", "--summary is a boolean flag; use --summary --json");
  }
  if (args.flags.has("summary") && args.flags.has("section")) {
    throw new SemctxError("INVALID_TASK_INPUT", "--summary and --section are mutually exclusive");
  }
  if (!args.flags.has("section")) {
    if (args.flags.has("cursor") || args.flags.has("limit")) {
      throw new SemctxError("INVALID_TASK_INPUT", "--cursor and --limit require --section");
    }
    return {};
  }
  const section = INDEX_HEALTH_SECTIONS.find((value) => value === args.flags.get("section"));
  if (section === undefined) {
    throw new SemctxError("INVALID_TASK_INPUT", `--section requires one of: ${INDEX_HEALTH_SECTIONS.join(", ")}`);
  }
  const cursor = args.flags.get("cursor");
  if (args.flags.has("cursor") && (typeof cursor !== "string" || cursor.length === 0)) {
    throw new SemctxError("INVALID_TASK_INPUT", "--cursor requires a nonempty cursor returned by an index-health page");
  }
  const rawLimit = args.flags.get("limit");
  const limit = typeof rawLimit === "string" ? Number(rawLimit) : undefined;
  if (args.flags.has("limit") && (typeof rawLimit !== "string" || !/^\d+$/.test(rawLimit) || limit === undefined || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
    throw new SemctxError("INVALID_TASK_INPUT", "--limit requires an integer from 1 through 100");
  }
  return {
    section,
    ...(typeof cursor === "string" ? { cursor } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

export function runIndexHealth(root: string, args: ParsedArgs): number {
  const request = viewRequest(args);
  if (request !== undefined) {
    const report = indexHealthView(root, request);
    info(canonicalJson(report));
    return exitCode(report);
  }
  const report = indexHealth(root);
  if (flagBool(args, "json")) {
    json(report);
    return exitCode(report);
  }

  heading("Index health");
  info(`  binding              ${report.binding.status}`);
  info(
    `  freshness            ${report.freshness.verdict}`
      + ` (high-risk capable: ${report.freshness.canRunHighRiskControl ? "yes" : "no"})`,
  );
  info(
    `  coverage             ${report.coverage.status}`
      + ` (${report.coverage.selected}/${report.coverage.candidates} selected,`
      + ` ${report.coverage.excluded} excluded)`,
  );
  info(
    "  outcomes             "
      + `analyzed ${report.coverage.analyzed},`
      + ` disabled ${report.coverage.disabled},`
      + ` unsupported ${report.coverage.unsupported},`
      + ` failed ${report.coverage.failed}`,
  );
  info(`  workspace diagnostics ${report.workspace?.diagnostics.length ?? 0}`);
  info(`  top coverage reasons ${topReasons(report.reasonSummary)}`);
  info(`  top freshness reasons ${topReasons(report.freshness.reasons)}`);
  return exitCode(report);
}
