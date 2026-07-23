import { describe, expect, it } from "bun:test";
import * as controlModel from "@semantic-context/control-model";
import {
  AuthoredSemanticNodeV1Schema,
  CanonicalProofAttestationV1Schema,
  ControlFreshnessSealV2Schema,
  CoordinateGraphReportV2Schema,
  ControlQueryEnvelopeV1Schema,
  EvidenceRefV1Schema,
  LevelCoverageV2Schema,
  RefinementCoverageReportV1Schema,
  RefinementRelationV1Schema,
  RelationEndpointV1Schema,
  SealedAttestationIndexV1Schema,
  TraversalReportV2Schema,
  computeAttestationSetHash,
  computeCanonicalProofAttestationDigest,
  computeControlFreshnessSealV2Hash,
  computeRefinementRelationDigest,
  createObservedDiffHunkV1,
  normalizeControlFreshnessSealV1,
  normalizeCoordinateGraphReportV1,
  normalizeTraversalReportV1,
} from "@semantic-context/control-model";
import { OBSERVED_DIFF_HUNK_V1_CONFORMANCE } from "@semantic-context/control-model/test/fixtures/l0-conformance";

describe("issue #26 public contract surface", () => {
  it("exports the frozen v2 schema, hashing, hunk, and migration primitives", () => {
    const publicApi = controlModel as Record<string, unknown>;
    for (const exportName of [
      "AuthoredSemanticNodeV1Schema",
      "RefinementRelationV1Schema",
      "ObservedDiffHunkV1Schema",
      "CoordinateGraphReportV2Schema",
      "TraversalReportV2Schema",
      "RefinementCoverageReportV1Schema",
      "ControlQueryEnvelopeV1Schema",
      "ControlFreshnessSealV2Schema",
      "CanonicalProofAttestationV1Schema",
      "SealedAttestationIndexV1Schema",
      "createObservedDiffHunkV1",
      "computeAttestationSetHash",
      "computeControlFreshnessSealV2Hash",
      "normalizeControlFreshnessSealV1",
      "normalizeCoordinateGraphReportV1",
      "normalizeTraversalReportV1",
      "normalizeTransitionAuthorizationReportV1",
      "normalizeStepAuthorizationReportV1",
      "normalizeDeletionAuthorizationReportV1",
    ]) {
      expect(publicApi[exportName], exportName).toBeDefined();
    }
  });
});

const hashA = `sha256:${"a".repeat(64)}` as const;
const hashB = `sha256:${"b".repeat(64)}` as const;
const digestA = { algorithm: "sha256" as const, value: "a".repeat(64) };
const evidence = {
  schemaVersion: 1 as const,
  kind: "commit" as const,
  locator: "commit:abc123",
  digest: digestA,
};

