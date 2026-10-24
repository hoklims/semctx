import { describe, expect, test } from "bun:test";
import { closeNamedConfigurationRows, compareNamedConfigurationObservation, enrichNamedConfigurations, namedConfigurationBound, normalizeNamedPath } from "./t00-ts7-q-config-named";
import type { CampaignContext, ObligationResult, PropertyResult } from "./t00-ts7-q-config-campaign";

const expected = {
  caseSensitive: true,
  passes: [{
    snapshot: 0,
    inspection: { cached: false, reasons: [] as string[], consumed: ["/repo/tsconfig.json"], reads: [{ path: "/repo/tsconfig.json", content: "{}", consumed_before_delegate: true }] },
    normalizations: [{ input: "tsconfig.json", normalized: "/repo/tsconfig.json" }],
  }],
};
const observed = {
  executed: true, unsupported: [], global_admission_inferred: false, case_sensitive: true,
  status: "development_observation_not_qualification", passes: expected.passes,
  request_descriptor_id: "sha256:request", producer_artifact_id: "sha256:producer",
};

describe("named configuration contract comparison", () => {
  test("requires complete consumed-before-delegate read attribution", () => {
    expect(compareNamedConfigurationObservation(observed, expected)).toBe(true);
    for (const patch of [{ consumed_before_delegate: false }, { content: null }, { path: "/outside/tsconfig.json" }]) {
      const changed = structuredClone(observed);
      Object.assign(changed.passes[0]!.inspection.reads[0]!, patch);
      expect(compareNamedConfigurationObservation(changed, expected)).toBe(false);
    }
    for (const reads of [[], [...expected.passes[0]!.inspection.reads, ...expected.passes[0]!.inspection.reads]]) {
      const changed = structuredClone(observed);
      changed.passes[0]!.inspection.reads = reads;
      expect(compareNamedConfigurationObservation(changed, expected)).toBe(false);
    }
  });
  test("rejects stale consumption, unexpected reasons and normalization drift", () => {
    for (const mutate of [
      (value: typeof observed) => { value.passes[0]!.inspection.consumed = []; },
      (value: typeof observed) => { value.passes[0]!.inspection.reasons = ["unexpected"]; },
      (value: typeof observed) => { value.passes[0]!.normalizations[0]!.normalized = "tsconfig.json"; },
      (value: typeof observed) => { value.passes[0]!.snapshot = 1; },
      (value: typeof observed) => { value.case_sensitive = false; },
    ]) {
      const changed = structuredClone(observed);
      mutate(changed);
      expect(compareNamedConfigurationObservation(changed, expected)).toBe(false);
    }
  });
  test("cache hits retain consumption and reasons without delegating reads again", () => {
    const cached = structuredClone(expected);
    cached.passes[0]!.inspection.cached = true;
    cached.passes[0]!.inspection.reads = [];
    const actual = { ...observed, passes: cached.passes };
    expect(compareNamedConfigurationObservation(actual, cached)).toBe(true);
    expect(compareNamedConfigurationObservation(observed, cached)).toBe(false);
    expect(compareNamedConfigurationObservation({ ...actual, passes: [] }, cached)).toBe(false);
    expect(compareNamedConfigurationObservation({ ...actual, passes: [...cached.passes, ...cached.passes] }, cached)).toBe(false);
  });
  test("missing, failed or unsupported observations cannot certify a callback", () => {
    for (const value of [null, {}, { ...observed, executed: false }, { ...observed, unsupported: ["unavailable"] }, { ...observed, global_admission_inferred: true }]) {
      expect(compareNamedConfigurationObservation(value, expected)).toBe(false);
    }
  });
  test("binds a clean process to both the descriptor and candidate artifact", () => {
    expect(namedConfigurationBound(0, "", observed, "sha256:request", "sha256:producer")).toBe(true);
    expect(namedConfigurationBound(1, "", observed, "sha256:request", "sha256:producer")).toBe(false);
    expect(namedConfigurationBound(0, "warning", observed, "sha256:request", "sha256:producer")).toBe(false);
    expect(namedConfigurationBound(0, "", observed, "sha256:foreign", "sha256:producer")).toBe(false);
    expect(namedConfigurationBound(0, "", observed, "sha256:request", "sha256:foreign")).toBe(false);
  });
  test("resolves POSIX segments before replacing backslashes and applying native case", () => {
    expect(normalizeNamedPath("/Repo", "nested/../tsconfig.extra.json", true)).toBe("/Repo/tsconfig.extra.json");
    expect(normalizeNamedPath("/Repo", "\\repo\\tsconfig.extra.json", true)).toBe("/Repo//repo/tsconfig.extra.json");
    expect(normalizeNamedPath("/Repo", "nested\\..\\tsconfig.extra.json", true)).toBe("/Repo/nested/../tsconfig.extra.json");
    expect(normalizeNamedPath("/Repo", "Tsconfig.extra.json", false)).toBe("/repo/tsconfig.extra.json");
  });
  test("normalization order is immaterial while duplicate input claims fail", () => {
    const wanted = structuredClone(expected);
    wanted.passes[0]!.normalizations.push({ input: "main.ts", normalized: "/repo/main.ts" });
    const actual = { ...observed, passes: structuredClone(wanted.passes) };
    actual.passes[0]!.normalizations.reverse();
    expect(compareNamedConfigurationObservation(actual, wanted)).toBe(true);
    actual.passes[0]!.normalizations.push(actual.passes[0]!.normalizations[0]!);
    expect(compareNamedConfigurationObservation(actual, wanted)).toBe(false);
  });
});

