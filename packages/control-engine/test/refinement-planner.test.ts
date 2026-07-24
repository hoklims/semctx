import { describe, expect, test } from "bun:test";
import {
  documentId,
  moduleId,
  symbolId,
  testId,
} from "@semantic-context/core";
import {
  MIGRATION_STEP_PROFILES,
  PlanningBundleV1Schema,
  SemanticChangeSetV1Schema,
  type RefinementProfileV1,
  type RepositoryEditExpectationV1,
  type SemanticExpectationV1,
  type WorkspaceBaselineSnapshotV1,
} from "@semantic-context/control-model";
import * as publicPlanning from "../src/planning";
import {
  compileSemanticChangeSet,
  compileTaskEnvelope,
  selectRefinementProfile,
} from "../src/planning";
import { describeMigrationRefinementAdapter } from "../src/legacy-planning";
import {
  buildPlanningBundleInternal,
} from "../src/refinement-planner";
import type { CompileTaskEnvelopeInput } from "../src/planning";

describe("refinement planner", () => {
  test("selects all five profiles and never accepts an advisory downgrade", () => {
    expect(selection("bugfix").profile).toBe("local_patch");
    expect(selection("refactor").profile).toBe("refactor");
    expect(selection("feature").profile).toBe("feature");
    expect(selection("feature", {
      profileCandidate: "redesign",
      altitudeCandidate: 5,
      hasAuthoredTarget: true,
    })).toMatchObject({ profile: "redesign", risk: "R3", requiredAltitude: 5 });
    expect(selection("migration", {
      profileCandidate: "migration",
      hasAuthoredTarget: true,
    })).toMatchObject({ profile: "migration", risk: "R3", requiredAltitude: 6 });

    const downgradeCases: readonly [Parameters<typeof selection>[0], RefinementProfileV1][] = [
      ["feature", "local_patch"],
      ["feature", "refactor"],
      ["migration", "local_patch"],
      ["migration", "feature"],
    ];
    for (const [mode, candidate] of downgradeCases) {
      const result = selection(mode, {
        profileCandidate: candidate,
        hasAuthoredTarget: true,
      });
      expect(result.candidateDisposition).toBe("overridden");
      expect(profileRank(result.profile)).toBeGreaterThanOrEqual(profileRank(
        mode === "migration" ? "migration" : "feature",
      ));
    }
  });

  test("raises the profile floor from risk and altitude without silent lowering", () => {
    expect(selection("bugfix", {
      riskSignals: ["critical_security"],
    })).toMatchObject({ profile: "redesign", risk: "R3", requiredAltitude: 5 });
    expect(selection("bugfix", {
      altitudeCandidate: 3,
      profileCandidate: "local_patch",
    })).toMatchObject({
      profile: "feature",
      candidateDisposition: "overridden",
      requiredAltitude: 3,
    });
  });

  test("keeps abstract feature intent structural and separate from external proof requirements", () => {
    const envelope = makeEnvelope();
    const expectation: SemanticExpectationV1 = {
      schemaVersion: 1,
      expectationId: "expectation.capability",
      kind: "capability",
      level: 3,
      required: true,
      subjectId: "capability.reconcile",
      statement: "Actual diffs are reconciled against planned intent.",
      acceptanceEvidenceIds: ["evidence.diff"],
    };
    const abstractOnly = compileSemanticChangeSet({
      envelope,
      semanticExpectations: [expectation],
      rollbackDescription: "Discard this descriptive plan.",
    });

    expect(abstractOnly.semanticExpectations).toEqual([expectation]);
    expect(abstractOnly.repositoryEditExpectations).toEqual([]);
    expect(abstractOnly.acceptanceEvidenceIds).toEqual(["evidence.diff"]);
    expect(abstractOnly.proofObligationIds).toEqual([]);
    expect(JSON.stringify(abstractOnly)).not.toMatch(/(?:profile|diagnostic):/);
    expect(abstractOnly.executionAuthority).toBe("none");
    expect(SemanticChangeSetV1Schema.safeParse(abstractOnly).success).toBe(true);
  });

  test("lowers unauthored local-patch intent to its concrete edit without inventing L2 authority", () => {
    const base = makeEnvelopeInput();
    const envelope = compileTaskEnvelope({
      ...base,
      taskFrame: {
        ...base.taskFrame,
        mode: "bugfix",
        riskSurfaces: [],
      },
      change: {
        ...base.change,
        requiresEvidence: [],
      },
      explicitDiscoveries: explicitDiscovery(),
    });
    const changeSet = compileSemanticChangeSet({
      envelope,
      repositoryEditExpectations: [{
        ...modifyEdit("edit.local"),
        acceptanceEvidenceIds: [],
      }],
      rollbackDescription: "Revert the bounded local patch.",
    });

    expect(changeSet.profile).toBe("local_patch");
    expect(changeSet.acceptanceEvidenceIds).toEqual([]);
    expect(changeSet.proofObligationIds).toEqual([]);
    expect(changeSet.semanticExpectations).toEqual([]);
    expect(changeSet.repositoryEditExpectations[0]?.expectedLiftedExpectationIds).toEqual([]);
    expect(changeSet.refinementSteps.map((step) => step.order)).toEqual([0, 1, 2]);
    expect(changeSet.rollbackDescription).toBe("Revert the bounded local patch.");
    expect(changeSet.executionAuthority).toBe("none");
  });

  test("never auto-binds caller-authored semantic intent to concrete edits", () => {
    const expectation = semanticExpectation("expectation.caller-authored");
    const changeSet = compileSemanticChangeSet({
      envelope: makeEnvelope(),
      semanticExpectations: [expectation],
      repositoryEditExpectations: [{
        ...modifyEdit("edit.caller-authored"),
        expectedLiftedExpectationIds: [],
      }],
      rollbackDescription: "Revert the candidate diff.",
    });

    expect(changeSet.semanticExpectations).toEqual([expectation]);
    expect(changeSet.repositoryEditExpectations[0]?.expectedLiftedExpectationIds).toEqual([]);
  });

  test("preserves explicit evidence once without promoting structural predicates to proof", () => {
    const changeSet = compileSemanticChangeSet({
      envelope: makeEnvelope(),
      semanticExpectations: [{
        ...semanticExpectation("expectation.explicit"),
        acceptanceEvidenceIds: ["evidence.expectation"],
      }],
      repositoryEditExpectations: [{
        ...modifyEdit("edit.explicit"),
        acceptanceEvidenceIds: ["evidence.edit"],
      }],
      rollbackDescription: "Revert the candidate diff.",
      acceptanceEvidenceIds: ["evidence.command"],
      proofObligationIds: ["proof.command", "evidence.diff", "evidence.command"],
    });

    expect(changeSet.acceptanceEvidenceIds).toEqual([
      "evidence.command",
      "evidence.diff",
    ]);
    expect(changeSet.semanticExpectations[0]?.acceptanceEvidenceIds).toEqual([
      "evidence.expectation",
    ]);
    expect(changeSet.repositoryEditExpectations[0]?.acceptanceEvidenceIds).toEqual([
      "evidence.edit",
    ]);
    expect(changeSet.proofObligationIds).toEqual(["proof.command"]);
    expect(JSON.stringify(changeSet)).not.toMatch(/(?:profile|diagnostic):/);
  });

  test("normalizes expectations and edits before deriving ChangeSet identity", () => {
    const envelope = makeEnvelope();
    const expectations = [
      semanticExpectation("expectation.z"),
      semanticExpectation("expectation.a"),
    ];
    const edits = [
      modifyEdit("edit.z"),
      modifyEdit("edit.a"),
    ];
    const first = compileSemanticChangeSet({
      envelope,
      semanticExpectations: expectations,
      repositoryEditExpectations: edits,
      rollbackDescription: "Revert the candidate diff.",
      testReferences: ["test:b", "test:a"],
    });
    const second = compileSemanticChangeSet({
      envelope,
      semanticExpectations: [...expectations].reverse(),
      repositoryEditExpectations: [...edits].reverse(),
      rollbackDescription: "Revert the candidate diff.",
      testReferences: ["test:a", "test:b"],
    });

    expect(second).toEqual(first);
    expect(second.changeSetId).toBe(first.changeSetId);
    expect(second.changeSetHash).toBe(first.changeSetHash);
  });

  test("binds an exact coordinate to its canonical path before a bundle can exist", () => {
    const envelope = makeEnvelope();
    expect(() => compileSemanticChangeSet({
      envelope,
      repositoryEditExpectations: [{
        ...modifyEdit("edit.path-escape"),
        path: "src/outside.ts",
      }],
      rollbackDescription: "Revert.",
    })).toThrow(/path does not match its sealed coordinate/);

    const valid = compileSemanticChangeSet({
      envelope,
      repositoryEditExpectations: [modifyEdit("edit.valid")],
      rollbackDescription: "Revert.",
    });
    const baseline = freshBaseline(envelope);
    const bundle = buildPlanningBundleInternal({ envelope, changeSet: valid, baseline });
    expect(PlanningBundleV1Schema.safeParse(bundle).success).toBe(true);
  });

  test("uses sealed repositoryPath for opaque repository node ids", () => {
    const cases = [
      symbolId("function", "src/feature.ts", "run", 1),
      moduleId("src/feature.ts"),
      testId("src/feature.test.ts"),
      documentId("docs/feature.md"),
    ] as const;
    for (const repositoryId of cases) {
      const coordinateId = `repo:${repositoryId}` as `repo:${string}`;
      const path = repositoryId.startsWith("test:")
        ? "src/feature.test.ts"
        : repositoryId.startsWith("doc:")
          ? "docs/feature.md"
          : "src/feature.ts";
      const base = makeEnvelopeInput();
      const envelope = compileTaskEnvelope({
        ...base,
        graph: {
          ...base.graph,
          nodes: [{
            id: coordinateId,
            plane: "repo",
            sourceId: repositoryId,
            sourceKind: "opaque_repository_node",
            appliesAtLevel: 1,
            category: "code_entity",
            label: repositoryId,
            epistemicStatus: "statically_observed",
            references: [path],
          }],
        },
        explicitDiscoveries: [{
          coordinateId,
          repositoryPath: path,
          evidenceId: `evidence:${repositoryId}`,
          evidenceProvenance: "static_analysis",
          scope: { kind: "exact_coordinate", coordinateId },
        }],
      });
      const changeSet = compileSemanticChangeSet({
        envelope,
        repositoryEditExpectations: [{
          schemaVersion: 1,
          editId: `edit:${repositoryId}`,
          kind: "modify",
          required: true,
          path,
          coordinateIds: [coordinateId],
          expectedLiftedExpectationIds: [],
          acceptanceEvidenceIds: [],
        }],
        rollbackDescription: "Revert.",
      });
      expect(changeSet.repositoryEditExpectations[0]).toMatchObject({
        path,
        coordinateIds: [coordinateId],
      });
    }
  });

  test("seals a rename destination as exact intent without treating the old binding as authority", () => {
    const exact = makeEnvelopeWithFileScope();
    const changeSet = compileSemanticChangeSet({
      envelope: exact,
      repositoryEditExpectations: [{
        schemaVersion: 1,
        editId: "edit.rename",
        kind: "rename",
        required: true,
        oldPath: "src/feature.ts",
        newPath: "src/renamed.ts",
        coordinateIds: ["repo:src/feature.ts#run"],
        expectedLiftedExpectationIds: [],
        acceptanceEvidenceIds: [],
      }],
      rollbackDescription: "Revert.",
    });
    expect(changeSet.repositoryEditExpectations[0]).toMatchObject({
      kind: "rename",
      oldPath: "src/feature.ts",
      newPath: "src/renamed.ts",
    });
    expect(changeSet.executionAuthority).toBe("none");
  });

  test("keeps bundle construction internal to control-engine", () => {
    expect("buildPlanningBundle" in publicPlanning).toBe(false);
    expect("buildPlanningBundleInternal" in publicPlanning).toBe(false);

    const envelope = makeEnvelope();
    const changeSet = compileSemanticChangeSet({
      envelope,
      rollbackDescription: "No repository mutation is performed.",
    });
    const bundle = buildPlanningBundleInternal({
      envelope,
      changeSet,
      baseline: freshBaseline(envelope),
    });
    expect(bundle.executionAuthority).toBe("none");
    expect(bundle.acceptedTargetBinding).toBeUndefined();
  });

  test("never promotes caller-selected or authored target identity to accepted", () => {
    const target = targetReference();
    const base = makeEnvelopeInput();
    const authoredEnvelope = compileTaskEnvelope({
      ...base,
      change: { ...base.change, targetBinding: target },
      targetSelection: { reference: target },
      explicitDiscoveries: explicitDiscovery(),
    });
    const authoredChangeSet = compileSemanticChangeSet({
      envelope: authoredEnvelope,
      rollbackDescription: "Discard the diagnostic plan.",
    });
    const authoredBundle = buildPlanningBundleInternal({
      envelope: authoredEnvelope,
      changeSet: authoredChangeSet,
      baseline: freshBaseline(authoredEnvelope),
    });
    expect(authoredEnvelope.authoredTargetBinding).toEqual(target);
    expect(authoredChangeSet.targetBinding).toBeUndefined();
    expect(authoredBundle.acceptedTargetBinding).toBeUndefined();

    const advisoryEnvelope = compileTaskEnvelope({
      ...base,
      targetSelection: { reference: target },
      explicitDiscoveries: explicitDiscovery(),
    });
    expect(advisoryEnvelope.advisoryTargetRef).toEqual(target);
    expect(advisoryEnvelope.authoredTargetBinding).toBeUndefined();
  });

  test("compiles five distinct templates and an eight-step descriptive migration adapter", () => {
    const templates = new Map<RefinementProfileV1, readonly string[]>();
    for (const [mode, profile] of [
      ["bugfix", "local_patch"],
      ["refactor", "refactor"],
      ["feature", "feature"],
    ] as const) {
      const envelope = makeEnvelopeForMode(mode);
      const changeSet = compileSemanticChangeSet({
        envelope,
        repositoryEditExpectations: profile === "feature" ? [] : [modifyEdit(`edit.${profile}`)],
        rollbackDescription: `Rollback ${profile}.`,
      });
      templates.set(profile, changeSet.refinementSteps.map((step) => step.stepId));
    }

    const target = targetReference();
    for (const [mode, profile] of [
      ["feature", "redesign"],
      ["migration", "migration"],
    ] as const) {
      const envelope = makeEnvelopeForMode(mode, {
        target,
        profileCandidate: profile,
      });
      const changeSet = compileSemanticChangeSet({
        envelope,
        repositoryEditExpectations: profile === "migration"
          ? [modifyEdit("edit.migration")]
          : [],
        rollbackDescription: `Rollback ${profile}.`,
      });
      templates.set(profile, changeSet.refinementSteps.map((step) => step.stepId));
      if (profile === "migration") {
        const adapter = describeMigrationRefinementAdapter(envelope);
        expect(adapter).toHaveLength(8);
        expect(adapter.map((step) => step.legacyProfile)).toEqual(
          MIGRATION_STEP_PROFILES.map((step) => step.profile),
        );
        expect(adapter.every((step) => step.executionAuthority === "none")).toBe(true);
        expect(adapter.every((step) =>
          !JSON.stringify(step).match(/(?:profile|diagnostic):/)
        )).toBe(true);
        expect(adapter.slice(1).every((step, index) =>
          step.dependsOnProfile === adapter[index]!.legacyProfile
        )).toBe(true);
        expect(changeSet.refinementSteps).toHaveLength(8);
        expect(changeSet.proofObligationIds).toEqual(
          [...new Set(MIGRATION_STEP_PROFILES.flatMap(
            (step) => step.minimumProofObligations,
          ))].sort(),
        );
        expect(changeSet.executionAuthority).toBe("none");
      }
    }
    expect(new Set([...templates.values()].map((steps) => steps.join("|"))).size).toBe(5);
  });
});

