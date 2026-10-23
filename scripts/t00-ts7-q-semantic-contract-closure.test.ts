import { expect, test } from "bun:test";
import { closeContractProjection } from "./t00-ts7-q-semantic-contract-closure";
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

test("site identity, both alternatives and effective witness predicates are required", () => {
  const activate = run("activate"), control = run("control");
  expect(close([activate, { ...control, sites: [] }]).status).toBe("not_run");
  expect(close([activate, { ...control, branches: activate.branches }]).status).toBe("not_run");
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
