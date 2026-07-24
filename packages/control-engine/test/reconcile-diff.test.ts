import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  PlanningBundleV1Schema,
  ReconcileDiffReportV1Schema,
  ReconciliationAnalysisV1Schema,
  computeObservationAnalysisV1Hash,
  computePlanningBundleV1Hash,
  computeReconciliationAnalysisV1Hash,
  computeReconciliationArchitectureDeltaV1Hash,
  computeReconciliationObservedDiffV1Hash,
  computeSemanticChangeSetV1Hash,
  computeTaskFrameSnapshotV1Hash,
  computeTaskEnvelopeV1Hash,
  createObservedDiffHunkV1,
  normalizeObservationAnalysisV1,
  normalizePlanningBundleV1,
  normalizeReconciliationAnalysisV1,
  normalizeSemanticChangeSetV1,
  normalizeTaskEnvelopeV1,
  type ObservationAnalysisV1,
  type PlanningBundleV1,
  type ReconciliationAnalysisV1,
  type ReconciliationReasonCodeV1,
  type RepositoryEditExpectationV1,
  type SemanticChangeSetV1,
  type SemanticExpectationV1,
  type TaskEnvelopeV1,
} from "@semantic-context/control-model/reconciliation";
import { fingerprintCoordinateGraph } from "../src/architecture";
import {
  reconcileDiff,
  type ReconcileDiffInputV1,
} from "../src/reconciliation";

