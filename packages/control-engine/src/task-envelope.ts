import type { TaskFrame } from "@semantic-context/core";
import {
  CandidateAnchorV1Schema,
  ResolvedBindingV1Schema,
  TaskEnvelopeV1Schema,
  TaskFrameSnapshotV1Schema,
  computeTaskEnvelopeV1Hash,
  computeTaskFrameSnapshotV1Hash,
  normalizeCanonicalRepoRelativePath,
  normalizeTaskEnvelopeV1,
  serializeControlReport,
  sha256HashUtf8,
  type CandidateAnchorV1,
  type CoordinateGraphReportV2,
  type DeclaredReconciliationScopeV1,
  type RefinementProfileV1,
  type ResolvedBindingScopeV1,
  type ResolvedBindingV1,
  type Sha256Hash,
  type TargetReferenceV1,
  type TaskEnvelopeV1,
  type TaskFrameSnapshotV1,
} from "@semantic-context/control-model/reconciliation";
import {
  ReconciliationChangeContractSchema,
  type ChangeContract,
  type RepositoryLink,
} from "@semantic-context/semantic-model/reconciliation-read";
import { selectRefinementProfile } from "./refinement-planner";
import { parseCoordinateGraphV2 } from "./reconciliation-validation";

export type TaskEnvelopeCompilationReason =
  | "INPUT_SCHEMA_INVALID"
  | "CHANGE_CONTRACT_HASH_MISMATCH"
  | "INDEX_STALE"
  | "CONTROL_INPUTS_UNSEALED"
  | "ANCHOR_UNRESOLVED"
  | "ANCHOR_STALE"
  | "ANCHOR_NOT_AUTHORED"
  | "COORDINATE_UNKNOWN"
  | "TARGET_REVISION_MISMATCH";

export class TaskEnvelopeCompilationError extends Error {
  constructor(
    readonly reason: TaskEnvelopeCompilationReason,
    message: string,
  ) {
    super(message);
    this.name = "TaskEnvelopeCompilationError";
  }
}

