export type ContractCoverageInventory = {
  sites: { index: number; site: string; expression: string }[];
  branches: { index: number; id: string }[];
};
export type ContractClosureRun = {
  scenario: string;
  label: "activate" | "control";
  projected: boolean;
  exactReasons: boolean;
  processVerified: boolean;
  witnessVerified: boolean;
  gaps: string[];
  sites: (ContractCoverageInventory["sites"][number] & { value: unknown })[];
  branches: (ContractCoverageInventory["branches"][number] & { outcome: boolean })[];
};

export function closeContractProjection(index: number, canonicalSites: ContractCoverageInventory["sites"], inventory: ContractCoverageInventory, scenarios: string[], runs: ContractClosureRun[], limitations: { alternative: string; reason: string; neededEvidence: string }[] = []) {
  const gaps = limitations.map(limitation => `${limitation.alternative}:${limitation.reason}; required: ${limitation.neededEvidence}`);
  const expected = canonicalSites.filter(site => site.index === index);
  const observedInventory = inventory.sites.filter(site => site.index === index);
  const branches = inventory.branches.filter(branch => branch.index === index);
  if (expected.length === 0 || scenarios.length === 0) gaps.push("EMPTY_CONTRACT_OR_SCENARIOS");
  if (new Set(scenarios).size !== scenarios.length) gaps.push("DUPLICATE_REQUIRED_SCENARIO");
  if (new Set(expected.map(site => site.site)).size !== expected.length) gaps.push("DUPLICATE_CANONICAL_SITE");
  if (observedInventory.length !== expected.length || expected.some(site => observedInventory.filter(observed => observed.site === site.site && observed.expression === site.expression).length !== 1)) gaps.push("CONTRACT_INSTRUMENTATION_INCOMPLETE");
  if (new Set(branches.map(branch => branch.id)).size !== branches.length) gaps.push("DUPLICATE_CONTRACT_BRANCH");
  for (const scenario of scenarios) {
    for (const label of ["activate", "control"] as const) {
      const matches = runs.filter(run => run.scenario === scenario && run.label === label);
      if (matches.length !== 1) gaps.push(`${scenario}:${label}:EXPECTED_ONE_OBSERVATION`);
      for (const run of matches) {
        if (!run.projected) gaps.push(`${scenario}:${label}:PROJECTION_UNAVAILABLE`);
        if (!run.witnessVerified) gaps.push(`${scenario}:${label}:ALTERNATIVE_NOT_OBSERVED`);
        gaps.push(...run.gaps.map(gap => `${scenario}:${label}:${gap}`));
      }
    }
  }
  if (runs.some(run => !scenarios.includes(run.scenario))) gaps.push("UNDECLARED_SCENARIO");
  const usable = runs.filter(run => scenarios.includes(run.scenario) && run.projected && run.exactReasons && run.processVerified && run.witnessVerified && run.gaps.length === 0);
  const sites = expected.map(site => {
    const activation = usable.filter(run => run.label === "activate" && run.sites.some(observed => observed.site === site.site && observed.index === index && observed.expression === site.expression)).map(run => run.scenario);
    const control = usable.filter(run => run.label === "control" && run.sites.some(observed => observed.site === site.site && observed.index === index && observed.expression === site.expression)).map(run => run.scenario);
    const status = activation.length > 0 && control.length > 0 ? "passed" : "not_run";
    if (status === "not_run") gaps.push(`${site.site}:MISSING_SITE_ACTIVATION_OR_CONTROL`);
    return { ...site, status, activation, control };
  });
  const alternatives = branches.map(branch => {
    const positive = usable.filter(run => run.branches.some(observed => observed.index === index && observed.id === branch.id && observed.outcome === true)).map(run => `${run.scenario}:${run.label}`);
    const negative = usable.filter(run => run.branches.some(observed => observed.index === index && observed.id === branch.id && observed.outcome === false)).map(run => `${run.scenario}:${run.label}`);
    const status = positive.length > 0 && negative.length > 0 ? "passed" : "not_run";
    if (status === "not_run") gaps.push(`${branch.id}:MISSING_BRANCH_ALTERNATIVE`);
    return { ...branch, status, positive, negative };
  });
  const failed = runs.some(run => !run.processVerified || (run.projected && !run.exactReasons));
  const status: "passed" | "failed" | "not_run" = failed ? "failed" : gaps.length > 0 ? "not_run" : "passed";
  return { status, sites, alternatives, gaps };
}
