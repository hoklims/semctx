import { describe, expect, it } from "bun:test";
import type {
  PlaneAEvaluationInput,
  PlaneAGates,
} from "../src/index";

const api = await import("../src/index").catch(() => null);

const scope = {
  repositoryIdentity: "repo:fixture",
  sourceStateDigest: "sha256:source",
  selectedPathSetDigest: "sha256:paths",
  selectedPaths: ["src/a.ts"],
  language: "typescript",
  dialectVersion: "5.6",
} as const;

const producer = { identity: "producer:ts", version: "1.0.0" } as const;

function analyzedInput() {
  return {
    request: {
      task: "verify",
      operation: "change",
      factKind: "test_link",
      requestedScopeDescriptor: "src/a.ts",
      candidateIdentity: "candidate:a",
      negativeConclusion: true,
    },
    scopeResolution: { status: "exact" as const, scope },
    ledgerEntry: {
      candidateIdentity: "candidate:a",
      scope,
      selectionDecision: "selected" as const,
      analysisOutcome: "analyzed" as const,
      selectionReasons: [],
      analysisReasons: [],
      selectedProducer: producer,
    },
    completedResults: [{
      resultId: "result:1",
      status: "completed" as const,
      producer,
      scope,
      factBatchId: "batch:1",
    }],
    factBatches: [{
      schemaVersion: 1 as const,
      batchId: "batch:1",
      scope,
      producer,
      producerConfigurationDigest: "sha256:actual-config",
      factSchemaDigest: "sha256:schema",
      sourceDigest: "sha256:source",
      factKinds: ["test_link"],
      capabilityProfileIds: ["profile:1"],
      evidenceContract: "source-lines-v1",
      facts: [],
    }],
    bindingAttestation: "valid" as const,
    currentFreshness: "FRESH" as const,
    capabilityProfiles: [{
      profileId: "profile:1",
      factKind: "test_link",
      scope: { ...scope, selectedPathSetDigest: "sha256:other-paths" },
      producer,
      producerConfigurationDigest: "sha256:expected-config",
      factSchemaDigest: "sha256:schema",
      evidenceContract: "source-lines-v1",
      resolutionSemantics: "typescript-static-v1",
      soundnessClaim: "sound-within-static-resolution",
      completenessClaim: "partial",
      negativeEvidenceEligible: false,
    }],
    requiredCapability: {
      resolutionSemantics: "typescript-static-v1",
      soundnessClaim: "sound-within-static-resolution",
      completenessClaim: "complete",
    },
    taskRelativeAuthority: { admissible: false },
  };
}

function validAnalyzedInput(): PlaneAEvaluationInput {
  const input = analyzedInput();
  return {
    ...input,
    capabilityProfiles: [{
      ...input.capabilityProfiles[0]!,
      scope,
      producerConfigurationDigest: "sha256:actual-config",
      completenessClaim: "complete",
      negativeEvidenceEligible: true,
    }],
    taskRelativeAuthority: { admissible: true },
  };
}

function withCandidate(
  input: PlaneAEvaluationInput,
  candidateIdentity: string,
  selectedPath: string,
): PlaneAEvaluationInput {
  const candidateScope = {
    ...scope,
    selectedPathSetDigest: `sha256:${candidateIdentity}`,
    selectedPaths: [selectedPath],
  };
  return {
    ...input,
    request: {
      ...input.request,
      requestedScopeDescriptor: selectedPath,
      candidateIdentity,
    },
    scopeResolution: { status: "exact", scope: candidateScope },
    ledgerEntry: {
      ...input.ledgerEntry,
      candidateIdentity,
      scope: candidateScope,
    },
    completedResults: input.completedResults.map((result) => ({
      ...result,
      scope: candidateScope,
    })),
    factBatches: input.factBatches.map((batch) => ({
      ...batch,
      scope: candidateScope,
    })),
    capabilityProfiles: input.capabilityProfiles.map((profile) => ({
      ...profile,
      scope: candidateScope,
    })),
  };
}