function selection(
  mode: Parameters<typeof selectRefinementProfile>[0]["mode"],
  overrides: Partial<Parameters<typeof selectRefinementProfile>[0]> = {},
) {
  return selectRefinementProfile({
    mode,
    riskSignals: [],
    hasAuthoredTarget: false,
    ...overrides,
  });
}

function makeEnvelope() {
  return compileTaskEnvelope({
    ...makeEnvelopeInput(),
    explicitDiscoveries: explicitDiscovery(),
  });
}

function makeEnvelopeForMode(
  mode: CompileTaskEnvelopeInput["taskFrame"]["mode"],
  options: {
    target?: ReturnType<typeof targetReference>;
    profileCandidate?: RefinementProfileV1;
  } = {},
) {
  const base = makeEnvelopeInput();
  return compileTaskEnvelope({
    ...base,
    taskFrame: {
      ...base.taskFrame,
      mode,
      riskSurfaces: mode === "migration" ? ["migration"] : [],
    },
    change: {
      ...base.change,
      ...(options.target === undefined ? {} : { targetBinding: options.target }),
    },
    ...(options.profileCandidate === undefined
      ? {}
      : { taskFrameAdvisory: { profileCandidate: options.profileCandidate } }),
    ...(options.target === undefined
      ? {}
      : { targetSelection: { reference: options.target } }),
    explicitDiscoveries: explicitDiscovery(),
  });
}

