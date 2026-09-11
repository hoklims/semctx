import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPublicEvidence, runBuildPublicDemo } from "../build-public-demo";
import { FIXTURE_CASES, baseFixtureFiles, changedFixtureFiles } from "../first-use-demo/fixture";
import { identifyFixture, sha256Hex } from "../first-use-demo/identity";

const SHA = "a".repeat(64);
const COMMIT = "b".repeat(40);
const EXPECTED_FIXTURE = identifyFixture(baseFixtureFiles(), changedFixtureFiles());
const roots: string[] = [];
const observationIds = [
  "phase-label", "phase-value", "demo-state", "pilot-state", "global-verdict", "cases-matched",
  "pilot-observations", "pilot-untrusted", "unknown-labels", "artifact-version", "release-commit-identity",
  "fixture-commit-identity", "report-status", "report-detail", "release-note", "evidence-report",
] as const;

function renderEvidenceInBrowserShell(evidence: unknown, ids: readonly string[] = observationIds): Record<string, { textContent: string; attributes: Record<string, string> }> {
  const appUrl = new URL("../../site/app.js", import.meta.url).href;
  const harness = `
const ids = new Set(${JSON.stringify(ids)});
const elements = new Map();
function element(id) {
  if (!ids.has(id)) return null;
  if (!elements.has(id)) elements.set(id, {
    textContent: "UNCHANGED",
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
  });
  return elements.get(id);
}
Object.assign(globalThis, {
  document: { querySelectorAll: () => [], getElementById: element },
  history: { replaceState() {} },
  location: { hash: "" },
  fetch: async () => ({ ok: true, json: async () => (${JSON.stringify(evidence)}) }),
});
for (const id of ids) element(id);
await import(${JSON.stringify(appUrl)});
await Bun.sleep(10);
console.log(JSON.stringify(Object.fromEntries([...elements])));
`;
  const child = Bun.spawnSync([process.execPath, "--eval", harness], { stdout: "pipe", stderr: "pipe" });
  const stderr = new TextDecoder().decode(child.stderr);
  expect(child.exitCode, stderr).toBe(0);
  return JSON.parse(new TextDecoder().decode(child.stdout)) as Record<string, { textContent: string; attributes: Record<string, string> }>;
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-public-demo-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("unknown, duplicate and incomplete CLI arguments fail before output", () => {
  for (const args of [
    ["--phase", "candidate", "--ouput", "unintended.json"],
    ["--phase", "candidate", "--phase", "release"],
    ["--phase", "candidate", "--demo"],
  ]) expect(() => runBuildPublicDemo(args)).toThrow("unknown, duplicate or incomplete argument");
});

function demoManifest(): Record<string, unknown> {
  const runtimeFiles = [
    { path: "index.js", present: true, sizeBytes: 123, sha256: SHA },
    { path: "semctx-index-worker.js", present: true, sizeBytes: 456, sha256: "d".repeat(64) },
  ];
  const cliPath = "C:\\private\\index.js";
  const fixtureRoot = "C:\\private\\fixture";
  const bun = "C:\\private\\bun.exe";
  const command = (label: "version" | "setup" | "index" | "verify-diff", argv: string[]) => ({
    label, argv, code: 0, signal: null, durationMs: 12.5,
    stdoutFile: `raw/${label}.stdout.txt`, stdoutDigest: SHA,
    stderrFile: `raw/${label}.stderr.txt`, stderrDigest: "e".repeat(64),
  });
  return {
    kind: "semctx-first-use-demo-manifest-v1",
    status: "COMPLETED",
    reason: null,
    detail: null,
    createdAt: "2026-09-08T01:00:00.000Z",
    outDir: "C:\\private\\demo",
    cli: {
      cliPath,
      cli: { path: cliPath, present: true, sizeBytes: 123, sha256: SHA },
      indexWorker: { path: "C:\\private\\semctx-index-worker.js", present: true, sizeBytes: 456, sha256: "d".repeat(64) },
      runtimeDigest: sha256Hex(JSON.stringify(runtimeFiles)),
      sourceProvenance: "secret local alias",
      authenticatedSource: "UNKNOWN",
      runtimeFiles,
    },
    fixture: { ...EXPECTED_FIXTURE },
    fixtureHeadCommit: COMMIT,
    commands: [
      command("version", [bun, cliPath, "--version"]),
      command("setup", [bun, cliPath, "setup", "--root", fixtureRoot, "--json"]),
      command("index", [bun, cliPath, "index", "--root", fixtureRoot, "--json"]),
      command("verify-diff", [bun, cliPath, "verify", "diff", "--root", fixtureRoot, "--json"]),
    ],
    verdict: "WARN",
    cases: [
      { id: "benign", title: "secret", relPath: "src/greeting.ts", expectedFinding: "none", observedRules: [], observedFindings: [], matchedExpectation: true, explanation: "secret", nextCheck: "secret" },
      {
        id: "exported-contract-risk", title: "secret", relPath: "src/cart.ts", expectedFinding: "warn",
        observedRules: ["contract_changed_without_test"],
        observedFindings: [{ rule: "contract_changed_without_test", tier: "advisory", severity: "warn", message: "secret", nodeIds: [], locations: [{ file: "src/cart.ts" }] }],
        matchedExpectation: true, explanation: "secret", nextCheck: "secret",
      },
      { id: "unsupported-limit", title: "secret", relPath: "src/pricing.ts", expectedFinding: "none", observedRules: [], observedFindings: [], matchedExpectation: true, explanation: "secret", nextCheck: "secret" },
    ],
    unknowns: ["TOP_SECRET unknown text"],
    workingDiffDigest: SHA,
    packageVersion: "0.2.0",
  };
}

function pilotSummary(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    experimentId: "private-experiment",
    protocolDigest: `sha256:${SHA}`,
    evidenceKind: "research",
    verdict: "EVIDENCE_MISSING",
    totals: { totalCases: 30, observedCases: 30, failedCases: 0, untrustedCases: 0, labelledCases: 0, unknownCases: 30 },
    perRepository: [
      { repositoryAlias: "C:\\private\\one", totalCases: 10, observedCases: 10, failedCases: 0, untrustedCases: 0, labelledCases: 0 },
      { repositoryAlias: "TOP_SECRET", totalCases: 10, observedCases: 10, failedCases: 0, untrustedCases: 0, labelledCases: 0 },
      { repositoryAlias: "private-repository-3", totalCases: 10, observedCases: 10, failedCases: 0, untrustedCases: 0, labelledCases: 0 },
    ],
    scores: null,
    criticalMisses: [{ caseId: "private", repositoryAlias: "TOP_SECRET", files: ["private/path.ts"] }],
    totalDurationMs: 1234.5,
    generatedAt: "2026-09-08T02:00:00.000Z",
  };
}

