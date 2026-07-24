import { describe, expect, test } from "bun:test";
import {
  CoordinateGraphReportV2Schema,
  ObservationAnalysisV1Schema,
  computeReconciliationObservedDiffV1Hash,
  createObservedDiffHunkV1,
  sha256HashUtf8,
  type CoordinateEdge,
  type CoordinateGraphReportV2,
  type CoordinateNodeV2,
  type Sha256Hash,
} from "@semantic-context/control-model";
import {
  buildObservationAnalysis,
  type BuildObservationAnalysisInputV1,
  type CandidatePathAnalysisV1,
  type CandidateSourceChangeV1,
} from "../src/observation-analysis";

const capturedAt = "2026-07-23T12:00:00.000Z";
const planningCommit = "a".repeat(40);
const digest = (value: string): Sha256Hash => sha256HashUtf8(value);

describe("ephemeral observation analysis", () => {
  test.each([
    ["add", [change("add", "src/new.ts")], [analyzed("src/new.ts", [
      node("new", "src/new.ts"),
    ])], ["repo:new"], []],
    ["modify", [change("modify", "src/old.ts")], [analyzed("src/old.ts", [
      node("replacement", "src/old.ts"),
    ])], ["repo:replacement"], ["repo:old"]],
    ["delete", [change("delete", "src/old.ts")], [], [], ["repo:old"]],
    ["rename", [change("rename", "src/old.ts", "src/new.ts")], [analyzed("src/new.ts", [
      node("renamed", "src/new.ts"),
    ])], ["repo:renamed"], ["repo:old"]],
  ] as const)(
    "%s applies closed path replacement rules",
    (kind, sourceChanges, candidateAnalyses, present, absent) => {
      const observedHunks = kind === "rename"
        ? [hunk("src/old.ts", "delete"), hunk("src/new.ts", "add")]
        : [hunk(
            kind === "add" ? "src/new.ts" : "src/old.ts",
            kind as "add" | "modify" | "delete",
          )];
      const result = buildObservationAnalysis(input({
        sourceChanges,
        candidateAnalyses,
        observedHunks,
      }));

      expect(result.analysis.completeness).toBe("complete");
      expect(result.analysis.changes).toHaveLength(1);
      expect(result.candidateGraph.nodes.map((item) => item.id)).toEqual(
        expect.arrayContaining(present),
      );
      for (const id of absent) {
        expect(result.candidateGraph.nodes.some((item) => item.id === id)).toBe(false);
      }
      expect(ObservationAnalysisV1Schema.safeParse(result.analysis).success).toBe(true);
      expect(CoordinateGraphReportV2Schema.safeParse(result.candidateGraph).success).toBe(true);
    },
  );

  test("modify removes every exact-path node and all incident edges before insertion", () => {
    const baselineGraph = graph([
      node("old", "src/a.ts"),
      node("old-child", "src/a.ts"),
      node("other", "src/a.tsx"),
    ], [
      edge("repo:old", "repo:other"),
      edge("repo:other", "repo:old-child"),
    ]);
    const result = buildObservationAnalysis(input({
      baselineGraph,
      sourceChanges: [change("modify", "src/a.ts")],
      candidateAnalyses: [analyzed("src/a.ts", [
        node("replacement", "src/a.ts"),
      ], [edge("repo:replacement", "repo:other")])],
    }));

    expect(result.candidateGraph.nodes.map((item) => item.id)).toContain("repo:other");
    expect(result.candidateGraph.nodes.map((item) => item.id)).not.toContain("repo:old");
    expect(result.candidateGraph.nodes.map((item) => item.id)).not.toContain("repo:old-child");
    expect(result.candidateGraph.structuralEdges).toEqual([
      edge("repo:replacement", "repo:other"),
    ]);
  });

  test("recalculated cross-file edges are retained and incomplete closure is partial", () => {
    const result = buildObservationAnalysis(input({
      sourceChanges: [change("modify", "src/old.ts")],
      candidateAnalyses: [analyzed(
        "src/old.ts",
        [node("replacement", "src/old.ts")],
        [edge("repo:replacement", "repo:outside")],
        "partial",
      )],
    }));

    expect(result.candidateGraph.structuralEdges).toEqual([
      edge("repo:replacement", "repo:outside"),
    ]);
    expect(result.analysis).toMatchObject({
      completeness: "partial",
      incompleteReasons: ["INCOMPLETE_CROSS_FILE_CLOSURE"],
    });
  });

  test.each([
    ["binary", "BINARY_CONTENT"],
    ["unsupported", "UNSUPPORTED_CONTENT"],
    ["failed", "ANALYZER_FAILURE"],
  ] as const)("%s candidate content produces a canonical partial analysis", (status, reason) => {
    const result = buildObservationAnalysis(input({
      sourceChanges: [change("modify", "src/old.ts")],
      candidateAnalyses: [{ path: "src/old.ts", status }],
    }));

    expect(result.analysis.completeness).toBe("partial");
    expect(result.analysis.incompleteReasons).toEqual([reason]);
    expect(result.candidateGraph.nodes.some((item) => item.id === "repo:old")).toBe(false);
  });

  test("duplicate content identities make a rename partial and preserve the baseline", () => {
    const oldDigest = digest("same-old");
    const result = buildObservationAnalysis(input({
      sourceChanges: [
        {
          kind: "rename",
          oldPath: "src/old.ts",
          newPath: "src/new.ts",
          oldSourceDigest: oldDigest,
          newSourceDigest: digest("new"),
        },
        {
          kind: "delete",
          oldPath: "src/duplicate.ts",
          oldSourceDigest: oldDigest,
        },
      ],
      candidateAnalyses: [analyzed("src/new.ts", [node("renamed", "src/new.ts")])],
    }));

    expect(result.analysis.incompleteReasons).toContain("AMBIGUOUS_RENAME_IDENTITY");
    expect(result.candidateGraph.nodes.map((item) => item.id)).toContain("repo:old");
    expect(result.candidateGraph.nodes.map((item) => item.id)).not.toContain("repo:renamed");
  });

  test("a duplicate rename descriptor is ambiguous even after canonical deduplication", () => {
    const rename = change("rename", "src/old.ts", "src/new.ts");
    const result = buildObservationAnalysis(input({
      sourceChanges: [rename, structuredClone(rename)],
      observedHunks: [
        hunk("src/old.ts", "delete"),
        hunk("src/new.ts", "add"),
      ],
      candidateAnalyses: [analyzed("src/new.ts", [node("renamed", "src/new.ts")])],
    }));

    expect(result.analysis.changes).toHaveLength(1);
    expect(result.analysis.incompleteReasons).toContain("AMBIGUOUS_RENAME_IDENTITY");
    expect(result.analysis.incompleteReasons).toContain("AMBIGUOUS_OBSERVED_HUNK");
    expect(result.candidateGraph.nodes.map((item) => item.id)).toContain("repo:old");
  });

  test("candidate architecture is derived from the candidate graph, not caller-supplied", () => {
    const result = buildObservationAnalysis(input({
      sourceChanges: [change("modify", "src/old.ts")],
      candidateAnalyses: [analyzed("src/old.ts", [
        node("replacement", "src/old.ts", 1),
      ])],
    }));

    expect(result.candidateArchitecture.elements.map((element) => element.id)).toEqual([
      "repo:replacement",
    ]);
    expect(result.analysis.candidateArchitectureHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("permuted sealed inputs produce identical hashes without mutating inputs", () => {
    const sourceChanges: CandidateSourceChangeV1[] = [
      change("add", "src/z.ts"),
      change("modify", "src/old.ts"),
    ];
    const candidateAnalyses: CandidatePathAnalysisV1[] = [
      analyzed("src/z.ts", [node("z", "src/z.ts")]),
      analyzed("src/old.ts", [node("replacement", "src/old.ts")]),
    ];
    const originalChanges = structuredClone(sourceChanges);
    const originalAnalyses = structuredClone(candidateAnalyses);
    const observedHunks = [
      hunk("src/z.ts", "add"),
      hunk("src/old.ts", "modify"),
    ];
    const first = buildObservationAnalysis(input({
      sourceChanges,
      candidateAnalyses,
      observedHunks,
    }));
    const second = buildObservationAnalysis(input({
      sourceChanges: [...sourceChanges].reverse(),
      candidateAnalyses: [...candidateAnalyses].reverse(),
      observedHunks: [...observedHunks].reverse(),
    }));

    expect(second.analysis.analysisHash).toBe(first.analysis.analysisHash);
    expect(second.analysis.candidateDiffHash).toBe(first.analysis.candidateDiffHash);
    expect(first.analysis.candidateDiffHash).toBe(
      computeReconciliationObservedDiffV1Hash(first.analysis.changes, observedHunks),
    );
    expect(second.analysis.candidateGraphHash).toBe(first.analysis.candidateGraphHash);
    expect(sourceChanges).toEqual(originalChanges);
    expect(candidateAnalyses).toEqual(originalAnalyses);
  });

  test("path identity is case-sensitive and never treats a directory prefix as scope", () => {
    const baselineGraph = graph([
      node("lower", "src/a.ts"),
      node("upper", "Src/a.ts"),
      node("nested", "src/a.ts/nested.ts"),
    ]);
    const result = buildObservationAnalysis(input({
      baselineGraph,
      sourceChanges: [change("delete", "src/a.ts")],
      candidateAnalyses: [],
    }));

    expect(result.candidateGraph.nodes.map((item) => item.id)).not.toContain("repo:lower");
    expect(result.candidateGraph.nodes.map((item) => item.id)).toContain("repo:upper");
    expect(result.candidateGraph.nodes.map((item) => item.id)).toContain("repo:nested");
  });

  test("the public object exposes digests only and the builder performs no persistence", () => {
    const result = buildObservationAnalysis(input());
    const serialized = JSON.stringify(result.analysis);

    expect(serialized).not.toContain("@@");
    expect(serialized).not.toContain("candidate source");
    expect(Object.keys(result.analysis)).toEqual([
      "schemaVersion",
      "kind",
      "baselineSealHash",
      "candidateDiffHash",
      "analyzerConfigHash",
      "toolVersion",
      "changes",
      "candidateGraphHash",
      "candidateArchitectureHash",
      "completeness",
      "incompleteReasons",
      "analysisHash",
    ]);
  });

  test("multiple compatible hunks in one modified file support one source change", () => {
    const result = buildObservationAnalysis(input({
      observedHunks: [
        hunk("src/old.ts", "modify", "first"),
        hunk("src/old.ts", "modify", "second"),
      ],
    }));

    expect(result.analysis.completeness).toBe("complete");
  });

  test("an orphan observed hunk makes the analysis partial", () => {
    const result = buildObservationAnalysis(input({
      observedHunks: [
        hunk("src/old.ts", "modify"),
        hunk("src/orphan.ts", "add"),
      ],
    }));

    expect(result.analysis).toMatchObject({
      completeness: "partial",
      incompleteReasons: ["UNMATCHED_OBSERVED_HUNK"],
    });
  });

  test("an orphan source change makes the analysis partial", () => {
    const result = buildObservationAnalysis(input({
      observedHunks: [],
    }));

    expect(result.analysis.incompleteReasons).toContain("UNMATCHED_SOURCE_CHANGE");
  });

  test("rename requires one unambiguous old delete side and new add side", () => {
    const sourceChanges = [change("rename", "src/old.ts", "src/new.ts")];
    const complete = buildObservationAnalysis(input({
      sourceChanges,
      observedHunks: [
        hunk("src/old.ts", "delete"),
        hunk("src/new.ts", "add"),
      ],
      candidateAnalyses: [analyzed("src/new.ts", [node("renamed", "src/new.ts")])],
    }));
    const missingOld = buildObservationAnalysis(input({
      sourceChanges,
      observedHunks: [hunk("src/new.ts", "add")],
      candidateAnalyses: [analyzed("src/new.ts", [node("renamed", "src/new.ts")])],
    }));

    expect(complete.analysis.completeness).toBe("complete");
    expect(missingOld.analysis.incompleteReasons).toContain("UNMATCHED_SOURCE_CHANGE");
  });

  test("a candidate analysis without a source change is partial", () => {
    const result = buildObservationAnalysis(input({
      candidateAnalyses: [
        analyzed("src/old.ts", [node("replacement", "src/old.ts")]),
        analyzed("src/orphan.ts", [node("orphan", "src/orphan.ts")]),
      ],
    }));

    expect(result.analysis.incompleteReasons).toContain("UNMATCHED_CANDIDATE_ANALYSIS");
  });
});

function input(
  overrides: Partial<BuildObservationAnalysisInputV1> = {},
): BuildObservationAnalysisInputV1 {
  return {
    baselineSealHash: digest("baseline"),
    analyzerConfigHash: digest("analyzer"),
    toolVersion: "0.1.0",
    planningCommit,
    baselineCapturedAt: capturedAt,
    baselineGraph: graph([
      node("old", "src/old.ts"),
      node("outside", "src/outside.ts"),
    ], [edge("repo:old", "repo:outside")]),
    observedHunks: [hunk("src/old.ts", "modify")],
    sourceChanges: [change("modify", "src/old.ts")],
    candidateAnalyses: [analyzed("src/old.ts", [node("replacement", "src/old.ts")])],
    ...overrides,
  };
}

function graph(
  nodes: readonly CoordinateNodeV2[],
  structuralEdges: readonly CoordinateEdge[] = [],
): CoordinateGraphReportV2 {
  const sortedNodes = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  return {
    schemaVersion: 2,
    nodes: sortedNodes,
    structuralEdges: [...structuralEdges].sort((a, b) =>
      `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`)),
    refinementRelations: [],
    verifiedEvidenceDigests: [],
    mapping: [],
    coverage: ([0, 1, 2, 3, 4, 5, 6] as const).map((level) => ({
      level,
      categories: [],
      coordinateIds: [],
    })),
    unsupported: [],
    unmapped: [],
    staleLinks: [],
    danglingReferences: [],
    compatibilityNormalization: [],
  };
}

function node(
  id: string,
  path: string,
  level: 1 | null = null,
): CoordinateNodeV2 {
  return {
    id: `repo:${id}`,
    plane: "repo",
    sourceId: id,
    sourceKind: "function",
    appliesAtLevel: level,
    category: level === null ? null : "code_entity",
    label: id,
    epistemicStatus: "statically_observed",
    references: [`${path}:1`],
    metadata: { filePath: path },
  };
}

function edge(from: `repo:${string}`, to: `repo:${string}`): CoordinateEdge {
  return {
    from,
    to,
    relation: "imports",
    sourceRelation: "imports",
    evidenceRefs: [],
  };
}

function analyzed(
  path: string,
  nodes: readonly CoordinateNodeV2[],
  structuralEdges: readonly CoordinateEdge[] = [],
  crossFileClosure: "complete" | "partial" = "complete",
): CandidatePathAnalysisV1 {
  return {
    path,
    status: "analyzed",
    fragment: { nodes, structuralEdges, crossFileClosure },
  };
}

function change(
  kind: "add" | "modify" | "delete" | "rename",
  oldOrNewPath: string,
  renameNewPath?: string,
): CandidateSourceChangeV1 {
  if (kind === "add") {
    return { kind, newPath: oldOrNewPath, newSourceDigest: digest(`new:${oldOrNewPath}`) };
  }
  if (kind === "modify") {
    return {
      kind,
      path: oldOrNewPath,
      oldSourceDigest: digest(`old:${oldOrNewPath}`),
      newSourceDigest: digest(`new:${oldOrNewPath}`),
    };
  }
  if (kind === "delete") {
    return { kind, oldPath: oldOrNewPath, oldSourceDigest: digest(`old:${oldOrNewPath}`) };
  }
  return {
    kind,
    oldPath: oldOrNewPath,
    newPath: renameNewPath!,
    oldSourceDigest: digest(`old:${oldOrNewPath}`),
    newSourceDigest: digest(`new:${renameNewPath}`),
  };
}

function hunk(
  path: string,
  kind: "add" | "modify" | "delete",
  identitySalt = "",
) {
  return createObservedDiffHunkV1({
    repositoryIdentity: "repo:semctx",
    normalizedPath: path,
    oldRange: { start: kind === "add" ? 0 : 1, lines: kind === "add" ? 0 : 1 },
    newRange: { start: kind === "delete" ? 0 : 1, lines: kind === "delete" ? 0 : 1 },
    oldBlobId: kind === "add" ? null : "old",
    newBlobId: kind === "delete" ? null : "new",
    rawHunkBytes: new TextEncoder().encode(`@@ ${kind} ${path} ${identitySalt} @@`),
  });
}
