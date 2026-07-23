import { describe, expect, it } from "bun:test";
import {
  ArchitectureComparisonReportSchema,
  ArchitectureDeltaSchema,
  ArchitectureSnapshotSchema,
  CLEAN_CONTROL_WORKING_DIFF_HASH,
  CoordinateGraphReportSchema,
  ControlFreshnessSealSchema,
  DELETION_PREREQUISITE_OBLIGATIONS,
  EPISTEMIC_STATUSES,
  MIGRATION_STATES,
  NORMATIVE_LEVEL_MAPPING,
  PROOF_OBLIGATIONS,
  PROOF_SUFFICIENCY_MATRIX,
  PublicControlReportSchema,
  QualifiedCoordinateIdSchema,
  REPOSITORY_LEVEL_MAPPING,
  SEMANTIC_LEVEL_MAPPING,
  SemanticLevelSchema,
  MigrationPlanReportSchema,
  SourceKindLevelMappingSchema,
  serializeControlReport,
  compareCodeUnits,
} from "@semantic-context/control-model";

const timestamp = "2026-07-19T12:00:00.000Z";
const current = {
  id: "snapshot.current",
  commit: "abc123",
  capturedAt: timestamp,
  elements: [],
  relations: [],
};
const target = { ...current, id: "snapshot.target" };
const delta = {
  currentSnapshotId: current.id,
  targetSnapshotId: target.id,
  added: [],
  removed: [],
  changed: [],
  addedRelations: [],
  removedRelations: [],
  changedRelations: [],
  changedInvariantIds: [],
};
const hash = `sha256:${"a".repeat(64)}`;
const freshnessSeal = {
  sealSchemaVersion: 1 as const,
  kind: "control_freshness_seal" as const,
  algorithm: "sha256-v1" as const,
  repositoryRoot: "C:\\work\\repository",
  indexedRepositoryRoot: null,
  headAtCapture: "abc123",
  indexedHeadCommit: null,
  repositoryGraphHash: hash,
  indexedRepositoryGraphHash: null,
  semanticModelHash: hash,
  indexedSemanticModelHash: null,
  analysisInputHash: hash,
  indexedAnalysisInputHash: null,
  workingDiffHash: hash,
  indexedWorkingDiffHash: null,
  indexedAt: null,
  storeSchemaVersion: 1,
  indexedStoreSchemaVersion: null,
  toolVersion: "@semantic-context/app-services@0.1.8",
  indexedToolVersion: null,
  sealHash: hash,
};