describe("explicit levels and typed proof-carrying relations", () => {
  it("requires appliesAtLevel without coupling it to kind", () => {
    const base = {
      schemaVersion: 1,
      nodeId: "goal.example",
      kind: "goal",
      appliesAtLevel: 2,
      category: "goal",
      label: "Example",
      epistemicStatus: "human_declared",
    };
    expect(AuthoredSemanticNodeV1Schema.parse(base).appliesAtLevel).toBe(2);
    expect(AuthoredSemanticNodeV1Schema.parse({ ...base, appliesAtLevel: 6 }).kind).toBe("goal");
    expect(AuthoredSemanticNodeV1Schema.safeParse({ ...base, appliesAtLevel: 0 }).success).toBe(false);
    const { appliesAtLevel: _level, ...missing } = base;
    expect(AuthoredSemanticNodeV1Schema.safeParse(missing).success).toBe(false);
  });

  it("accepts only tagged cross-plane endpoints", () => {
    expect(RelationEndpointV1Schema.parse({
      plane: "B", kind: "semantic_node", nodeId: "goal.example",
    })).toEqual({ plane: "B", kind: "semantic_node", nodeId: "goal.example" });
    expect(RelationEndpointV1Schema.parse({
      plane: "A", kind: "observed_diff_hunk", coordinateDigest: hashA,
    }).plane).toBe("A");
    for (const invalid of [
      { kind: "semantic_node", nodeId: "goal.example" },
      { plane: "A", kind: "semantic_node", nodeId: "goal.example" },
      { plane: "B", kind: "observed_diff_hunk", coordinateDigest: hashA },
      { plane: "A", kind: "observed_diff_hunk", coordinateDigest: "sha256:ABC" },
    ]) expect(RelationEndpointV1Schema.safeParse(invalid).success).toBe(false);
  });

  it("requires exact canonical evidence and closed status/provenance", () => {
    const relation = {
      schemaVersion: 1,
      id: "relation.a",
      kind: "decomposes_to",
      source: { plane: "B", kind: "semantic_node", nodeId: "goal.example" },
      target: { plane: "A", kind: "observed_diff_hunk", coordinateDigest: hashA },
      epistemicStatus: "human_declared",
      provenance: "author",
      evidenceRefs: [evidence],
    } as const;
    expect(RefinementRelationV1Schema.parse(relation).kind).toBe("decomposes_to");
    expect(EvidenceRefV1Schema.safeParse({ ...evidence, extra: true }).success).toBe(false);
    expect(RefinementRelationV1Schema.safeParse({ ...relation, evidenceRefs: [] }).success).toBe(false);
    expect(RefinementRelationV1Schema.safeParse({ ...relation, provenance: "alice" }).success).toBe(false);
    expect(RefinementRelationV1Schema.safeParse({ ...relation, epistemicStatus: "verified" }).success).toBe(false);
    expect(RefinementRelationV1Schema.safeParse({
      ...relation, evidenceRefs: [evidence, evidence],
    }).success).toBe(false);
    const relationDigest = computeRefinementRelationDigest(relation);
    expect(relationDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeRefinementRelationDigest({
      ...relation,
      relationDigest,
    })).toBe(relationDigest);
    expect(computeRefinementRelationDigest({
      ...relation,
      target: { plane: "A", kind: "observed_diff_hunk", coordinateDigest: hashB },
    })).not.toBe(relationDigest);
    expect(RefinementRelationV1Schema.safeParse({
      ...relation,
      relationDigest: hashB,
    }).success).toBe(false);
  });
});

describe("observed L0 identity", () => {
  it("matches the normative framed hex and sha256 coordinate", () => {
    expect(OBSERVED_DIFF_HUNK_V1_CONFORMANCE.framedHex)
      .toBe(OBSERVED_DIFF_HUNK_V1_CONFORMANCE.expectedFramedHex);
    expect(OBSERVED_DIFF_HUNK_V1_CONFORMANCE.identity)
      .toBe(OBSERVED_DIFF_HUNK_V1_CONFORMANCE.expectedIdentity);
  });

  it("normalizes only path syntax and preserves raw line endings", () => {
    const slash = createObservedDiffHunkV1({
      ...OBSERVED_DIFF_HUNK_V1_CONFORMANCE.input,
      normalizedPath: "packages\\demo.txt",
    });
    expect(slash.normalizedPath).toBe("packages/demo.txt");
    expect(slash.identity).toBe(OBSERVED_DIFF_HUNK_V1_CONFORMANCE.expectedIdentity);
    const crlf = createObservedDiffHunkV1({
      ...OBSERVED_DIFF_HUNK_V1_CONFORMANCE.input,
      rawHunkBytes: new TextEncoder().encode("@@ -1,2 +1,2 @@\r\n-old\r\n+new\r\n keep\r\n"),
    });
    expect(crlf.identity).not.toBe(slash.identity);
    for (const path of ["", "../demo.txt", "./demo.txt", "/demo.txt", "C:\\demo.txt", "a//b"]) {
      expect(() => createObservedDiffHunkV1({
        ...OBSERVED_DIFF_HUNK_V1_CONFORMANCE.input,
        normalizedPath: path,
      })).toThrow();
    }
  });
});

