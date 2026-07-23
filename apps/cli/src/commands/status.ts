import { controlStatus } from "@semantic-context/app-services";
import { serializeControlReport } from "@semantic-context/control-model";
import type { ParsedArgs } from "../args";
import { flagBool } from "../args";
import { info } from "../output";

export function runStatus(root: string, args: ParsedArgs): number {
  const report = controlStatus(root);
  info(
    flagBool(args, "json")
      ? serializeControlReport(report)
      : `${report.verdict}${report.reasons.length === 0 ? "" : `: ${report.reasons.join(", ")}`}`,
  );
  return report.canRunHighRiskControl ? 0 : 3;
}