const boundEvidence = [{ path: "/evidence", bytes: 1, sha256: "a".repeat(64) }];
const normalizationNames = ["named relative and absolute normalization with POSIX dot segments", "named POSIX resolution precedes backslash replacement", "named native-case collisions reach the owning consumer"];
const normalizationResults = () => new Map<string, PropertyResult>(normalizationNames.map(property => [property, { property, status: "pass", reason: "controlled bound activation/control", evidence: boundEvidence }]));
const normalizationRow = (): ObligationResult => ({ index: 46, id: "normalization", status: "not_qualified", reason: "missing native normalization", durationMs: 0, evidence: [], properties: [
  { property: "existing independent compiler control", status: "pass", reason: "controlled", evidence: boundEvidence },
  { property: "owning consumer observable rule(s) in canonical family/call-path contract", status: "not_qualified", reason: "missing", evidence: [] },
  { property: "normalization of relative/backslash/case-colliding named inputs for native case mode", status: "not_qualified", reason: "missing", evidence: [] },
] });

test("named closure removes only covered gaps after every required property passes with evidence", () => {
  const row = normalizationRow();
  expect(closeNamedConfigurationRows([row], normalizationResults())[0]!.status).toBe("qualified");
  for (const mutation of ["missing", "failed", "unbound"] as const) {
    const results = normalizationResults();
    const name = normalizationNames[0]!;
    if (mutation === "missing") results.delete(name);
    else if (mutation === "failed") results.set(name, { ...results.get(name)!, status: "fail" });
    else results.set(name, { ...results.get(name)!, evidence: [] });
    const result = closeNamedConfigurationRows([row], results)[0]!;
    expect(result.status).toBe("not_qualified");
    expect(result.properties).toContainEqual(row.properties[1]!);
  }
  const unrelated = { property: "unrelated missing boundary", status: "not_qualified" as const, reason: "missing", evidence: [] };
  expect(closeNamedConfigurationRows([{ ...row, properties: [...row.properties, unrelated] }], normalizationResults())[0]!.status).toBe("not_qualified");
});

test("a named consumer cannot close from normalization proofs without its inherited classification witnesses", () => {
  const row = { ...normalizationRow(), index: 44 };
  expect(closeNamedConfigurationRows([row], normalizationResults())[0]!.status).toBe("not_qualified");
});

test("unselected obligations never read artifacts or start an observer", async () => {
  const ctx: CampaignContext = { producer: "absent", helper: "absent", oracle: "absent", sdk: "absent", out: "absent", platform: "macos", run: () => { throw Error("unexpected execution"); } };
  const rows = [{ ...normalizationRow(), index: 23 }];
  expect(await enrichNamedConfigurations(ctx, rows)).toBe(rows);
});
