import {
  ObservationAnalysisV1Schema,
  compareCodeUnits as compareIds,
  computeObservationAnalysisV1Hash,
  computeReconciliationObservedDiffV1Hash,
  normalizeCanonicalRepoRelativePath,
  normalizeObservationAnalysisV1,
  sha256HashCanonicalJson,
  type ArchitectureSnapshot,
  type CoordinateEdge,
  type CoordinateGraphReportV2,
  type CoordinateNodeV2,
  type ObservationAnalysisV1,
  type ObservationChangeV1,
  type ObservedDiffHunkV1,
  type RefinementRelationV1,
  type Sha256Hash,
} from "@semantic-context/control-model/reconciliation";
import { fingerprintCoordinateGraph, snapshotArchitecture } from "./architecture";
import {
  parseCoordinateGraphV2,
  parseObservedDiffHunk,
  parseSha256Hash,
} from "./reconciliation-validation";

export const OBSERVATION_INCOMPLETE_REASONS = [
  "AMBIGUOUS_CANDIDATE_ANALYSIS",
  "AMBIGUOUS_OBSERVED_HUNK",
  "AMBIGUOUS_RENAME_IDENTITY",
  "ANALYZER_FAILURE",
  "BINARY_CONTENT",
  "CANDIDATE_ANALYSIS_MISSING",
  "INCOMPLETE_CROSS_FILE_CLOSURE",
  "UNMATCHED_CANDIDATE_ANALYSIS",
  "UNMATCHED_OBSERVED_HUNK",
  "UNMATCHED_SOURCE_CHANGE",
  "UNSUPPORTED_CONTENT",
] as const;

export type ObservationIncompleteReason =
  typeof OBSERVATION_INCOMPLETE_REASONS[number];

export type CandidateSourceChangeV1 =
  | {
      kind: "add";
      newPath: string;
      newSourceDigest: Sha256Hash;
    }
  | {
      kind: "modify";
      path: string;
      oldSourceDigest: Sha256Hash;
      newSourceDigest: Sha256Hash;
    }
  | {
      kind: "delete";
      oldPath: string;
      oldSourceDigest: Sha256Hash;
    }
  | {
      kind: "rename";
      oldPath: string;
      newPath: string;
      oldSourceDigest: Sha256Hash;
      newSourceDigest: Sha256Hash;
    };

export interface CandidateGraphFragmentV1 {
  nodes: readonly CoordinateNodeV2[];
  structuralEdges: readonly CoordinateEdge[];
  refinementRelations?: readonly RefinementRelationV1[];
  crossFileClosure: "complete" | "partial";
}

export type CandidatePathAnalysisV1 =
  | {
      path: string;
      status: "analyzed";
      fragment: CandidateGraphFragmentV1;
    }
  | {
      path: string;
      status: "binary" | "unsupported" | "failed";
    };

export interface BuildObservationAnalysisInputV1 {
  baselineSealHash: Sha256Hash;
  analyzerConfigHash: Sha256Hash;
  toolVersion: string;
  planningCommit: string;
  baselineCapturedAt: string;
  baselineGraph: CoordinateGraphReportV2;
  observedHunks: readonly ObservedDiffHunkV1[];
  sourceChanges: readonly CandidateSourceChangeV1[];
  candidateAnalyses: readonly CandidatePathAnalysisV1[];
}

export interface ObservationAnalysisResultV1 {
  analysis: ObservationAnalysisV1;
  candidateGraph: CoordinateGraphReportV2;
  candidateArchitecture: ArchitectureSnapshot;
}

/**
 * Builds an ephemeral candidate overlay from sealed, already-observed inputs.
 * It performs no discovery, file access, persistence, policy decision or
 * authorization.
 */
