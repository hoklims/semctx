import { describe, expect, it } from "bun:test";
import {
  computeAttestationSetHash,
  computeCanonicalProofAttestationDigest,
  computeControlFreshnessSealV2Hash,
  normalizeControlFreshnessSealV1,
  serializeControlReport,
  type CanonicalProofAttestationV1,
  type ControlFreshnessSeal,
  type ControlFreshnessSealV2,
  type ControlFreshnessStatusReport,
} from "@semantic-context/control-model";
import {
  deletionAuthorizationQuery,
  refinementCoverageQuery,
  transitionAuthorizationQuery,
  type ControlQueryRuntime,
} from "../src/control-queries";

const hash = `sha256:${"a".repeat(64)}` as const;
const legacySeal: ControlFreshnessSeal = {
  sealSchemaVersion: 1,
  kind: "control_freshness_seal",
  algorithm: "sha256-v1",
  repositoryRoot: "C:/repo",
  indexedRepositoryRoot: "C:/repo",
  headAtCapture: "abc123",
  indexedHeadCommit: "abc123",
  repositoryGraphHash: hash,
  indexedRepositoryGraphHash: hash,
  semanticModelHash: hash,
  indexedSemanticModelHash: hash,
  analysisInputHash: hash,
  indexedAnalysisInputHash: hash,
  workingDiffHash: hash,
  indexedWorkingDiffHash: hash,
  indexedAt: "2026-07-23T00:00:00.000Z",
  storeSchemaVersion: 1,
  indexedStoreSchemaVersion: 1,
  toolVersion: "test",
  indexedToolVersion: "test",
  sealHash: hash,
};
const freshStatus: ControlFreshnessStatusReport = {
  schemaVersion: 1,
  kind: "control_freshness_status",
  basis: "control_index_snapshot_v1",
  verdict: "FRESH",
  canRunHighRiskControl: true,
  reasons: [],
  freshnessSeal: legacySeal,
};

function attestation(): CanonicalProofAttestationV1 {
  const payload = {
    schemaVersion: 1 as const,
    id: "attestation.baseline",
    obligation: "baseline_captured" as const,
    subject: "change.demo",
    epistemicStatus: "statically_observed" as const,
    references: [{ kind: "static_analysis" as const, uri: "evidence:baseline", nonLlm: true }],
    commit: "git:abc123",
    observedAt: "2026-07-23T00:00:00.000Z",
    expiresAt: "2026-07-24T00:00:00.000Z",
  };
  return { ...payload, attestationDigest: computeCanonicalProofAttestationDigest(payload) };
}

function runtime(): ControlQueryRuntime {
  const proof = attestation();
  const attestationSetHash = computeAttestationSetHash([proof.attestationDigest]);
  const normalized = normalizeControlFreshnessSealV1(legacySeal).value;
  const { sealHash: _normalizedHash, ...normalizedPayload } = normalized;
  const payload: Omit<ControlFreshnessSealV2, "sealHash"> = {
    ...normalizedPayload,
    attestationSetHash,
  };
  const seal = { ...payload, sealHash: computeControlFreshnessSealV2Hash(payload) };
  return {
    graph: {
      schemaVersion: 2,
      nodes: [],
      structuralEdges: [],
      refinementRelations: [],
      mapping: [],
      coverage: [],
      unsupported: [],
      unmapped: [],
      staleLinks: [],
      danglingReferences: [],
      compatibilityNormalization: [],
      verifiedEvidenceDigests: [],
    },
    freshnessStatus: freshStatus,
    freshnessSeal: seal,
    currentArchitecture: {
      id: "current",
      commit: "git:abc123",
      capturedAt: "2026-07-23T00:00:00.000Z",
      elements: [],
      relations: [],
    },
    sealedAttestationIndex: {
      schemaVersion: 1,
      entries: [proof],
      attestationSetHash,
    },
    sealedEvidence: [{
      id: "evidence:baseline",
      filePath: "src/baseline.ts",
      sourceKind: "code",
    }],
  };
}