function labelledPilot(verdict: "INCONCLUSIVE" | "NEGATIVE" | "POSITIVE", labelledCases: number, semctxPrecision: number): Record<string, unknown> {
  const pilot = pilotSummary();
  pilot["verdict"] = verdict;
  pilot["totals"] = {
    totalCases: 30,
    observedCases: 30,
    failedCases: 0,
    untrustedCases: 0,
    labelledCases,
    unknownCases: 30 - labelledCases,
  };
  const labelledByRepository = labelledCases === 5 ? [2, 2, 1] : [10, 10, 10];
  for (const [index, repository] of (pilot["perRepository"] as Record<string, unknown>[]).entries()) {
    repository["labelledCases"] = labelledByRepository[index];
  }
  pilot["scores"] = [
    { tool: "semctx", labelledCasesScored: labelledCases, precision: semctxPrecision, recall: 0.75, criticalRecall: 1 },
    { tool: "changed-files", labelledCasesScored: labelledCases, precision: 0.6, recall: 0.5, criticalRecall: 0.8 },
    { tool: "one-hop-import-neighborhood", labelledCasesScored: labelledCases, precision: 0.7, recall: 0.65, criticalRecall: 0.8 },
  ];
  return pilot;
}

function smokePilot(): Record<string, unknown> {
  const pilot = pilotSummary();
  pilot["evidenceKind"] = "smoke";
  pilot["totals"] = { totalCases: 1, observedCases: 1, failedCases: 0, untrustedCases: 0, labelledCases: 0, unknownCases: 1 };
  pilot["perRepository"] = [
    { repositoryAlias: "fixture", totalCases: 1, observedCases: 1, failedCases: 0, untrustedCases: 0, labelledCases: 0 },
  ];
  return pilot;
}