export function buildObservationAnalysis(
  input: BuildObservationAnalysisInputV1,
): ObservationAnalysisResultV1 {
  const baselineGraph = parseCoordinateGraphV2(input.baselineGraph);
  const baselineSealHash = parseSha256Hash(input.baselineSealHash, "baselineSealHash");
  const analyzerConfigHash = parseSha256Hash(input.analyzerConfigHash, "analyzerConfigHash");
  if (input.toolVersion.length === 0) throw new Error("toolVersion is required");
  if (input.planningCommit.length === 0) throw new Error("planningCommit is required");
  if (!Number.isFinite(Date.parse(input.baselineCapturedAt))) {
    throw new Error("baselineCapturedAt must be an ISO timestamp");
  }

  const observedHunks = input.observedHunks
    .map(parseObservedDiffHunk)
    .sort((left, right) => compareIds(left.identity, right.identity));
  requireUnique(observedHunks.map((hunk) => hunk.identity), "observed hunk identity");

  const parsedSourceChanges = input.sourceChanges.map(parseChange);
  const changes = uniqueSorted(parsedSourceChanges, changeKey);
  const analyses = canonicalAnalyses(input.candidateAnalyses);
  const candidateDiffHash = computeReconciliationObservedDiffV1Hash(
    changes,
    observedHunks,
  );
  const ambiguousRenameKeys = new Set([
    ...findAmbiguousRenameKeys(changes),
    ...duplicateRenameKeys(parsedSourceChanges),
  ]);
  const incompleteReasons = new Set<ObservationIncompleteReason>();
  if (ambiguousRenameKeys.size > 0) {
    incompleteReasons.add("AMBIGUOUS_RENAME_IDENTITY");
  }
  for (const reason of observedCoverageReasons(observedHunks, parsedSourceChanges)) {
    incompleteReasons.add(reason);
  }
  for (const reason of candidateAnalysisCoverageReasons(parsedSourceChanges, analyses)) {
    incompleteReasons.add(reason);
  }

  const removedNodeIds = new Set<string>();
  const removedSourceIds = new Set<string>();
  for (const change of changes) {
    if (change.kind === "add" || isAmbiguousRename(change, ambiguousRenameKeys)) continue;
    const oldPath = change.kind === "modify" ? change.path : change.oldPath;
    for (const node of baselineGraph.nodes) {
      if (!nodeBelongsToExactPath(node, oldPath)) continue;
      removedNodeIds.add(node.id);
      removedSourceIds.add(node.sourceId);
    }
  }

  const retainedNodes = baselineGraph.nodes.filter((node) => !removedNodeIds.has(node.id));
  const retainedEdges = baselineGraph.structuralEdges.filter((edge) =>
    !removedNodeIds.has(edge.from) && !removedNodeIds.has(edge.to));
  const retainedRelations = baselineGraph.refinementRelations.filter((relation) =>
    !removedNodeIds.has(endpointCoordinateId(relation.source))
    && !removedNodeIds.has(endpointCoordinateId(relation.target)));

  const insertedNodes: CoordinateNodeV2[] = [];
  const insertedEdges: CoordinateEdge[] = [];
  const insertedRelations: RefinementRelationV1[] = [];
  for (const change of changes) {
    if (change.kind === "delete" || isAmbiguousRename(change, ambiguousRenameKeys)) continue;
    const newPath = change.kind === "modify" ? change.path : change.newPath;
    if (analyses.ambiguousPaths.has(newPath)) continue;
    const candidate = analyses.byPath.get(newPath);
    if (!candidate) {
      incompleteReasons.add("CANDIDATE_ANALYSIS_MISSING");
      continue;
    }
    if (candidate.status !== "analyzed") {
      incompleteReasons.add(statusReason(candidate.status));
      continue;
    }
    if (candidate.fragment.crossFileClosure === "partial") {
      incompleteReasons.add("INCOMPLETE_CROSS_FILE_CLOSURE");
    }
    for (const node of candidate.fragment.nodes) {
      if (node.plane === "observed" || !nodeBelongsToExactPath(node, newPath)) {
        throw new Error(`candidate node ${node.id} is not bound to exact path ${newPath}`);
      }
      insertedNodes.push(node);
    }
    insertedEdges.push(...candidate.fragment.structuralEdges);
    insertedRelations.push(...(candidate.fragment.refinementRelations ?? []));
  }

  const observedNodes = observedHunks.map(observedNode);
  const nodes = uniqueSorted(
    [...retainedNodes, ...insertedNodes, ...observedNodes],
    (node) => node.id,
  );
  const nodeIds = new Set(nodes.map((node) => node.id));
  const allEdges = [...retainedEdges, ...insertedEdges];
  if (allEdges.some((edge) => !nodeIds.has(edge.from) || !nodeIds.has(edge.to))) {
    incompleteReasons.add("INCOMPLETE_CROSS_FILE_CLOSURE");
  }
  const structuralEdges = uniqueSorted(
    allEdges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)),
    edgeKey,
  );
  const refinementRelations = uniqueSorted(
    [...retainedRelations, ...insertedRelations].filter((relation) =>
      nodeIds.has(endpointCoordinateId(relation.source))
      && nodeIds.has(endpointCoordinateId(relation.target))),
    (relation) => relation.id,
  );
  if (retainedRelations.length + insertedRelations.length !== refinementRelations.length) {
    incompleteReasons.add("INCOMPLETE_CROSS_FILE_CLOSURE");
  }

  const candidateGraph: CoordinateGraphReportV2 = {
    schemaVersion: 2,
    nodes,
    structuralEdges,
    refinementRelations,
    verifiedEvidenceDigests: [...baselineGraph.verifiedEvidenceDigests],
    mapping: [...baselineGraph.mapping],
    coverage: buildCoverage(nodes),
    unsupported: baselineGraph.unsupported.filter((issue) => !removedSourceIds.has(issue.sourceId)),
    unmapped: baselineGraph.unmapped.filter((issue) => !removedSourceIds.has(issue.sourceId)),
    staleLinks: baselineGraph.staleLinks.filter((issue) => !removedSourceIds.has(issue.ownerId)),
    danglingReferences: baselineGraph.danglingReferences.filter((issue) =>
      !removedSourceIds.has(issue.ownerId)),
    compatibilityNormalization: [...baselineGraph.compatibilityNormalization],
  };
  parseCoordinateGraphV2(candidateGraph);

  const candidateArchitecture = snapshotArchitecture(candidateGraph, {
    id: `observation:${candidateDiffHash}`,
    commit: input.planningCommit,
    capturedAt: input.baselineCapturedAt,
  });
  const normalizedIncompleteReasons = [...incompleteReasons].sort(compareIds);
  const withoutHash: Omit<ObservationAnalysisV1, "analysisHash"> = {
    schemaVersion: 1,
    kind: "observation_analysis",
    baselineSealHash,
    candidateDiffHash,
    analyzerConfigHash,
    toolVersion: input.toolVersion,
    changes,
    candidateGraphHash: `sha256:${fingerprintCoordinateGraph(candidateGraph)}` as Sha256Hash,
    candidateArchitectureHash: sha256HashCanonicalJson(candidateArchitecture),
    completeness: normalizedIncompleteReasons.length === 0 ? "complete" : "partial",
    incompleteReasons: normalizedIncompleteReasons,
  };
  const analysis = normalizeObservationAnalysisV1({
    ...withoutHash,
    analysisHash: computeObservationAnalysisV1Hash(withoutHash),
  });
  ObservationAnalysisV1Schema.parse(analysis);

  return { analysis, candidateGraph, candidateArchitecture };
}

