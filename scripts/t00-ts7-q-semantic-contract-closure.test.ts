import { expect, test } from "bun:test";
import { closeContractProjection, contractCoverage } from "./t00-ts7-q-semantic-contract-closure";
import type { ContractClosureRun, ContractCoverageInventory } from "./t00-ts7-q-semantic-contract-closure";

const inventory: ContractCoverageInventory = {
  sites: [{ index: 62, site: "62:0", expression: "ts.isStringLiteralLike" }, { index: 62, site: "62:1", expression: "value.text" }],
  branches: [{ index: 62, id: "62:condition:1" }],
};
const run = (label: "activate" | "control"): ContractClosureRun => ({
  scenario: "literal-or-unknown", label, projected: true, exactReasons: true, processVerified: true,
  witnessVerified: true, gaps: [], sites: inventory.sites.map(site => ({ ...site, value: label === "activate" })),
  branches: [{ index: 62, id: "62:condition:1", outcome: label === "activate" }],
});
const close = (runs: ContractClosureRun[], coverage = inventory, required = ["literal-or-unknown"]) => closeContractProjection(62, inventory.sites, coverage, required, runs);

test("complete native paired observations close the contract while a missing control cannot", () => {
  expect(close([run("activate"), run("control")]).status).toBe("passed");
  expect(close([run("activate")]).status).toBe("not_run");
  expect(close([]).status).toBe("not_run");
  expect(close([run("activate"), run("control"), run("control")]).status).toBe("not_run");
});

test("site identity and effective named witness predicates are required", () => {
  const activate = run("activate"), control = run("control");
  expect(close([activate, { ...control, sites: [] }]).status).toBe("passed");
  expect(close([{ ...activate, sites: [] }, { ...control, sites: [] }]).status).toBe("not_run");
  expect(close([activate, { ...control, witnessVerified: false }]).status).toBe("not_run");
  expect(close([activate, control], { ...inventory, sites: inventory.sites.slice(1) }).status).toBe("not_run");
  expect(close([activate, control], { ...inventory, sites: inventory.sites.map(site => ({ ...site, expression: "another.expression" })) }).status).toBe("not_run");
});

test("unprojected or process-failed observations cannot provide coverage and exact mismatches fail", () => {
  const activate = run("activate"), control = run("control");
  expect(close([activate, { ...control, projected: false }]).status).toBe("not_run");
  expect(close([activate, { ...control, processVerified: false }]).status).toBe("failed");
  expect(close([activate, { ...control, exactReasons: false }]).status).toBe("failed");
  expect(close([activate, { ...control, gaps: ["TYPE_FACT_MISSING"] }]).status).toBe("not_run");
});

test("empty or conflicting inventories cannot grant vacuous coverage", () => {
  expect(close([run("activate"), run("control")], inventory, []).status).toBe("not_run");
  expect(close([run("activate"), run("control")], inventory, ["literal-or-unknown", "literal-or-unknown"]).status).toBe("not_run");
  expect(closeContractProjection(62, [], { sites: [], branches: [] }, ["literal-or-unknown"], [run("activate"), run("control")]).status).toBe("not_run");
  expect(close([run("activate"), run("control")], { ...inventory, sites: [...inventory.sites, inventory.sites[0]!] }).status).toBe("not_run");
  expect(close([run("activate"), run("control")], { ...inventory, branches: [...inventory.branches, inventory.branches[0]!] }).status).toBe("not_run");
});

test("known missing ownership or provenance controls prevent closure despite full syntactic coverage", () => {
  const limitation = { alternative: "external-origin", reason: "No retained-exclusion input exercised", neededEvidence: "An observed external declaration" };
  const result = closeContractProjection(62, inventory.sites, inventory, ["literal-or-unknown"], [run("activate"), run("control")], [limitation]);
  expect(result.status).toBe("not_run");
  expect(result.gaps.some(gap => gap.includes("external-origin"))).toBe(true);
});

test("coverage summaries preserve refusal decisions without retaining unrelated source traces", () => {
  const sourceText = "compiler source payload ".repeat(10_000);
  const observations = [run("activate"), run("control")].map(run => ({ ...run,
    sites: [...run.sites.map(site => ({ ...site, value: { text: sourceText } })), ...run.sites, { index: 63, site: "63:0", expression: "other", value: { text: sourceText } }],
    branches: [...run.branches, ...run.branches, { index: 63, id: "63:other", outcome: true }],
  }));
  const compact = observations.map(run => ({ ...run, ...contractCoverage(62, run) }));
  expect(close(compact).status).toBe("passed");
  expect(JSON.stringify(compact)).not.toContain(sourceText);
  expect(close([compact[0]!]).status).toBe("not_run");
  expect(close(compact.map(run => ({ ...run, branches: [] }))).status).toBe("passed");
  expect(close(compact.map(run => ({ ...run, sites: run.sites.filter(site => site.site !== "62:1") }))).status).toBe("not_run");
});


test("unobserved universal branch outcomes remain diagnostic while finite witness failures refuse", () => {
  const activate = run("activate"), control = { ...run("control"), branches: [] };
  const result = close([activate, control]);
  expect(result.status).toBe("passed");
  expect(result.branchDiagnostics).toEqual([{ index: 62, id: "62:condition:1", status: "not_run", positive: ["literal-or-unknown:activate"], negative: [] }]);
  expect(close([activate, { ...control, witnessVerified: false, gaps: ["WITNESS_ALTERNATIVE_ASSERTION_MISSING:mutable-key"] }]).status).toBe("not_run");
  expect(close([activate, { ...control, sites: [] }]).status).toBe("passed");
  expect(close([{ ...activate, sites: [] }, { ...control, sites: [] }]).status).toBe("not_run");
  expect(close([activate, { ...control, exactReasons: false }]).status).toBe("failed");
});
