export type SiteObservation = { expression: string; activation: boolean };
export type ProjectionRun = {
  scenario: string;
  label: "activate" | "control";
  projected: boolean;
  exactReasons: boolean;
  processVerified: boolean;
  predicateMatched: boolean;
  operands?: { leftPrimitive: boolean; rightPrimitive: boolean };
  sites: SiteObservation[];
  gaps: string[];
};
export type SiteClosure = { site: string; expression: string; status: "passed" | "not_run"; activation: string[]; control: string[] };

export function closeProjection(index: number, expressions: string[], requiredScenarios: string[], runs: ProjectionRun[]): { status: "passed" | "failed" | "not_run"; sites: SiteClosure[]; gaps: string[] } {
  const gaps = runs.flatMap(run => run.gaps.map(gap => `${run.scenario}:${run.label}:${gap}`));
  if (expressions.length === 0 || requiredScenarios.length === 0) gaps.push("No complete site/scenario inventory");
  for (const scenario of requiredScenarios) {
    for (const label of ["activate", "control"] as const) {
      const matches = runs.filter(run => run.scenario === scenario && run.label === label);
      if (matches.length !== 1) gaps.push(`${scenario}:${label}:expected exactly one observation`);
      if (matches.some(run => !run.projected)) gaps.push(`${scenario}:${label}:projection unavailable`);
    }
  }
  for (const label of ["activate", "control"] as const) {
    for (const polarity of [true, false]) {
      if (!runs.some(run => requiredScenarios.includes(run.scenario) && run.label === label && run.projected && run.exactReasons && run.processVerified && run.predicateMatched === polarity)) gaps.push(`${label}:missing native predicate ${String(polarity)} witness`);
    }
  }
  if (index === 61) {
    for (const [leftPrimitive, rightPrimitive, label] of [[false, true, "activate"], [true, false, "activate"], [true, true, "control"]] as const) {
      if (!runs.some(run => requiredScenarios.includes(run.scenario) && run.label === label && run.projected && run.exactReasons && run.processVerified && run.predicateMatched && run.operands?.leftPrimitive === leftPrimitive && run.operands.rightPrimitive === rightPrimitive)) gaps.push(`${label}:missing binary operand alternative ${String(leftPrimitive)}/${String(rightPrimitive)}`);
    }
  }
  const sites: SiteClosure[] = expressions.map((expression, position) => {
    const matching = runs.filter(run => requiredScenarios.includes(run.scenario) && run.projected && run.exactReasons && run.processVerified && run.gaps.length === 0 && run.sites.some(site => site.expression === expression && site.activation));
    const activation = matching.filter(run => run.label === "activate").map(run => run.scenario);
    const control = matching.filter(run => run.label === "control").map(run => run.scenario);
    const status = activation.length > 0 && control.length > 0 ? "passed" : "not_run";
    if (status === "not_run") gaps.push(`${index}:${position}:missing activation/control for ${expression}`);
    return { site: `${index}:${position}`, expression, status, activation, control };
  });
  const failed = runs.some(run => !run.processVerified || (run.projected && !run.exactReasons));
  return { status: failed ? "failed" : gaps.length > 0 ? "not_run" : "passed", sites, gaps };
}
