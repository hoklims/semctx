/* global document, history, location */

const caseInputs = [...document.querySelectorAll('input[name="case"]')];
const casePanels = [...document.querySelectorAll("[data-case]")];

function selectCase(caseId, updateUrl = true) {
  const input = caseInputs.find(candidate => candidate.value === caseId);
  if (!input) return;
  input.checked = true;
  for (const panel of casePanels) panel.hidden = panel.dataset.case !== caseId;
  if (updateUrl) history.replaceState(null, "", `#case-${caseId}`);
}

for (const input of caseInputs) input.addEventListener("change", () => selectCase(input.value));
const requestedCase = location.hash.startsWith("#case-") ? location.hash.slice(6) : null;
selectCase(requestedCase ?? caseInputs.find(input => input.checked)?.value, false);

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

const CASES = {
  benign: { fixturePath: "src/greeting.ts", expectedFinding: "none", expectedRuleIds: [] },
  "exported-contract-risk": {
    fixturePath: "src/cart.ts",
    expectedFinding: "warn",
    expectedRuleIds: ["contract_changed_without_test"],
  },
  "unsupported-limit": { fixturePath: "src/pricing.ts", expectedFinding: "none", expectedRuleIds: [] },
};
const KNOWN_RULES = new Set([
  "invariant_touched_without_test",
  "critical_contract_changed_without_test",
  "contract_changed_without_test",
  "contradiction_unresolved",
  "security_surface_without_verification",
  "analysis_scope_incomplete",
  "index_binding_stale",
]);
const PILOT_TOOLS = ["semctx", "changed-files", "one-hop-import-neighborhood"];
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SCOPE_DISCLOSURE = "Semctx reports structural impact and declared contract risk. It does not prove runtime or business correctness.";
const MEASUREMENT_DISCLOSURE = "Automated evidence does not measure adoption, retention, or contribution time.";

function invalid(name) {
  throw new Error(`Invalid public evidence: ${name}`);
}

function record(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(name);
  return value;
}

function oneOf(value, allowed, name) {
  if (!allowed.includes(value)) invalid(name);
  return value;
}

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(name);
  return value;
}

function finiteNonNegative(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid(name);
  return value;
}

function ratio(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) invalid(name);
  return value;
}

function isoDate(value, name) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(name);
  return value;
}

function digest(value, name) {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) invalid(name);
  return value;
}

function commit(value, name) {
  if (value === null) return null;
  const identity = record(value, name);
  if (!/^[0-9a-f]{40}$/.test(identity.value) || identity.authority !== "caller-asserted") invalid(name);
  return identity;
}

function demoEvidence(value) {
  if (value === null) return null;
  const demo = record(value, "demo");
  const status = oneOf(demo.status, ["COMPLETED", "BLOCKED"], "demo.status");
  isoDate(demo.observedAt, "demo.observedAt");
  if (demo.packageVersion !== null && (typeof demo.packageVersion !== "string" || !SEMVER.test(demo.packageVersion))) invalid("demo.packageVersion");
  if (demo.runtimeDigest !== null) digest(demo.runtimeDigest, "demo.runtimeDigest");
  digest(demo.fixtureBaseDigest, "demo.fixtureBaseDigest");
  digest(demo.fixtureChangedDigest, "demo.fixtureChangedDigest");
  commit(demo.fixtureCommit, "demo.fixtureCommit");
  const verdict = demo.verdict === null ? null : oneOf(demo.verdict, ["PASS", "WARN", "BLOCK"], "demo.verdict");
  integer(demo.unknownCount, "demo.unknownCount");
  if (!Array.isArray(demo.cases)) invalid("demo.cases");
  const ids = new Set();
  for (const value of demo.cases) {
    const item = record(value, "demo case");
    const expected = typeof item.id === "string" && Object.hasOwn(CASES, item.id) ? CASES[item.id] : null;
    if (!expected || item.fixturePath !== expected.fixturePath || item.expectedFinding !== expected.expectedFinding || ids.has(item.id)) invalid("demo case contract");
    ids.add(item.id);
    if (!Array.isArray(item.observedRuleIds) || !item.observedRuleIds.every(rule => typeof rule === "string" && KNOWN_RULES.has(rule))) invalid("demo case rules");
    if (typeof item.matchedExpectation !== "boolean") invalid("demo case match");
    const matched = item.observedRuleIds.length === expected.expectedRuleIds.length
      && item.observedRuleIds.every((rule, ruleIndex) => rule === expected.expectedRuleIds[ruleIndex]);
    if ((status === "COMPLETED" || item.matchedExpectation) && item.matchedExpectation !== matched) invalid("demo case match");
  }
  if (status === "COMPLETED") {
    if (ids.size !== Object.keys(CASES).length || Object.keys(CASES).some(id => !ids.has(id))) invalid("completed demo cases");
    if (demo.cases.some(item => !item.matchedExpectation)) invalid("completed demo expectations");
    if (demo.packageVersion === null || demo.runtimeDigest === null || demo.fixtureCommit === null || verdict === null) invalid("completed demo identity");
    if (verdict !== "WARN") invalid("demo.verdict");
  } else if (demo.cases.length === 0) {
    if (verdict !== null) invalid("blocked demo outcomes");
  } else {
    if (ids.size !== Object.keys(CASES).length || Object.keys(CASES).some(id => !ids.has(id))) invalid("blocked demo cases");
    if (demo.packageVersion === null || demo.runtimeDigest === null || demo.fixtureCommit === null || verdict === null) invalid("blocked demo identity");
  }
  return demo;
}