describe("public evidence projection", () => {
  test("missing evidence remains explicit and all human metrics stay unmeasured", () => {
    const result = buildPublicEvidence({ phase: "candidate", now: () => "2026-09-08T00:00:00.000Z" });
    expect(result.evidenceState).toBe("NOT_OBSERVED");
    expect(result.demo).toBeNull();
    expect(result.pilot).toBeNull();
    expect(new Set(Object.values(result.humanMetrics))).toEqual(new Set(["NOT_MEASURED"]));
  });

  test("raw paths, logs, free text, aliases and unknown labels cannot reach public JSON", () => {
    const result = buildPublicEvidence({
      phase: "candidate",
      demo: demoManifest(),
      pilot: pilotSummary(),
      releaseCommit: COMMIT,
      now: () => "2026-09-08T03:00:00.000Z",
    });
    const serialized = JSON.stringify(result);
    expect(result.demo?.unknownCount).toBe(1);
    expect(result.pilot?.scores).toBeNull();
    expect(result.pilot?.repositoryCount).toBe(3);
    expect(serialized).not.toContain("TOP_SECRET");
    expect(serialized).not.toContain("private-experiment");
    expect(serialized).not.toContain("private/path");
    expect(serialized).not.toContain("cliPath");
    expect(result.releaseCommit).toEqual({ value: COMMIT, authority: "caller-asserted" });
  });

  test("malformed demo structure and unknown rule IDs fail closed", () => {
    const missingCase = demoManifest();
    missingCase["cases"] = (missingCase["cases"] as unknown[]).slice(0, 2);
    expect(() => buildPublicEvidence({ phase: "candidate", demo: missingCase })).toThrow("all three frozen cases");
    const unknownRule = demoManifest();
    ((unknownRule["cases"] as Record<string, unknown>[])[0]!["observedRules"] as string[]).push("private-custom-rule");
    expect(() => buildPublicEvidence({ phase: "candidate", demo: unknownRule })).toThrow("unknown rule identifier");
    const falseMatch = demoManifest();
    (falseMatch["cases"] as Record<string, unknown>[])[0]!["matchedExpectation"] = false;
    expect(() => buildPublicEvidence({ phase: "candidate", demo: falseMatch })).toThrow("match flag contradicts");
    const falseGlobalPass = demoManifest();
    falseGlobalPass["verdict"] = "PASS";
    expect(() => buildPublicEvidence({ phase: "candidate", demo: falseGlobalPass })).toThrow("global verdict contradicts");
    const falseGlobalBlock = demoManifest();
    falseGlobalBlock["verdict"] = "BLOCK";
    expect(() => buildPublicEvidence({ phase: "candidate", demo: falseGlobalBlock })).toThrow("global verdict contradicts");
    const unmatchedExpectation = demoManifest();
    const expectedWarn = (unmatchedExpectation["cases"] as Record<string, unknown>[])[1]!;
    expectedWarn["observedRules"] = [];
    expectedWarn["observedFindings"] = [];
    expectedWarn["matchedExpectation"] = false;
    unmatchedExpectation["verdict"] = "PASS";
    expect(() => buildPublicEvidence({ phase: "candidate", demo: unmatchedExpectation })).toThrow("every frozen case expectation");
    const missingObservedCommit = demoManifest();
    missingObservedCommit["fixtureHeadCommit"] = null;
    expect(() => buildPublicEvidence({
      phase: "candidate", demo: missingObservedCommit, demoFixtureCommit: COMMIT,
    })).toThrow("observed fixture commit");
    const malformedObservedCommit = demoManifest();
    malformedObservedCommit["fixtureHeadCommit"] = "not-a-commit";
    expect(() => buildPublicEvidence({ phase: "candidate", demo: malformedObservedCommit })).toThrow("full lowercase Git commit");
    const strictRule = demoManifest();
    strictRule["verdict"] = "BLOCK";
    const strictCase = (strictRule["cases"] as Record<string, unknown>[])[1]!;
    strictCase["observedRules"] = ["contract_changed_without_test", "security_surface_without_verification"];
    (strictCase["observedFindings"] as Record<string, unknown>[]).push({
      rule: "security_surface_without_verification", tier: "strict", severity: "block",
      message: "secret", nodeIds: [], locations: [{ file: "src/cart.ts" }],
    });
    strictCase["matchedExpectation"] = true;
    expect(() => buildPublicEvidence({ phase: "candidate", demo: strictRule })).toThrow("match flag contradicts");
    strictCase["matchedExpectation"] = false;
    expect(() => buildPublicEvidence({ phase: "candidate", demo: strictRule })).toThrow("every frozen case expectation");

    const duplicateAdvisory = demoManifest();
    const duplicateCase = (duplicateAdvisory["cases"] as Record<string, unknown>[])[1]!;
    duplicateCase["observedRules"] = ["contract_changed_without_test", "contract_changed_without_test"];
    (duplicateCase["observedFindings"] as Record<string, unknown>[]).push(structuredClone(
      (duplicateCase["observedFindings"] as Record<string, unknown>[])[0]!,
    ));
    duplicateCase["matchedExpectation"] = true;
    expect(() => buildPublicEvidence({ phase: "candidate", demo: duplicateAdvisory })).toThrow("match flag contradicts");
  });

  test("completed demo requires coherent runtime, command, and working-diff observations", () => {
    const missingCommands = demoManifest();
    delete missingCommands["commands"];
    expect(() => buildPublicEvidence({ phase: "candidate", demo: missingCommands })).toThrow("commands must be an array");

    const malformedCommand = demoManifest();
    ((malformedCommand["commands"] as Record<string, unknown>[])[2]!)["argv"] = ["other-bun", "other-cli", "index"];
    expect(() => buildPublicEvidence({ phase: "candidate", demo: malformedCommand })).toThrow("same Bun executable and packaged CLI entry");

    const failedCommand = demoManifest();
    ((failedCommand["commands"] as Record<string, unknown>[])[3]!)["code"] = 3;
    expect(() => buildPublicEvidence({ phase: "candidate", demo: failedCommand })).toThrow("exit successfully");

    const missingCaptureDigest = demoManifest();
    delete ((missingCaptureDigest["commands"] as Record<string, unknown>[])[0]!)["stdoutDigest"];
    expect(() => buildPublicEvidence({ phase: "candidate", demo: missingCaptureDigest })).toThrow("stdoutDigest must be a string");

    const runtimeDrift = demoManifest();
    (runtimeDrift["cli"] as Record<string, unknown>)["runtimeDigest"] = "f".repeat(64);
    expect(() => buildPublicEvidence({ phase: "candidate", demo: runtimeDrift })).toThrow("runtime digest contradicts");

    const missingWorkingDiff = demoManifest();
    delete missingWorkingDiff["workingDiffDigest"];
    expect(() => buildPublicEvidence({ phase: "candidate", demo: missingWorkingDiff })).toThrow("workingDiffDigest must be a string");
    const malformedWorkingDiff = demoManifest();
    malformedWorkingDiff["workingDiffDigest"] = "not-a-digest";
    expect(() => buildPublicEvidence({ phase: "candidate", demo: malformedWorkingDiff })).toThrow("workingDiffDigest must be a SHA-256 digest");

    const contradictoryMissingFile = demoManifest();
    const entry = (contradictoryMissingFile["cli"] as Record<string, unknown>)["cli"] as Record<string, unknown>;
    entry["present"] = false;
    entry["sizeBytes"] = 123;
    entry["sha256"] = null;
    expect(() => buildPublicEvidence({ phase: "candidate", demo: contradictoryMissingFile })).toThrow("presence metadata is inconsistent");

    const wrongBaseFixture = demoManifest();
    (wrongBaseFixture["fixture"] as Record<string, unknown>)["baseDigest"] = SHA;
    expect(() => buildPublicEvidence({ phase: "candidate", demo: wrongBaseFixture })).toThrow("contradicts the frozen fixture inputs");
    const wrongChangedFixture = demoManifest();
    (wrongChangedFixture["fixture"] as Record<string, unknown>)["changedDigest"] = "c".repeat(64);
    expect(() => buildPublicEvidence({ phase: "candidate", demo: wrongChangedFixture })).toThrow("contradicts the frozen fixture inputs");
  });

  test("completed demo accepts a conforming single-file CLI with unknown source provenance", () => {
    const singleFile = demoManifest();
    const cli = singleFile["cli"] as Record<string, unknown>;
    cli["indexWorker"] = null;
    cli["sourceProvenance"] = "UNKNOWN";
    cli["runtimeFiles"] = (cli["runtimeFiles"] as Record<string, unknown>[]).slice(0, 1);
    cli["runtimeDigest"] = sha256Hex(JSON.stringify(cli["runtimeFiles"]));
    expect(buildPublicEvidence({ phase: "candidate", demo: singleFile }).demo?.status).toBe("COMPLETED");
  });

  test("blocked demo accepts the producer's honest absent worker identity", () => {
    const blocked = demoManifest();
    blocked["status"] = "BLOCKED";
    blocked["reason"] = "INDEX_CHILD_FAILED";
    blocked["detail"] = "worker path is not a file";
    blocked["commands"] = (blocked["commands"] as unknown[]).slice(0, 3);
    blocked["cases"] = [];
    blocked["verdict"] = null;
    blocked["workingDiffDigest"] = null;
    blocked["packageVersion"] = null;
    const cli = blocked["cli"] as Record<string, unknown>;
    cli["indexWorker"] = { path: "C:\\private\\semctx-index-worker.js", present: false, sizeBytes: null, sha256: null };
    cli["runtimeFiles"] = (cli["runtimeFiles"] as Record<string, unknown>[]).slice(0, 1);
    cli["runtimeDigest"] = sha256Hex(JSON.stringify(cli["runtimeFiles"]));
    expect(buildPublicEvidence({ phase: "candidate", demo: blocked }).demo?.status).toBe("BLOCKED");
  });

  test("blocked demo accepts a command prefix and preserves complete parsed observations", () => {
    const early = demoManifest();
    early["status"] = "BLOCKED";
    early["reason"] = "SETUP_CHILD_FAILED";
    early["detail"] = "setup failed";
    early["commands"] = (early["commands"] as unknown[]).slice(0, 2);
    early["cases"] = [];
    early["verdict"] = null;
    early["workingDiffDigest"] = null;
    early["packageVersion"] = null;
    expect(buildPublicEvidence({ phase: "candidate", demo: early }).demo?.status).toBe("BLOCKED");

    const observed = demoManifest();
    observed["status"] = "BLOCKED";
    observed["reason"] = "UNEXPECTED_ANALYSIS";
    observed["detail"] = "frozen expectation mismatch";
    const cart = (observed["cases"] as Record<string, unknown>[])[1]!;
    ((cart["observedFindings"] as Record<string, unknown>[])[0]!)["tier"] = "strict";
    cart["matchedExpectation"] = false;
    observed["verdict"] = "WARN";
    observed["unassignedFindings"] = [{
      rule: "private-rule", tier: "advisory", severity: "warn", message: "TOP_SECRET finding",
      nodeIds: ["private-node"], locations: [{ file: "C:\\private\\source.ts", line: 12 }],
    }];
    const projection = buildPublicEvidence({ phase: "candidate", demo: observed });
    expect(projection.demo?.status).toBe("BLOCKED");
    expect(projection.demo?.verdict).toBe("WARN");
    expect(projection.demo?.cases[1]?.observedRuleIds).toEqual(["contract_changed_without_test"]);
    expect(projection.demo?.cases[1]?.matchedExpectation).toBe(false);
    expect(JSON.stringify(projection)).not.toContain("TOP_SECRET");

    const malformed = structuredClone(observed);
    ((malformed["unassignedFindings"] as Record<string, unknown>[])[0]!["locations"] as Record<string, unknown>[])[0]!["file"] = 42;
    expect(() => buildPublicEvidence({ phase: "candidate", demo: malformed })).toThrow("locations[0].file must be a string");

    const partialObserved = structuredClone(observed);
    partialObserved["commands"] = (partialObserved["commands"] as unknown[]).slice(0, 3);
    expect(() => buildPublicEvidence({ phase: "candidate", demo: partialObserved })).toThrow("observation fields are inconsistent");

    const earlyWithUnassigned = structuredClone(early);
    earlyWithUnassigned["unassignedFindings"] = observed["unassignedFindings"];
    expect(() => buildPublicEvidence({ phase: "candidate", demo: earlyWithUnassigned })).toThrow("observation fields are inconsistent");
  });

  test("public package versions follow strict SemVer", () => {
    const valid = demoManifest();
    valid["packageVersion"] = "1.2.3-alpha.1+build.5";
    expect(buildPublicEvidence({ phase: "candidate", demo: valid }).demo?.packageVersion).toBe("1.2.3-alpha.1+build.5");
    for (const version of ["01.2.3", "1.02.3", "1.2.03", "1.2.3-", "1.2.3-alpha..1", "1.2.3-01", "1.2.3+build..1"]) {
      const demo = demoManifest();
      demo["packageVersion"] = version;
      expect(() => buildPublicEvidence({ phase: "candidate", demo }), version).toThrow("semantic version");
    }
  });

  test("inconsistent pilot counts and scores without adjudicated labels fail closed", () => {
    const inconsistent = pilotSummary();
    (inconsistent["totals"] as Record<string, unknown>)["observedCases"] = 29;
    expect(() => buildPublicEvidence({ phase: "candidate", pilot: inconsistent })).toThrow("totals are inconsistent");
    const scoredUnknown = pilotSummary();
    scoredUnknown["scores"] = [
      { tool: "semctx", labelledCasesScored: 0, precision: 1, recall: 1, criticalRecall: 1 },
      { tool: "changed-files", labelledCasesScored: 0, precision: 1, recall: 1, criticalRecall: 1 },
      { tool: "one-hop-import-neighborhood", labelledCasesScored: 0, precision: 1, recall: 1, criticalRecall: 1 },
    ];
    expect(() => buildPublicEvidence({ phase: "candidate", pilot: scoredUnknown })).toThrow("observed adjudicated cases");
    const oneRepository = pilotSummary();
    oneRepository["verdict"] = "POSITIVE";
    oneRepository["totals"] = { totalCases: 30, observedCases: 30, failedCases: 0, untrustedCases: 0, labelledCases: 30, unknownCases: 0 };
    oneRepository["perRepository"] = [
      { repositoryAlias: "only-one", totalCases: 30, observedCases: 30, failedCases: 0, untrustedCases: 0, labelledCases: 30 },
    ];
    oneRepository["scores"] = [
      { tool: "semctx", labelledCasesScored: 30, precision: 1, recall: 1, criticalRecall: 1 },
      { tool: "changed-files", labelledCasesScored: 30, precision: 1, recall: 1, criticalRecall: 1 },
      { tool: "one-hop-import-neighborhood", labelledCasesScored: 30, precision: 1, recall: 1, criticalRecall: 1 },
    ];
    expect(() => buildPublicEvidence({ phase: "candidate", pilot: oneRepository })).toThrow("at least 3 repositories");
    const smoke = pilotSummary();
    smoke["evidenceKind"] = "smoke";
    smoke["totals"] = { totalCases: 1, observedCases: 1, failedCases: 0, untrustedCases: 0, labelledCases: 0, unknownCases: 1 };
    smoke["perRepository"] = [
      { repositoryAlias: "fixture", totalCases: 1, observedCases: 1, failedCases: 0, untrustedCases: 0, labelledCases: 0 },
    ];
    expect(buildPublicEvidence({ phase: "candidate", pilot: smoke }).pilot?.repositoryCount).toBe(1);
  });

  test("fractional durations and labelled-subset scores match PublicSummaryV1", () => {
    const labelled = pilotSummary();
    labelled["verdict"] = "INCONCLUSIVE";
    labelled["totals"] = { totalCases: 30, observedCases: 30, failedCases: 0, untrustedCases: 0, labelledCases: 5, unknownCases: 25 };
    const repositories = labelled["perRepository"] as Record<string, unknown>[];
    repositories[0]!["labelledCases"] = 2;
    repositories[1]!["labelledCases"] = 2;
    repositories[2]!["labelledCases"] = 1;
    labelled["scores"] = [
      { tool: "semctx", labelledCasesScored: 5, precision: 0.8, recall: 0.75, criticalRecall: 1 },
      { tool: "changed-files", labelledCasesScored: 5, precision: 0.6, recall: 0.5, criticalRecall: 0.8 },
      { tool: "one-hop-import-neighborhood", labelledCasesScored: 5, precision: 0.7, recall: 0.65, criticalRecall: 0.8 },
    ];
    const result = buildPublicEvidence({ phase: "candidate", pilot: labelled });
    expect(result.pilot?.totalDurationMs).toBe(1234.5);
    expect(result.pilot?.scores?.map(score => score.tool)).toEqual(["semctx", "changed-files", "one-hop-import-neighborhood"]);
    labelled["totals"] = { totalCases: 30, observedCases: 30, failedCases: 0, untrustedCases: 0, labelledCases: 30, unknownCases: 0 };
    for (const repository of repositories) repository["labelledCases"] = 10;
    for (const score of labelled["scores"] as Record<string, unknown>[]) score["labelledCasesScored"] = 30;
    labelled["verdict"] = "NEGATIVE";
    expect(() => buildPublicEvidence({ phase: "candidate", pilot: labelled })).toThrow("contradicts the reported scores");
    labelled["verdict"] = "POSITIVE";
    expect(buildPublicEvidence({ phase: "candidate", pilot: labelled }).pilot?.verdict).toBe("POSITIVE");
  });

  test("an untrusted observed report remains visible and cannot carry scores", () => {
    const pilot = pilotSummary();
    (pilot["totals"] as Record<string, unknown>)["untrustedCases"] = 1;
    (pilot["perRepository"] as Record<string, unknown>[])[0]!["untrustedCases"] = 1;
    expect(buildPublicEvidence({ phase: "candidate", pilot }).pilot?.untrustedCases).toBe(1);
    pilot["verdict"] = "POSITIVE";
    expect(() => buildPublicEvidence({ phase: "candidate", pilot })).toThrow("overstates");
  });

  test("parseable date text is normalized and privacy suffixes never survive", () => {
    const demo = demoManifest();
    demo["createdAt"] = "Tue, 08 Sep 2026 01:00:00 GMT (TOP_SECRET)";
    const pilot = pilotSummary();
    pilot["generatedAt"] = "Tue, 08 Sep 2026 02:00:00 GMT (TOP_SECRET)";
    const result = buildPublicEvidence({
      phase: "candidate",
      demo,
      pilot,
      now: () => "Tue, 08 Sep 2026 03:00:00 GMT (TOP_SECRET)",
    });
    expect(result.demo?.observedAt).toBe("2026-09-08T01:00:00.000Z");
    expect(result.pilot?.generatedAt).toBe("2026-09-08T02:00:00.000Z");
    expect(result.generatedAt).toBe("2026-09-08T03:00:00.000Z");
    expect(JSON.stringify(result)).not.toContain("TOP_SECRET");
  });

  test("runtime phase and clock inputs fail closed", () => {
    expect(() => buildPublicEvidence({ phase: "future" as "candidate" })).toThrow("phase is invalid");
    expect(() => buildPublicEvidence({ phase: "candidate", now: "not-a-clock" as unknown as () => string })).toThrow("now must be a function");
    expect(() => buildPublicEvidence({ phase: "candidate", now: () => "not-a-date" })).toThrow("generatedAt must be a valid date");
  });

  test("release phase requires completed packaged evidence", () => {
    expect(() => buildPublicEvidence({ phase: "release", pilot: pilotSummary() })).toThrow("completed packaged demo");
  });

  test("CLI builder writes the same strict projection to the requested output", () => {
    const root = temporaryRoot();
    const demo = join(root, "demo.json");
    const pilot = join(root, "pilot.json");
    const output = join(root, "site", "evidence.json");
    writeFileSync(demo, JSON.stringify(demoManifest()));
    writeFileSync(pilot, JSON.stringify(pilotSummary()));
    runBuildPublicDemo(["--phase", "candidate", "--demo", demo, "--pilot", pilot, "--output", output]);
    const result = JSON.parse(readFileSync(output, "utf8"));
    expect(result.kind).toBe("semctx-public-evidence-v1");
    expect(result.demo.cases).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain("TOP_SECRET");
  });
});