function parseChange(change: CandidateSourceChangeV1): ObservationChangeV1 {
  if (change.kind === "add") {
    return {
      kind: "add",
      newPath: canonicalPath(change.newPath),
      newSourceDigest: digest(change.newSourceDigest),
    };
  }
  if (change.kind === "modify") {
    return {
      kind: "modify",
      path: canonicalPath(change.path),
      oldSourceDigest: digest(change.oldSourceDigest),
      newSourceDigest: digest(change.newSourceDigest),
    };
  }
  if (change.kind === "delete") {
    return {
      kind: "delete",
      oldPath: canonicalPath(change.oldPath),
      oldSourceDigest: digest(change.oldSourceDigest),
    };
  }
  const oldPath = canonicalPath(change.oldPath);
  const newPath = canonicalPath(change.newPath);
  if (oldPath === newPath) throw new Error("rename paths must differ");
  return {
    kind: "rename",
    oldPath,
    newPath,
    oldSourceDigest: digest(change.oldSourceDigest),
    newSourceDigest: digest(change.newSourceDigest),
  };
}

function canonicalAnalyses(
  candidateAnalyses: readonly CandidatePathAnalysisV1[],
): {
  byPath: ReadonlyMap<string, CandidatePathAnalysisV1>;
  ambiguousPaths: ReadonlySet<string>;
  allPaths: readonly string[];
} {
  const grouped = new Map<string, CandidatePathAnalysisV1[]>();
  for (const analysis of candidateAnalyses) {
    const path = canonicalPath(analysis.path);
    const canonical = analysis.status === "analyzed"
      ? {
          path,
          status: "analyzed",
          fragment: {
            nodes: [...analysis.fragment.nodes],
            structuralEdges: [...analysis.fragment.structuralEdges],
            ...(analysis.fragment.refinementRelations
              ? { refinementRelations: [...analysis.fragment.refinementRelations] }
              : {}),
            crossFileClosure: analysis.fragment.crossFileClosure,
          },
        }
      : { path, status: analysis.status };
    const existing = grouped.get(path) ?? [];
    existing.push(canonical as CandidatePathAnalysisV1);
    grouped.set(path, existing);
  }
  const ambiguousPaths = new Set(
    [...grouped].filter(([, values]) => values.length !== 1).map(([path]) => path),
  );
  return {
    byPath: new Map(
      [...grouped]
        .filter(([path]) => !ambiguousPaths.has(path))
        .map(([path, values]) => [path, values[0]!] as const)
        .sort(([left], [right]) => compareIds(left, right)),
    ),
    ambiguousPaths,
    allPaths: [...grouped.keys()].sort(compareIds),
  };
}