function pilotEvidence(value) {
  if (value === null) return null;
  const pilot = record(value, "pilot");
  const evidenceKind = oneOf(pilot.evidenceKind, ["research", "smoke"], "pilot.evidenceKind");
  const verdict = oneOf(pilot.verdict, ["EVIDENCE_MISSING", "INCONCLUSIVE", "NEGATIVE", "POSITIVE"], "pilot.verdict");
  digest(pilot.protocolDigest, "pilot.protocolDigest");
  const total = integer(pilot.totalCases, "pilot.totalCases");
  const observed = integer(pilot.observedCases, "pilot.observedCases");
  const failed = integer(pilot.failedCases, "pilot.failedCases");
  const untrusted = integer(pilot.untrustedCases, "pilot.untrustedCases");
  const labelled = integer(pilot.labelledCases, "pilot.labelledCases");
  const unknown = integer(pilot.unknownCases, "pilot.unknownCases");
  const repositories = integer(pilot.repositoryCount, "pilot.repositoryCount");
  finiteNonNegative(pilot.totalDurationMs, "pilot.totalDurationMs");
  isoDate(pilot.generatedAt, "pilot.generatedAt");
  if (observed + failed !== total || labelled + unknown !== total || untrusted > observed) invalid("pilot counts");
  if (evidenceKind === "research" && (total < 30 || repositories < 3)) invalid("pilot research coverage");
  if ((evidenceKind === "smoke" || failed > 0 || untrusted > 0 || labelled === 0) && verdict !== "EVIDENCE_MISSING") invalid("pilot.verdict");
  if (evidenceKind === "research" && failed === 0 && untrusted === 0 && labelled > 0 && labelled < 30 && verdict !== "INCONCLUSIVE") invalid("pilot.verdict");
  if (evidenceKind === "research" && labelled >= 30 && failed === 0 && untrusted === 0 && !["POSITIVE", "NEGATIVE"].includes(verdict)) invalid("pilot.verdict");
  if (pilot.scores === null) {
    if (failed === 0 && untrusted === 0 && labelled > 0) invalid("pilot.scores");
  } else {
    if (!Array.isArray(pilot.scores) || pilot.scores.length !== PILOT_TOOLS.length || labelled === 0 || failed > 0 || untrusted > 0) invalid("pilot.scores");
    const tools = new Set();
    for (const value of pilot.scores) {
      const score = record(value, "pilot score");
      oneOf(score.tool, PILOT_TOOLS, "pilot score tool");
      if (tools.has(score.tool) || integer(score.labelledCasesScored, "pilot score coverage") !== labelled) invalid("pilot score coverage");
      tools.add(score.tool);
      ratio(score.precision, "pilot score precision");
      ratio(score.recall, "pilot score recall");
      ratio(score.criticalRecall, "pilot score critical recall");
    }
    if (evidenceKind === "research" && labelled >= 30) {
      const semctx = pilot.scores.find(score => score.tool === "semctx");
      const baselineCriticalRecall = Math.max(...pilot.scores.filter(score => score.tool !== "semctx").map(score => score.criticalRecall));
      const expectedVerdict = semctx.precision >= 0.8 && semctx.criticalRecall >= baselineCriticalRecall ? "POSITIVE" : "NEGATIVE";
      if (verdict !== expectedVerdict) invalid("pilot.verdict");
    }
  }
  return pilot;
}