describe("static page contract", () => {
  test("embedded greeting snippets are byte-faithful to their published fixtures", () => {
    const html = readFileSync(join(import.meta.dir, "..", "..", "site", "index.html"), "utf8");
    for (const variant of ["base", "changed"] as const) {
      const pattern = new RegExp(`<a href="\\./fixtures/${variant}/src/greeting\\.ts">[\\s\\S]*?<pre><code>([\\s\\S]*?)</code>`);
      const snippet = pattern.exec(html)?.[1];
      const fixture = readFileSync(join(import.meta.dir, "..", "..", "site", "fixtures", variant, "src", "greeting.ts"), "utf8").trimEnd();
      expect(snippet, `${variant} greeting snippet`).toBe(fixture);
    }
  });

  test("browser reader rejects incompatible or malformed evidence before observation DOM updates", () => {
    const valid = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "site", "evidence.json"), "utf8")) as Record<string, unknown>;
    const missingFixtureCommit = structuredClone(valid);
    (missingFixtureCommit["demo"] as Record<string, unknown>)["fixtureCommit"] = null;
    const unmatchedDemo = structuredClone(valid);
    const unmatched = ((unmatchedDemo["demo"] as Record<string, unknown>)["cases"] as Record<string, unknown>[])[1]!;
    unmatched["observedRuleIds"] = [];
    unmatched["matchedExpectation"] = false;
    (unmatchedDemo["demo"] as Record<string, unknown>)["verdict"] = "PASS";
    const extraBlockingDemo = structuredClone(valid);
    const extraBlockingCase = ((extraBlockingDemo["demo"] as Record<string, unknown>)["cases"] as Record<string, unknown>[])[1]!;
    extraBlockingCase["observedRuleIds"] = ["contract_changed_without_test", "security_surface_without_verification"];
    extraBlockingCase["matchedExpectation"] = true;
    (extraBlockingDemo["demo"] as Record<string, unknown>)["verdict"] = "BLOCK";
    for (const hostile of [
      { ...valid, schemaVersion: 2 },
      { ...valid, kind: "foreign-evidence" },
      { ...valid, phase: "future" },
      { ...valid, demo: { ...(valid["demo"] as Record<string, unknown>), cases: "not-an-array", verdict: "BLOCK" } },
      missingFixtureCommit,
      unmatchedDemo,
      extraBlockingDemo,
      { ...valid, demo: { ...(valid["demo"] as Record<string, unknown>), packageVersion: "01.2.3" } },
      { ...valid, demo: { ...(valid["demo"] as Record<string, unknown>), packageVersion: "1.2.3-alpha..1" } },
      { ...valid, pilot: { ...(valid["pilot"] as Record<string, unknown>), observedCases: 29 } },
      { ...valid, disclosures: { ...(valid["disclosures"] as Record<string, unknown>), scope: "forged scope" } },
    ]) {
      const rendered = renderEvidenceInBrowserShell(hostile, [
        "phase-value", "global-verdict", "artifact-version", "report-status", "report-detail", "evidence-report",
      ]);
      expect(rendered["phase-value"]?.textContent).toBe("UNCHANGED");
      expect(rendered["global-verdict"]?.textContent).toBe("UNCHANGED");
      expect(rendered["artifact-version"]?.textContent).toBe("UNCHANGED");
      expect(rendered["report-status"]?.textContent).toBe("Public evidence could not be loaded.");
      expect(rendered["evidence-report"]?.attributes["aria-busy"]).toBe("false");
    }
  });

  test("browser reader accepts the committed strict evidence projection", () => {
    const evidence = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "site", "evidence.json"), "utf8"));
    const rendered = renderEvidenceInBrowserShell(evidence);
    expect(evidence.releaseCommit).toEqual({
      value: "23b49dc70d666b5b76d4333dadb4bbdf6070f077",
      authority: "caller-asserted",
    });
    expect(rendered["phase-value"]?.textContent).toBe("release");
    expect(rendered["global-verdict"]?.textContent).toBe("WARN");
    expect(rendered["artifact-version"]?.textContent).toBe("0.2.0");
    expect(rendered["report-status"]?.textContent).toBe("Packaged demo evidence is present.");
  });

  test("browser reader accepts every projection produced by the public builder", () => {
    const blocked = demoManifest();
    blocked["status"] = "BLOCKED";
    blocked["reason"] = "VERIFY_OUTPUT_MALFORMED";
    blocked["detail"] = "fixture runner output was malformed";
    blocked["cases"] = [];
    blocked["verdict"] = null;
    blocked["workingDiffDigest"] = null;
    blocked["packageVersion"] = null;

    const observedBlocked = demoManifest();
    observedBlocked["status"] = "BLOCKED";
    observedBlocked["reason"] = "UNEXPECTED_ANALYSIS";
    observedBlocked["detail"] = "frozen expectation mismatch";
    const observedCart = (observedBlocked["cases"] as Record<string, unknown>[])[1]!;
    ((observedCart["observedFindings"] as Record<string, unknown>[])[0]!)["tier"] = "strict";
    observedCart["matchedExpectation"] = false;
    observedBlocked["verdict"] = "WARN";

    const variants = [
      {
        name: "missing",
        evidence: buildPublicEvidence({ phase: "candidate", now: () => "2026-09-08T03:00:00.000Z" }),
        phase: "candidate",
        demo: "not observed",
        pilot: "not observed",
        status: "Public evidence loaded; no demo or pilot observations are present.",
      },
      {
        name: "blocked demo",
        evidence: buildPublicEvidence({ phase: "candidate", demo: blocked, now: () => "2026-09-08T03:00:00.000Z" }),
        phase: "candidate",
        demo: "blocked",
        pilot: "not observed",
        status: "Evidence is present with an unresolved or blocked demo.",
      },
      {
        name: "blocked demo with parsed observations",
        evidence: buildPublicEvidence({ phase: "candidate", demo: observedBlocked, now: () => "2026-09-08T03:00:00.000Z" }),
        phase: "candidate",
        demo: "blocked",
        pilot: "not observed",
        status: "Evidence is present with an unresolved or blocked demo.",
      },
      {
        name: "pilot only",
        evidence: buildPublicEvidence({ phase: "candidate", pilot: pilotSummary(), now: () => "2026-09-08T03:00:00.000Z" }),
        phase: "candidate",
        demo: "not observed",
        pilot: "evidence missing",
        status: "Pilot evidence is present; packaged demo evidence is not observed.",
      },
      {
        name: "release",
        evidence: buildPublicEvidence({ phase: "release", demo: demoManifest(), releaseCommit: COMMIT, now: () => "2026-09-08T03:00:00.000Z" }),
        phase: "release",
        demo: "completed",
        pilot: "not observed",
        status: "Packaged demo evidence is present.",
      },
      ...([
        ["positive", labelledPilot("POSITIVE", 30, 0.8), "positive"],
        ["negative", labelledPilot("NEGATIVE", 30, 0.79), "negative"],
        ["inconclusive", labelledPilot("INCONCLUSIVE", 5, 0.8), "inconclusive"],
        ["smoke", smokePilot(), "evidence missing"],
      ] as const).map(([name, pilotEvidence, pilot]) => ({
        name,
        evidence: buildPublicEvidence({ phase: "candidate", pilot: pilotEvidence, now: () => "2026-09-08T03:00:00.000Z" }),
        phase: "candidate",
        demo: "not observed",
        pilot,
        status: "Pilot evidence is present; packaged demo evidence is not observed.",
      })),
    ];

    for (const variant of variants) {
      const rendered = renderEvidenceInBrowserShell(variant.evidence);
      expect(rendered["phase-value"]?.textContent, variant.name).toBe(variant.phase);
      expect(rendered["demo-state"]?.textContent, variant.name).toBe(variant.demo);
      expect(rendered["pilot-state"]?.textContent, variant.name).toBe(variant.pilot);
      expect(rendered["report-status"]?.textContent, variant.name).toBe(variant.status);
    }
  });

  test("published fixture sources match the executed demo and compile", () => {
    const repository = join(import.meta.dir, "..", "..");
    for (const item of FIXTURE_CASES) {
      for (const phase of ["base", "changed"] as const) {
        const publicSource = readFileSync(join(repository, "site", "fixtures", phase, item.file.relPath), "utf8");
        expect(publicSource.replaceAll("\r\n", "\n")).toBe(item.file[phase]);
      }
    }
    const checked = Bun.spawnSync([process.execPath, "node_modules/typescript/bin/tsc", "-p", "site/fixtures/tsconfig.json"], { cwd: repository, stdout: "pipe", stderr: "pipe" });
    expect(checked.exitCode, new TextDecoder().decode(checked.stdout) + new TextDecoder().decode(checked.stderr)).toBe(0);
  });
  test("assets are local, links are local or the fixed repository, and the page has fallback evidence copy", () => {
    const siteRoot = join(import.meta.dir, "..", "..", "site");
    const html = readFileSync(join(siteRoot, "index.html"), "utf8");
    const references = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(match => match[1]!);
    expect(references.every(value => value.startsWith("./") || value.startsWith("#") || value === "https://github.com/hoklims/semctx" || value === "https://hoklims.github.io/semctx/demo/")).toBe(true);
    expect(html).toContain("Dynamic evidence is not loaded in this view.");
    expect(html).toContain("Open the public evidence JSON");
    expect(html).not.toContain("Evidence has not been generated for this candidate.");
    expect(html).toContain('id="evidence-report" aria-live="polite" aria-busy="false"');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).not.toContain("analytics");
    expect(readFileSync(join(siteRoot, "styles.css"), "utf8")).not.toContain("transition: all");
  });
});