describe("sealed attestations and freshness v2", () => {
  const canonicalWithoutDigest = {
    schemaVersion: 1 as const,
    id: "attestation.a",
    obligation: "target_reviewed" as const,
    subject: "change.example",
    epistemicStatus: "human_declared" as const,
    references: [{ kind: "architecture" as const, uri: "semctx://decision/a", nonLlm: true }],
    commit: "abc123",
    observedAt: "2026-07-23T00:00:00.000Z",
    expiresAt: "2026-07-24T00:00:00.000Z",
  };
  const attestation = {
    ...canonicalWithoutDigest,
    attestationDigest: computeCanonicalProofAttestationDigest(canonicalWithoutDigest),
  };

  it("matches the normative attestation set vector", () => {
    expect(computeAttestationSetHash([
      `sha256:${"0".repeat(63)}1`,
      `sha256:${"0".repeat(63)}2`,
    ])).toBe("sha256:bb00beacebd86beaf26d13bac8a5fc19a958dce6b88e4943a1c5e702225e69fa");
  });

  it("commits every canonical proof field and rejects a stale digest", () => {
    expect(CanonicalProofAttestationV1Schema.parse(attestation)).toEqual(attestation);
    expect(CanonicalProofAttestationV1Schema.safeParse({
      ...attestation, subject: "change.other",
    }).success).toBe(false);
    expect(computeCanonicalProofAttestationDigest({
      ...canonicalWithoutDigest, commit: "def456",
    })).not.toBe(attestation.attestationDigest);
  });

  it("requires the sealed index hash to match its canonical digest membership", () => {
    const index = {
      schemaVersion: 1,
      entries: [attestation],
      attestationSetHash: computeAttestationSetHash([attestation.attestationDigest]),
    };
    expect(SealedAttestationIndexV1Schema.safeParse(index).success).toBe(true);
    expect(SealedAttestationIndexV1Schema.safeParse({
      ...index, attestationSetHash: hashB,
    }).success).toBe(false);
  });

  it("normalizes v1 freshness without fabricating attestation binding", () => {
    const legacy = {
      sealSchemaVersion: 1 as const,
      kind: "control_freshness_seal" as const,
      algorithm: "sha256-v1" as const,
      repositoryRoot: "C:\\repo",
      indexedRepositoryRoot: "C:\\repo",
      headAtCapture: "abc123",
      indexedHeadCommit: "abc123",
      repositoryGraphHash: hashA,
      indexedRepositoryGraphHash: hashA,
      semanticModelHash: hashA,
      indexedSemanticModelHash: hashA,
      analysisInputHash: hashA,
      indexedAnalysisInputHash: hashA,
      workingDiffHash: hashA,
      indexedWorkingDiffHash: hashA,
      indexedAt: "2026-07-23T00:00:00.000Z",
      storeSchemaVersion: 1,
      indexedStoreSchemaVersion: 1,
      toolVersion: "semctx@1",
      indexedToolVersion: "semctx@1",
      sealHash: hashB,
    };
    const normalized = normalizeControlFreshnessSealV1(legacy);
    expect(normalized.value.sealSchemaVersion).toBe(2);
    expect(normalized.value.attestationSetHash).toBeNull();
    expect(normalized.compatibility.legacySealHash).toBe(hashB);
    expect(ControlFreshnessSealV2Schema.safeParse(normalized.value).success).toBe(true);
    const { sealHash: _sealHash, ...payload } = normalized.value;
    expect(computeControlFreshnessSealV2Hash(payload)).toBe(normalized.value.sealHash);
  });
});

