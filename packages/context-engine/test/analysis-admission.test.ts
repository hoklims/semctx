import { expect, test } from "bun:test";
import { evaluateAnalysisAdmission } from "../src/analysis-admission";

test("a healthy changed file cannot admit an inadmissible transitive dependent", () => {
  const candidates = ["src/changed.mjs", "src/unchanged.ts"].map((path) => ({ path, selectionDecision: "selected" as const, analysisOutcome: "analyzed", selectionReasons: [], analysisReasons: [], admissible: true }));
  const input: Parameters<typeof evaluateAnalysisAdmission>[0] = {
    changedPaths: ["src/changed.mjs"], links: [["src/unchanged.ts", "src/changed.mjs"]], candidates,
    current: candidates.map((candidate) => ({ path: candidate.path, selectionDecision: "selected", reason: "SELECTED" })),
    unresolvedImports: [], scopeReasons: [], bindingReasons: [], bindingStatus: "valid", canRunHighRiskControl: true,
    freshnessReasons: [], buildComplete: true, checkChanged: false, repositoryCoverageStatus: "complete",
  };
  expect(evaluateAnalysisAdmission(input).status).toBe("admitted");
  candidates[1]!.admissible = false;
  const rejected = evaluateAnalysisAdmission(input);
  expect(rejected.status).toBe("rejected");
  expect(rejected.changeCoverage.files).toContainEqual({ path: "src/unchanged.ts", status: "failed", reasons: ["LOAD_BEARING_EVALUATION_NOT_ADMITTED"] });
});
