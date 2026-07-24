import { afterEach, describe, expect, it } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskFrame } from "@semantic-context/core";
import { SemctxError } from "@semantic-context/core";
import {
  computeAttestationSetHash,
  computeCanonicalProofAttestationDigest,
  type CanonicalProofAttestationV1,
} from "@semantic-context/control-model";
import { sha256HashCanonicalJson } from "@semantic-context/control-model/reconciliation";
import {
  buildCoordinateGraph,
  snapshotArchitecture,
} from "@semantic-context/control-engine/reconciliation";
import {
  applyChangePatch,
  createTargetProposal,
  initSemanticScaffold,
  loadSemanticModel,
  newChangeContract,
  writeChangeFile,
} from "@semantic-context/semantic-engine";
import { initWorkspace, openStore } from "@semantic-context/repository-store";
import { SAMPLE_REPO, must } from "@semantic-context/test-fixtures";
import {
  CONTROL_ATTESTATION_INDEX_META_KEY,
  indexRepository,
  reviewTargetProposal,
} from "../src";
import {
  buildPlanningBundle,
  prepareTaskEnvelope,
  reconcileWorkingTree,
} from "@semantic-context/app-services/reconciliation";

const roots: string[] = [];
const RECONCILIATION_TEST_HOOK = Symbol.for(
  "@semantic-context/app-services/reconciliation-test-hook",
);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "semctx-test",
  GIT_AUTHOR_EMAIL: "semctx-test@example.com",
  GIT_COMMITTER_NAME: "semctx-test",
  GIT_COMMITTER_EMAIL: "semctx-test@example.com",
};