function observedCoverageReasons(
  hunks: readonly ObservedDiffHunkV1[],
  changes: readonly ObservationChangeV1[],
): ReadonlySet<ObservationIncompleteReason> {
  const reasons = new Set<ObservationIncompleteReason>();
  const supportedChangeIndexes = new Set<number>();
  for (const hunk of hunks) {
    const matches = changes.flatMap((change, index) =>
      hunkSupportsChange(hunk, change) ? [index] : []);
    if (matches.length === 0) {
      reasons.add("UNMATCHED_OBSERVED_HUNK");
    } else if (matches.length > 1) {
      reasons.add("AMBIGUOUS_OBSERVED_HUNK");
    } else {
      supportedChangeIndexes.add(matches[0]!);
    }
  }
  changes.forEach((change, index) => {
    if (!supportedChangeIndexes.has(index)) {
      reasons.add("UNMATCHED_SOURCE_CHANGE");
      return;
    }
    if (change.kind !== "rename") return;
    const oldMatches = hunks.filter((hunk) =>
      hunkKind(hunk) === "delete" && hunk.normalizedPath === change.oldPath);
    const newMatches = hunks.filter((hunk) =>
      hunkKind(hunk) === "add" && hunk.normalizedPath === change.newPath);
    if (oldMatches.length === 0 || newMatches.length === 0) {
      reasons.add("UNMATCHED_SOURCE_CHANGE");
    }
  });
  return reasons;
}

function candidateAnalysisCoverageReasons(
  changes: readonly ObservationChangeV1[],
  analyses: ReturnType<typeof canonicalAnalyses>,
): ReadonlySet<ObservationIncompleteReason> {
  const reasons = new Set<ObservationIncompleteReason>();
  if (analyses.ambiguousPaths.size > 0) {
    reasons.add("AMBIGUOUS_CANDIDATE_ANALYSIS");
  }
  const analyzableChanges = changes.filter(
    (change): change is Exclude<ObservationChangeV1, { kind: "delete" }> =>
      change.kind !== "delete",
  );
  for (const path of analyses.allPaths) {
    const matches = analyzableChanges.filter((change) => newSidePath(change) === path);
    if (matches.length === 0) {
      reasons.add("UNMATCHED_CANDIDATE_ANALYSIS");
    } else if (matches.length > 1) {
      reasons.add("AMBIGUOUS_CANDIDATE_ANALYSIS");
    }
  }
  for (const change of analyzableChanges) {
    const path = newSidePath(change);
    const matchingChanges = analyzableChanges.filter((candidate) =>
      newSidePath(candidate) === path);
    if (
      matchingChanges.length !== 1
      || analyses.ambiguousPaths.has(path)
      || !analyses.byPath.has(path)
    ) {
      reasons.add("CANDIDATE_ANALYSIS_MISSING");
    }
  }
  return reasons;
}

function hunkSupportsChange(
  hunk: ObservedDiffHunkV1,
  change: ObservationChangeV1,
): boolean {
  const kind = hunkKind(hunk);
  if (change.kind === "add") return kind === "add" && hunk.normalizedPath === change.newPath;
  if (change.kind === "modify") return kind === "modify" && hunk.normalizedPath === change.path;
  if (change.kind === "delete") return kind === "delete" && hunk.normalizedPath === change.oldPath;
  return (kind === "delete" && hunk.normalizedPath === change.oldPath)
    || (kind === "add" && hunk.normalizedPath === change.newPath);
}

function hunkKind(
  hunk: ObservedDiffHunkV1,
): "add" | "modify" | "delete" | "unsupported" {
  if (hunk.oldBlobId === null && hunk.newBlobId !== null) return "add";
  if (hunk.oldBlobId !== null && hunk.newBlobId === null) return "delete";
  if (hunk.oldBlobId !== null && hunk.newBlobId !== null) return "modify";
  return "unsupported";
}

function newSidePath(
  change: Exclude<ObservationChangeV1, { kind: "delete" }>,
): string {
  return change.kind === "modify" ? change.path : change.newPath;
}