describe("reconcileDiff", () => {
  test("reports REALIZED only for a fully sealed, exactly accounted modification", () => {
    const report = reconcileDiff(makeInput({ profile: "local_patch" }));
    expect(report.terminalStatus).toBe("REALIZED");
    expect(report.reasonCodes).toEqual([]);
    expect(report.matchedPlannedEdits).toEqual([{
      editId: "edit.modify",
      observedHunkIds: [makeHunk().identity],
    }]);
    expect(ReconcileDiffReportV1Schema.safeParse(report).success).toBe(true);
  });

  test("refuses hash drift before analysis with canonical precedence", () => {
    const input = makeInput();
    input.planningBundle = {
      ...input.planningBundle,
      taskEnvelope: {
        ...input.planningBundle.taskEnvelope,
        envelopeHash: hash("9"),
      },
      semanticChangeSet: {
        ...input.planningBundle.semanticChangeSet,
        changeSetHash: hash("8"),
      },
    };
    const report = reconcileDiff(input);
    expect(report).toMatchObject({
      terminalStatus: "REFUSED",
      primaryReason: "ENVELOPE_HASH_MISMATCH",
      reasonCodes: ["ENVELOPE_HASH_MISMATCH", "CHANGE_SET_HASH_MISMATCH"],
      matchedPlannedEdits: [],
      evidenceEvaluations: [],
    });
  });

  test("orders planning, target, source, index, seal and attestation refusals", () => {
    const target = {
      schemaVersion: 1 as const,
      targetId: "target.one",
      revision: 1,
      artifactHash: hash("7"),
    };
    const input = makeInput({ target });
    input.capture = {
      ...input.capture,
      observedCommit: "moved",
      currentHead: "moved",
      indexCommit: "moved",
      baselineSealHash: hash("6"),
      sourceSealMatched: false,
      indexFresh: false,
      controlInputsSealed: false,
      candidateBytesStable: false,
    };
    updateSealedAnalysis(input, (analysis) => {
      analysis.targetAnalysis = {
        targetRef: {
          schemaVersion: 1,
          targetId: "target.other",
          revision: 2,
          artifactHash: hash("5"),
        },
        normativeStatus: "proposed",
        reviewAttestationDigests: [],
        findings: [],
      };
    });
    expect(reconcileDiff(input).reasonCodes).toEqual([
      "PLANNING_COMMIT_MISMATCH",
      "TARGET_REVISION_MISMATCH",
      "SOURCE_SEAL_MISMATCH",
      "INDEX_STALE",
      "CONTROL_INPUTS_UNSEALED",
      "ATTESTATION_UNBOUND",
    ]);
  });

  test("distinguishes scope escape, missing edit, and an unplanned in-scope hunk", () => {
    const escaped = makeInput({ hunkPath: "src/outside.ts", bindingCoordinates: [] });
    expect(reconcileDiff(escaped)).toMatchObject({
      terminalStatus: "VIOLATED",
      reasonCodes: ["SCOPE_ESCAPE", "MISSING_PLANNED_EDIT"],
    });

    const unexpected = makeInput({
      edits: [{
        ...modifyEdit(),
        editId: "edit.expected-other",
        oldRange: { start: 99, lines: 1 },
      }],
    });
    expect(reconcileDiff(unexpected)).toMatchObject({
      terminalStatus: "VIOLATED",
      reasonCodes: ["MISSING_PLANNED_EDIT", "UNPLANNED_COORDINATE"],
    });
  });

  test("never hides surplus coordinates behind an otherwise matching edit", () => {
    const extraCoordinate = "repo:src/feature.ts#extra" as const;
    const exact = reconcileDiff(makeInput({
      bindingCoordinates: [coordinate, extraCoordinate],
    }));
    expect(exact.terminalStatus).toBe("VIOLATED");
    expect(exact.reasonCodes).toContain("UNPLANNED_COORDINATE");
    expect(exact.unplannedCoordinateIds).toContain(extraCoordinate);

    const fileScoped = reconcileDiff(makeInput({
      scope: {
        kind: "file",
        bindingId: "binding.feature",
        path: "src/feature.ts",
      },
      bindingCoordinates: [coordinate, extraCoordinate],
    }));
    expect(fileScoped.terminalStatus).toBe("VIOLATED");
    expect(fileScoped.reasonCodes).toEqual(["UNPLANNED_COORDINATE"]);
    expect(fileScoped.matchedPlannedEdits.map((match) => match.editId)).toEqual(["edit.modify"]);
    expect(fileScoped.unplannedCoordinateIds).toEqual([extraCoordinate]);
  });

  test("never substitutes add, delete, or ambiguous rename for modify", () => {
    for (const blobs of [
      { oldBlobId: null, newBlobId: "new" },
      { oldBlobId: "old", newBlobId: null },
    ]) {
      const input = makeInput({ hunkBlobs: blobs });
      const report = reconcileDiff(input);
      expect(report.terminalStatus).toBe("VIOLATED");
      expect(report.reasonCodes).toContain("MISSING_PLANNED_EDIT");
      expect(report.reasonCodes).toContain("UNPLANNED_COORDINATE");
    }

    const rename = makeInput({
      edits: [{
        schemaVersion: 1,
        editId: "edit.rename",
        kind: "rename",
        required: true,
        oldPath: "src/feature.ts",
        newPath: "src/renamed.ts",
        coordinateIds: [coordinate],
        expectedLiftedExpectationIds: [],
        acceptanceEvidenceIds: [],
      }],
      scope: {
        kind: "coordinate_set",
        bindingIds: ["binding.destination", "binding.feature"],
        coordinateIds: [coordinate],
      },
      hunks: [
        makeHunk("src/feature.ts", { oldBlobId: "old", newBlobId: null }),
        makeHunk("src/renamed.ts", { oldBlobId: null, newBlobId: "new" }),
      ],
      observationChanges: [
        {
          kind: "delete",
          oldPath: "src/feature.ts",
          oldSourceDigest: hash("1"),
        },
        {
          kind: "add",
          newPath: "src/renamed.ts",
          newSourceDigest: hash("1"),
        },
      ],
    });
    const report = reconcileDiff(rename);
    expect(report.terminalStatus).toBe("VIOLATED");
    expect(report.advisoryDiagnostics.map((item) => item.code)).toContain("AMBIGUOUS_STEP_MATCH");
  });

  test("matches add, delete, and an explicit rename only against their own kinds", () => {
    const add = makeInput({
      scope: { kind: "file", bindingId: "binding.feature", path: "src/feature.ts" },
      edits: [{
        schemaVersion: 1,
        editId: "edit.add",
        kind: "add",
        required: true,
        newPath: "src/feature.ts",
        expectedLiftedExpectationIds: [],
        acceptanceEvidenceIds: [],
      }],
      hunkBlobs: { oldBlobId: null, newBlobId: "new" },
    });
    expect(reconcileDiff(add).terminalStatus).toBe("REALIZED");

    const deletion = makeInput({
      edits: [{
        schemaVersion: 1,
        editId: "edit.delete",
        kind: "delete",
        required: true,
        oldPath: "src/feature.ts",
        coordinateIds: [coordinate],
        expectedLiftedExpectationIds: [],
        acceptanceEvidenceIds: [],
      }],
      hunkBlobs: { oldBlobId: "old", newBlobId: null },
    });
    expect(reconcileDiff(deletion).terminalStatus).toBe("REALIZED");

    const rename = makeInput({
      scope: {
        kind: "coordinate_set",
        bindingIds: ["binding.destination", "binding.feature"],
        coordinateIds: [coordinate],
      },
      edits: [{
        schemaVersion: 1,
        editId: "edit.rename",
        kind: "rename",
        required: true,
        oldPath: "src/feature.ts",
        newPath: "src/renamed.ts",
        coordinateIds: [coordinate],
        expectedLiftedExpectationIds: [],
        acceptanceEvidenceIds: [],
      }],
      hunks: [
        makeHunk("src/feature.ts", { oldBlobId: "old", newBlobId: null }),
        makeHunk("src/renamed.ts", { oldBlobId: null, newBlobId: "new" }),
      ],
      observationChanges: [renameChange("src/feature.ts", "src/renamed.ts")],
    });
    expect(reconcileDiff(rename).terminalStatus).toBe("REALIZED");

    const oneSidedRename = makeInput({
      scope: {
        kind: "coordinate_set",
        bindingIds: ["binding.destination", "binding.feature"],
        coordinateIds: [coordinate],
      },
      edits: rename.planningBundle.semanticChangeSet.repositoryEditExpectations,
      hunks: [makeHunk("src/feature.ts", { oldBlobId: "old", newBlobId: null })],
      observationChanges: [renameChange("src/feature.ts", "src/renamed.ts")],
    });
    expect(reconcileDiff(oneSidedRename)).toMatchObject({
      terminalStatus: "VIOLATED",
      reasonCodes: ["MISSING_PLANNED_EDIT", "UNPLANNED_COORDINATE"],
    });
  });

  test("treats two planned renames for one observed pair as globally ambiguous", () => {
    const edits: RepositoryEditExpectationV1[] = [
      renameEdit("edit.rename.a"),
      renameEdit("edit.rename.b"),
    ];
    const input = makeInput({
      scope: {
        kind: "coordinate_set",
        bindingIds: ["binding.destination", "binding.feature"],
        coordinateIds: [coordinate],
      },
      edits,
      hunks: [
        makeHunk("src/feature.ts", { oldBlobId: "old", newBlobId: null }),
        makeHunk("src/renamed.ts", { oldBlobId: null, newBlobId: "new" }),
      ],
      observationChanges: [renameChange("src/feature.ts", "src/renamed.ts")],
    });
    const report = reconcileDiff(input);
    expect(report.terminalStatus).toBe("VIOLATED");
    expect(report.reasonCodes).toEqual(["MISSING_PLANNED_EDIT", "UNPLANNED_COORDINATE"]);
    expect(report.missingPlannedEditIds).toEqual(["edit.rename.a", "edit.rename.b"]);
    expect(report.advisoryDiagnostics).toContainEqual({
      code: "AMBIGUOUS_STEP_MATCH",
      message: "One observed rename pair cannot certify multiple planned rename edits.",
      subjectIds: ["edit.rename.a", "edit.rename.b"],
    });
    expect(ReconcileDiffReportV1Schema.safeParse(report).success).toBe(true);
  });

  test("detects invariant drift and undeclared lifted impact", () => {
    const input = makeInput();
    updateSealedAnalysis(input, (analysis) => {
      analysis.architectureDelta = {
        currentSnapshotId: "current",
        targetSnapshotId: "candidate",
        added: [],
        removed: [],
        changed: [],
        addedRelations: [],
        removedRelations: [],
        changedRelations: [],
        changedInvariantIds: ["semantic:invariant.keep", "semantic:invariant.unrelated"],
      };
      analysis.liftedImpacts = [{
        hunkId: makeHunk().identity,
        expectationIds: ["expectation.undeclared"],
        semanticSubjectIds: [],
      }];
    });
    expect(reconcileDiff(input)).toMatchObject({
      terminalStatus: "VIOLATED",
      reasonCodes: ["INVARIANT_DRIFT", "UNDECLARED_LIFTED_IMPACT"],
      invariantDriftIds: ["semantic:invariant.keep"],
      undeclaredLiftedExpectationIds: ["expectation.undeclared"],
    });
  });

  test("keeps proof gaps secondary when an observed violation dominates", () => {
    const input = makeInput({
      hunkPath: "src/outside.ts",
      bindingCoordinates: [],
      changeSetEvidenceIds: ["evidence.required"],
      completeness: "partial",
    });
    const report = reconcileDiff(input);
    expect(report.terminalStatus).toBe("VIOLATED");
    expect(report.reasonCodes).toEqual(["SCOPE_ESCAPE", "MISSING_PLANNED_EDIT"]);
    expect(report.secondaryInsufficiencies).toEqual([
      "OBSERVATION_ANALYSIS_INCOMPLETE",
      "REQUIRED_EVIDENCE_UNSATISFIED",
    ]);
  });

  test("evaluates evidence against exact content seals", () => {
    const missing = makeInput({ changeSetEvidenceIds: ["evidence.required"] });
    expect(reconcileDiff(missing)).toMatchObject({
      terminalStatus: "UNPROVEN",
      reasonCodes: ["REQUIRED_EVIDENCE_UNSATISFIED"],
    });
    const satisfied = makeInput({
      changeSetEvidenceIds: ["evidence.required"],
      evidenceByRequirement: ["evidence.required"],
    });
    expect(reconcileDiff(satisfied).terminalStatus).toBe("REALIZED");

    updateSealedAnalysis(satisfied, (analysis) => {
      analysis.evidenceInputs = [{
        ...analysis.evidenceInputs[0]!,
        semanticModelHash: hash("3"),
        result: "stale",
      }];
      analysis.evidenceEvaluations = [{
        ...analysis.evidenceEvaluations[0]!,
        semanticModelHash: hash("3"),
        result: "stale",
      }];
    });
    const stale = reconcileDiff(satisfied);
    expect(stale.terminalStatus).toBe("UNPROVEN");
    expect(stale.evidenceEvaluations[0]?.result).toBe("stale");
  });

  test("certifies only adjacent same-seal load-bearing round trips", () => {
    const expectation = semanticExpectation();
    const input = makeInput({
      semanticExpectations: [expectation],
      edits: [{
        ...modifyEdit(),
        expectedLiftedExpectationIds: [expectation.expectationId],
      }],
      evidenceByRequirement: ["evidence.behavior"],
    });
    updateSealedAnalysis(input, (analysis) => {
      analysis.roundTripCoverages = [certifiedRoundTrip(input, expectation.expectationId)];
    });
    expect(reconcileDiff(input).terminalStatus).toBe("REALIZED");

    updateSealedAnalysis(input, (analysis) => {
      analysis.roundTripCoverages[0]!.steps[0]!.epistemicStatus = "llm_inferred";
      analysis.roundTripCoverages[0]!.terminalStatus = "refused";
    });
    const advisory = reconcileDiff(input);
    expect(advisory.terminalStatus).toBe("UNPROVEN");
    expect(advisory.reasonCodes).toEqual(["ROUND_TRIP_UNPROVEN"]);
    expect(advisory.advisoryDiagnostics.map((item) => item.code))
      .toContain("ROUND_TRIP_ADVISORY_ONLY");
  });

  test("classifies independent proof insufficiencies without inventing violations", () => {
    const dirty = makeInput({ cleanliness: "DIRTY_KNOWN" });
    expect(reconcileDiff(dirty).reasonCodes).toEqual(["BASELINE_NOT_CLEAN"]);

    const unavailable = makeInput();
    delete (unavailable as unknown as { sealedAnalysis?: unknown }).sealedAnalysis;
    expect(reconcileDiff(unavailable).reasonCodes)
      .toEqual(["SCHEMA_VERSION_UNSUPPORTED"]);

    const budget = makeInput();
    updateSealedAnalysis(budget, (analysis) => {
      analysis.traversalBudgetExhausted = true;
    });
    expect(reconcileDiff(budget).reasonCodes).toEqual(["BUDGET_EXHAUSTED"]);

    const abstractOnly = makeInput({
      edits: [],
      hunks: [],
      semanticExpectations: [{
        ...semanticExpectation(),
        acceptanceEvidenceIds: [],
      }],
    });
    expect(reconcileDiff(abstractOnly).reasonCodes)
      .toEqual(["CONCRETE_EDIT_EXPECTATION_MISSING"]);

    const disconnected = makeInput({
      semanticExpectations: [{ ...semanticExpectation(), acceptanceEvidenceIds: [] }],
      edits: [{
        ...modifyEdit(),
        expectedLiftedExpectationIds: ["expectation.behavior"],
      }],
      refinementSteps: [],
    });
    expect(reconcileDiff(disconnected).reasonCodes).toEqual([
      "REFINEMENT_DISCONNECTED",
      "ROUND_TRIP_UNPROVEN",
    ]);
  });

  test("maps malformed and future contracts to closed refusal codes", () => {
    const malformed = makeInput();
    const mutable = malformed.planningBundle as PlanningBundleV1 & { unexpected?: boolean };
    mutable.unexpected = true;
    mutable.bundleHash = computePlanningBundleV1Hash(mutable);
    expect(reconcileDiff(malformed)).toMatchObject({
      terminalStatus: "REFUSED",
      reasonCodes: ["INPUT_SCHEMA_INVALID"],
      observationAnalysis: null,
    });

    const future = makeInput();
    (future.planningBundle as unknown as { schemaVersion: number }).schemaVersion = 2;
    expect(reconcileDiff(future).reasonCodes).toEqual(["SCHEMA_VERSION_UNSUPPORTED"]);
  });

  test("refuses malformed positive evidence instead of trusting raw assertions", () => {
    const input = makeInput({ changeSetEvidenceIds: ["evidence.required"] });
    updateSealedAnalysis(input, (analysis) => {
      analysis.evidenceInputs = [{
        requirementId: "evidence.required",
        evidenceId: "evidence.claimed",
        acceptedAttestationDigests: [hash("5")],
        planningCommit,
        observedDiffHash: input.capture.observedWorkingDiffHash,
        semanticModelHash: input.capture.semanticModelHash,
        provenance: ["plane_b_authored"],
        result: "satisfied",
      }];
    }, false);
    const report = reconcileDiff(input);
    expect(report).toMatchObject({
      terminalStatus: "REFUSED",
      reasonCodes: ["INPUT_SCHEMA_INVALID"],
    });
  });

  test("requires an exact accepted target and positive target findings", () => {
    const target = {
      schemaVersion: 1 as const,
      targetId: "target.one",
      revision: 1,
      artifactHash: hash("7"),
    };
    const targetExpectation: SemanticExpectationV1 = {
      schemaVersion: 1,
      expectationId: "expectation.target",
      kind: "target_element",
      level: 5,
      required: true,
      subjectId: "semantic:target-element",
      statement: "Target element exists.",
      acceptanceEvidenceIds: [],
    };
    const input = makeInput({
      target,
      semanticExpectations: [targetExpectation],
      changeSetEvidenceIds: ["evidence.target.roundtrip"],
      evidenceByRequirement: ["evidence.target.roundtrip"],
      edits: [{
        ...modifyEdit(),
        expectedLiftedExpectationIds: [targetExpectation.expectationId],
      }],
    });
    updateSealedAnalysis(input, (analysis) => {
      analysis.targetAnalysis = {
        targetRef: target,
        normativeStatus: "accepted",
        reviewAttestationDigests: [hash("8")],
        findings: [{
          targetElementId: targetExpectation.subjectId,
          result: "not_realized",
          evidenceIds: ["evidence.target"],
        }],
      };
      analysis.roundTripCoverages = [
        certifiedRoundTrip(input, targetExpectation.expectationId),
      ];
    });
    expect(reconcileDiff(input)).toMatchObject({
      terminalStatus: "VIOLATED",
      reasonCodes: ["TARGET_NOT_REALIZED"],
    });
  });

  test("derives normative target requirements from the exact accepted analysis", () => {
    const target = {
      schemaVersion: 1 as const,
      targetId: "target.local-patch",
      revision: 1,
      artifactHash: hash("7"),
    };
    const targetElementId = "semantic:target-from-artifact";
    const realized = makeInput({ target });
    updateSealedAnalysis(realized, (analysis) => {
      const inputEvidence = analysis.evidenceInputs.find(
        (item) => item.requirementId === "target_reviewed",
      )!;
      inputEvidence.semanticEvidenceDigest = hash("4");
      inputEvidence.provenance = [
        "canonical_attestation",
        "plane_a_observed",
        "plane_b_authored",
      ];
      const evaluation = analysis.evidenceEvaluations.find(
        (item) => item.requirementId === "target_reviewed",
      )!;
      evaluation.semanticEvidenceDigest = hash("4");
      evaluation.provenance = [
        "canonical_attestation",
        "plane_a_observed",
        "plane_b_authored",
      ];
      analysis.targetAnalysis!.findings = [{
        targetElementId,
        result: "realized",
        evidenceIds: ["bound:target_reviewed"],
      }];
    });
    expect(realized.planningBundle.semanticChangeSet.semanticExpectations).toEqual([]);
    expect(reconcileDiff(realized)).toMatchObject({
      terminalStatus: "REALIZED",
      reasonCodes: [],
      requiredTargetElementIds: [targetElementId],
      requiredEvidenceRequirementIds: ["target_reviewed"],
      targetRealizationFindings: [{
        targetElementId,
        required: true,
        result: "realized",
        evidenceIds: ["bound:target_reviewed"],
      }],
      evidenceEvaluations: [{
        requirementId: "target_reviewed",
        origin: "proof_obligation",
        required: true,
        evidenceId: "bound:target_reviewed",
        result: "satisfied",
      }],
    });

    const nearMiss = makeInput({ target });
    updateSealedAnalysis(nearMiss, (analysis) => {
      analysis.targetAnalysis!.findings = [{
        targetElementId,
        result: "not_realized",
        evidenceIds: ["bound:target_reviewed"],
      }];
    });
    expect(reconcileDiff(nearMiss)).toMatchObject({
      terminalStatus: "VIOLATED",
      reasonCodes: ["TARGET_NOT_REALIZED"],
      requiredTargetElementIds: [targetElementId],
      requiredEvidenceRequirementIds: ["target_reviewed"],
      evidenceEvaluations: [{
        requirementId: "target_reviewed",
        origin: "proof_obligation",
        required: true,
        evidenceId: "bound:target_reviewed",
        result: "satisfied",
      }],
    });
  });

  test("is deterministic under permutation and admits only an explicit proved no-op", () => {
    const first = makeInput();
    updateSealedAnalysis(first, (analysis) => {
      analysis.advisoryDiagnostics = [
        { code: "CANDIDATE_ANCHOR_UNUSED", message: "b", subjectIds: ["b"] },
        { code: "CANDIDATE_ANCHOR_UNUSED", message: "a", subjectIds: ["a"] },
      ];
    });
    const second = makeInput();
    updateSealedAnalysis(second, (analysis) => {
      analysis.advisoryDiagnostics = [...first.sealedAnalysis.advisoryDiagnostics].reverse();
    });
    expect(reconcileDiff(second)).toEqual(reconcileDiff(first));

    const noOp = makeInput({ edits: [], hunks: [] });
    expect(reconcileDiff(noOp).terminalStatus).toBe("REALIZED");
    noOp.capture.reconciliationAnalysisHash = hash("9");
    expect(reconcileDiff(noOp)).toMatchObject({
      terminalStatus: "REFUSED",
      reasonCodes: ["SOURCE_SEAL_MISMATCH"],
    });
  });

  test("preserves a sealed analyzer failure in the canonical advisory report", () => {
    const input = makeInput();
    updateSealedAnalysis(input, (analysis) => {
      analysis.advisoryDiagnostics = [{
        code: "ANALYZER_FAILURE",
        message: "Candidate analyzer failed for src/x.ts.",
        subjectIds: ["src/x.ts"],
      }];
    });
    const report = reconcileDiff(input);
    expect(report.advisoryDiagnostics).toContainEqual({
      code: "ANALYZER_FAILURE",
      message: "Candidate analyzer failed for src/x.ts.",
      subjectIds: ["src/x.ts"],
    });
    expect(report.reasonCodes).toEqual([]);
  });

  test("refuses TOCTOU instead of returning partial semantic findings", () => {
    const input = makeInput();
    input.capture.gitStateAfter = hash("2");
    input.capture.candidateBytesStable = false;
    const report = reconcileDiff(input);
    expect(report).toMatchObject({
      terminalStatus: "REFUSED",
      reasonCodes: ["SOURCE_SEAL_MISMATCH"],
      matchedPlannedEdits: [],
      invariantDriftIds: [],
    });
  });

  test("compares every current control constituent to the planning baseline", () => {
    const stable = makeInput();
    expect(stable.capture.observedWorkingDiffHash).not.toBe(
      stable.planningBundle.baseline.workingDiffHash,
    );
    expect(reconcileDiff(stable).terminalStatus).toBe("REALIZED");

    const drifts: {
      reason: ReconciliationReasonCodeV1;
      mutate: (input: ReconcileDiffInputV1) => void;
    }[] = [{
      reason: "SEMANTIC_MODEL_DRIFT",
      mutate: (input) => { input.capture.semanticModelHash = hash("1"); },
    }, {
      reason: "ANALYZER_CONFIG_DRIFT",
      mutate: (input) => { input.capture.analyzerConfigHash = hash("2"); },
    }, {
      reason: "TOOL_VERSION_DRIFT",
      mutate: (input) => { input.capture.toolVersion = "other-tool"; },
    }, {
      reason: "STORE_SCHEMA_DRIFT",
      mutate: (input) => { input.capture.storeSchemaVersion = 3; },
    }, {
      reason: "ATTESTATION_SET_DRIFT",
      mutate: (input) => { input.capture.attestationSetHash = hash("3"); },
    }];
    for (const drift of drifts) {
      const input = makeInput();
      drift.mutate(input);
      expect(reconcileDiff(input)).toMatchObject({
        terminalStatus: "REFUSED",
        primaryReason: drift.reason,
        reasonCodes: [drift.reason],
      });
    }
  });

  test("refuses forged sealed-analysis fields and capture/hash drift", () => {
    const mutations: ((analysis: ReconciliationAnalysisV1) => void)[] = [
      (analysis) => { analysis.observedDiffHash = hash("1"); },
      (analysis) => { analysis.observationAnalysis.analysisHash = hash("2"); },
      (analysis) => { analysis.candidateGraphHash = hash("3"); },
      (analysis) => { analysis.candidateArchitectureHash = hash("4"); },
      (analysis) => { analysis.architectureDeltaHash = hash("5"); },
      (analysis) => { analysis.hunkBindings[0]!.coordinateIds = ["repo:forged"]; },
      (analysis) => {
        analysis.liftedImpacts = [{
          hunkId: analysis.observedHunks[0]!.identity,
          expectationIds: ["expectation.forged"],
          semanticSubjectIds: ["subject.forged"],
        }];
      },
      (analysis) => {
        analysis.evidenceEvaluations = [{
          schemaVersion: 1,
          requirementId: "forged",
          origin: "change_contract",
          required: false,
          evidenceId: null,
          acceptedAttestationDigests: [],
          planningCommit,
          observedDiffHash: analysis.observedDiffHash,
          semanticModelHash: hash("b"),
          provenance: [],
          result: "missing",
        }];
      },
      (analysis) => { analysis.analysisHash = hash("6"); },
    ];
    for (const mutate of mutations) {
      const input = makeInput();
      mutate(input.sealedAnalysis);
      expect(reconcileDiff(input)).toMatchObject({
        terminalStatus: "REFUSED",
        reasonCodes: ["INPUT_SCHEMA_INVALID"],
      });
    }

    const rebound = makeInput();
    updateSealedAnalysis(rebound, (analysis) => {
      analysis.advisoryDiagnostics = [{
        code: "CANDIDATE_ANCHOR_UNUSED",
        message: "sealed",
        subjectIds: ["anchor"],
      }];
    });
    rebound.capture.reconciliationAnalysisHash = hash("7");
    expect(reconcileDiff(rebound)).toMatchObject({
      terminalStatus: "REFUSED",
      reasonCodes: ["SOURCE_SEAL_MISMATCH"],
    });
  });

  test("rejects positive raw assertions outside the sealed analysis", () => {
    const input = makeInput();
    Object.assign(input as unknown as Record<string, unknown>, {
      hunkBindings: [{
        hunkId: input.sealedAnalysis.observedHunks[0]!.identity,
        coordinateIds: [coordinate],
      }],
      evidence: [{ requirementId: "forged", result: "satisfied" }],
      targetRealization: { normativeStatus: "accepted" },
    });
    expect(reconcileDiff(input)).toMatchObject({
      terminalStatus: "REFUSED",
      reasonCodes: ["INPUT_SCHEMA_INVALID"],
    });
  });

  test("does not certify a round trip forged onto another subject or terminal hunk", () => {
    const expectation = semanticExpectation();
    const makeRoundTripInput = () => makeInput({
      semanticExpectations: [expectation],
      edits: [{
        ...modifyEdit(),
        expectedLiftedExpectationIds: [expectation.expectationId],
      }],
      evidenceByRequirement: ["evidence.behavior"],
    });

    const wrongSubject = makeRoundTripInput();
    updateSealedAnalysis(wrongSubject, (analysis) => {
      const coverage = certifiedRoundTrip(wrongSubject, expectation.expectationId);
      coverage.semanticSubjectId = "subject.forged";
      coverage.steps[0]!.fromId = "subject.forged";
      analysis.liftedImpacts[0]!.semanticSubjectIds = ["subject.forged"];
      analysis.roundTripCoverages = [coverage];
    });
    expect(reconcileDiff(wrongSubject)).toMatchObject({
      terminalStatus: "UNPROVEN",
      reasonCodes: ["ROUND_TRIP_UNPROVEN"],
    });

    const wrongTerminal = makeRoundTripInput();
    updateSealedAnalysis(wrongTerminal, (analysis) => {
      const coverage = certifiedRoundTrip(wrongTerminal, expectation.expectationId);
      coverage.steps.at(-1)!.toId = hash("9");
      analysis.roundTripCoverages = [coverage];
    });
    expect(reconcileDiff(wrongTerminal)).toMatchObject({
      terminalStatus: "UNPROVEN",
      reasonCodes: ["ROUND_TRIP_UNPROVEN"],
    });
  });

  test("keeps reconciliation exports transitively outside authority and mutation modules", async () => {
    const repositoryRoot = resolve(import.meta.dir, "../../..");
    const roots = [
      resolve(repositoryRoot, "packages/control-model/src/reconciliation.ts"),
      resolve(repositoryRoot, "packages/control-engine/src/reconciliation.ts"),
    ];
    const reached = runtimeImportClosure(roots, repositoryRoot);
    const forbiddenRuntimeModules = [
      "/packages/control-engine/src/policy.ts",
      "/packages/control-engine/src/migration.ts",
      "/packages/semantic-engine/src/targets.ts",
      "/packages/semantic-engine/src/change.ts",
    ];
    for (const file of reached) {
      const normalizedFile = file.replaceAll("\\", "/");
      if (forbiddenRuntimeModules.some((suffix) => normalizedFile.endsWith(suffix))) {
        throw new Error(`reconciliation runtime reaches forbidden module ${file}`);
      }
    }
    for (const root of roots) {
      const source = readFileSync(root, "utf8");
      expect(source).not.toMatch(/\bAuthorization[A-Za-z]*\b|\bExecutionState\b|["']ALLOW["']/);
    }
    const controlModelSurface = await import("@semantic-context/control-model/reconciliation");
    expect(Object.keys(controlModelSurface)).not.toContain("AuthorizationDecisionSchema");
    expect(Object.keys(controlModelSurface)).not.toContain("ExecutionStateSchema");
  });
});

const coordinate = "repo:src/feature.ts#run" as const;
const planningCommit = "commit-a";

interface FactoryOptions {
  profile?: "local_patch" | "feature";
  edits?: readonly RepositoryEditExpectationV1[];
  semanticExpectations?: readonly SemanticExpectationV1[];
  scope?: TaskEnvelopeV1["declaredReconciliationScope"];
  hunks?: readonly ReturnType<typeof makeHunk>[];
  hunkPath?: string;
  hunkBlobs?: { oldBlobId: string | null; newBlobId: string | null };
  observationChanges?: ObservationAnalysisV1["changes"];
  completeness?: ObservationAnalysisV1["completeness"];
  target?: PlanningBundleV1["acceptedTargetBinding"];
  changeSetEvidenceIds?: readonly string[];
  evidenceByRequirement?: readonly string[];
  bindingCoordinates?: readonly `repo:${string}`[];
  cleanliness?: "FRESH" | "DIRTY_KNOWN";
  refinementSteps?: SemanticChangeSetV1["refinementSteps"];
}

function makeInput(options: FactoryOptions = {}): ReconcileDiffInputV1 {
  const scope = options.scope ?? {
    kind: "exact_coordinate",
    bindingId: "binding.feature",
    coordinateId: coordinate,
  };
  const envelope = sealEnvelope(scope, options.target, options.profile);
  const edits = options.edits ?? [modifyEdit()];
  const changeSet = sealChangeSet(
    envelope,
    edits,
    options.semanticExpectations ?? [],
    options.changeSetEvidenceIds ?? [],
    options.target,
    options.refinementSteps,
  );
  const baseline = {
    schemaVersion: 1 as const,
    kind: "workspace_baseline" as const,
    planningCommit,
    cleanliness: options.cleanliness ?? "FRESH",
    freshnessSealHash: hash("c"),
    workingDiffHash: hash("0"),
    semanticModelHash: hash("b"),
    analyzerConfigHash: hash("d"),
    toolVersion: "test",
    storeSchemaVersion: 2,
    attestationSetHash: options.target === undefined ? null : hash("9"),
  };
  const bundlePayload = {
    schemaVersion: 1 as const,
    kind: "planning_bundle" as const,
    executionAuthority: "none" as const,
    bundleId: "bundle.one",
    planningCommit,
    taskEnvelope: envelope,
    semanticChangeSet: changeSet,
    baseline,
    ...(options.target === undefined ? {} : { acceptedTargetBinding: options.target }),
  };
  const pendingBundle = normalizePlanningBundleV1({
    ...bundlePayload,
    bundleHash: hash("0"),
  });
  const planningBundle = {
    ...pendingBundle,
    bundleHash: computePlanningBundleV1Hash(pendingBundle),
  };
  const parsedBundle = PlanningBundleV1Schema.safeParse(planningBundle);
  if (!parsedBundle.success) throw new Error(JSON.stringify(parsedBundle.error.issues));
  const hunks = options.hunks ?? [makeHunk(
    options.hunkPath,
    options.hunkBlobs,
  )];
  const candidateGraph = makeCandidateGraph(hunks[0]?.identity ?? hash("9"));
  const observationChanges = options.observationChanges ?? hunks.map((hunk) => ({
    kind: observedKind(hunk),
    ...(observedKind(hunk) === "add"
      ? { newPath: hunk.normalizedPath, newSourceDigest: hash("1") }
      : observedKind(hunk) === "delete"
        ? { oldPath: hunk.normalizedPath, oldSourceDigest: hash("1") }
        : {
            path: hunk.normalizedPath,
            oldSourceDigest: hash("1"),
            newSourceDigest: hash("2"),
          }),
  })) as ObservationAnalysisV1["changes"];
  const candidateDiffHash = computeReconciliationObservedDiffV1Hash(
    observationChanges,
    hunks,
  );
  const analysisPayload = normalizeObservationAnalysisV1({
    schemaVersion: 1,
    kind: "observation_analysis",
    baselineSealHash: baseline.freshnessSealHash,
    candidateDiffHash,
    analyzerConfigHash: hash("d"),
    toolVersion: "test",
    changes: observationChanges,
    candidateGraphHash: `sha256:${fingerprintCoordinateGraph(candidateGraph)}`,
    candidateArchitectureHash: hash("f"),
    completeness: options.completeness ?? "complete",
    incompleteReasons: options.completeness === "partial" ? ["test_partial"] : [],
    analysisHash: hash("0"),
  });
  const observationAnalysis = {
    ...analysisPayload,
    analysisHash: computeObservationAnalysisV1Hash(analysisPayload),
  };
  const hunkBindings = hunks.map((hunk) => ({
    hunkId: hunk.identity,
    coordinateIds: options.bindingCoordinates ?? [coordinate],
    editIds: edits.filter((edit) =>
      edit.kind === observedKind(hunk)
      && (
        (edit.kind === "add" && edit.newPath === hunk.normalizedPath)
        || (edit.kind === "delete" && edit.oldPath === hunk.normalizedPath)
        || (edit.kind === "modify" && edit.path === hunk.normalizedPath)
      )
      || (
        edit.kind === "rename"
        && (edit.oldPath === hunk.normalizedPath || edit.newPath === hunk.normalizedPath)
      )
    ).map((edit) => edit.editId).sort(),
  }));
  const evidenceInputs: ReconciliationAnalysisV1["evidenceInputs"][number][] = [
    ...(options.evidenceByRequirement ?? []).map((requirementId) => ({
    requirementId,
    evidenceId: `bound:${requirementId}`,
    semanticEvidenceDigest: hash("4"),
    acceptedAttestationDigests: [],
    planningCommit,
    observedDiffHash: candidateDiffHash,
    semanticModelHash: hash("b"),
    observationAnalysisHash: observationAnalysis.analysisHash,
    provenance: ["plane_b_authored", "plane_a_observed"] as const,
      result: "satisfied" as const,
    })),
    ...(options.target === undefined ? [] : [{
    requirementId: "target_reviewed",
    evidenceId: "bound:target_reviewed",
    acceptedAttestationDigests: [hash("8")],
    planningCommit,
    observedDiffHash: candidateDiffHash,
    semanticModelHash: hash("b"),
    attestationSetHash: hash("9"),
    observationAnalysisHash: observationAnalysis.analysisHash,
    provenance: ["canonical_attestation", "plane_b_authored"] as const,
      result: "satisfied" as const,
    }]),
  ];
  const evidenceEvaluations = evidenceInputs.map((evidence) => ({
    schemaVersion: 1 as const,
    requirementId: evidence.requirementId,
    origin: (
      evidence.requirementId === "target_reviewed"
        ? "proof_obligation"
        : changeSet.semanticExpectations.some((item) =>
        item.acceptanceEvidenceIds.includes(evidence.requirementId)
      )
        ? "semantic_expectation"
        : changeSet.repositoryEditExpectations.some((item) =>
            item.acceptanceEvidenceIds.includes(evidence.requirementId)
          )
          ? "repository_edit_expectation"
          : "change_contract"
    ) as "change_contract" | "semantic_expectation" | "repository_edit_expectation" | "proof_obligation",
    required: true,
    evidenceId: evidence.evidenceId,
    semanticEvidenceDigest: evidence.semanticEvidenceDigest,
    acceptedAttestationDigests: evidence.acceptedAttestationDigests ?? [],
    planningCommit,
    observedDiffHash: candidateDiffHash,
    semanticModelHash: hash("b"),
    observationAnalysisHash: observationAnalysis.analysisHash,
    ...("attestationSetHash" in evidence
      ? { attestationSetHash: evidence.attestationSetHash }
      : {}),
    provenance: [...evidence.provenance],
    result: "satisfied" as const,
  }));
  const architectureDelta = {
    currentSnapshotId: "architecture.baseline",
    targetSnapshotId: "architecture.candidate",
    added: [],
    removed: [],
    changed: [],
    addedRelations: [],
    removedRelations: [],
    changedRelations: [],
    changedInvariantIds: [],
  };
  const pendingAnalysis = normalizeReconciliationAnalysisV1({
    schemaVersion: 1,
    kind: "reconciliation_analysis",
    executionAuthority: "none",
    planningBundleHash: planningBundle.bundleHash,
    planningCommit,
    observedDiffHash: candidateDiffHash,
    observationAnalysis,
    candidateGraphHash: observationAnalysis.candidateGraphHash,
    baselineArchitectureHash: hash("e"),
    candidateArchitectureHash: observationAnalysis.candidateArchitectureHash,
    architectureDeltaHash: computeReconciliationArchitectureDeltaV1Hash(architectureDelta),
    observedHunks: hunks,
    hunkBindings,
    architectureDelta,
    liftedImpacts: hunkBindings.flatMap((binding) => {
      const expectationIds = edits
        .filter((edit) => binding.editIds.includes(edit.editId))
        .flatMap((edit) => edit.expectedLiftedExpectationIds);
      return expectationIds.length === 0 ? [] : [{
        hunkId: binding.hunkId,
        expectationIds,
        semanticSubjectIds: expectationIds.flatMap((expectationId) =>
          (options.semanticExpectations ?? [])
            .filter((expectation) => expectation.expectationId === expectationId)
            .map((expectation) => expectation.subjectId)
        ),
      }];
    }),
    evidenceInputs,
    evidenceEvaluations,
    roundTripCoverages: [],
    ...(options.target === undefined ? {} : {
      targetAnalysis: {
        targetRef: options.target,
        normativeStatus: "accepted" as const,
        reviewAttestationDigests: [hash("8")],
        findings: [],
      },
    }),
    traversalBudgetExhausted: false,
    advisoryDiagnostics: [],
    analysisHash: hash("0"),
  });
  const sealedAnalysis = {
    ...pendingAnalysis,
    analysisHash: computeReconciliationAnalysisV1Hash(pendingAnalysis),
  };
  const input: ReconcileDiffInputV1 = {
    planningBundle,
    capture: {
      observedCommit: planningCommit,
      observedWorkingDiffHash: candidateDiffHash,
      currentHead: planningCommit,
      indexCommit: planningCommit,
      baselineSealHash: baseline.freshnessSealHash,
      coordinateGraphSeal: envelope.coordinateGraphSeal,
      indexSeal: envelope.indexSeal,
      sourceSealMatched: true,
      indexFresh: true,
      controlInputsSealed: true,
      gitStateBefore: hash("a"),
      gitStateAfter: hash("a"),
      candidateBytesStable: true,
      semanticModelHash: hash("b"),
      analyzerConfigHash: analysisPayload.analyzerConfigHash,
      toolVersion: analysisPayload.toolVersion,
      storeSchemaVersion: 2,
      attestationSetHash: options.target === undefined ? null : hash("9"),
      reconciliationAnalysisHash: sealedAnalysis.analysisHash,
    },
    sealedAnalysis,
  };
  return input;
}

function sealEnvelope(
  scope: TaskEnvelopeV1["declaredReconciliationScope"],
  target?: PlanningBundleV1["acceptedTargetBinding"],
  profile: "local_patch" | "feature" = "feature",
): TaskEnvelopeV1 {
  const taskFrameSnapshot = {
    schemaVersion: 1 as const,
    taskFrameId: "task.one",
    rawTaskDigest: hash("1"),
    mode: profile === "local_patch" ? "bugfix" as const : "feature" as const,
    createdAt: "2026-07-23T10:00:00.000Z",
    capabilitySignals: [],
    riskSignals: [],
  };
  const payload = {
    schemaVersion: 1 as const,
    kind: "task_envelope" as const,
    executionAuthority: "none" as const,
    envelopeId: "envelope.one",
    planningCommit,
    taskFrameSnapshot,
    taskFrameHash: computeTaskFrameSnapshotV1Hash(taskFrameSnapshot),
    changeId: "change.one",
    changeContractHash: hash("3"),
    coordinateGraphSeal: hash("a"),
    indexSeal: hash("b"),
    baselineFreshnessSeal: hash("c"),
    profile,
    risk: profile === "local_patch" ? "R1" as const : "R2" as const,
    requiredAltitude: profile === "local_patch" ? 1 as const : 3 as const,
    candidateAnchors: [],
    resolvedBindings: scope.kind === "coordinate_set"
      ? scope.bindingIds.map((bindingId) => bindingId === "binding.destination"
        ? {
            schemaVersion: 1 as const,
            bindingId,
            coordinateId: coordinate,
            repositoryPath: "src/renamed.ts",
            provenance: "explicit_discovery" as const,
            evidenceId: "evidence.discovery",
            planningCommit,
            graphSeal: hash("a"),
            scope: { kind: "file" as const, path: "src/renamed.ts" },
          }
        : {
            schemaVersion: 1 as const,
            bindingId,
            coordinateId: coordinate,
            repositoryPath: "src/feature.ts",
            provenance: "explicit_discovery" as const,
            evidenceId: "evidence.discovery",
            planningCommit,
            graphSeal: hash("a"),
            scope: { kind: "coordinate_set" as const, coordinateIds: scope.coordinateIds },
          })
      : [{
          schemaVersion: 1 as const,
          bindingId: scope.bindingId,
          coordinateId: coordinate,
          repositoryPath: scope.kind === "file" ? scope.path : "src/feature.ts",
          provenance: "explicit_discovery" as const,
          evidenceId: "evidence.discovery",
          planningCommit,
          graphSeal: hash("a"),
          scope: scope.kind === "exact_coordinate"
            ? { kind: "exact_coordinate" as const, coordinateId: scope.coordinateId }
            : { kind: "file" as const, path: scope.path },
        }],
    parentIntentIds: [],
    preservedInvariantIds: ["semantic:invariant.keep"],
    nonGoals: [],
    expectedBehaviorDelta: [],
    declaredReconciliationScope: scope,
    proofObligationIds: [],
    ...(target === undefined ? {} : { authoredTargetBinding: target }),
    compatibilityNotes: [],
  };
  const pending = normalizeTaskEnvelopeV1({ ...payload, envelopeHash: hash("0") });
  return { ...pending, envelopeHash: computeTaskEnvelopeV1Hash(pending) };
}

function sealChangeSet(
  envelope: TaskEnvelopeV1,
  edits: readonly RepositoryEditExpectationV1[],
  semanticExpectations: readonly SemanticExpectationV1[],
  acceptanceEvidenceIds: readonly string[],
  target?: PlanningBundleV1["acceptedTargetBinding"],
  refinementSteps?: SemanticChangeSetV1["refinementSteps"],
): SemanticChangeSetV1 {
  const payload = {
    schemaVersion: 1 as const,
    kind: "semantic_change_set" as const,
    executionAuthority: "none" as const,
    changeSetId: "change-set.one",
    envelopeId: envelope.envelopeId,
    envelopeHash: envelope.envelopeHash,
    planningCommit,
    profile: envelope.profile,
    ...(target === undefined ? {} : { targetBinding: target }),
    declaredReconciliationScope: envelope.declaredReconciliationScope,
    refinementSteps: refinementSteps ?? (semanticExpectations.length === 0
      ? []
      : [{
          schemaVersion: 1 as const,
          stepId: "step.one",
          order: 0,
          fromExpectationIds: semanticExpectations.map((item) => item.expectationId),
          toExpectationIds: [],
          repositoryEditIds: edits.map((item) => item.editId),
        }]),
    semanticExpectations,
    repositoryEditExpectations: edits,
    rollbackDescription: "Revert the candidate diff.",
    testReferences: [],
    acceptanceEvidenceIds,
    proofObligationIds: [],
  };
  const pending = normalizeSemanticChangeSetV1({ ...payload, changeSetHash: hash("0") });
  return { ...pending, changeSetHash: computeSemanticChangeSetV1Hash(pending) };
}

function modifyEdit(): Extract<RepositoryEditExpectationV1, { kind: "modify" }> {
  return {
    schemaVersion: 1,
    editId: "edit.modify",
    kind: "modify",
    required: true,
    path: "src/feature.ts",
    coordinateIds: [coordinate],
    oldRange: { start: 1, lines: 1 },
    expectedLiftedExpectationIds: [],
    acceptanceEvidenceIds: [],
  };
}

function renameEdit(
  editId: string,
): Extract<RepositoryEditExpectationV1, { kind: "rename" }> {
  return {
    schemaVersion: 1,
    editId,
    kind: "rename",
    required: true,
    oldPath: "src/feature.ts",
    newPath: "src/renamed.ts",
    coordinateIds: [coordinate],
    expectedLiftedExpectationIds: [],
    acceptanceEvidenceIds: [],
  };
}

function semanticExpectation(): SemanticExpectationV1 {
  return {
    schemaVersion: 1,
    expectationId: "expectation.behavior",
    kind: "behavior",
    level: 3,
    required: true,
    subjectId: "capability.reconcile",
    statement: "Reconciliation preserves intended behavior.",
    acceptanceEvidenceIds: ["evidence.behavior"],
  };
}

function makeHunk(
  path = "src/feature.ts",
  blobs: { oldBlobId: string | null; newBlobId: string | null } = {
    oldBlobId: "old",
    newBlobId: "new",
  },
) {
  return createObservedDiffHunkV1({
    repositoryIdentity: "repo:test",
    normalizedPath: path,
    oldRange: { start: 1, lines: 1 },
    newRange: { start: 1, lines: 1 },
    ...blobs,
    rawHunkBytes: new TextEncoder().encode("@@ -1 +1 @@\r\n-old\r\n+new\r\n"),
  });
}

function observedKind(hunk: ReturnType<typeof makeHunk>): "add" | "modify" | "delete" {
  return hunk.oldBlobId === null ? "add" : hunk.newBlobId === null ? "delete" : "modify";
}

function certifiedRoundTrip(input: ReconcileDiffInputV1, expectationId: string) {
  const expectation = input.planningBundle.semanticChangeSet.semanticExpectations
    .find((item) => item.expectationId === expectationId)!;
  const edit = input.planningBundle.semanticChangeSet.repositoryEditExpectations
    .find((item) => item.expectedLiftedExpectationIds.includes(expectationId))!;
  const matchedHunks = input.sealedAnalysis.hunkBindings
    .filter((binding) => binding.editIds.includes(edit.editId))
    .map((binding) => binding.hunkId);
  const evidenceIds = input.sealedAnalysis.evidenceEvaluations
    .flatMap((evaluation) => evaluation.evidenceId === null ? [] : [evaluation.evidenceId]);
  if (matchedHunks.length === 0 || evidenceIds.length === 0) {
    throw new Error(`round-trip fixture lacks hunks/evidence: ${JSON.stringify({
      matchedHunks,
      evidenceIds,
      bindings: input.sealedAnalysis.hunkBindings,
      evaluations: input.sealedAnalysis.evidenceEvaluations,
    })}`);
  }
  const steps: ReconciliationAnalysisV1["roundTripCoverages"][number]["steps"][number][] = [];
  let fromId = expectation.subjectId;
  for (let fromLevel = expectation.level; fromLevel > 0; fromLevel -= 1) {
    const toLevel = fromLevel - 1;
    const toId = toLevel === 0
      ? matchedHunks[0]!
      : toLevel === 1
        ? coordinate
        : `semantic:${expectation.expectationId}:L${toLevel}`;
    steps.push({
      relationId: `relation.${expectationId}.${expectation.level - fromLevel}`,
      relationDigest: hash(String(fromLevel)),
      fromId,
      toId,
      fromLevel: fromLevel as 0 | 1 | 2 | 3 | 4 | 5 | 6,
      toLevel: toLevel as 0 | 1 | 2 | 3 | 4 | 5 | 6,
      epistemicStatus: "human_declared" as const,
      evidenceDigests: [hash("4")],
    });
    fromId = toId;
  }
  return {
    schemaVersion: 1 as const,
    expectationId,
    editId: edit.editId,
    semanticSubjectId: expectation.subjectId,
    semanticLevel: expectation.level,
    sourceSeal: input.sealedAnalysis.observationAnalysis.baselineSealHash,
    indexSeal: input.planningBundle.taskEnvelope.indexSeal,
    observationAnalysisHash: input.sealedAnalysis.observationAnalysis.analysisHash,
    steps,
    terminalCoordinateIds: [coordinate],
    observedHunkIds: matchedHunks,
    evidenceIds,
    terminalStatus: "success" as const,
    truncated: false,
  };
}

function renameChange(oldPath: string, newPath: string) {
  return {
    kind: "rename" as const,
    oldPath,
    newPath,
    oldSourceDigest: hash("1"),
    newSourceDigest: hash("1"),
  };
}

function makeCandidateGraph(hunkId: `sha256:${string}`) {
  const evidenceDigest = hash("4");
  return {
    schemaVersion: 2 as const,
    nodes: [{
      id: coordinate,
      plane: "repo" as const,
      sourceId: "src/feature.ts#run",
      sourceKind: "function",
      appliesAtLevel: 1 as const,
      category: "code_entity" as const,
      label: "run",
      epistemicStatus: "statically_observed" as const,
      references: ["src/feature.ts"],
    }],
    structuralEdges: [],
    refinementRelations: [{
      schemaVersion: 1 as const,
      id: "relation.roundtrip",
      kind: "implements" as const,
      source: { plane: "B" as const, kind: "semantic_node" as const, nodeId: "behavior" },
      target: {
        plane: "A" as const,
        kind: "observed_diff_hunk" as const,
        coordinateDigest: hunkId,
      },
      epistemicStatus: "human_declared" as const,
      provenance: "author" as const,
      evidenceRefs: [{
        schemaVersion: 1 as const,
        kind: "document_span" as const,
        locator: "evidence.roundtrip",
        digest: { algorithm: "sha256" as const, value: "4".repeat(64) },
      }],
    }],
    verifiedEvidenceDigests: [evidenceDigest],
    mapping: [],
    coverage: [],
    unsupported: [],
    unmapped: [],
    staleLinks: [],
    danglingReferences: [],
    compatibilityNormalization: [],
  };
}

function updateSealedAnalysis(
  input: ReconcileDiffInputV1,
  update: (analysis: ReconciliationAnalysisV1) => void,
  validate = true,
): void {
  const draft = structuredClone(input.sealedAnalysis);
  update(draft);
  draft.observationAnalysis = normalizeObservationAnalysisV1(draft.observationAnalysis);
  draft.observationAnalysis.analysisHash = computeObservationAnalysisV1Hash(
    draft.observationAnalysis,
  );
  draft.architectureDeltaHash = computeReconciliationArchitectureDeltaV1Hash(
    draft.architectureDelta,
  );
  const normalized = normalizeReconciliationAnalysisV1(draft);
  normalized.analysisHash = computeReconciliationAnalysisV1Hash(normalized);
  if (validate) {
    const parsed = ReconciliationAnalysisV1Schema.safeParse(normalized);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
  }
  input.sealedAnalysis = normalized;
  input.capture.reconciliationAnalysisHash = normalized.analysisHash;
}

function hash(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

function runtimeImportClosure(roots: readonly string[], repositoryRoot: string): Set<string> {
  const reached = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (reached.has(file)) continue;
    reached.add(file);
    const source = readFileSync(file, "utf8");
    const imports = source.matchAll(
      /\b(?:import|export)\s+(?!type\b)[\s\S]*?\bfrom\s+["']([^"']+)["']/g,
    );
    for (const match of imports) {
      const resolved = resolveRuntimeImport(file, match[1]!, repositoryRoot);
      if (resolved !== null && !reached.has(resolved)) pending.push(resolved);
    }
  }
  return reached;
}

function resolveRuntimeImport(
  importer: string,
  specifier: string,
  repositoryRoot: string,
): string | null {
  if (specifier.startsWith(".")) {
    return resolveTypeScriptFile(resolve(dirname(importer), specifier));
  }
  if (!specifier.startsWith("@semantic-context/")) return null;
  const [, packageName, ...subpathParts] = specifier.split("/");
  const packageRoot = resolve(repositoryRoot, "packages", packageName!);
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
    exports?: Record<string, string>;
    main?: string;
  };
  const subpath = subpathParts.length === 0 ? "." : `./${subpathParts.join("/")}`;
  const target = manifest.exports?.[subpath] ?? (subpath === "." ? manifest.main : undefined);
  if (target === undefined) throw new Error(`unresolved workspace export ${specifier}`);
  return resolveTypeScriptFile(resolve(packageRoot, target));
}

function resolveTypeScriptFile(candidate: string): string {
  for (const file of [candidate, `${candidate}.ts`, resolve(candidate, "index.ts")]) {
    if (existsSync(file)) return file;
  }
  throw new Error(`unresolved TypeScript import ${candidate}`);
}