afterEach(() => {
  delete (globalThis as Record<PropertyKey, unknown>)[RECONCILIATION_TEST_HOOK];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("read-only task reconciliation application boundary", () => {
  it("prepares deterministic diagnostic envelopes and is the only certifying bundle surface", () => {
    const fixture = preparedRepository();
    const left = prepareTaskEnvelope(fixture.root, fixture.command);
    const right = prepareTaskEnvelope(fixture.root, fixture.command);

    expect(left).toEqual(right);
    expect(left.certifying).toBe(false);
    expect(left.envelope.executionAuthority).toBe("none");
    expect(left.baseline.cleanliness).toBe("FRESH");

    const bundle = buildPlanningBundle(fixture.root, {
      ...fixture.command,
      rollbackDescription: "Restore the committed implementation.",
      repositoryEditExpectations: [fixture.edit],
      testReferences: ["test/capacity.test.ts"],
    });
    expect(bundle.executionAuthority).toBe("none");
    expect(bundle.semanticChangeSet.executionAuthority).toBe("none");
    expect(bundle.baseline.cleanliness).toBe("FRESH");
    expect(bundle.semanticChangeSet.repositoryEditExpectations).toEqual([fixture.edit]);
  });

  it("observes the actual worktree without writing the index or target store", () => {
    const fixture = preparedRepository();
    const modifyEdit = {
      ...fixture.edit,
      coordinateIds: fixture.pathCoordinateIds,
    };
    const bundle = buildPlanningBundle(fixture.root, {
      ...fixture.command,
      explicitDiscoveries: fixture.pathCoordinateIds.map((coordinateId, index) => ({
        coordinateId,
        repositoryPath: fixture.path,
        evidenceId: `discovery:modify:${index}`,
        evidenceProvenance: "test" as const,
        scope: {
          kind: "coordinate_set" as const,
          coordinateIds: fixture.pathCoordinateIds,
        },
      })),
      rollbackDescription: "Restore the committed implementation.",
      repositoryEditExpectations: [modifyEdit],
      testReferences: ["test/capacity.test.ts"],
    });
    const database = join(fixture.root, ".semctx", "semctx.db");
    const beforeDatabase = readFileSync(database);
    const beforeMtime = statSync(database).mtimeMs;
    const source = join(fixture.root, fixture.path);
    writeFileSync(source, `${readFileSync(source, "utf8")}\n// candidate\n`, "utf8");

    const report = reconcileWorkingTree(fixture.root, {
      schemaVersion: 1,
      planningBundle: bundle,
    });

    expect(report.observedHunkIds.length).toBeGreaterThan(0);
    expect(report.terminalStatus, JSON.stringify(report)).not.toBe("REFUSED");
    expect(report.requiredPlannedEditIds).toContain(modifyEdit.editId);
    expect(report.matchedPlannedEdits).toEqual([{
      editId: modifyEdit.editId,
      observedHunkIds: report.observedHunkIds,
    }]);
    expect(report.scopeEscapes).toEqual([]);
    expect(report.unplannedCoordinateIds).toEqual([]);
    expect(readFileSync(database)).toEqual(beforeDatabase);
    expect(statSync(database).mtimeMs).toBe(beforeMtime);
  });

  it("certifies a real Git diff through an exact sealed L2 to L1 refinement path", () => {
    const fixture = realizedRepository();
    const expectation = {
      schemaVersion: 1 as const,
      expectationId: "expectation.capacity.behavior",
      kind: "behavior" as const,
      level: 2 as const,
      required: true,
      subjectId: "goal.capacity.behavior",
      statement: "Capacity behavior remains explicit.",
      acceptanceEvidenceIds: [],
    };
    const edit = {
      ...fixture.edit,
      expectedLiftedExpectationIds: [expectation.expectationId],
    };
    const bundle = buildPlanningBundle(fixture.root, {
      ...fixture.command,
      rollbackDescription: "Restore the committed implementation.",
      semanticExpectations: [expectation],
      repositoryEditExpectations: [edit],
    });
    const source = join(fixture.root, fixture.path);
    writeFileSync(source, `${readFileSync(source, "utf8")}\n// candidate\n`, "utf8");

    const report = reconcileWorkingTree(fixture.root, {
      schemaVersion: 1,
      planningBundle: bundle,
    });

    expect(report.terminalStatus, JSON.stringify(report)).toBe("REALIZED");
    expect(report.certifiedRoundTrips).toHaveLength(1);
    expect(report.certifiedRoundTrips[0]?.expectationId).toBe(
      expectation.expectationId,
    );
    expect(report.certifiedRoundTrips[0]?.coordinateIds).toContain(
      fixture.edit.coordinateIds[0],
    );
    expect(report.undeclaredLiftedExpectationIds).toEqual([]);
    expect(report.certifiedRoundTrips[0]?.evidenceIds.some((evidenceId) =>
      evidenceId.startsWith("structural-round-trip:")
    )).toBe(true);
  });

  it("realizes an immutable accepted target through the real review service", () => {
    const fixture = acceptedTargetRepository("none");
    const bundle = buildPlanningBundle(fixture.root, {
      ...fixture.command,
      rollbackDescription: "Restore the committed implementation.",
      repositoryEditExpectations: [fixture.edit],
    });
    const source = join(fixture.root, fixture.path);
    writeFileSync(source, `${readFileSync(source, "utf8")}\n// candidate\n`, "utf8");

    const report = reconcileWorkingTree(fixture.root, {
      schemaVersion: 1,
      planningBundle: bundle,
    });

    expect(bundle.acceptedTargetBinding).toEqual(fixture.targetRef);
    expect(report.terminalStatus, JSON.stringify(report)).toBe("REALIZED");
    expect(report.requiredTargetElementIds.length).toBeGreaterThan(0);
    expect(report.targetRealizationFindings.every((finding) =>
      finding.result === "realized"
      && finding.evidenceIds.includes(fixture.reviewAttestationId)
    )).toBe(true);
    expect(report.evidenceEvaluations.find((evaluation) =>
      evaluation.requirementId === "target_reviewed"
    )).toMatchObject({
      required: true,
      evidenceId: fixture.reviewAttestationId,
      result: "satisfied",
    });
  });

  it("admits a sealed target attestation with code-unit ordered references", () => {
    const fixture = acceptedTargetRepository("none", true);
    const bundle = buildPlanningBundle(fixture.root, {
      ...fixture.command,
      rollbackDescription: "Restore the committed implementation.",
      repositoryEditExpectations: [fixture.edit],
    });
    const source = join(fixture.root, fixture.path);
    writeFileSync(source, `${readFileSync(source, "utf8")}\n// candidate\n`, "utf8");

    const report = reconcileWorkingTree(fixture.root, {
      schemaVersion: 1,
      planningBundle: bundle,
    });

    expect(report.terminalStatus, JSON.stringify(report)).toBe("REALIZED");
    expect(report.evidenceEvaluations.find((evaluation) =>
      evaluation.requirementId === "target_reviewed"
    )).toMatchObject({
      evidenceId: fixture.reviewAttestationId,
      result: "satisfied",
    });
  });

  it.each(["element", "relation"] as const)(
    "does not realize an accepted target with a near-miss %s fingerprint",
    (mismatch) => {
      const fixture = acceptedTargetRepository(mismatch);
      const bundle = buildPlanningBundle(fixture.root, {
        ...fixture.command,
        rollbackDescription: "Restore the committed implementation.",
        repositoryEditExpectations: [fixture.edit],
      });
      const source = join(fixture.root, fixture.path);
      writeFileSync(source, `${readFileSync(source, "utf8")}\n// candidate\n`, "utf8");

      const report = reconcileWorkingTree(fixture.root, {
        schemaVersion: 1,
        planningBundle: bundle,
      });

      expect(report.terminalStatus).toBe("VIOLATED");
      expect(report.reasonCodes).toContain("TARGET_NOT_REALIZED");
      expect(report.targetRealizationFindings.some((finding) =>
        finding.result === "not_realized" && finding.evidenceIds.length === 0
      )).toBe(true);
    },
  );

  it.each(["llm_inferred", "hypothetical"] as const)(
    "keeps a %s refinement path advisory-only",
    (epistemicStatus) => {
      const fixture = realizedRepository(epistemicStatus);
      const expectation = {
        schemaVersion: 1 as const,
        expectationId: "expectation.capacity.behavior",
        kind: "behavior" as const,
        level: 2 as const,
        required: true,
        subjectId: "goal.capacity.behavior",
        statement: "Capacity behavior remains explicit.",
        acceptanceEvidenceIds: [],
      };
      const edit = {
        ...fixture.edit,
        expectedLiftedExpectationIds: [expectation.expectationId],
      };
      const bundle = buildPlanningBundle(fixture.root, {
        ...fixture.command,
        rollbackDescription: "Restore the committed implementation.",
        semanticExpectations: [expectation],
        repositoryEditExpectations: [edit],
      });
      const source = join(fixture.root, fixture.path);
      writeFileSync(source, `${readFileSync(source, "utf8")}\n// candidate\n`, "utf8");

      const report = reconcileWorkingTree(fixture.root, {
        schemaVersion: 1,
        planningBundle: bundle,
      });

      expect(report.terminalStatus).toBe("UNPROVEN");
      expect(report.reasonCodes).toContain("ROUND_TRIP_UNPROVEN");
      expect(report.certifiedRoundTrips).toEqual([]);
    },
  );

  it("rejects a sealed lifted impact omitted from the planned edit", () => {
    const fixture = realizedRepository();
    const primary = {
      schemaVersion: 1 as const,
      expectationId: "expectation.capacity.behavior",
      kind: "behavior" as const,
      level: 2 as const,
      required: true,
      subjectId: "goal.capacity.behavior",
      statement: "Capacity behavior remains explicit.",
      acceptanceEvidenceIds: [],
    };
    const undeclared = {
      ...primary,
      expectationId: "expectation.capacity.secondary-impact",
      required: false,
      statement: "Secondary capacity impact remains visible.",
    };
    const edit = {
      ...fixture.edit,
      expectedLiftedExpectationIds: [primary.expectationId],
    };
    const bundle = buildPlanningBundle(fixture.root, {
      ...fixture.command,
      rollbackDescription: "Restore the committed implementation.",
      semanticExpectations: [primary, undeclared],
      repositoryEditExpectations: [edit],
    });
    const source = join(fixture.root, fixture.path);
    writeFileSync(source, `${readFileSync(source, "utf8")}\n// candidate\n`, "utf8");

    const report = reconcileWorkingTree(fixture.root, {
      schemaVersion: 1,
      planningBundle: bundle,
    });

    expect(report.terminalStatus).toBe("VIOLATED");
    expect(report.reasonCodes).toContain("UNDECLARED_LIFTED_IMPACT");
    expect(report.undeclaredLiftedExpectationIds).toEqual([
      undeclared.expectationId,
    ]);
  });

  it("binds deleted hunks to baseline coordinates removed from the candidate graph", () => {
    const fixture = preparedRepository();
    const deleteEdit = {
      ...fixture.edit,
      editId: "edit.capacity.delete",
      kind: "delete" as const,
      oldPath: fixture.path,
      coordinateIds: fixture.pathCoordinateIds,
    };
    const { path: _path, ...withoutModifyPath } = deleteEdit;
    const bundle = buildPlanningBundle(fixture.root, {
      ...fixture.command,
      explicitDiscoveries: fixture.pathCoordinateIds.map((coordinateId, index) => ({
        coordinateId,
        repositoryPath: fixture.path,
        evidenceId: `discovery:delete:${index}`,
        evidenceProvenance: "test" as const,
        scope: {
          kind: "coordinate_set" as const,
          coordinateIds: fixture.pathCoordinateIds,
        },
      })),
      rollbackDescription: "Restore the deleted implementation.",
      repositoryEditExpectations: [withoutModifyPath],
    });
    rmSync(join(fixture.root, fixture.path));

    const report = reconcileWorkingTree(fixture.root, {
      schemaVersion: 1,
      planningBundle: bundle,
    });

    expect(
      bundle.taskEnvelope.declaredReconciliationScope,
      JSON.stringify(bundle.taskEnvelope.declaredReconciliationScope),
    ).toMatchObject({
      kind: "coordinate_set",
      coordinateIds: fixture.pathCoordinateIds,
    });
    const scope = bundle.taskEnvelope.declaredReconciliationScope;
    if (scope.kind !== "coordinate_set") throw new Error("expected coordinate-set scope");
    expect(
      bundle.taskEnvelope.resolvedBindings.some((binding) =>
        scope.bindingIds.includes(binding.bindingId)
        &&
        binding.repositoryPath === fixture.path
        && fixture.pathCoordinateIds.includes(binding.coordinateId)
        && fixture.pathCoordinateIds.every((coordinateId) =>
          scope.coordinateIds.includes(coordinateId)
        )
      ),
      JSON.stringify(bundle.taskEnvelope.resolvedBindings),
    ).toBe(true);
    expect(report.terminalStatus, JSON.stringify(report)).not.toBe("REFUSED");
    expect(report.matchedPlannedEdits, JSON.stringify(report)).toEqual([{
      editId: withoutModifyPath.editId,
      observedHunkIds: report.observedHunkIds,
    }]);
    expect(report.missingPlannedEditIds).toEqual([]);
    expect(report.unplannedCoordinateIds).toEqual([]);
  });

  it("reconciles an exact planned add without inventing a pre-edit repository binding", () => {
    const fixture = preparedRepository();
    const newPath = "src/domain/new-capacity.ts";
    const addEdit = {
      schemaVersion: 1 as const,
      editId: "edit.capacity.add",
      kind: "add" as const,
      required: true,
      newPath,
      expectedLiftedExpectationIds: [],
      acceptanceEvidenceIds: [],
    };
    const bundle = buildPlanningBundle(fixture.root, {
      ...fixture.command,
      rollbackDescription: "Remove the newly added implementation.",
      repositoryEditExpectations: [addEdit],
    });
    expect(bundle.taskEnvelope.resolvedBindings.some((binding) =>
      binding.repositoryPath === newPath
    )).toBe(false);
    writeFileSync(
      join(fixture.root, newPath),
      "export function newCapacity(): number {\n  return 1;\n}\n",
      "utf8",
    );

    const report = reconcileWorkingTree(fixture.root, {
      schemaVersion: 1,
      planningBundle: bundle,
    });

    expect(report.terminalStatus, JSON.stringify(report)).not.toBe("REFUSED");
    expect(report.matchedPlannedEdits).toEqual([{
      editId: addEdit.editId,
      observedHunkIds: report.observedHunkIds,
    }]);
    expect(report.missingPlannedEditIds).toEqual([]);
    expect(report.scopeEscapes).toEqual([]);
  });

  it("keeps an untracked binary add out of observed hunks and fails closed", () => {
    const fixture = preparedRepository();
    const newPath = "src/domain/binary-capacity.ts";
    const addEdit = {
      schemaVersion: 1 as const,
      editId: "edit.capacity.binary-add",
      kind: "add" as const,
      required: true,
      newPath,
      expectedLiftedExpectationIds: [],
      acceptanceEvidenceIds: [],
    };
    const bundle = buildPlanningBundle(fixture.root, {
      ...fixture.command,
      rollbackDescription: "Remove the untracked binary input.",
      repositoryEditExpectations: [addEdit],
    });
    writeFileSync(
      join(fixture.root, newPath),
      Uint8Array.from([0x65, 0x78, 0x70, 0x6f, 0x72, 0x74, 0x00, 0x0a]),
    );

    const report = reconcileWorkingTree(fixture.root, {
      schemaVersion: 1,
      planningBundle: bundle,
    });

    expect(report.observedHunkIds).toEqual([]);
    expect(report.terminalStatus).not.toBe("REALIZED");
    expect(report.missingPlannedEditIds).toEqual([addEdit.editId]);
    expect(report.reasonCodes).toContain("MISSING_PLANNED_EDIT");
    expect(report.observationAnalysis?.completeness).toBe("partial");
    expect(report.secondaryInsufficiencies).toContain(
      "OBSERVATION_ANALYSIS_INCOMPLETE",
    );
  });

  it("reconciles a real Git rename as exact old delete and new add observations", () => {
    const fixture = preparedRepository();
    const newPath = "src/domain/renamed-capacity.ts";
    const renameEdit = {
      schemaVersion: 1 as const,
      editId: "edit.capacity.rename",
      kind: "rename" as const,
      required: true,
      oldPath: fixture.path,
      newPath,
      coordinateIds: fixture.pathCoordinateIds,
      expectedLiftedExpectationIds: [],
      acceptanceEvidenceIds: [],
    };
    const bundle = buildPlanningBundle(fixture.root, {
      ...fixture.command,
      explicitDiscoveries: fixture.pathCoordinateIds.map((coordinateId, index) => ({
        coordinateId,
        repositoryPath: fixture.path,
        evidenceId: `discovery:rename:${index}`,
        evidenceProvenance: "test" as const,
        scope: {
          kind: "coordinate_set" as const,
          coordinateIds: fixture.pathCoordinateIds,
        },
      })),
      rollbackDescription: "Rename the implementation back to its original path.",
      repositoryEditExpectations: [renameEdit],
    });
    renameSync(join(fixture.root, fixture.path), join(fixture.root, newPath));

    const report = reconcileWorkingTree(fixture.root, {
      schemaVersion: 1,
      planningBundle: bundle,
    });

    expect(report.terminalStatus, JSON.stringify(report)).not.toBe("REFUSED");
    expect(report.observedHunkIds).toHaveLength(2);
    expect(report.matchedPlannedEdits).toEqual([{
      editId: renameEdit.editId,
      observedHunkIds: report.observedHunkIds,
    }]);
    expect(report.missingPlannedEditIds).toEqual([]);
    expect(report.scopeEscapes).toEqual([]);
  });

  it("rejects caller-selected Git refs and detects worktree TOCTOU", () => {
    const fixture = preparedRepository();
    const bundle = buildPlanningBundle(fixture.root, {
      ...fixture.command,
      rollbackDescription: "Restore the committed implementation.",
      repositoryEditExpectations: [fixture.edit],
    });
    expect(() => reconcileWorkingTree(fixture.root, {
      schemaVersion: 1,
      planningBundle: bundle,
      base: "HEAD~1",
    } as never)).toThrow();

    const source = join(fixture.root, fixture.path);
    writeFileSync(source, `${readFileSync(source, "utf8")}\n// first\n`, "utf8");
    (globalThis as Record<PropertyKey, unknown>)[RECONCILIATION_TEST_HOOK] = (stage: string) => {
      if (stage === "before_final_capture") {
        writeFileSync(source, `${readFileSync(source, "utf8")}// raced\n`, "utf8");
      }
    };
    const report = reconcileWorkingTree(fixture.root, {
      schemaVersion: 1,
      planningBundle: bundle,
    });
    expect(report.terminalStatus).toBe("REFUSED");
    expect(report.reasonCodes).toContain("SOURCE_SEAL_MISMATCH");
  });

  it("preserves observed hunks when the candidate analyzer fails in a controlled way", () => {
    const fixture = preparedRepository();
    const bundle = buildPlanningBundle(fixture.root, {
      ...fixture.command,
      rollbackDescription: "Restore the committed implementation.",
      repositoryEditExpectations: [fixture.edit],
    });
    const source = join(fixture.root, fixture.path);
    writeFileSync(source, `${readFileSync(source, "utf8")}\n// candidate\n`, "utf8");
    (globalThis as Record<PropertyKey, unknown>)[RECONCILIATION_TEST_HOOK] = (
      stage: string,
    ) => {
      if (stage === "before_candidate_analysis") {
        throw new SemctxError("ANALYSIS_FAILED", "controlled analyzer failure");
      }
    };

    const report = reconcileWorkingTree(fixture.root, {
      schemaVersion: 1,
      planningBundle: bundle,
    });

    expect(report.observedHunkIds.length).toBeGreaterThan(0);
    expect(report.terminalStatus).not.toBe("REFUSED");
    expect(report.observationAnalysis?.completeness).toBe("partial");
    expect(report.secondaryInsufficiencies).toContain(
      "OBSERVATION_ANALYSIS_INCOMPLETE",
    );
    expect(report.advisoryDiagnostics.some((diagnostic) =>
      diagnostic.code === "ANALYZER_FAILURE"
    )).toBe(true);
  });

  it("does not downgrade unexpected candidate analyzer failures", () => {
    const fixture = preparedRepository();
    const bundle = buildPlanningBundle(fixture.root, {
      ...fixture.command,
      rollbackDescription: "Restore the committed implementation.",
      repositoryEditExpectations: [fixture.edit],
    });
    const source = join(fixture.root, fixture.path);
    writeFileSync(source, `${readFileSync(source, "utf8")}\n// candidate\n`, "utf8");
    (globalThis as Record<PropertyKey, unknown>)[RECONCILIATION_TEST_HOOK] = (
      stage: string,
    ) => {
      if (stage === "before_candidate_analysis") {
        throw new Error("unexpected analyzer failure");
      }
    };

    expect(() => reconcileWorkingTree(fixture.root, {
      schemaVersion: 1,
      planningBundle: bundle,
    })).toThrow("unexpected analyzer failure");
  });

  it("keeps a DIRTY_KNOWN planning baseline diagnostic-only", () => {
    const fixture = preparedRepository({ dirtyBeforeIndex: true });
    const bundle = buildPlanningBundle(fixture.root, {
      ...fixture.command,
      rollbackDescription: "Restore the committed implementation.",
      repositoryEditExpectations: [fixture.edit],
    });

    expect(bundle.baseline.cleanliness).toBe("DIRTY_KNOWN");
    const report = reconcileWorkingTree(fixture.root, {
      schemaVersion: 1,
      planningBundle: bundle,
    });
    expect(report.terminalStatus).not.toBe("REALIZED");
    expect(report.secondaryInsufficiencies).toContain("BASELINE_NOT_CLEAN");
  });

  it("refuses when HEAD moves after the bundle is sealed", () => {
    const fixture = preparedRepository();
    const bundle = buildPlanningBundle(fixture.root, {
      ...fixture.command,
      rollbackDescription: "Restore the committed implementation.",
      repositoryEditExpectations: [fixture.edit],
    });
    git(fixture.root, "commit", "--allow-empty", "-qm", "move head");

    const report = reconcileWorkingTree(fixture.root, {
      schemaVersion: 1,
      planningBundle: bundle,
    });
    expect(report.terminalStatus).toBe("REFUSED");
    expect(report.reasonCodes).toContain("PLANNING_COMMIT_MISMATCH");
  });
});

function preparedRepository(options: { dirtyBeforeIndex?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "semctx-task-reconciliation-"));
  roots.push(root);
  cpSync(SAMPLE_REPO, root, {
    recursive: true,
    filter: (source) => !source.includes(".semctx") && !source.includes("node_modules"),
  });
  git(root, "init", "-q");
  initWorkspace(root);
  initSemanticScaffold(root);
  const change = newChangeContract({
    id: "change.task-envelope",
    statement: "Adjust capacity behavior.",
    lifecycle: "draft",
  });
  writeChangeFile(root, change);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  if (options.dirtyBeforeIndex === true) {
    writeFileSync(join(root, "local-state.tmp"), "known dirty state\n", "utf8");
  }
  indexRepository(root, "2026-07-23T18:00:00.000Z");

  const frame: TaskFrame = {
    id: "task.issue-27",
    rawTask: "Adjust capacity behavior.",
    mode: "bugfix",
    capabilities: ["capacity"],
    observedBehavior: [],
    expectedBehavior: [],
    boundedContexts: [],
    hardInvariants: [],
    softConstraints: [],
    acceptanceEvidence: [],
    nonGoals: [],
    riskSurfaces: [],
    hypotheses: [],
    createdAt: "2026-07-23T17:00:00.000Z",
  };
  const store = openStore(root);
  const path = "src/domain/capacity.ts";
  const pathNodes = store.loadGraph().nodes.filter((candidate) =>
    candidate.filePath?.replaceAll("\\", "/") === path
    || candidate.evidence.some((evidence) =>
      evidence.filePath.replaceAll("\\", "/") === path
    )
  );
  const node = must(pathNodes[0]);
  store.saveTaskFrame(frame);
  store.close();

  const coordinateId = `repo:${node.id}` as const;
  const pathCoordinateIds = [
    ...new Set([
      ...pathNodes.map((pathNode) => `repo:${pathNode.id}` as const),
    ]),
  ].sort();
  const command = {
    schemaVersion: 1 as const,
    taskFrameId: frame.id,
    changeId: change.id,
    explicitDiscoveries: [{
      coordinateId,
      repositoryPath: path,
      evidenceId: "discovery:test",
      evidenceProvenance: "test" as const,
      scope: { kind: "file" as const, path },
    }],
  };
  const prepared = prepareTaskEnvelope(root, command);
  const bindingId = prepared.envelope.resolvedBindings[0]!.bindingId;
  const edit = {
    schemaVersion: 1 as const,
    editId: "edit.capacity",
    kind: "modify" as const,
    required: true,
    path,
    coordinateIds: [coordinateId],
    expectedLiftedExpectationIds: [],
    acceptanceEvidenceIds: [],
  };
  expect(prepared.envelope.declaredReconciliationScope).toEqual({
    kind: "file",
    bindingId,
    path,
  });
  return { root, path, command, edit, pathCoordinateIds };
}

function acceptedTargetRepository(
  mismatch: "none" | "element" | "relation",
  useCodeUnitReferenceOrder = false,
) {
  const root = mkdtempSync(join(tmpdir(), "semctx-task-accepted-target-"));
  roots.push(root);
  cpSync(SAMPLE_REPO, root, {
    recursive: true,
    filter: (source) => !source.includes(".semctx") && !source.includes("node_modules"),
  });
  git(root, "init", "-q");
  initWorkspace(root);
  initSemanticScaffold(root);
  const change = newChangeContract({
    id: "change.task-envelope",
    statement: "Adjust capacity behavior.",
    lifecycle: "draft",
  });
  writeChangeFile(root, change);
  writeFileSync(
    join(root, ".semctx", "semantic", "accepted-target-architecture.sem"),
    [
      "goal goal.capacity.target",
      "  statement: Preserve the capacity target.",
      "  status: declared",
      "  provenance: author",
      "  appliesAtLevel: 2",
      "  implements: goal.capacity.component",
      "",
      "goal goal.capacity.component",
      "  statement: Represent the capacity component.",
      "  status: declared",
      "  provenance: author",
      "  appliesAtLevel: 1",
      "",
    ].join("\n"),
    "utf8",
  );
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");

  const initial = indexRepository(root, "2026-07-23T08:00:00.000Z");
  const semanticModel = loadSemanticModel(root).model;
  const graph = buildCoordinateGraph({
    repositoryFacts: {
      graph: initial.analysis.graph,
      claims: initial.claims,
      evidence: initial.analysis.evidence,
    },
    semanticModel,
  });
  const architecture = snapshotArchitecture(graph, {
    id: "target-source",
    commit: `git:${git(root, "rev-parse", "HEAD")}`,
    capturedAt: "2026-07-23T08:00:00.000Z",
  });
  const elements = architecture.elements.map((element) => ({ ...element }));
  const relations = architecture.relations.map((relation) => ({ ...relation }));
  expect(elements.length).toBeGreaterThan(0);
  if (mismatch === "element") {
    elements[0] = {
      ...elements[0]!,
      fingerprint: `${elements[0]!.fingerprint}:near-miss`,
    };
  }
  if (mismatch === "relation") {
    expect(relations.length).toBeGreaterThan(0);
    relations[0] = {
      ...relations[0]!,
      fingerprint: `${relations[0]!.fingerprint}:near-miss`,
    };
  }
  const proposal = createTargetProposal(root, {
    targetId: "target.capacity",
    revision: 1,
    statement: "Preserve the exact capacity architecture.",
    baseCommit: git(root, "rev-parse", "HEAD"),
    sourceGraphSeal: initial.freshnessSeal.repositoryGraphHash,
    elements,
    relations,
    preservedInvariantIds: [],
    authorshipOrigin: "agent",
  });
  git(root, "add", ".semctx/semantic/targets");
  git(root, "commit", "-qm", "propose target");
  const proposalCommit = git(root, "rev-parse", "HEAD");
  const references = useCodeUnitReferenceOrder
    ? [{
        kind: "architecture" as const,
        uri: "semctx://architecture/B-review",
        nonLlm: true,
      }, {
        kind: "architecture" as const,
        uri: "semctx://architecture/a-review",
        nonLlm: true,
      }]
    : [{
        kind: "architecture" as const,
        uri: "semctx://architecture/capacity-review",
        nonLlm: true,
      }];
  const attestationPayload = {
    schemaVersion: 1 as const,
    id: "attestation.target.capacity.review",
    obligation: "target_reviewed" as const,
    subject: proposal.artifactHash,
    epistemicStatus: "human_declared" as const,
    references,
    commit: proposalCommit,
    observedAt: "2026-07-23T09:00:00.000Z",
    expiresAt: "2026-07-24T09:00:00.000Z",
  };
  const attestation: CanonicalProofAttestationV1 = {
    ...attestationPayload,
    attestationDigest: computeCanonicalProofAttestationDigest(
      attestationPayload,
    ),
  };
  const attestationStore = openStore(root);
  attestationStore.setMeta(
    CONTROL_ATTESTATION_INDEX_META_KEY,
    JSON.stringify({
      schemaVersion: 1,
      entries: [attestation],
      attestationSetHash: computeAttestationSetHash([
        attestation.attestationDigest,
      ]),
    }),
  );
  attestationStore.close();
  indexRepository(root, "2026-07-23T10:00:00.000Z");
  const accepted = reviewTargetProposal(root, {
    targetId: proposal.targetId,
    proposalRevision: proposal.revision,
    proposalContainingCommit: proposalCommit,
    attestationRef: attestation.id,
    evaluatedAt: "2026-07-23T11:00:00.000Z",
  });
  const targetRef = {
    schemaVersion: 1 as const,
    targetId: accepted.targetId,
    revision: accepted.revision,
    artifactHash: accepted.artifactHash,
  };
  writeChangeFile(root, applyChangePatch(change, { targetBinding: targetRef }));
  git(root, "add", ".semctx/semantic");
  git(root, "commit", "-qm", "bind accepted target");
  indexRepository(root, "2026-07-23T12:00:00.000Z");
  expect(
    loadSemanticModel(root).model.changes.find((candidate) =>
      candidate.id === change.id
    )?.targetBinding,
  ).toEqual(targetRef);

  const frame: TaskFrame = {
    id: `task.issue-27-target-${mismatch}`,
    rawTask: "Adjust capacity behavior.",
    mode: "bugfix",
    capabilities: ["capacity"],
    observedBehavior: [],
    expectedBehavior: [],
    boundedContexts: [],
    hardInvariants: [],
    softConstraints: [],
    acceptanceEvidence: [],
    nonGoals: [],
    riskSurfaces: [],
    hypotheses: [],
    createdAt: "2026-07-23T07:00:00.000Z",
  };
  const store = openStore(root);
  const path = "src/domain/capacity.ts";
  const pathNodes = store.loadGraph().nodes.filter((candidate) =>
    candidate.filePath?.replaceAll("\\", "/") === path
    || candidate.evidence.some((evidence) =>
      evidence.filePath.replaceAll("\\", "/") === path
    )
  );
  store.saveTaskFrame(frame);
  store.close();
  const pathCoordinateIds = pathNodes.map((node) => `repo:${node.id}` as const)
    .sort();
  const command = {
    schemaVersion: 1 as const,
    taskFrameId: frame.id,
    changeId: change.id,
    targetSelection: { reference: targetRef },
    explicitDiscoveries: pathCoordinateIds.map((coordinateId, index) => ({
      coordinateId,
      repositoryPath: path,
      evidenceId: `discovery:accepted-target:${index}`,
      evidenceProvenance: "test" as const,
      scope: {
        kind: "coordinate_set" as const,
        coordinateIds: pathCoordinateIds,
      },
    })),
  };
  const edit = {
    schemaVersion: 1 as const,
    editId: "edit.capacity.accepted-target",
    kind: "modify" as const,
    required: true,
    path,
    coordinateIds: pathCoordinateIds,
    expectedLiftedExpectationIds: [],
    acceptanceEvidenceIds: [],
  };
  return {
    root,
    path,
    command,
    edit,
    targetRef,
    reviewAttestationId: attestation.id,
  };
}

function realizedRepository(
  epistemicStatus: "human_declared" | "llm_inferred" | "hypothetical" =
    "human_declared",
) {
  const root = mkdtempSync(join(tmpdir(), "semctx-task-realized-"));
  roots.push(root);
  cpSync(SAMPLE_REPO, root, {
    recursive: true,
    filter: (source) => !source.includes(".semctx") && !source.includes("node_modules"),
  });
  git(root, "init", "-q");
  initWorkspace(root);
  initSemanticScaffold(root);
  const change = newChangeContract({
    id: "change.task-envelope",
    statement: "Adjust capacity behavior.",
    lifecycle: "draft",
  });
  writeChangeFile(root, change);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  indexRepository(root, "2026-07-23T18:00:00.000Z");

  const firstStore = openStore(root);
  const path = "src/domain/capacity.ts";
  const pathNodes = firstStore.loadGraph().nodes.filter((candidate) =>
    candidate.filePath?.replaceAll("\\", "/") === path
    || candidate.evidence.some((evidence) =>
      evidence.filePath.replaceAll("\\", "/") === path
    )
  );
  const linkedNode = must(
    pathNodes.find((node) => node.id.startsWith("sym:")),
    "capacity fixture must expose a symbol coordinate",
  );
  const relationEvidence = must(
    firstStore.loadEvidence().find((evidence) =>
      evidence.filePath.replaceAll("\\", "/") === path
    ),
    "capacity fixture must expose sealed source evidence",
  );
  firstStore.close();
  const evidenceDigest = sha256HashCanonicalJson(relationEvidence);
  const semanticSource = [
    "goal goal.capacity.behavior",
    "  statement: Capacity behavior remains explicit.",
    "  status: declared",
    "  provenance: author",
    "  appliesAtLevel: 2",
    "",
    "goal goal.capacity.component",
    "  statement: Capacity component implements the behavior.",
    "  status: declared",
    "  provenance: author",
    "  appliesAtLevel: 1",
    `  link: ${linkedNode.id}`,
    "",
    "relation relation.capacity.behavior-to-component decomposes_to source semantic goal.capacity.behavior",
    "target semantic goal.capacity.component",
    `epistemicStatus ${epistemicStatus}`,
    "provenance author",
    `evidenceRef document_span ${relationEvidence.id} ${evidenceDigest}`,
    "end",
    "",
  ].join("\n");
  writeFileSync(
    join(root, ".semctx", "semantic", "capacity-refinement.sem"),
    semanticSource,
    "utf8",
  );
  git(root, "add", "-A");
  git(root, "commit", "-qm", "seal refinement");
  indexRepository(root, "2026-07-23T18:01:00.000Z");

  const frame: TaskFrame = {
    id: "task.issue-27-realized",
    rawTask: "Adjust capacity behavior.",
    mode: "bugfix",
    capabilities: ["capacity"],
    observedBehavior: [],
    expectedBehavior: [],
    boundedContexts: [],
    hardInvariants: [],
    softConstraints: [],
    acceptanceEvidence: [],
    nonGoals: [],
    riskSurfaces: [],
    hypotheses: [],
    createdAt: "2026-07-23T17:00:00.000Z",
  };
  const store = openStore(root);
  store.saveTaskFrame(frame);
  store.close();
  const pathCoordinateIds = pathNodes.map((node) => `repo:${node.id}` as const).sort();
  const command = {
    schemaVersion: 1 as const,
    taskFrameId: frame.id,
    changeId: change.id,
    explicitDiscoveries: pathCoordinateIds.map((discoveredCoordinateId, index) => ({
      coordinateId: discoveredCoordinateId,
      repositoryPath: path,
      evidenceId: `discovery:realized:${index}`,
      evidenceProvenance: "test" as const,
      scope: {
        kind: "coordinate_set" as const,
        coordinateIds: pathCoordinateIds,
      },
    })),
  };
  const edit = {
    schemaVersion: 1 as const,
    editId: "edit.capacity.realized",
    kind: "modify" as const,
    required: true,
    path,
      coordinateIds: pathCoordinateIds,
    expectedLiftedExpectationIds: [],
    acceptanceEvidenceIds: [],
  };
  return { root, path, command, edit };
}

function git(root: string, ...args: string[]): string {
  const process = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: GIT_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (process.exitCode !== 0) throw new Error(new TextDecoder().decode(process.stderr));
  return new TextDecoder().decode(process.stdout).trim();
}