describe("shared read-only control queries", () => {
  it("refuses stale inputs before authorization and returns no payload", () => {
    const stale: ControlQueryRuntime = {
      ...runtime(),
      freshnessStatus: {
        ...freshStatus,
        verdict: "STALE",
        canRunHighRiskControl: false,
        reasons: ["HEAD_MISMATCH"],
      },
    };
    const result = deletionAuthorizationQuery(stale, {
      subject: "change.demo",
      planningCommit: "git:abc123",
      evaluatedAt: "2026-07-23T12:00:00.000Z",
      attestationRequests: [],
    });
    expect(result).toMatchObject({
      terminalStatus: "refused",
      reasonCodes: ["INDEX_STALE"],
      payload: null,
    });
  });

  it("resolves only a complete attestation bound to the current seal and commit", () => {
    const result = transitionAuthorizationQuery(runtime(), {
      fromState: "OBSERVED",
      toState: "MODELED",
      risk: "R0",
      subject: "change.demo",
      planningCommit: "git:abc123",
      evaluatedAt: "2026-07-23T12:00:00.000Z",
      proofObligations: ["baseline_captured"],
      rollback: undefined,
      changesL4Invariant: false,
      attestationRequests: [{ schemaVersion: 1, attestationRef: "attestation.baseline" }],
    });
    expect(result.payload?.decision).toBe("ALLOW");
    expect(result.payload?.acceptedAttestations.map((item) => item.id)).toEqual(["attestation.baseline"]);
    expect(result.payload?.advisoryRejectedAttestations).toEqual([]);
  });

  it("gives fabricated or unbound caller records zero authorization weight", () => {
    const requestWithIgnoredBody = {
      schemaVersion: 1 as const,
      attestationRef: "attestation.fabricated",
      subject: "change.demo",
      commit: "git:abc123",
      sealHash: runtime().freshnessSeal?.sealHash,
    };
    const result = transitionAuthorizationQuery(runtime(), {
      fromState: "OBSERVED",
      toState: "MODELED",
      risk: "R0",
      subject: "change.demo",
      planningCommit: "git:abc123",
      evaluatedAt: "2026-07-23T12:00:00.000Z",
      proofObligations: ["baseline_captured"],
      changesL4Invariant: false,
      attestationRequests: [requestWithIgnoredBody],
    });
    expect(result.payload?.decision).toBe("DENY");
    expect(result.payload?.acceptedAttestations).toEqual([]);
    expect(result.payload?.advisoryRejectedAttestations).toEqual([{
      schemaVersion: 1,
      attestationRef: "attestation.fabricated",
      reason: "ATTESTATION_UNBOUND",
    }]);
    expect(result.reasonCodes).toEqual(["ATTESTATION_UNBOUND"]);
  });

  it("canonicalizes duplicate request order to byte-identical reports", () => {
    const query = {
      fromState: "OBSERVED" as const,
      toState: "MODELED" as const,
      risk: "R0" as const,
      subject: "change.demo",
      planningCommit: "git:abc123",
      evaluatedAt: "2026-07-23T12:00:00.000Z",
      proofObligations: ["baseline_captured" as const],
      changesL4Invariant: false,
    };
    const a = transitionAuthorizationQuery(runtime(), {
      ...query,
      attestationRequests: [
        { schemaVersion: 1, attestationRef: "missing.z" },
        { schemaVersion: 1, attestationRef: "attestation.baseline" },
        { schemaVersion: 1, attestationRef: "missing.z" },
      ],
    });
    const b = transitionAuthorizationQuery(runtime(), {
      ...query,
      attestationRequests: [
        { schemaVersion: 1, attestationRef: "attestation.baseline" },
        { schemaVersion: 1, attestationRef: "missing.z" },
      ],
    });
    expect(serializeControlReport(a)).toBe(serializeControlReport(b));
  });

  it("derives coverage seals from the runtime and rejects arbitrary equal caller seals", () => {
    const current = runtime();
    const derived = refinementCoverageQuery(current, {
      sourceId: hash,
      targetLevel: 6,
      direction: "lift",
    });
    expect(derived.terminalStatus).not.toBe("refused");
    const forged = `sha256:${"f".repeat(64)}` as const;
    const refused = refinementCoverageQuery(current, {
      sourceId: hash,
      targetLevel: 6,
      direction: "lift",
      sourceSeal: forged,
      indexSeal: forged,
    });
    expect(refused).toMatchObject({
      terminalStatus: "refused",
      reasonCodes: ["INDEX_STALE"],
      payload: null,
    });
  });

  it("rejects every attestation when the currently read index is not snapshot-bound", () => {
    const current = runtime();
    const result = transitionAuthorizationQuery({
      ...current,
      sealedAttestationIndex: {
        ...current.sealedAttestationIndex!,
        attestationSetHash: `sha256:${"b".repeat(64)}`,
      },
    }, {
      fromState: "OBSERVED",
      toState: "MODELED",
      risk: "R0",
      subject: "change.demo",
      planningCommit: "git:abc123",
      evaluatedAt: "2026-07-23T12:00:00.000Z",
      proofObligations: ["baseline_captured"],
      changesL4Invariant: false,
      attestationRequests: [{ schemaVersion: 1, attestationRef: "attestation.baseline" }],
    });
    expect(result.payload?.acceptedAttestations).toEqual([]);
    expect(result.reasonCodes).toEqual(["ATTESTATION_UNBOUND"]);
  });
});