function makeEnvelopeWithFileScope() {
  const base = makeEnvelopeInput();
  const change = {
    ...base.change,
    repositoryLinks: [{ kind: "file" as const, ref: "src/feature.ts" }],
  };
  return compileTaskEnvelope({
    ...base,
    change,
    authoredLinkResolutions: [{
      link: change.repositoryLinks[0]!,
      resolved: true,
      coordinateId: "repo:src/feature.ts#run",
      repositoryPath: "src/feature.ts",
      evidenceId: "evidence.authored-link",
      evidenceProvenance: "plane_b_source",
      scope: { kind: "file", path: "src/feature.ts" },
    }],
  });
}

function makeEnvelopeInput(): CompileTaskEnvelopeInput {
  return {
    taskFrame: {
      id: "task.planner",
      rawTask: "Implement a feature.",
      mode: "feature",
      capabilities: ["reconcile"],
      observedBehavior: [],
      expectedBehavior: [],
      boundedContexts: [],
      hardInvariants: [],
      softConstraints: [],
      acceptanceEvidence: [],
      nonGoals: [],
      riskSurfaces: ["cross-package"],
      hypotheses: [],
      createdAt: "2026-07-23T10:00:00.000Z",
    },
    change: {
      id: "change.planner",
      statement: "Compile a semantic change set.",
      lifecycle: "active",
      provenance: "author",
      sourceRefs: [{ file: "control.sem", line: 1 }],
      serves: [],
      preserves: [],
      requiresEvidence: ["evidence.diff"],
      openUnknowns: [],
      repositoryLinks: [],
      tags: [],
      appliesAtLevel: 4,
    },
    graph: {
      schemaVersion: 2,
      nodes: [{
        id: "repo:src/feature.ts#run",
        plane: "repo",
        sourceId: "src/feature.ts#run",
        sourceKind: "function",
        appliesAtLevel: 1,
        category: "code_entity",
        label: "run",
        epistemicStatus: "statically_observed",
        references: ["src/feature.ts"],
      }],
      structuralEdges: [],
      refinementRelations: [],
      verifiedEvidenceDigests: [],
      mapping: [],
      coverage: [],
      unsupported: [],
      unmapped: [],
      staleLinks: [],
      danglingReferences: [],
      compatibilityNormalization: [],
    },
    planningCommit: "commit-a",
    graphSeal: hash("a"),
    indexSeal: hash("b"),
    baselineFreshnessSeal: hash("c"),
  };
}

