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

test("Rust remains outside the qualified profile regardless of producer outcome or missing facts", () => {
  const input: Parameters<typeof evaluateAnalysisAdmission>[0] = {
    changedPaths: ["src/lib.rs"], links: [], candidates: [],
    current: [{ path: "src/lib.rs", selectionDecision: "selected", reason: "SELECTED" }],
    unresolvedImports: [], scopeReasons: [], bindingReasons: [], bindingStatus: "valid", canRunHighRiskControl: true,
    freshnessReasons: [], buildComplete: true, checkChanged: false, repositoryCoverageStatus: "complete",
  };
  for (const candidate of [
    undefined,
    { path: "src/lib.rs", selectionDecision: "selected" as const, analysisOutcome: "analyzed", selectionReasons: [], analysisReasons: [], admissible: true },
    { path: "src/lib.rs", selectionDecision: "selected" as const, analysisOutcome: "failed", selectionReasons: [], analysisReasons: ["RUST_NAVIGATION_DISABLED"], admissible: false },
  ]) {
    const result = evaluateAnalysisAdmission({ ...input, candidates: candidate === undefined ? [] : [candidate] });
    expect(result.status).toBe("rejected");
    expect(result.changeCoverage.files).toEqual([{ path: "src/lib.rs", status: "unsupported", reasons: ["OUTSIDE_BOUNDED_ESM_TYPESCRIPT_PROFILE"] }]);
  }
});