export interface TaskFrameAdvisoryV1 {
  profileCandidate?: RefinementProfileV1;
  altitudeCandidate?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

export interface AuthoredLinkResolutionInputV1 {
  link: RepositoryLink;
  resolved: boolean;
  coordinateId?: `repo:${string}`;
  repositoryPath?: string;
  evidenceId?: string;
  evidenceProvenance?: BindingEvidenceProvenanceV1;
  scope?: ResolvedBindingScopeV1;
}

export type BindingEvidenceProvenanceV1 =
  | "plane_b_source"
  | "static_analysis"
  | "test"
  | "manual_discovery";

export interface ExplicitDiscoveryInputV1 {
  coordinateId: `repo:${string}`;
  repositoryPath: string;
  evidenceId: string;
  evidenceProvenance: Exclude<BindingEvidenceProvenanceV1, "plane_b_source">;
  scope: ResolvedBindingScopeV1;
}

export interface BindExplicitAnchorsInput {
  change: ChangeContract;
  graph: CoordinateGraphReportV2;
  planningCommit: string;
  graphSeal: Sha256Hash;
  candidateAnchors?: readonly CandidateAnchorV1[];
  authoredLinkResolutions?: readonly AuthoredLinkResolutionInputV1[];
  explicitDiscoveries?: readonly ExplicitDiscoveryInputV1[];
}

export interface BoundExplicitAnchorsV1 {
  candidateAnchors: readonly CandidateAnchorV1[];
  resolvedBindings: readonly ResolvedBindingV1[];
  declaredReconciliationScope: DeclaredReconciliationScopeV1;
  advisoryDiagnostics: readonly string[];
}

export interface TargetSelectionInputV1 {
  reference: TargetReferenceV1;
}

export interface CompileTaskEnvelopeInput extends BindExplicitAnchorsInput {
  taskFrame: TaskFrame;
  taskFrameAdvisory?: TaskFrameAdvisoryV1;
  indexSeal: Sha256Hash;
  baselineFreshnessSeal: Sha256Hash;
  targetSelection?: TargetSelectionInputV1;
  expectedChangeContractHash?: Sha256Hash;
}

export function createCandidateAnchor(
  input: Omit<CandidateAnchorV1, "schemaVersion">,
): CandidateAnchorV1 {
  return CandidateAnchorV1Schema.parse({ schemaVersion: 1, ...input }) as CandidateAnchorV1;
}

export function createResolvedBinding(input: {
  provenance: ResolvedBindingV1["provenance"];
  coordinateId: `repo:${string}`;
  repositoryPath: string;
  evidenceId: string;
  evidenceProvenance: BindingEvidenceProvenanceV1;
  planningCommit: string;
  graphSeal: Sha256Hash;
  scope: ResolvedBindingScopeV1;
}): ResolvedBindingV1 {
  if (!isBindingEvidenceProvenance(input.evidenceProvenance)) {
    throw new TaskEnvelopeCompilationError(
      "ANCHOR_NOT_AUTHORED",
      "LLM-only, import-only, and proximity-only evidence cannot create a binding",
    );
  }
  const repositoryPath = normalizeCanonicalRepoRelativePath(input.repositoryPath);
  const bindingId = `binding:${digestId({
    provenance: input.provenance,
    coordinateId: input.coordinateId,
    repositoryPath,
    evidenceId: input.evidenceId,
    evidenceProvenance: input.evidenceProvenance,
    planningCommit: input.planningCommit,
    graphSeal: input.graphSeal,
    scope: input.scope,
  })}`;
  return ResolvedBindingV1Schema.parse({
    schemaVersion: 1,
    bindingId,
    provenance: input.provenance,
    coordinateId: input.coordinateId,
    repositoryPath,
    evidenceId: input.evidenceId,
    planningCommit: input.planningCommit,
    graphSeal: input.graphSeal,
    scope: input.scope,
  }) as ResolvedBindingV1;
}

export function snapshotTaskFrame(
  taskFrame: TaskFrame,
  advisory: TaskFrameAdvisoryV1 = {},
): TaskFrameSnapshotV1 {
  const snapshot: TaskFrameSnapshotV1 = {
    schemaVersion: 1,
    taskFrameId: taskFrame.id,
    rawTaskDigest: sha256HashUtf8(taskFrame.rawTask),
    mode: taskFrame.mode,
    createdAt: taskFrame.createdAt,
    capabilitySignals: sortedUnique(taskFrame.capabilities),
    riskSignals: sortedUnique(taskFrame.riskSurfaces),
    descriptiveNonGoals: sortedUnique(taskFrame.nonGoals),
    ...(advisory.profileCandidate === undefined
      ? {}
      : { profileCandidate: advisory.profileCandidate }),
    ...(advisory.altitudeCandidate === undefined
      ? {}
      : { altitudeCandidate: advisory.altitudeCandidate }),
  };
  return TaskFrameSnapshotV1Schema.parse(snapshot) as TaskFrameSnapshotV1;
}

export function bindExplicitAnchors(input: BindExplicitAnchorsInput): BoundExplicitAnchorsV1 {
  parseGraph(input.graph);
  parseChange(input.change);
  const repoCoordinateIds = new Set(
    input.graph.nodes
      .filter((node) => node.plane === "repo" && node.id.startsWith("repo:"))
      .map((node) => node.id as `repo:${string}`),
  );
  const candidates = (input.candidateAnchors ?? [])
    .map((candidate) => CandidateAnchorV1Schema.parse(candidate) as CandidateAnchorV1);
  const diagnostics = candidates.map((candidate) =>
    `candidate_only:${candidate.anchorId}:${candidate.provenance}`,
  );
  const resolutions = input.authoredLinkResolutions ?? [];
  const bindings: ResolvedBindingV1[] = [];

  for (const link of input.change.repositoryLinks) {
    const matches = resolutions.filter((resolution) => linksEqual(resolution.link, link));
    if (matches.length !== 1) {
      throw new TaskEnvelopeCompilationError(
        "ANCHOR_UNRESOLVED",
        `authored repository link ${link.kind}:${link.ref} requires one exact resolution`,
      );
    }
    const resolution = matches[0]!;
    if (
      !resolution.resolved
      || !resolution.coordinateId
      || !resolution.repositoryPath
      || !resolution.evidenceId
      || !resolution.evidenceProvenance
      || !resolution.scope
    ) {
      throw new TaskEnvelopeCompilationError(
        "ANCHOR_UNRESOLVED",
        `authored repository link ${link.kind}:${link.ref} is unresolved`,
      );
    }
    if (!repoCoordinateIds.has(resolution.coordinateId)) {
      throw new TaskEnvelopeCompilationError(
        "ANCHOR_STALE",
        `resolved coordinate ${resolution.coordinateId} is absent from the sealed graph`,
      );
    }
    assertCoordinatePath(
      input.graph,
      resolution.coordinateId,
      resolution.repositoryPath,
    );
    if (link.kind === "file") {
      if (
        resolution.scope.kind !== "file"
        || resolution.scope.path !== normalizeCanonicalRepoRelativePath(link.ref)
      ) {
        throw new TaskEnvelopeCompilationError(
          "ANCHOR_NOT_AUTHORED",
          `file link ${link.ref} may bind only its exact canonical file`,
        );
      }
    }
    bindings.push(createResolvedBinding({
      provenance: "authored_link",
      coordinateId: resolution.coordinateId,
      repositoryPath: resolution.repositoryPath,
      evidenceId: resolution.evidenceId,
      evidenceProvenance: resolution.evidenceProvenance,
      planningCommit: input.planningCommit,
      graphSeal: input.graphSeal,
      scope: resolution.scope,
    }));
  }

  for (const discovery of input.explicitDiscoveries ?? []) {
    if (!repoCoordinateIds.has(discovery.coordinateId)) {
      throw new TaskEnvelopeCompilationError(
        "COORDINATE_UNKNOWN",
        `explicit discovery coordinate ${discovery.coordinateId} is absent from the sealed graph`,
      );
    }
    assertCoordinatePath(input.graph, discovery.coordinateId, discovery.repositoryPath);
    bindings.push(createResolvedBinding({
      provenance: "explicit_discovery",
      coordinateId: discovery.coordinateId,
      repositoryPath: discovery.repositoryPath,
      evidenceId: discovery.evidenceId,
      evidenceProvenance: discovery.evidenceProvenance,
      planningCommit: input.planningCommit,
      graphSeal: input.graphSeal,
      scope: discovery.scope,
    }));
  }

  const uniqueBindings = uniqueBy(bindings, (binding) => binding.bindingId)
    .sort((left, right) => compareText(left.bindingId, right.bindingId));
  if (uniqueBindings.length === 0) {
    throw new TaskEnvelopeCompilationError(
      "ANCHOR_UNRESOLVED",
      "at least one explicit, evidence-bearing repository binding is required",
    );
  }
  return {
    candidateAnchors: [...candidates].sort((left, right) =>
      compareText(left.anchorId, right.anchorId)
    ),
    resolvedBindings: uniqueBindings,
    declaredReconciliationScope: declaredScope(uniqueBindings),
    advisoryDiagnostics: sortedUnique(diagnostics),
  };
}

export function compileTaskEnvelope(input: CompileTaskEnvelopeInput): TaskEnvelopeV1 {
  const graph = parseGraph(input.graph);
  const change = parseChange(input.change);
  if (graph.staleLinks.some((item) => item.ownerId === change.id)) {
    throw new TaskEnvelopeCompilationError(
      "INDEX_STALE",
      `change ${change.id} has stale authored repository links`,
    );
  }
  const changeContractHash = computeChangeContractHash(change);
  if (
    input.expectedChangeContractHash !== undefined
    && input.expectedChangeContractHash !== changeContractHash
  ) {
    throw new TaskEnvelopeCompilationError(
      "CHANGE_CONTRACT_HASH_MISMATCH",
      "the supplied ChangeContract hash does not match canonical content",
    );
  }
  const snapshot = snapshotTaskFrame(input.taskFrame, input.taskFrameAdvisory);
  const bound = bindExplicitAnchors({ ...input, change, graph });
  const target = classifyTarget(change, input.targetSelection);
  const selection = selectRefinementProfile({
    mode: snapshot.mode,
    riskSignals: snapshot.riskSignals,
    profileCandidate: snapshot.profileCandidate,
    altitudeCandidate: snapshot.altitudeCandidate,
    hasAuthoredTarget: target.authored !== undefined,
  });
  const payload: Omit<TaskEnvelopeV1, "envelopeHash"> = {
    schemaVersion: 1,
    kind: "task_envelope",
    executionAuthority: "none",
    envelopeId: `envelope:${digestId({
      taskFrameId: snapshot.taskFrameId,
      changeId: change.id,
      planningCommit: input.planningCommit,
      graphSeal: input.graphSeal,
      indexSeal: input.indexSeal,
    })}`,
    planningCommit: input.planningCommit,
    taskFrameSnapshot: snapshot,
    taskFrameHash: computeTaskFrameSnapshotV1Hash(snapshot),
    changeId: change.id,
    changeContractHash,
    coordinateGraphSeal: input.graphSeal,
    indexSeal: input.indexSeal,
    baselineFreshnessSeal: input.baselineFreshnessSeal,
    profile: selection.profile,
    risk: selection.risk,
    requiredAltitude: selection.requiredAltitude,
    candidateAnchors: bound.candidateAnchors,
    resolvedBindings: bound.resolvedBindings,
    parentIntentIds: sortedUnique(change.serves),
    preservedInvariantIds: sortedUnique(change.preserves),
    nonGoals: snapshot.descriptiveNonGoals ?? [],
    expectedBehaviorDelta: change.statement.length === 0 ? [] : [change.statement],
    declaredReconciliationScope: bound.declaredReconciliationScope,
    proofObligationIds: sortedUnique(change.requiresEvidence),
    ...(target.authored === undefined ? {} : { authoredTargetBinding: target.authored }),
    ...(target.advisory === undefined ? {} : { advisoryTargetRef: target.advisory }),
    compatibilityNotes: sortedUnique([
      ...selection.reasons,
      ...bound.advisoryDiagnostics,
      ...(target.authored === undefined ? [] : ["target_acceptance_requires_app_service_validation"]),
    ]),
  };
  const normalized = normalizeTaskEnvelopeV1({
    ...payload,
    envelopeHash: sha256HashUtf8("pending"),
  });
  const envelope = {
    ...normalized,
    envelopeHash: computeTaskEnvelopeV1Hash(normalized),
  };
  return TaskEnvelopeV1Schema.parse(envelope) as TaskEnvelopeV1;
}

export function computeChangeContractHash(change: ChangeContract): Sha256Hash {
  const normalized = {
    ...change,
    sourceRefs: [...change.sourceRefs].sort((left, right) =>
      compareText(left.file, right.file) || left.line - right.line
    ),
    serves: sortedUnique(change.serves),
    preserves: sortedUnique(change.preserves),
    requiresEvidence: sortedUnique(change.requiresEvidence),
    openUnknowns: sortedUnique(change.openUnknowns),
    repositoryLinks: [...change.repositoryLinks].sort((left, right) =>
      compareText(left.kind, right.kind) || compareText(left.ref, right.ref)
    ),
    tags: sortedUnique(change.tags),
    ...(change.metadata === undefined
      ? {}
      : {
          metadata: Object.fromEntries(
            Object.entries(change.metadata).sort(([left], [right]) => compareText(left, right)),
          ),
        }),
  };
  return sha256HashUtf8(`SEMCTX_CHANGE_CONTRACT_V1\0${serializeControlReport(normalized)}`);
}

function classifyTarget(
  change: ChangeContract,
  selection: TargetSelectionInputV1 | undefined,
): {
  authored?: TargetReferenceV1;
  advisory?: TargetReferenceV1;
} {
  const authored = change.targetBinding;
  if (authored !== undefined) {
    if (
      selection === undefined
      || !targetsEqual(authored, selection.reference)
    ) {
      throw new TaskEnvelopeCompilationError(
        "TARGET_REVISION_MISMATCH",
        "an authored target binding requires the exact selected target revision",
      );
    }
    return { authored: selection.reference };
  }
  return selection === undefined ? {} : { advisory: selection.reference };
}

function declaredScope(bindings: readonly ResolvedBindingV1[]): DeclaredReconciliationScopeV1 {
  if (bindings.length === 1) {
    const binding = bindings[0]!;
    if (binding.scope.kind === "exact_coordinate") {
      return {
        kind: "exact_coordinate",
        bindingId: binding.bindingId,
        coordinateId: binding.scope.coordinateId,
      };
    }
    if (binding.scope.kind === "file") {
      return { kind: "file", bindingId: binding.bindingId, path: binding.scope.path };
    }
    return {
      kind: "coordinate_set",
      bindingIds: [binding.bindingId],
      coordinateIds: sortedUnique(binding.scope.coordinateIds),
    };
  }
  const coordinateIds = sortedUnique(bindings.flatMap((binding) =>
    binding.scope.kind === "coordinate_set"
      ? binding.scope.coordinateIds
      : binding.scope.kind === "exact_coordinate"
        ? [binding.scope.coordinateId]
        : [binding.coordinateId]
  ));
  const filePaths = sortedUnique(bindings.flatMap((binding) =>
    binding.scope.kind === "file" ? [binding.scope.path] : []
  ));
  return {
    kind: "coordinate_set",
    bindingIds: sortedUnique(bindings.map((binding) => binding.bindingId)),
    coordinateIds,
    ...(filePaths.length === 0 ? {} : { filePaths }),
  };
}

function parseGraph(graph: CoordinateGraphReportV2): CoordinateGraphReportV2 {
  try {
    return parseCoordinateGraphV2(graph);
  } catch (error) {
    throw new TaskEnvelopeCompilationError(
      "INPUT_SCHEMA_INVALID",
      `invalid coordinate graph: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

function parseChange(change: ChangeContract): ChangeContract {
  const result = ReconciliationChangeContractSchema.safeParse(change);
  if (!result.success) {
    throw new TaskEnvelopeCompilationError(
      "INPUT_SCHEMA_INVALID",
      `invalid ChangeContract: ${result.error.issues[0]?.message ?? "unknown error"}`,
    );
  }
  return result.data as ChangeContract;
}

function linksEqual(left: RepositoryLink, right: RepositoryLink): boolean {
  return left.kind === right.kind && left.ref === right.ref;
}

function isBindingEvidenceProvenance(value: unknown): value is BindingEvidenceProvenanceV1 {
  return value === "plane_b_source"
    || value === "static_analysis"
    || value === "test"
    || value === "manual_discovery";
}

function assertCoordinatePath(
  graph: CoordinateGraphReportV2,
  coordinateId: `repo:${string}`,
  repositoryPathInput: string,
): void {
  const repositoryPath = normalizeCanonicalRepoRelativePath(repositoryPathInput);
  const node = graph.nodes.find((candidate) => candidate.id === coordinateId);
  const referencedPaths = (node?.references ?? []).flatMap((reference) => {
    const withoutLine = reference.replace(/:\d+(?::\d+)?$/, "");
    try {
      return [normalizeCanonicalRepoRelativePath(withoutLine)];
    } catch {
      return [];
    }
  });
  if (!referencedPaths.includes(repositoryPath)) {
    throw new TaskEnvelopeCompilationError(
      "ANCHOR_STALE",
      `resolved coordinate ${coordinateId} is not sealed to repository path ${repositoryPath}`,
    );
  }
}

function targetsEqual(left: TargetReferenceV1, right: TargetReferenceV1): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.targetId === right.targetId
    && left.revision === right.revision
    && left.artifactHash === right.artifactHash;
}

function digestId(value: unknown): string {
  return sha256HashUtf8(serializeControlReport(value)).slice("sha256:".length, "sha256:".length + 24);
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareText);
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