function explicitDiscovery(): CompileTaskEnvelopeInput["explicitDiscoveries"] {
  return [{
    coordinateId: "repo:src/feature.ts#run",
    repositoryPath: "src/feature.ts",
    evidenceId: "evidence.discovery",
    evidenceProvenance: "static_analysis",
    scope: {
      kind: "exact_coordinate",
      coordinateId: "repo:src/feature.ts#run",
    },
  }];
}

function semanticExpectation(expectationId: string): SemanticExpectationV1 {
  return {
    schemaVersion: 1,
    expectationId,
    kind: "capability",
    level: 3,
    required: true,
    subjectId: expectationId,
    statement: `Realize ${expectationId}.`,
    acceptanceEvidenceIds: ["evidence.diff"],
  };
}

function modifyEdit(
  editId: string,
): Extract<RepositoryEditExpectationV1, { kind: "modify" }> {
  return {
    schemaVersion: 1,
    editId,
    kind: "modify",
    required: true,
    path: "src/feature.ts",
    coordinateIds: ["repo:src/feature.ts#run"],
    expectedLiftedExpectationIds: [],
    acceptanceEvidenceIds: ["evidence.diff"],
  };
}

function freshBaseline(envelope: ReturnType<typeof makeEnvelope>): WorkspaceBaselineSnapshotV1 {
  return {
    schemaVersion: 1,
    kind: "workspace_baseline",
    planningCommit: envelope.planningCommit,
    cleanliness: "FRESH",
    freshnessSealHash: envelope.baselineFreshnessSeal,
    workingDiffHash: hash("e"),
    semanticModelHash: hash("a"),
    analyzerConfigHash: hash("b"),
    toolVersion: "test",
    storeSchemaVersion: 2,
    attestationSetHash: hash("c"),
  };
}

function targetReference() {
  return {
    schemaVersion: 1 as const,
    targetId: "target.proposed",
    revision: 1,
    artifactHash: hash("d"),
  };
}

function profileRank(profile: RefinementProfileV1): number {
  return ["local_patch", "refactor", "feature", "redesign", "migration"].indexOf(profile);
}

function hash(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}
