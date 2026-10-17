import { expect, test } from "bun:test";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { SAMPLE_RUST_REPO } from "@semantic-context/test-fixtures";
import { discoverRepository } from "@semantic-context/ts-analyzer";
import { admissibleFor, evaluatePlaneA, type PlaneAEvaluationInput, type PlaneAGates } from "@semantic-context/plane-a-internal";
import { analyzePlaneARuntime } from "../src/plane-a-runtime";
import { isPlaneAOperationAdmitted } from "../src/plane-a-authority-policy";
import { resolvePlaneACapabilityRequirement } from "../src/plane-a-capability-requirements";

function rustFunctionEvaluation(): PlaneAEvaluationInput {
  const config = { ...createGlobSelectionConfig(SAMPLE_RUST_REPO), include: ["**/*.rs"], languages: { rust: "on" as const } };
  const sidecar = analyzePlaneARuntime(config, discoverRepository(config)).sidecar;
  const entry = sidecar.discoveryLedger.find((candidate) => candidate.scope.language === "rust"
    && candidate.scope.selectedPaths.includes("domain/src/reservation.rs"));
  if (entry === undefined) throw new Error("Rust fixture discovery entry missing");
  const batch = sidecar.factBatches.find((candidate) => candidate.scope.sourceStateDigest === entry.scope.sourceStateDigest
    && candidate.scope.selectedPathSetDigest === entry.scope.selectedPathSetDigest && candidate.factKinds.includes("function"));
  if (batch === undefined) throw new Error("Rust function batch missing");
  const result = sidecar.producerResults.find((candidate) => candidate.factBatchId === batch.batchId);
  const profile = sidecar.capabilityProfiles.find((candidate) => batch.capabilityProfileIds.includes(candidate.profileId)
    && candidate.factKind === "function");
  if (result === undefined || profile === undefined) throw new Error("Rust producer evidence missing");
  const requiredCapability = resolvePlaneACapabilityRequirement({
    configVersion: 2, producerConfigurationDigest: sidecar.producerConfigurationDigest,
    task: "verify", operation: "change", language: "rust", dialectVersion: entry.scope.dialectVersion ?? null,
    factKind: "function", completenessClaim: profile.completenessClaim,
  });
  if (requiredCapability === null) throw new Error("Rust consumer requirement missing");
  const taskRelativeAuthority = admissibleFor({ task: "verify", operation: "change", factKind: "function", scope: entry.scope }).admissible
    && isPlaneAOperationAdmitted({ configVersion: 2, task: "verify", operation: "change", factKind: "function", scope: entry.scope });
  return {
    request: { task: "verify", operation: "change", factKind: "function",
      requestedScopeDescriptor: "domain/src/reservation.rs", candidateIdentity: entry.candidateIdentity, negativeConclusion: false },
    scopeResolution: { status: "exact", scope: entry.scope }, ledgerEntry: entry,
    completedResults: [result], factBatches: [batch], bindingAttestation: "valid", currentFreshness: "FRESH",
    capabilityProfiles: [profile], requiredCapability, taskRelativeAuthority: { admissible: taskRelativeAuthority },
  };
}

test("real Rust facts require each ADR 0010 gate independently", () => {
  const baseline = rustFunctionEvaluation();
  const accepted = evaluatePlaneA(baseline);
  expect(accepted).toMatchObject({ decisionKind: "exact_subject", outcome: "PASS", admissible: true,
    gates: { discoveryAndScope: "passed", bindingAndIntegrity: "passed", currentFreshness: "passed",
      capabilityMatch: "passed", negativeCompleteness: "not_applicable", taskRelativeAuthority: "passed" } });
  const cases: { name: keyof PlaneAGates; input: PlaneAEvaluationInput }[] = [
    { name: "discoveryAndScope", input: { ...baseline, completedResults: [] } },
    { name: "bindingAndIntegrity", input: { ...baseline, bindingAttestation: "invalid" } },
    { name: "currentFreshness", input: { ...baseline, currentFreshness: "STALE" } },
    { name: "capabilityMatch", input: { ...baseline, capabilityProfiles: [{ ...baseline.capabilityProfiles[0]!, resolutionSemantics: "unknown-rust-resolution" }] } },
    { name: "negativeCompleteness", input: { ...baseline, request: { ...baseline.request, negativeConclusion: true } } },
    { name: "taskRelativeAuthority", input: { ...baseline, taskRelativeAuthority: { admissible: false } } },
  ];
  for (const { name, input } of cases) {
    const decision = evaluatePlaneA(input);
    expect(decision.admissible).toBe(false);
    expect(decision.gates[name]).toBe("failed");
    for (const [other, state] of Object.entries(accepted.gates)) {
      if (other === name || name === "discoveryAndScope") continue;
      expect(decision.gates[other as keyof PlaneAGates]).toBe(state);
    }
    if (name === "discoveryAndScope") expect(decision.gates.bindingAndIntegrity).toBe("not_applicable");
  }
});

test("a producer-declared Rust fact kind absent from the consumer registry cannot pass gate 4", () => {
  const baseline = rustFunctionEvaluation();
  const profile = baseline.capabilityProfiles[0]!;
  const unknown = "runtime_execution";
  const requirement = resolvePlaneACapabilityRequirement({ configVersion: 2,
    producerConfigurationDigest: baseline.factBatches[0]!.producerConfigurationDigest,
    task: "verify", operation: "change", language: "rust", dialectVersion: profile.scope.dialectVersion ?? null,
    factKind: unknown, completenessClaim: profile.completenessClaim });
  expect(requirement).toBeNull();
  const decision = evaluatePlaneA({ ...baseline,
    request: { ...baseline.request, factKind: unknown },
    factBatches: [{ ...baseline.factBatches[0]!, factKinds: [...baseline.factBatches[0]!.factKinds, unknown] }],
    capabilityProfiles: [{ ...profile, factKind: unknown }], requiredCapability: requirement });
  expect(decision).toMatchObject({ admissible: false, gates: { discoveryAndScope: "passed", bindingAndIntegrity: "passed",
    currentFreshness: "passed", capabilityMatch: "failed", taskRelativeAuthority: "passed" } });
});