function findAmbiguousRenameKeys(
  changes: readonly ObservationChangeV1[],
): ReadonlySet<string> {
  const ambiguous = new Set<string>();
  const renames = changes.filter(
    (change): change is Extract<ObservationChangeV1, { kind: "rename" }> =>
      change.kind === "rename",
  );
  for (const rename of renames) {
    const matchingOld = changes.filter((change) =>
      change.kind !== "add" && change.oldSourceDigest === rename.oldSourceDigest);
    const matchingNew = changes.filter((change) =>
      change.kind !== "delete" && change.newSourceDigest === rename.newSourceDigest);
    if (matchingOld.length !== 1 || matchingNew.length !== 1) {
      ambiguous.add(changeKey(rename));
    }
  }
  return ambiguous;
}

function duplicateRenameKeys(
  changes: readonly ObservationChangeV1[],
): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const change of changes) {
    if (change.kind !== "rename") continue;
    const key = changeKey(change);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
}

function isAmbiguousRename(
  change: ObservationChangeV1,
  ambiguous: ReadonlySet<string>,
): boolean {
  return change.kind === "rename" && ambiguous.has(changeKey(change));
}

function nodeBelongsToExactPath(node: CoordinateNodeV2, path: string): boolean {
  const metadataPaths = ["path", "filePath", "normalizedPath"]
    .flatMap((key) => node.metadata?.[key] ? [node.metadata[key]] : []);
  return metadataPaths.some((candidate) => canonicalPath(candidate) === path)
    || node.references.some((reference) => referencePath(reference) === path);
}

function referencePath(reference: string): string | undefined {
  const withoutLocation = reference.replace(/:\d+(?::\d+)?$/, "");
  try {
    return canonicalPath(withoutLocation);
  } catch {
    return undefined;
  }
}

function observedNode(hunk: ObservedDiffHunkV1): CoordinateNodeV2 {
  return {
    id: hunk.identity,
    plane: "observed",
    sourceId: hunk.identity,
    sourceKind: "observed_diff_hunk",
    appliesAtLevel: 0,
    category: "syntax",
    label: `${hunk.normalizedPath}:${hunk.newRange.start}`,
    epistemicStatus: "statically_observed",
    references: [hunk.identity],
    metadata: {
      normalizedPath: hunk.normalizedPath,
      repositoryIdentity: hunk.repositoryIdentity,
    },
  };
}

function endpointCoordinateId(
  endpoint: RefinementRelationV1["source"],
): CoordinateNodeV2["id"] {
  return endpoint.plane === "A"
    ? endpoint.coordinateDigest
    : `semantic:${endpoint.nodeId}` as CoordinateNodeV2["id"];
}

function buildCoverage(
  nodes: readonly CoordinateNodeV2[],
): CoordinateGraphReportV2["coverage"] {
  return ([0, 1, 2, 3, 4, 5, 6] as const).map((level) => {
    const atLevel = nodes.filter((node) => node.appliesAtLevel === level);
    return {
      level,
      categories: [...new Set(atLevel.flatMap((node) =>
        node.category === null ? [] : [node.category]))].sort(compareIds),
      coordinateIds: atLevel.map((node) => node.id).sort(compareIds),
    };
  });
}

function statusReason(
  status: Exclude<CandidatePathAnalysisV1["status"], "analyzed">,
): ObservationIncompleteReason {
  if (status === "binary") return "BINARY_CONTENT";
  if (status === "unsupported") return "UNSUPPORTED_CONTENT";
  return "ANALYZER_FAILURE";
}

function canonicalPath(path: string): string {
  return normalizeCanonicalRepoRelativePath(path);
}

function digest(value: Sha256Hash): Sha256Hash {
  return parseSha256Hash(value, "source digest");
}

function changeKey(change: ObservationChangeV1): string {
  if (change.kind === "add") {
    return `${change.kind}\0${change.newPath}\0${change.newSourceDigest}`;
  }
  if (change.kind === "modify") {
    return `${change.kind}\0${change.path}\0${change.oldSourceDigest}\0${change.newSourceDigest}`;
  }
  if (change.kind === "delete") {
    return `${change.kind}\0${change.oldPath}\0${change.oldSourceDigest}`;
  }
  return `${change.kind}\0${change.oldPath}\0${change.newPath}\0${change.oldSourceDigest}\0${change.newSourceDigest}`;
}

function edgeKey(edge: CoordinateEdge): string {
  return `${edge.from}\0${edge.to}\0${edge.relation}\0${edge.sourceRelation ?? ""}\0${edge.evidenceRefs.join("\u0001")}`;
}

function uniqueSorted<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()]
    .sort((left, right) => compareIds(key(left), key(right)));
}

function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`duplicate ${label}`);
  }
}