describe("Plane A gate and reason engine", () => {
  it("keeps task-relative admissibility explicit and exact-coordinate bound", () => {
    if (api === null) throw new Error("internal Plane A API is unavailable");
    expect(api.admissibleFor({
      task: "verify",
      operation: "change",
      factKind: "imports",
      scope,
    })).toEqual({ admissible: true, reasons: [] });
    expect(api.admissibleFor({
      task: "publish",
      operation: "execute",
      factKind: "imports",
      scope,
    })).toEqual({
      admissible: false,
      reasons: ["TASK_OPERATION_NOT_ADMITTED"],
    });
  });

  it("accepts only the ADR selection and terminal-outcome pairs", () => {
    if (api === null) throw new Error("internal Plane A API is unavailable");
    expect(api.normalizeDiscoveryLedgerEntry).toBeFunction();
    expect(api.normalizeDiscoveryLedgerEntry({
      ...analyzedInput().ledgerEntry,
      selectionDecision: "excluded",
      analysisOutcome: "not_applicable",
    })).toMatchObject({
      selectionDecision: "excluded",
      analysisOutcome: "not_applicable",
    });
    expect(() => api.normalizeDiscoveryLedgerEntry({
      ...analyzedInput().ledgerEntry,
      selectionDecision: "excluded",
      analysisOutcome: "analyzed",
    })).toThrow(expect.objectContaining({ code: "INVALID_DISCOVERY_TERMINAL_PAIR" }));
    expect(() => api.normalizeDiscoveryLedgerEntry({
      ...analyzedInput().ledgerEntry,
      selectionDecision: "selected",
      analysisOutcome: "not_applicable",
    })).toThrow(expect.objectContaining({ code: "INVALID_DISCOVERY_TERMINAL_PAIR" }));
  });

  it("normalizes analyzed result cardinality failures at gate 1 and stops downstream gates", () => {
    if (api === null) throw new Error("internal Plane A API is unavailable");
    const decision = api.evaluatePlaneA({
      ...analyzedInput(),
      completedResults: [],
      bindingAttestation: "absent",
      currentFreshness: "STALE",
    });

    expect(decision).toMatchObject({
      decisionKind: "exact_subject",
      outcome: "INSUFFICIENT_ANALYSIS",
      admissible: false,
      normalizedAnalysisOutcome: "failed",
      primaryReason: "PRODUCER_FAILED",
      reasons: [{
        code: "PRODUCER_FAILED",
        details: [{ coordinate: "resultCardinality", expected: 1, actual: 0 }],
      }],
    });
    expect(decision.gates).toEqual({
      discoveryAndScope: "failed",
      bindingAndIntegrity: "not_applicable",
      currentFreshness: "not_applicable",
      capabilityMatch: "not_applicable",
      negativeCompleteness: "not_applicable",
      taskRelativeAuthority: "not_applicable",
    });
  });

  it.each([
    {
      label: "multiple completed results",
      mutate: () => {
        const input = analyzedInput();
        return {
          ...input,
          completedResults: [
            ...input.completedResults,
            { ...input.completedResults[0]!, resultId: "result:2" },
          ],
        };
      },
      coordinate: "resultCardinality",
      actual: 2,
    },
    {
      label: "no corresponding fact batch",
      mutate: () => {
        const input = analyzedInput();
        return { ...input, factBatches: [] };
      },
      coordinate: "factBatchCardinality",
      actual: 0,
    },
    {
      label: "multiple matching fact batches",
      mutate: () => {
        const input = analyzedInput();
        return {
          ...input,
          factBatches: [
            ...input.factBatches,
            { ...input.factBatches[0]!, batchId: "batch:2" },
          ],
        };
      },
      coordinate: "factBatchCardinality",
      actual: 2,
    },
    {
      label: "a result pointing at a different fact batch",
      mutate: () => {
        const input = analyzedInput();
        return {
          ...input,
          completedResults: [{
            ...input.completedResults[0]!,
            factBatchId: "batch:missing",
          }],
        };
      },
      coordinate: "factBatchCardinality",
      actual: 0,
    },
  ])("fails gate 1 for $label", ({ mutate, coordinate, actual }) => {
    if (api === null) throw new Error("internal Plane A API is unavailable");
    const decision = api.evaluatePlaneA(mutate());

    expect(decision).toMatchObject({
      outcome: "INSUFFICIENT_ANALYSIS",
      admissible: false,
      normalizedAnalysisOutcome: "failed",
      primaryReason: "PRODUCER_FAILED",
      reasons: [{
        code: "PRODUCER_FAILED",
        details: [{ coordinate, expected: 1, actual }],
      }],
    });
    expect(decision.gates).toEqual({
      discoveryAndScope: "failed",
      bindingAndIntegrity: "not_applicable",
      currentFreshness: "not_applicable",
      capabilityMatch: "not_applicable",
      negativeCompleteness: "not_applicable",
      taskRelativeAuthority: "not_applicable",
    });
  });

  it("composes exact-subject failures in the closed ADR order with canonical details", () => {
    if (api === null) throw new Error("internal Plane A API is unavailable");
    const decision = api.evaluatePlaneA({
      ...analyzedInput(),
      currentFreshness: "STALE",
    });

    expect(decision.reasons.map((reason) => reason.code)).toEqual([
      "CURRENT_STATE_STALE",
      "SCOPE_MISMATCH",
      "CONFIG_DIGEST_MISMATCH",
      "NEGATIVE_COMPLETENESS_MISSING",
      "POLICY_DENIED",
    ]);
    expect(decision.reasons.find((reason) =>
      reason.code === "SCOPE_MISMATCH")?.details).toEqual([{
        coordinate: "selectedPathSetDigest",
        expected: "sha256:other-paths",
        actual: "sha256:paths",
      }]);
    expect(decision.primaryReason).toBe("CURRENT_STATE_STALE");
    expect(decision.gates).toEqual({
      discoveryAndScope: "passed",
      bindingAndIntegrity: "passed",
      currentFreshness: "failed",
      capabilityMatch: "failed",
      negativeCompleteness: "failed",
      taskRelativeAuthority: "failed",
    });
  });

  it("keeps positive completeness mismatch at capability gate 4", () => {
    if (api === null) throw new Error("internal Plane A API is unavailable");
    const input = analyzedInput();
    const profile = {
      ...input.capabilityProfiles[0]!,
      scope,
      producerConfigurationDigest: "sha256:actual-config",
    };
    const decision = api.evaluatePlaneA({
      ...input,
      request: {
        ...input.request,
        negativeConclusion: false,
      },
      currentFreshness: "FRESH",
      taskRelativeAuthority: { admissible: true },
      capabilityProfiles: [profile],
    });

    expect(decision.reasons).toEqual([{
      code: "CAPABILITY_MISSING",
      details: [{
        coordinate: "completenessClaim",
        expected: "complete",
        actual: "partial",
      }],
    }]);
    expect(decision.gates.capabilityMatch).toBe("failed");
    expect(decision.gates.negativeCompleteness).toBe("not_applicable");
  });

  it.each([
    {
      label: "binding/integrity gate 2",
      mutate: (input: PlaneAEvaluationInput): PlaneAEvaluationInput => ({
        ...input,
        bindingAttestation: "invalid",
      }),
      failedGate: "bindingAndIntegrity" as keyof PlaneAGates,
      reason: "BINDING_INVALID",
      outcome: "INSUFFICIENT_ANALYSIS",
    },
    {
      label: "current freshness gate 3",
      mutate: (input: PlaneAEvaluationInput): PlaneAEvaluationInput => ({
        ...input,
        currentFreshness: "STALE",
      }),
      failedGate: "currentFreshness" as keyof PlaneAGates,
      reason: "CURRENT_STATE_STALE",
      outcome: "INSUFFICIENT_ANALYSIS",
    },
    {
      label: "capability gate 4",
      mutate: (input: PlaneAEvaluationInput): PlaneAEvaluationInput => ({
        ...input,
        capabilityProfiles: [{
          ...input.capabilityProfiles[0]!,
          evidenceContract: "different-evidence-contract",
        }],
      }),
      failedGate: "capabilityMatch" as keyof PlaneAGates,
      reason: "EVIDENCE_CONTRACT_MISMATCH",
      outcome: "INSUFFICIENT_ANALYSIS",
    },
    {
      label: "negative completeness gate 5",
      mutate: (input: PlaneAEvaluationInput): PlaneAEvaluationInput => ({
        ...input,
        capabilityProfiles: [{
          ...input.capabilityProfiles[0]!,
          negativeEvidenceEligible: false,
        }],
      }),
      failedGate: "negativeCompleteness" as keyof PlaneAGates,
      reason: "NEGATIVE_COMPLETENESS_MISSING",
      outcome: "INSUFFICIENT_ANALYSIS",
    },
    {
      label: "task-relative authority gate 6",
      mutate: (input: PlaneAEvaluationInput): PlaneAEvaluationInput => ({
        ...input,
        taskRelativeAuthority: { admissible: false },
      }),
      failedGate: "taskRelativeAuthority" as keyof PlaneAGates,
      reason: "POLICY_DENIED",
      outcome: "POLICY_DENIED",
    },
  ])("fails only $label while every other applicable gate passes", ({
    mutate,
    failedGate,
    reason,
    outcome,
  }) => {
    if (api === null) throw new Error("internal Plane A API is unavailable");
    const decision = api.evaluatePlaneA(mutate(validAnalyzedInput()));

    expect(decision.outcome).toBe(outcome);
    expect(decision.reasons.map((item) => item.code)).toEqual([reason]);
    for (const [gate, state] of Object.entries(decision.gates)) {
      expect(state).toBe(gate === failedGate ? "failed" : "passed");
    }
  });

  it("selects only the capability profile explicitly referenced by the corresponding batch", () => {
    if (api === null) throw new Error("internal Plane A API is unavailable");
    const input = analyzedInput();
    const goodProfile = {
      ...input.capabilityProfiles[0]!,
      profileId: "profile:b",
      scope,
      producerConfigurationDigest: "sha256:actual-config",
      completenessClaim: "complete",
      negativeEvidenceEligible: true,
    };
    const decoyProfile = {
      ...goodProfile,
      profileId: "profile:a",
      resolutionSemantics: "path-only",
      completenessClaim: "partial",
      negativeEvidenceEligible: false,
    };
    const decision = api.evaluatePlaneA({
      ...input,
      currentFreshness: "FRESH",
      taskRelativeAuthority: { admissible: true },
      capabilityProfiles: [decoyProfile, goodProfile],
      factBatches: [{
        ...input.factBatches[0]!,
        capabilityProfileIds: ["profile:b"],
      }],
    });

    expect(decision).toMatchObject({
      outcome: "PASS",
      admissible: true,
      reasons: [],
      gates: {
        discoveryAndScope: "passed",
        bindingAndIntegrity: "passed",
        currentFreshness: "passed",
        capabilityMatch: "passed",
        negativeCompleteness: "passed",
        taskRelativeAuthority: "passed",
      },
    });
  });

  it("aggregates distinct pre-subject and exact decisions without inventing scope", () => {
    if (api === null) throw new Error("internal Plane A API is unavailable");
    const unresolved = api.evaluatePlaneA({
      ...analyzedInput(),
      scopeResolution: {
        status: "unresolved",
        failures: [{
          code: "AMBIGUOUS_SCOPE",
          detail: {
            coordinate: "requestedScopeDescriptor",
            expected: "one exact ArtifactScope",
            actual: 0,
          },
        }],
      },
    });
    const failed = api.evaluatePlaneA({
      ...analyzedInput(),
      ledgerEntry: {
        ...analyzedInput().ledgerEntry,
        analysisOutcome: "failed",
      },
    });
    const report = api.aggregatePlaneAEvaluations([failed, unresolved]);

    expect(unresolved).not.toHaveProperty("scope");
    expect(report.reasonSummary).toEqual(["AMBIGUOUS_SCOPE", "PRODUCER_FAILED"]);
    expect(report.decisions).toHaveLength(2);
    expect(report.decisions.map((decision) => decision.candidateIdentity)).toEqual([
      "candidate:a",
      "candidate:a",
    ]);
  });

  it("locks the ADR-C17 pre-subject and terminal-outcome report composition", () => {
    if (api === null) throw new Error("internal Plane A API is unavailable");
    const requestB = withCandidate(analyzedInput(), "request:b", "packages/conflict");
    const requestC = withCandidate(analyzedInput(), "request:c", "src/unresolved.ts");
    const subjectD = withCandidate(validAnalyzedInput(), "subject:d", "src/disabled.ts");
    const subjectE = withCandidate(validAnalyzedInput(), "subject:e", "src/unsupported.py");
    const subjectF = withCandidate(validAnalyzedInput(), "subject:f", "src/failed.ts");
    const decisions = [
      api.evaluatePlaneA({
        ...requestB,
        scopeResolution: {
          status: "unresolved",
          failures: [{
            code: "AMBIGUOUS_LAYOUT",
            detail: {
              coordinate: "requestedScopeDescriptor",
              expected: "one manifest-evidenced workspace",
              actual: "conflicting detectors",
            },
          }],
        },
      }),
      api.evaluatePlaneA({
        ...requestC,
        scopeResolution: {
          status: "unresolved",
          failures: [{
            code: "AMBIGUOUS_SCOPE",
            detail: {
              coordinate: "requestedScopeDescriptor",
              expected: "one exact ArtifactScope",
              actual: 0,
            },
          }],
        },
      }),
      api.evaluatePlaneA({
        ...subjectD,
        ledgerEntry: { ...subjectD.ledgerEntry, analysisOutcome: "disabled" },
      }),
      api.evaluatePlaneA({
        ...subjectE,
        ledgerEntry: { ...subjectE.ledgerEntry, analysisOutcome: "unsupported" },
      }),
      api.evaluatePlaneA({
        ...subjectF,
        ledgerEntry: { ...subjectF.ledgerEntry, analysisOutcome: "failed" },
      }),
    ];
    const report = api.aggregatePlaneAEvaluations(decisions);

    expect(report.reasonSummary).toEqual([
      "AMBIGUOUS_LAYOUT",
      "AMBIGUOUS_SCOPE",
      "ANALYSIS_DISABLED",
      "LANGUAGE_UNSUPPORTED",
      "PRODUCER_FAILED",
    ]);
    expect(report.primaryReason).toBe("AMBIGUOUS_LAYOUT");
    expect(Object.fromEntries(report.decisions.map((decision) => [
      decision.candidateIdentity,
      [decision.decisionKind, decision.primaryReason],
    ]))).toEqual({
      "request:b": ["pre_subject", "AMBIGUOUS_LAYOUT"],
      "request:c": ["pre_subject", "AMBIGUOUS_SCOPE"],
      "subject:d": ["exact_subject", "ANALYSIS_DISABLED"],
      "subject:e": ["exact_subject", "LANGUAGE_UNSUPPORTED"],
      "subject:f": ["exact_subject", "PRODUCER_FAILED"],
    });
    const byCandidate = Object.fromEntries(report.decisions.map((decision) => [
      decision.candidateIdentity,
      decision,
    ]));
    expect(byCandidate["request:b"]).not.toHaveProperty("scope");
    expect(byCandidate["request:c"]).not.toHaveProperty("scope");
    expect(["subject:d", "subject:e", "subject:f"].every((candidate) =>
      "scope" in byCandidate[candidate]!)).toBe(true);
    expect(api.aggregatePlaneAEvaluations([...decisions].reverse())).toEqual(report);
  });

  it("locks the ADR-C17 binding and capability report composition", () => {
    if (api === null) throw new Error("internal Plane A API is unavailable");
    const subjectG = withCandidate(validAnalyzedInput(), "subject:g", "src/unsealed.ts");
    const subjectH = withCandidate(validAnalyzedInput(), "subject:h", "src/invalid.ts");
    const subjectI = withCandidate(validAnalyzedInput(), "subject:i", "src/capability.ts");
    const profileI = subjectI.capabilityProfiles[0]!;
    const decisions = [
      api.evaluatePlaneA({
        ...subjectG,
        bindingAttestation: "absent",
      }),
      api.evaluatePlaneA({
        ...subjectH,
        bindingAttestation: "invalid",
      }),
      api.evaluatePlaneA({
        ...subjectI,
        capabilityProfiles: [{
          ...profileI,
          producer: { ...profileI.producer, version: "2.0.0" },
          factSchemaDigest: "sha256:expected-schema",
          evidenceContract: "source-lines-v2",
          resolutionSemantics: "path-only",
        }],
      }),
    ];
    const report = api.aggregatePlaneAEvaluations(decisions);

    expect(report.reasonSummary).toEqual([
      "BINDING_UNSEALED",
      "BINDING_INVALID",
      "CAPABILITY_MISSING",
      "PRODUCER_VERSION_MISMATCH",
      "SCHEMA_DIGEST_MISMATCH",
      "EVIDENCE_CONTRACT_MISMATCH",
    ]);
    expect(report.primaryReason).toBe("BINDING_UNSEALED");
    expect(Object.fromEntries(report.decisions.map((decision) => [
      decision.candidateIdentity,
      {
        primaryReason: decision.primaryReason,
        reasons: decision.reasons.map((reason) => reason.code),
      },
    ]))).toEqual({
      "subject:g": {
        primaryReason: "BINDING_UNSEALED",
        reasons: ["BINDING_UNSEALED"],
      },
      "subject:h": {
        primaryReason: "BINDING_INVALID",
        reasons: ["BINDING_INVALID"],
      },
      "subject:i": {
        primaryReason: "CAPABILITY_MISSING",
        reasons: [
          "CAPABILITY_MISSING",
          "PRODUCER_VERSION_MISMATCH",
          "SCHEMA_DIGEST_MISMATCH",
          "EVIDENCE_CONTRACT_MISMATCH",
        ],
      },
    });
    expect(api.aggregatePlaneAEvaluations([...decisions].reverse())).toEqual(report);
  });
});
