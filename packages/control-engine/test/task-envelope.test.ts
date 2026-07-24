import { describe, expect, test } from "bun:test";
import type { TaskFrame } from "@semantic-context/core";
import {
  TaskEnvelopeV1Schema,
  type CoordinateGraphReportV2,
  type Sha256Hash,
  type TargetReferenceV1,
} from "@semantic-context/control-model";
import type { ChangeContract } from "@semantic-context/semantic-model";
import {
  TaskEnvelopeCompilationError,
  bindExplicitAnchors,
  compileTaskEnvelope,
  createCandidateAnchor,
  snapshotTaskFrame,
} from "../src/planning";

const HASH_A = `sha256:${"a".repeat(64)}` as Sha256Hash;
const HASH_B = `sha256:${"b".repeat(64)}` as Sha256Hash;
const HASH_C = `sha256:${"c".repeat(64)}` as Sha256Hash;
const HASH_D = `sha256:${"d".repeat(64)}` as Sha256Hash;
const targetRef: TargetReferenceV1 = {
  schemaVersion: 1,
  targetId: "target.v1",
  revision: 2,
  artifactHash: HASH_D,
};

describe("TaskEnvelope compilation", () => {
  test("projects TaskFrame through a strict whitelist without promoting task prose", () => {
    const frame = taskFrame();
    const snapshot = snapshotTaskFrame(frame, {
      profileCandidate: "feature",
      altitudeCandidate: 4,
    });

    expect(snapshot).toEqual({
      schemaVersion: 1,
      taskFrameId: "task.27",
      rawTaskDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      mode: "feature",
      createdAt: "2026-07-23T10:00:00.000Z",
      capabilitySignals: ["diff_reconciliation", "task_envelope"],
      riskSignals: ["cross-package"],
      descriptiveNonGoals: ["delete"],
      profileCandidate: "feature",
      altitudeCandidate: 4,
    });
    for (const forbidden of [
      "rawTask",
      "observedBehavior",
      "expectedBehavior",
      "hardInvariants",
      "boundedContexts",
      "acceptanceEvidence",
      "hypotheses",
    ]) expect(forbidden in snapshot).toBe(false);
    expect("src/from-task.ts" in snapshot).toBe(false);
  });

  test("keeps task-text candidates advisory and builds scope only from explicit discovery", () => {
    const candidate = createCandidateAnchor({
      anchorId: "candidate.task-text",
      kind: "path",
      value: "src/from-task.ts",
      provenance: "task_text",
    });
    const bound = bindExplicitAnchors({
      change: changeContract([]),
      graph: graph(),
      planningCommit: "commit-a",
      graphSeal: HASH_A,
      candidateAnchors: [candidate],
      explicitDiscoveries: [{
        coordinateId: "repo:src/feature.ts#run",
        repositoryPath: "src/feature.ts",
        evidenceId: "evidence.discovery",
        evidenceProvenance: "static_analysis",
        scope: {
          kind: "exact_coordinate",
          coordinateId: "repo:src/feature.ts#run",
        },
      }],
    });

    expect(bound.candidateAnchors).toEqual([candidate]);
    expect(bound.resolvedBindings).toHaveLength(1);
    expect(bound.resolvedBindings[0]!.provenance).toBe("explicit_discovery");
    expect(bound.declaredReconciliationScope).toEqual({
      kind: "exact_coordinate",
      bindingId: bound.resolvedBindings[0]!.bindingId,
      coordinateId: "repo:src/feature.ts#run",
    });
    expect(() => bindExplicitAnchors({
      change: changeContract([]),
      graph: graph(),
      planningCommit: "commit-a",
      graphSeal: HASH_A,
      explicitDiscoveries: [{
        coordinateId: "repo:src/feature.ts#run",
        repositoryPath: "src/feature.ts",
        evidenceId: "evidence.llm",
        evidenceProvenance: "llm_only",
        scope: {
          kind: "exact_coordinate",
          coordinateId: "repo:src/feature.ts#run",
        },
      } as never],
    })).toThrow(/LLM-only/);
  });

  test("resolves an authored file link exactly and refuses unresolved or stale links", () => {
    const change = changeContract([{ kind: "file", ref: "src/feature.ts" }]);
    const bound = bindExplicitAnchors({
      change,
      graph: graph(),
      planningCommit: "commit-a",
      graphSeal: HASH_A,
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
    expect(bound.declaredReconciliationScope).toMatchObject({
      kind: "file",
      path: "src/feature.ts",
    });

    expect(() => bindExplicitAnchors({
      change,
      graph: graph(),
      planningCommit: "commit-a",
      graphSeal: HASH_A,
      authoredLinkResolutions: [{
        link: change.repositoryLinks[0]!,
        resolved: false,
      }],
    })).toThrow(TaskEnvelopeCompilationError);
    expect(() => bindExplicitAnchors({
      change,
      graph: graph(),
      planningCommit: "commit-a",
      graphSeal: HASH_A,
      authoredLinkResolutions: [{
        link: change.repositoryLinks[0]!,
        resolved: true,
        coordinateId: "repo:missing",
        repositoryPath: "src/missing.ts",
        evidenceId: "evidence.old-index",
        evidenceProvenance: "static_analysis",
        scope: { kind: "exact_coordinate", coordinateId: "repo:missing" },
      }],
    })).toThrow(/absent from the sealed graph/);
  });

  test("combines multiple exact file bindings without inventing coordinate authority", () => {
    const links: ChangeContract["repositoryLinks"] = [
      { kind: "file", ref: "src/other.ts" },
      { kind: "file", ref: "src/feature.ts" },
    ];
    const first = compileTaskEnvelope(envelopeInput({
      change: changeContract(links),
      explicitDiscoveries: [],
      authoredLinkResolutions: [
        fileResolution(links[0]!, "repo:src/other.ts#load", "evidence.other"),
        fileResolution(links[1]!, "repo:src/feature.ts#run", "evidence.feature"),
      ],
    }));
    const second = compileTaskEnvelope(envelopeInput({
      change: changeContract([...links].reverse()),
      explicitDiscoveries: [],
      authoredLinkResolutions: [
        fileResolution(links[1]!, "repo:src/feature.ts#run", "evidence.feature"),
        fileResolution(links[0]!, "repo:src/other.ts#load", "evidence.other"),
      ],
    }));

    expect(second).toEqual(first);
    expect(first.declaredReconciliationScope).toEqual({
      kind: "coordinate_set",
      bindingIds: first.resolvedBindings.map((binding) => binding.bindingId),
      coordinateIds: ["repo:src/feature.ts#run", "repo:src/other.ts#load"],
      filePaths: ["src/feature.ts", "src/other.ts"],
    });
    expect(TaskEnvelopeV1Schema.safeParse(first).success).toBe(true);
  });

  test("keeps mixed file and coordinate bindings exact and restrictive", () => {
    const link = { kind: "file", ref: "src/other.ts" } as const;
    const envelope = compileTaskEnvelope(envelopeInput({
      change: changeContract([link]),
      authoredLinkResolutions: [
        fileResolution(link, "repo:src/other.ts#load", "evidence.other"),
      ],
    }));

    expect(envelope.declaredReconciliationScope).toMatchObject({
      kind: "coordinate_set",
      coordinateIds: ["repo:src/feature.ts#run", "repo:src/other.ts#load"],
      filePaths: ["src/other.ts"],
    });
    expect(envelope.declaredReconciliationScope).not.toHaveProperty("repository");
    expect(envelope.candidateAnchors).toEqual([]);
  });

  test("preserves descriptive non-goals deterministically in snapshot and envelope hashes", () => {
    const first = compileTaskEnvelope(envelopeInput({
      taskFrame: { ...taskFrame(), nonGoals: ["write outside scope", "delete", "delete"] },
    }));
    const second = compileTaskEnvelope(envelopeInput({
      taskFrame: { ...taskFrame(), nonGoals: ["delete", "write outside scope"] },
    }));
    const changed = compileTaskEnvelope(envelopeInput({
      taskFrame: { ...taskFrame(), nonGoals: ["delete"] },
    }));

    expect(first).toEqual(second);
    expect(first.taskFrameSnapshot.descriptiveNonGoals).toEqual([
      "delete",
      "write outside scope",
    ]);
    expect(first.nonGoals).toEqual(["delete", "write outside scope"]);
    expect(first.taskFrameHash).not.toBe(changed.taskFrameHash);
    expect(first.envelopeHash).not.toBe(changed.envelopeHash);
    expect(JSON.stringify(TaskEnvelopeV1Schema.parse(JSON.parse(JSON.stringify(first)))))
      .toBe(JSON.stringify(first));
  });

  test("is deterministic under set-like input permutations", () => {
    const first = compileTaskEnvelope(envelopeInput({
      candidateAnchors: [
        createCandidateAnchor({
          anchorId: "candidate.z",
          kind: "semantic_term",
          value: "z",
          provenance: "task_text",
        }),
        createCandidateAnchor({
          anchorId: "candidate.a",
          kind: "semantic_term",
          value: "a",
          provenance: "task_text",
        }),
      ],
      explicitDiscoveries: [
        {
          coordinateId: "repo:src/feature.ts#run",
          repositoryPath: "src/feature.ts",
          evidenceId: "evidence.run",
          evidenceProvenance: "test",
          scope: {
            kind: "exact_coordinate",
            coordinateId: "repo:src/feature.ts#run",
          },
        },
        {
          coordinateId: "repo:src/feature.ts#helper",
          repositoryPath: "src/feature.ts",
          evidenceId: "evidence.helper",
          evidenceProvenance: "static_analysis",
          scope: {
            kind: "exact_coordinate",
            coordinateId: "repo:src/feature.ts#helper",
          },
        },
      ],
    }));
    const second = compileTaskEnvelope(envelopeInput({
      candidateAnchors: [...first.candidateAnchors].reverse(),
      explicitDiscoveries: [
        {
          coordinateId: "repo:src/feature.ts#helper",
          repositoryPath: "src/feature.ts",
          evidenceId: "evidence.helper",
          evidenceProvenance: "static_analysis",
          scope: {
            kind: "exact_coordinate",
            coordinateId: "repo:src/feature.ts#helper",
          },
        },
        {
          coordinateId: "repo:src/feature.ts#run",
          repositoryPath: "src/feature.ts",
          evidenceId: "evidence.run",
          evidenceProvenance: "test",
          scope: {
            kind: "exact_coordinate",
            coordinateId: "repo:src/feature.ts#run",
          },
        },
      ],
    }));

    expect(second).toEqual(first);
    expect(TaskEnvelopeV1Schema.safeParse(first).success).toBe(true);
    expect(first.executionAuthority).toBe("none");
    expect(first.nonGoals).toEqual(["delete"]);
    expect(first.expectedBehaviorDelta).toEqual([
      "Reconcile a sealed task envelope against the actual diff.",
    ]);
    expect(first.proofObligationIds).toEqual(["evidence.diff"]);
  });

  test("keeps exact authored target identity without caller-driven acceptance", () => {
    const authored = compileTaskEnvelope(envelopeInput({
      change: { ...changeContract([]), targetBinding: targetRef },
      targetSelection: { reference: targetRef },
      taskFrameAdvisory: { profileCandidate: "redesign", altitudeCandidate: 5 },
    }));
    expect(authored.authoredTargetBinding).toEqual(targetRef);
    expect(authored.advisoryTargetRef).toBeUndefined();
    expect(authored.profile).toBe("redesign");

    const advisory = compileTaskEnvelope(envelopeInput({
      targetSelection: { reference: targetRef },
    }));
    expect(advisory.authoredTargetBinding).toBeUndefined();
    expect(advisory.advisoryTargetRef).toEqual(targetRef);

    expect(() => compileTaskEnvelope(envelopeInput({
      change: { ...changeContract([]), targetBinding: targetRef },
      targetSelection: {
        reference: { ...targetRef, revision: 3 },
      },
    }))).toThrow(/exact selected target revision/);
  });

  test("refuses stale graph links and future graph schemas instead of downgrading", () => {
    const change = changeContract([{ kind: "symbol", ref: "src/feature.ts#run" }]);
    expect(() => compileTaskEnvelope(envelopeInput({
      change,
      graph: {
        ...graph(),
        staleLinks: [{
          ownerId: change.id,
          link: change.repositoryLinks[0]!,
          resolved: false,
          reason: "missing",
        }],
      },
      authoredLinkResolutions: [{
        link: change.repositoryLinks[0]!,
        resolved: true,
        coordinateId: "repo:src/feature.ts#run",
        repositoryPath: "src/feature.ts",
        evidenceId: "evidence.old",
        evidenceProvenance: "plane_b_source",
        scope: {
          kind: "exact_coordinate",
          coordinateId: "repo:src/feature.ts#run",
        },
      }],
    }))).toThrow(/stale authored repository links/);
    expect(() => compileTaskEnvelope(envelopeInput({
      graph: { ...graph(), schemaVersion: 3 } as unknown as CoordinateGraphReportV2,
    }))).toThrow(/invalid coordinate graph/);
  });
});

function envelopeInput(
  overrides: Partial<Parameters<typeof compileTaskEnvelope>[0]> = {},
): Parameters<typeof compileTaskEnvelope>[0] {
  return {
    taskFrame: taskFrame(),
    change: changeContract([]),
    graph: graph(),
    planningCommit: "commit-a",
    graphSeal: HASH_A,
    indexSeal: HASH_B,
    baselineFreshnessSeal: HASH_C,
    explicitDiscoveries: [{
      coordinateId: "repo:src/feature.ts#run",
      repositoryPath: "src/feature.ts",
      evidenceId: "evidence.discovery",
      evidenceProvenance: "static_analysis",
      scope: {
        kind: "exact_coordinate",
        coordinateId: "repo:src/feature.ts#run",
      },
    }],
    ...overrides,
  };
}

function taskFrame(): TaskFrame {
  return {
    id: "task.27",
    rawTask: "Change src/from-task.ts and assume this prose is normative.",
    mode: "feature",
    capabilities: ["task_envelope", "diff_reconciliation"],
    observedBehavior: ["old behavior"],
    expectedBehavior: ["new behavior"],
    boundedContexts: ["control"],
    hardInvariants: ["must not leak"],
    softConstraints: [],
    acceptanceEvidence: ["test"],
    nonGoals: ["delete"],
    riskSurfaces: ["cross-package"],
    hypotheses: [{
      id: "hypothesis.task",
      statement: "src/from-task.ts is probably the right file",
      confidence: 0.5,
      evidenceIds: [],
      status: "unverified",
    }],
    createdAt: "2026-07-23T10:00:00.000Z",
  };
}

function changeContract(repositoryLinks: ChangeContract["repositoryLinks"]): ChangeContract {
  return {
    id: "change.issue-27",
    statement: "Reconcile a sealed task envelope against the actual diff.",
    lifecycle: "active",
    provenance: "author",
    sourceRefs: [{ file: ".semctx/semantic/project/control-plane.sem", line: 1 }],
    serves: ["goal.semantic-control"],
    preserves: ["invariant.no-execution-authority"],
    requiresEvidence: ["evidence.diff"],
    openUnknowns: [],
    repositoryLinks,
    tags: ["issue-27"],
    appliesAtLevel: 4,
  };
}

function graph(): CoordinateGraphReportV2 {
  return {
    schemaVersion: 2,
    nodes: [
      repoNode("repo:src/feature.ts#helper", "helper"),
      repoNode("repo:src/feature.ts#run", "run"),
      repoNode("repo:src/other.ts#load", "load", "src/other.ts"),
    ],
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
  };
}

function repoNode(
  id: `repo:${string}`,
  label: string,
  path = "src/feature.ts",
): CoordinateGraphReportV2["nodes"][number] {
  return {
    id,
    plane: "repo",
    sourceId: id.slice("repo:".length),
    sourceKind: "function",
    appliesAtLevel: 1,
    category: "code_entity",
    label,
    epistemicStatus: "statically_observed",
    references: [path],
  };
}

function fileResolution(
  link: ChangeContract["repositoryLinks"][number],
  coordinateId: `repo:${string}`,
  evidenceId: string,
): NonNullable<Parameters<typeof compileTaskEnvelope>[0]["authoredLinkResolutions"]>[number] {
  return {
    link,
    resolved: true,
    coordinateId,
    repositoryPath: link.ref,
    evidenceId,
    evidenceProvenance: "plane_b_source",
    scope: { kind: "file", path: link.ref },
  };
}