describe("legacy normalizers preserve uncertainty", () => {
  it("does not promote legacy node levels or bare edges into certifying refinement", () => {
    const legacy = {
      schemaVersion: 1 as const,
      nodes: [{
        id: "semantic:goal.example" as const,
        plane: "semantic" as const,
        sourceId: "goal.example",
        sourceKind: "goal",
        level: 5 as const,
        category: "goal" as const,
        label: "Goal",
        epistemicStatus: "human_declared" as const,
        references: [],
      }],
      edges: [{
        from: "semantic:goal.example" as const,
        to: "repo:symbol.x" as const,
        relation: "supports",
        evidenceRefs: [],
      }],
      mapping: [],
      coverage: [],
      unsupported: [],
      unmapped: [],
    };
    const normalized = normalizeCoordinateGraphReportV1(legacy).value;
    expect(normalized.nodes[0]?.appliesAtLevel).toBeNull();
    expect(normalized.refinementRelations).toEqual([]);
    expect(normalized.structuralEdges).toHaveLength(1);
    expect(normalized.verifiedEvidenceDigests).toEqual([]);
  });

  it("does not certify legacy traversal paths", () => {
    const normalized = normalizeTraversalReportV1({
      schemaVersion: 1,
      direction: "lift",
      sourceId: "repo:x",
      targetLevel: 6,
      maxDepth: 5,
      maxResults: 10,
      maxExpansions: 100,
      maxQueue: 50,
      paths: [{
        nodes: ["repo:x", "semantic:goal.x"],
        edges: [{ from: "repo:x", to: "semantic:goal.x", relation: "supports", evidenceRefs: [] }],
      }],
      truncated: false,
    }).value;
    expect(normalized.paths).toEqual([]);
    expect(normalized.terminalStatus).toBe("empty");
    expect(normalized.reasonCode).toBe("REFINEMENT_DISCONNECTED");
  });
});

describe("terminal status and reason coherence", () => {
  const traversalBase = {
    schemaVersion: 2 as const,
    direction: "lift" as const,
    sourceId: "repo:x" as const,
    targetLevel: 6 as const,
    visitedCoordinateIds: [],
    paths: [],
    governingConstraints: [],
    proofs: [],
    advisoryRelations: [],
    budget: { limit: 1, consumed: 0, remaining: 1, truncated: false },
    compatibilityNormalization: [],
  };
  const coverageBase = {
    schemaVersion: 1 as const,
    rootCoordinate: "repo:x" as const,
    sourceSeal: hashA,
    indexSeal: hashA,
    direction: "lift" as const,
    levelSpan: { from: 1 as const, to: 6 as const },
    visitedCoordinates: [],
    loadBearingSteps: [],
    advisorySteps: [],
    governingConstraints: [],
    proofs: [],
    coveredLevels: [],
    missingLevels: [1, 2, 3, 4, 5, 6],
    loadBearingEvidence: [],
    proofReferences: [],
    budget: { limit: 1, consumed: 0, remaining: 1, truncated: false },
    compatibilityNormalization: [],
  };

  it("enforces the exact traversal and coverage terminal/reason matrix", () => {
    for (const schema of [TraversalReportV2Schema, RefinementCoverageReportV1Schema]) {
      const base = schema === TraversalReportV2Schema ? traversalBase : coverageBase;
      for (const valid of [
        { terminalStatus: "success" },
        { terminalStatus: "budget_exhausted", reasonCode: "BUDGET_EXHAUSTED" },
        { terminalStatus: "refused", reasonCode: "INDEX_STALE" },
        { terminalStatus: "empty", reasonCode: "COORDINATE_UNKNOWN" },
        { terminalStatus: "empty", reasonCode: "MAPPING_MISSING" },
        { terminalStatus: "empty", reasonCode: "REFINEMENT_DISCONNECTED" },
      ]) expect(schema.safeParse({ ...base, ...valid }).success).toBe(true);

      for (const invalid of [
        { terminalStatus: "success", reasonCode: "COORDINATE_UNKNOWN" },
        { terminalStatus: "budget_exhausted", reasonCode: "REFINEMENT_DISCONNECTED" },
        { terminalStatus: "refused", reasonCode: "MAPPING_MISSING" },
        { terminalStatus: "refused", reasonCode: "PLANNING_COMMIT_MISMATCH" },
        { terminalStatus: "empty", reasonCode: "INDEX_STALE" },
        { terminalStatus: "empty", reasonCode: "BUDGET_EXHAUSTED" },
      ]) expect(schema.safeParse({ ...base, ...invalid }).success).toBe(false);
    }
  });

  it("requires traversal envelope status and reasons to equal its payload", () => {
    const payload = {
      ...traversalBase,
      terminalStatus: "empty" as const,
      reasonCode: "COORDINATE_UNKNOWN" as const,
    };
    const envelope = {
      schemaVersion: 1,
      kind: "traversal",
      freshness: { verdict: "FRESH", reasons: [], seal: null },
      terminalStatus: "empty",
      reasonCodes: ["COORDINATE_UNKNOWN"],
      payload,
    };
    expect(ControlQueryEnvelopeV1Schema.safeParse(envelope).success).toBe(true);
    expect(ControlQueryEnvelopeV1Schema.safeParse({
      ...envelope, terminalStatus: "refused",
    }).success).toBe(false);
    expect(ControlQueryEnvelopeV1Schema.safeParse({
      ...envelope, reasonCodes: ["MAPPING_MISSING"],
    }).success).toBe(false);
  });

  it("requires coverage envelope status and reasons to equal its payload", () => {
    const payload = {
      ...coverageBase,
      terminalStatus: "budget_exhausted" as const,
      reasonCode: "BUDGET_EXHAUSTED" as const,
    };
    const envelope = {
      schemaVersion: 1,
      kind: "refinement_coverage",
      freshness: { verdict: "FRESH", reasons: [], seal: null },
      terminalStatus: "budget_exhausted",
      reasonCodes: ["BUDGET_EXHAUSTED"],
      payload,
    };
    expect(ControlQueryEnvelopeV1Schema.safeParse(envelope).success).toBe(true);
    expect(ControlQueryEnvelopeV1Schema.safeParse({
      ...envelope, terminalStatus: "empty", reasonCodes: ["BUDGET_EXHAUSTED"],
    }).success).toBe(false);
  });

  it("uses the declared canonical reason order without constraining authorization payload rules", () => {
    const envelope = {
      schemaVersion: 1,
      kind: "authorize_transition",
      freshness: { verdict: "FRESH", reasons: [], seal: null },
      terminalStatus: "refused",
      reasonCodes: ["PLANNING_COMMIT_MISMATCH", "ATTESTATION_UNBOUND"],
      payload: null,
    };
    expect(ControlQueryEnvelopeV1Schema.safeParse(envelope).success).toBe(true);
    expect(ControlQueryEnvelopeV1Schema.safeParse({
      ...envelope,
      reasonCodes: [...envelope.reasonCodes].reverse(),
    }).success).toBe(false);
  });
});