function publicEvidence(value) {
  const evidence = record(value, "root");
  if (evidence.schemaVersion !== 1 || evidence.kind !== "semctx-public-evidence-v1") invalid("schema identity");
  const phase = oneOf(evidence.phase, ["candidate", "release"], "phase");
  isoDate(evidence.generatedAt, "generatedAt");
  const evidenceState = oneOf(evidence.evidenceState, ["NOT_OBSERVED", "OBSERVED"], "evidenceState");
  commit(evidence.releaseCommit, "releaseCommit");
  const demo = demoEvidence(evidence.demo);
  const pilot = pilotEvidence(evidence.pilot);
  const metrics = record(evidence.humanMetrics, "humanMetrics");
  if (metrics.adoption !== "NOT_MEASURED" || metrics.retention !== "NOT_MEASURED" || metrics.contributionTime !== "NOT_MEASURED") invalid("humanMetrics");
  const disclosures = record(evidence.disclosures, "disclosures");
  if (disclosures.scope !== SCOPE_DISCLOSURE || disclosures.measurement !== MEASUREMENT_DISCLOSURE) invalid("disclosures");
  if ((demo === null && pilot === null) !== (evidenceState === "NOT_OBSERVED")) invalid("evidenceState");
  if (phase === "release" && demo?.status !== "COMPLETED") invalid("release demo");
  return evidence;
}

async function loadEvidence() {
  const report = document.getElementById("evidence-report");
  report?.setAttribute("aria-busy", "true");
  try {
    const response = await fetch("./evidence.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Evidence file unavailable");
    const evidence = publicEvidence(await response.json());
    const phase = evidence.phase;
    setText("phase-label", phase === "release" ? "Released evidence" : "Candidate evidence");
    setText("phase-value", phase);
    setText("demo-state", evidence.demo?.status?.toLowerCase() ?? "not observed");
    setText("pilot-state", evidence.pilot?.verdict?.toLowerCase().replaceAll("_", " ") ?? "not observed");
    setText("global-verdict", evidence.demo?.verdict ?? "—");
    const matched = evidence.demo?.cases?.filter(item => item.matchedExpectation).length;
    setText("cases-matched", matched === undefined ? "—" : `${matched} / ${evidence.demo.cases.length}`);
    setText("pilot-observations", evidence.pilot ? `${evidence.pilot.observedCases} / ${evidence.pilot.totalCases}` : "—");
    setText("pilot-untrusted", evidence.pilot ? `${evidence.pilot.untrustedCases} untrusted · ${evidence.pilot.failedCases} failed to run` : "—");
    setText("unknown-labels", evidence.pilot ? String(evidence.pilot.unknownCases) : "—");
    setText("artifact-version", evidence.demo?.packageVersion ?? "—");
    const releaseCommit = evidence.releaseCommit;
    const fixtureCommit = evidence.demo?.fixtureCommit;
    setText("release-commit-identity", releaseCommit ? `${releaseCommit.value.slice(0, 12)} · ${releaseCommit.authority}` : "Not bound");
    setText("fixture-commit-identity", fixtureCommit ? `${fixtureCommit.value.slice(0, 12)} · ${fixtureCommit.authority}` : "—");
    for (const result of document.querySelectorAll("[data-case-result]")) {
      const observed = evidence.demo?.cases?.find(item => item.id === result.dataset.caseResult);
      result.textContent = observed
        ? `Observed result: ${observed.matchedExpectation ? "matched expectation" : "did not match expectation"}; rules: ${observed.observedRuleIds.join(", ") || "none"}.`
        : "Observed result: not available.";
    }
    if (evidence.evidenceState === "NOT_OBSERVED") {
      setText("report-status", "Public evidence loaded; no demo or pilot observations are present.");
      setText("report-detail", "The loaded projection contains neither packaged demo nor pilot evidence.");
    } else {
      setText("report-status", evidence.demo?.status === "COMPLETED"
        ? "Packaged demo evidence is present."
        : evidence.demo
          ? "Evidence is present with an unresolved or blocked demo."
          : "Pilot evidence is present; packaged demo evidence is not observed.");
      setText("report-detail", evidence.disclosures.scope);
    }
    setText("release-note", phase === "release"
      ? "This projection is marked as release evidence. Inspect its digests and caller-asserted commit before relying on it."
      : "This projection is candidate evidence. Confirm a published release before installing it as released evidence.");
  } catch {
    setText("report-status", "Public evidence could not be loaded.");
    setText("report-detail", "Open evidence.json directly or retry from the published site. No result is inferred from this error.");
  } finally {
    report?.setAttribute("aria-busy", "false");
  }
}

void loadEvidence();
