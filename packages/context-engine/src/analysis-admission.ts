import type { AnalysisAdmission } from "@semantic-context/core";

/** Pure evidence projection; source discovery and freshness observations belong to callers. */
export interface AdmissionCandidate {
  path: string; selectionDecision: "selected" | "excluded";
  analysisOutcome: string; selectionReasons: string[]; analysisReasons: string[]; admissible: boolean;
}
export function evaluateAnalysisAdmission(input: {
  changedPaths: readonly string[]; links: readonly (readonly [string, string])[];
  candidates: readonly AdmissionCandidate[];
  current: readonly { path: string; selectionDecision: "selected" | "excluded"; reason: string }[];
  unresolvedImports: readonly { path: string; specifier: string }[];
  scopeReasons: readonly string[]; bindingReasons: readonly string[];
  bindingStatus: string; canRunHighRiskControl: boolean; freshnessReasons: readonly string[];
  buildComplete: boolean; checkChanged: boolean; repositoryCoverageStatus: AnalysisAdmission["repositoryCoverage"]["status"];
}): Pick<AnalysisAdmission, "status" | "changeCoverage" | "repositoryCoverage" | "reasons"> {
  const expected = new Set(input.changedPaths);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [from, to] of input.links) {
      if (!expected.has(from) && !expected.has(to)) continue;
      for (const path of [from, to]) if (!expected.has(path)) { expected.add(path); changed = true; }
    }
  }
  const persisted = new Map(input.candidates.map((candidate) => [candidate.path, candidate]));
  const current = new Map(input.current.map((candidate) => [candidate.path, candidate]));
  const file = (path: string): AnalysisAdmission["changeCoverage"]["files"][number] => {
    const candidate = persisted.get(path); const selected = current.get(path);
    if (candidate?.selectionDecision === "excluded" || selected?.selectionDecision === "excluded") return {
      path, status: "excluded", reasons: [...(candidate?.selectionReasons ?? []), ...(selected === undefined ? [] : [selected.reason])],
    };
    if (candidate === undefined || selected === undefined) return { path, status: "missing", reasons: ["NO_CURRENT_ANALYZED_SOURCE"] };
    if (candidate.analysisOutcome !== "analyzed") return { path, status: candidate.analysisOutcome === "failed" ? "failed" : "unsupported", reasons: [...candidate.analysisReasons, ...candidate.selectionReasons, `ANALYSIS_OUTCOME:${candidate.analysisOutcome}`] };
    if (candidate.analysisReasons.length > 0) return { path, status: candidate.analysisReasons.some((reason) => /UNSUPPORTED|UNRESOLVED|SOURCE_CONFIGURATION/.test(reason)) ? "unsupported" : "failed", reasons: candidate.analysisReasons };
    if (!candidate.admissible) return { path, status: "failed", reasons: ["LOAD_BEARING_EVALUATION_NOT_ADMITTED"] };
    if (!/\.[cm]?[jt]sx?$/.test(path)) return { path, status: "unsupported", reasons: ["OUTSIDE_BOUNDED_ESM_TYPESCRIPT_PROFILE"] };
    return { path, status: "analyzed", reasons: [] };
  };
  const files = [...expected].sort().map(file);
  const analyzed = files.filter((entry) => entry.status === "analyzed").map((entry) => entry.path);
  const reasons = [...input.bindingReasons, ...input.scopeReasons];
  if (!input.buildComplete) reasons.push("INDEX_BUILD_INCOMPLETE");
  if (input.bindingStatus !== "valid") reasons.push("INDEX_BINDING_INVALID");
  if (!input.canRunHighRiskControl) reasons.push(...input.freshnessReasons, "INDEX_NOT_FRESH");
  if (input.checkChanged) reasons.push("CHECK_INPUT_CHANGED");
  if (files.length === 0 || analyzed.length === 0) reasons.push("ZERO_ANALYZED_OBLIGATIONS");
  for (const entry of files) if (entry.status !== "analyzed") reasons.push(`ANALYSIS_SCOPE_INCOMPLETE:${entry.path}:${entry.status}`);
  for (const entry of input.unresolvedImports) if (expected.has(entry.path)) reasons.push(`UNRESOLVED_IMPORT:${entry.path}:${entry.specifier}`);
  for (const path of input.changedPaths) if (!/\.(?:[cm]?[jt]sx?|py|sql)$/.test(path)) reasons.push(`UNSUPPORTED_CHANGED_OBLIGATION:${path}`);
  return {
    status: reasons.length === 0 ? "admitted" : "rejected",
    changeCoverage: { expected: [...expected].sort(), analyzed, files },
    repositoryCoverage: { status: input.repositoryCoverageStatus, files: input.candidates.map((candidate) => file(candidate.path)) },
    reasons: [...new Set(reasons)],
  };
}