describe("Plane C closed vocabularies", () => {
  it("accepts exactly integer semantic levels L0 through L6", () => {
    for (let level = 0; level <= 6; level += 1) expect(SemanticLevelSchema.parse(level)).toBe(level);
    for (const invalid of [-1, 7, 1.5, "1", null]) expect(SemanticLevelSchema.safeParse(invalid).success).toBe(false);
  });

  it("requires plane-qualified coordinate ids", () => {
    expect(QualifiedCoordinateIdSchema.parse("repo:sym:function:x")).toBe("repo:sym:function:x");
    expect(QualifiedCoordinateIdSchema.parse("semantic:goal.checkout")).toBe("semantic:goal.checkout");
    for (const invalid of ["goal.checkout", "repo:", "semantic:", "other:x"]) {
      expect(QualifiedCoordinateIdSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("keeps the migration state machine, risk evidence vocabulary, and obligations closed", () => {
    expect(MIGRATION_STATES).toEqual([
      "OBSERVED", "MODELED", "TARGET_PROPOSED", "PROOFS_DEFINED", "PARALLEL_IMPLEMENTATION",
      "SHADOW_VALIDATED", "CUTOVER", "LEGACY_REMOVABLE", "DELETED",
    ]);
    expect(EPISTEMIC_STATUSES).toEqual([
      "human_declared", "statically_observed", "dynamically_observed", "test_observed",
      "historically_observed", "llm_inferred", "hypothetical",
    ]);
    expect(PROOF_OBLIGATIONS).toHaveLength(13);
    expect(new Set(PROOF_OBLIGATIONS).size).toBe(PROOF_OBLIGATIONS.length);
  });
});

describe("normative level mapping", () => {
  it("covers every current repository kind and explicitly leaves L0 unavailable", () => {
    expect(REPOSITORY_LEVEL_MAPPING.map((entry) => entry.sourceKind)).toEqual([
      "bounded_context", "capability", "class", "contract", "decision", "document", "enum",
      "external_integration", "function", "interface", "invariant", "migration", "module", "package",
      "repository", "risk", "symbol", "test", "type",
    ]);
    expect(REPOSITORY_LEVEL_MAPPING.every((entry) => entry.supported && entry.level !== null)).toBe(true);
    expect(NORMATIVE_LEVEL_MAPPING.some((entry) => entry.level === 0)).toBe(false);
  });

  it("maps only semantic goals, decisions, and invariants", () => {
    const supported = SEMANTIC_LEVEL_MAPPING.filter((entry) => entry.supported);
    expect(supported.map((entry) => [entry.sourceKind, entry.level])).toEqual([
      ["decision", 5], ["goal", 5], ["invariant", 4],
    ]);
    expect(SEMANTIC_LEVEL_MAPPING.filter((entry) => !entry.supported).map((entry) => entry.sourceKind)).toEqual([
      "assumption", "change", "evidence", "unknown",
    ]);
  });

  it("rejects implicit levels for unsupported mappings", () => {
    expect(SourceKindLevelMappingSchema.safeParse({
      plane: "semantic", sourceKind: "unknown", level: 4, category: "invariant", supported: false,
    }).success).toBe(false);
  });
});

describe("proof matrix", () => {
  it("never admits LLM or hypothetical evidence as sufficient", () => {
    for (const policy of Object.values(PROOF_SUFFICIENCY_MATRIX)) {
      for (const clause of policy.allOf) {
        expect(clause.statuses).not.toContain("llm_inferred");
        expect(clause.statuses).not.toContain("hypothetical");
      }
    }
  });

  it("models composite and deletion requirements explicitly", () => {
    expect(PROOF_SUFFICIENCY_MATRIX.shadow_equivalent.allOf.map((clause) => clause.statuses)).toEqual([
      ["test_observed"], ["dynamically_observed"],
    ]);
    expect(PROOF_SUFFICIENCY_MATRIX.target_reviewed.allOf[0]).toEqual({
      statuses: ["human_declared"], referenceKinds: ["architecture"], requireNonLlmReference: true,
    });
    expect(PROOF_SUFFICIENCY_MATRIX.deletion_approved.prerequisiteObligations).toEqual([
      ...DELETION_PREREQUISITE_OBLIGATIONS,
    ]);
  });
});

describe("external report schemas", () => {
  const coordinateReport = {
    schemaVersion: 1,
    nodes: [],
    edges: [],
    mapping: [...NORMATIVE_LEVEL_MAPPING],
    coverage: Array.from({ length: 7 }, (_, level) => ({ level, categories: [], coordinateIds: [] })),
    unsupported: [],
    unmapped: [],
    staleLinks: [],
    danglingReferences: [],
  };

  const traversalReport = {
    schemaVersion: 1 as const,
    direction: "lift" as const,
    sourceId: "repo:x",
    targetLevel: 2,
    maxDepth: 3,
    maxResults: 10,
    maxExpansions: 100,
    maxQueue: 50,
    paths: [],
    truncated: false,
  };

  const migrationPlanReport = {
    schemaVersion: 1 as const,
    plan: {
      id: "plan:change.x", changeId: "change.x", planningCommit: current.commit, status: "BLOCKED" as const,
      blockedReason: "target_architecture_missing" as const,
      blockedDetails: [{ schemaVersion: 1 as const, reason: "target_architecture_missing" as const, subjectIds: [], message: "target required" }],
      planningContext: { id: "change.x", serves: [], preserves: [], requiredEvidence: [], openUnknowns: [] },
      current, steps: [], outstandingObligations: ["target_reviewed" as const],
    },
  };

  it("validates the strict control freshness seal contract", () => {
    expect(ControlFreshnessSealSchema.parse(freshnessSeal)).toEqual(freshnessSeal);
    for (const field of [
      "repositoryGraphHash",
      "indexedRepositoryGraphHash",
      "semanticModelHash",
      "workingDiffHash",
      "sealHash",
    ] as const) {
      for (const malformed of [
        "sha256:abc",
        `sha256:${"A".repeat(64)}`,
        `sha512:${"a".repeat(64)}`,
      ]) {
        expect(ControlFreshnessSealSchema.safeParse({ ...freshnessSeal, [field]: malformed }).success).toBe(false);
      }
    }
    expect(ControlFreshnessSealSchema.safeParse({ ...freshnessSeal, algorithm: "sha512" }).success).toBe(false);
    expect(ControlFreshnessSealSchema.safeParse({ ...freshnessSeal, sealSchemaVersion: 2 }).success).toBe(false);
    expect(ControlFreshnessSealSchema.safeParse({ ...freshnessSeal, verdict: "FRESH" }).success).toBe(false);
  });

  it("accepts additive freshness seals on traversal and migration plan reports", () => {
    expect(PublicControlReportSchema.safeParse({ ...traversalReport, freshnessSeal }).success).toBe(true);
    expect(MigrationPlanReportSchema.safeParse({ ...migrationPlanReport, freshnessSeal }).success).toBe(true);
    expect(PublicControlReportSchema.safeParse({ ...migrationPlanReport, freshnessSeal }).success).toBe(true);
  });

  it("accepts fail-closed freshness blockers on migration plans", () => {
    const report = {
      ...migrationPlanReport,
      plan: {
        ...migrationPlanReport.plan,
        blockedReason: "control_inputs_stale",
        blockedDetails: [{
          schemaVersion: 1,
          reason: "control_inputs_stale",
          subjectIds: ["ANALYSIS_INPUT_MISMATCH"],
          message: "Control inputs are stale.",
        }],
        outstandingObligations: [],
      },
    };
    expect(MigrationPlanReportSchema.safeParse(report).success).toBe(true);
  });

  it("accepts a separate explicit freshness status report", () => {
    const sealed = {
      ...freshnessSeal,
      indexedRepositoryRoot: freshnessSeal.repositoryRoot,
      indexedHeadCommit: freshnessSeal.headAtCapture,
      indexedRepositoryGraphHash: freshnessSeal.repositoryGraphHash,
      indexedSemanticModelHash: freshnessSeal.semanticModelHash,
      indexedAnalysisInputHash: freshnessSeal.analysisInputHash,
      workingDiffHash: CLEAN_CONTROL_WORKING_DIFF_HASH,
      indexedWorkingDiffHash: CLEAN_CONTROL_WORKING_DIFF_HASH,
      indexedAt: timestamp,
      indexedStoreSchemaVersion: freshnessSeal.storeSchemaVersion,
      indexedToolVersion: freshnessSeal.toolVersion,
    };
    const report = {
      schemaVersion: 1,
      kind: "control_freshness_status",
      basis: "control_index_snapshot_v1",
      verdict: "FRESH",
      canRunHighRiskControl: true,
      reasons: [],
      freshnessSeal: sealed,
    };

    expect(PublicControlReportSchema.safeParse(report).success).toBe(true);
    expect(PublicControlReportSchema.safeParse({
      ...report,
      verdict: "UNSEALED",
      canRunHighRiskControl: false,
      reasons: ["REPOSITORY_NOT_INITIALIZED"],
      freshnessSeal: null,
    }).success).toBe(true);
    expect(PublicControlReportSchema.safeParse({
      ...report,
      verdict: "DIRTY_KNOWN",
      reasons: ["HEAD_MISMATCH"],
    }).success).toBe(false);
    expect(PublicControlReportSchema.safeParse({
      ...report,
      verdict: "STALE",
      canRunHighRiskControl: false,
      reasons: ["HEAD_MISMATCH", "HEAD_MISMATCH"],
    }).success).toBe(false);
    expect(PublicControlReportSchema.safeParse({
      ...report,
      freshnessSeal: { ...sealed, indexedHeadCommit: "def456" },
    }).success).toBe(false);
    expect(PublicControlReportSchema.safeParse({
      ...report,
      verdict: "DIRTY_KNOWN",
      reasons: ["WORKING_TREE_DIRTY"],
    }).success).toBe(false);
  });

  it("validates a coordinate report with explicit L0-L6 coverage", () => {
    expect(CoordinateGraphReportSchema.parse(coordinateReport).coverage).toHaveLength(7);
    const { staleLinks: _staleLinks, danglingReferences: _danglingReferences, ...legacyReport } = coordinateReport;
    expect(CoordinateGraphReportSchema.safeParse(legacyReport).success).toBe(true);
    expect(CoordinateGraphReportSchema.safeParse({ ...coordinateReport, schemaVersion: 2 }).success).toBe(false);
  });

  it("validates versioned architecture comparisons", () => {
    const report = { schemaVersion: 1 as const, current, target, delta };
    expect(ArchitectureComparisonReportSchema.parse(report)).toEqual(report);
    expect(PublicControlReportSchema.safeParse(report).success).toBe(true);
  });

  it("rejects duplicate and dangling architecture identities", () => {
    const element = { id: "repo:a", level: 1, category: "code_entity", fingerprint: "a" };
    expect(ArchitectureSnapshotSchema.safeParse({ ...current, elements: [element, element], relations: [] }).success).toBe(false);
    expect(ArchitectureSnapshotSchema.safeParse({ ...current, elements: [element], relations: [{ from: "repo:a", to: "repo:missing", relation: "uses", fingerprint: "r" }] }).success).toBe(false);
    const relation = { from: "repo:a", to: "repo:a", relation: "uses", fingerprint: "r" };
    expect(ArchitectureSnapshotSchema.safeParse({ ...current, elements: [element], relations: [relation, relation] }).success).toBe(false);
  });

  it("rejects duplicate delta element and relation keys regardless of ordering", () => {
    const item = { id: "repo:a", level: 1, category: "code_entity", fingerprint: "a" };
    expect(ArchitectureDeltaSchema.safeParse({ ...delta, added: [item], removed: [item] }).success).toBe(false);
    const relation = { from: "repo:a", to: "repo:b", relation: "uses", fingerprint: "r" };
    expect(ArchitectureDeltaSchema.safeParse({ ...delta, addedRelations: [relation], removedRelations: [relation] }).success).toBe(false);
  });

  it("requires schemaVersion 1 on every public report kind", () => {
    const reports = [
      coordinateReport,
      traversalReport,
      { schemaVersion: 1, sourceIds: ["repo:x"], maxDepth: 3, maxResults: 10, maxExpansions: 100, maxQueue: 50, affected: [], truncated: false },
      { schemaVersion: 1, sourceId: "repo:x", maxDepth: 3, maxResults: 10, maxExpansions: 100, maxQueue: 50, known: false, rationaleIds: [], paths: [], unknownReason: "rationale_not_authored" },
      { schemaVersion: 1, current, target, delta },
      migrationPlanReport,
      {
        schemaVersion: 1, decision: "DENY", fromState: "OBSERVED", toState: "TARGET_PROPOSED", risk: "R0",
        reasons: ["transition_not_adjacent"], proofEvaluations: [], details: [],
      },
      { schemaVersion: 1, decision: "DENY", stepId: "step.x", reasons: ["proof_missing"], missingDependencies: [], proofEvaluations: [], details: [] },
      { schemaVersion: 1, decision: "DENY", subject: "legacy:x", reasons: ["proof_missing"], proofEvaluations: [], details: [] },
    ];

    expect(reports).toHaveLength(9);
    for (const report of reports) {
      expect(PublicControlReportSchema.safeParse(report).success).toBe(true);
      expect(PublicControlReportSchema.safeParse({ ...report, schemaVersion: 2 }).success).toBe(false);
    }
  });

  it("rejects malformed public payloads", () => {
    expect(PublicControlReportSchema.safeParse({ schemaVersion: 1, arbitrary: true }).success).toBe(false);
  });

  it("serializes deterministically regardless of object insertion order", () => {
    const left = { schemaVersion: 1, payload: { z: 1, a: [{ y: 2, b: 3 }] } };
    const right = { payload: { a: [{ b: 3, y: 2 }], z: 1 }, schemaVersion: 1 };
    expect(serializeControlReport(left)).toBe(serializeControlReport(right));
    expect(serializeControlReport(left)).toBe('{"payload":{"a":[{"b":3,"y":2}],"z":1},"schemaVersion":1}');
  });

  it("uses locale-independent UTF-16 code-unit ordering", () => {
    expect(["é", "a", "!", "A"].sort(compareCodeUnits)).toEqual(["!", "A", "a", "é"]);
    expect(serializeControlReport({ é: 1, a: 2, "!": 3, A: 4 })).toBe('{"!":3,"A":4,"a":2,"é":1}');
  });
});