describe("coordinate graph verified evidence binding", () => {
  const report = {
    schemaVersion: 2,
    nodes: [],
    structuralEdges: [],
    refinementRelations: [],
    verifiedEvidenceDigests: [hashA, hashB],
    mapping: [],
    coverage: [],
    unsupported: [],
    unmapped: [],
    staleLinks: [],
    danglingReferences: [],
    compatibilityNormalization: [],
  };

  it("requires verified evidence digests in canonical unique order", () => {
    expect(CoordinateGraphReportV2Schema.safeParse(report).success).toBe(true);
    expect(CoordinateGraphReportV2Schema.safeParse({
      ...report, verifiedEvidenceDigests: [hashB, hashA],
    }).success).toBe(false);
    expect(CoordinateGraphReportV2Schema.safeParse({
      ...report, verifiedEvidenceDigests: [hashA, hashA],
    }).success).toBe(false);
    const { verifiedEvidenceDigests: _digests, ...missing } = report;
    expect(CoordinateGraphReportV2Schema.safeParse(missing).success).toBe(false);
  });

  it("represents L0 sha256 coordinates in v2 coverage only", () => {
    const l0Coverage = {
      level: 0,
      categories: ["code_entity", "syntax"],
      coordinateIds: [hashA, hashB],
    };
    expect(LevelCoverageV2Schema.safeParse(l0Coverage).success).toBe(true);
    expect(CoordinateGraphReportV2Schema.safeParse({
      ...report, coverage: [l0Coverage],
    }).success).toBe(true);
    expect(LevelCoverageV2Schema.safeParse({
      ...l0Coverage, coordinateIds: [hashB, hashA],
    }).success).toBe(false);
    expect(LevelCoverageV2Schema.safeParse({
      ...l0Coverage, coordinateIds: [hashA, hashA],
    }).success).toBe(false);
    expect(LevelCoverageV2Schema.safeParse({
      ...l0Coverage, categories: ["syntax", "code_entity"],
    }).success).toBe(false);
  });
});
