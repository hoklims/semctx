import {
  indexHealth,
  type IndexHealthReportV1,
} from "@semantic-context/app-services";
import type { ParsedArgs } from "../args";
import { flagBool } from "../args";
import { heading, info, json } from "../output";

function exitCode(report: IndexHealthReportV1): 0 | 2 | 3 {
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

/** `semctx index-health` — read-only Plane-A binding, freshness, and coverage health. */
export function runIndexHealth(root: string, args: ParsedArgs): number {
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
