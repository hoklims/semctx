import { basename } from "node:path";
import {
  boundedContextId,
  capabilityId,
  contractId,
  invariantId,
  moduleId,
  repositoryId,
  riskId,
  symbolId,
  testId,
  type EvidenceRef,
  type SemctxConfig,
} from "@semantic-context/core";
import {
  addAggregatedImportEdges,
  attachPlaneASidecar,
  canonicalSourceText,
  DeterministicGraphAssembler,
  digestCanonical,
  getPlaneASidecar,
  normalizeDiscoveryLedgerEntry,
  type ArtifactScope,
  type CapabilityProfile,
  type DiscoveryLedgerEntry,
  type FactBatchV1,
  type ImportEdgeOccurrence,
  type PlaneAFact,
  type PlaneASidecarV1,
  type ProducerIdentity,
  type ProducerResult,
  type UnresolvedReference,
} from "@semantic-context/plane-a-internal";
import {
  extractPython,
  type PythonExtraction,
  type PythonImport,
  type PythonLimitation,
  type PythonMarker,
} from "@semantic-context/python-analyzer";
import {
  analyzeRepository,
  type AnalysisResult,
  type DiscoveredFile,
  type DiscoveryCandidate,
  type DiscoveryResult,
  TYPESCRIPT_DIALECT_VERSION,
} from "@semantic-context/ts-analyzer";
import {
  analyzeWorkspaceSync,
  type WorkspaceArtifact,
  type WorkspaceProjection,
} from "@semantic-context/workspace-analyzer-internal";

const TYPESCRIPT_PRODUCER: ProducerIdentity = {
  identity: "@semantic-context/ts-analyzer",
  version: "0.1.0",
};

const PYTHON_PRODUCER: ProducerIdentity = {
  identity: "@semantic-context/python-analyzer",
  version: "0.1.0",
};

const RUNTIME_FACT_SCHEMA = {
  schemaVersion: 1,
  facts: ["node", "edge"],
  evidence: "source-lines-v1",
  languages: ["typescript", "python", "markdown", "sql"],
} as const;

export interface PlaneARuntimeResult {
  readonly analysis: AnalysisResult;
  readonly sidecar: PlaneASidecarV1;
  readonly discoveryLedger: readonly DiscoveryLedgerEntry[];
  readonly workspaceProjection: WorkspaceProjection;
}

interface PerPathAnalysis {
  readonly candidate: DiscoveryCandidate;
  readonly file: DiscoveredFile;
  readonly producer: ProducerIdentity;
  readonly facts: readonly PlaneAFact[];
  readonly analysisReasons: readonly string[];
  readonly completenessClaim: string;
  readonly negativeEvidenceEligible: boolean;
  readonly resolutionSemantics: string;
}

interface PythonFacts {
  readonly factsByPath: ReadonlyMap<string, readonly PlaneAFact[]>;
  readonly reasonsByPath: ReadonlyMap<string, readonly string[]>;
}

/**
 * Private Plane-A composition seam. This module is intentionally absent from the package root.
 */
export function analyzePlaneARuntime(
  config: SemctxConfig,
  discovery: DiscoveryResult,
): PlaneARuntimeResult {
  const legacyAnalysis = analyzeRepository(config, discovery.files);
  const legacySidecar = getPlaneASidecar(legacyAnalysis);
  if (legacySidecar === undefined) {
    throw new Error("TypeScript analysis did not provide its private Plane-A sidecar");
  }

  const repositoryIdentity = repositoryId(config.repositoryRoot);
  const producerConfigurationDigest = digestCanonical(config);
  const factSchemaDigest = config.version === 1
    ? legacySidecar.factSchemaDigest
    : digestCanonical(RUNTIME_FACT_SCHEMA);
  const filesByPath = new Map(discovery.files.map((file) => [file.relPath, file]));
  const selectedAnalyzable = discovery.candidates.filter((candidate) =>
    candidate.selectionDecision === "selected"
    && candidate.analysisOutcome === undefined
    && filesByPath.has(candidate.relPath));
  const forcedOutcomes = new Map<string, DiscoveryLedgerEntry["analysisOutcome"]>();
  const forcedAnalysisReasons = new Map<string, readonly string[]>();
  const legacyFacts = legacySidecar.factBatches.flatMap((batch) => batch.facts);
  const legacyFactsByPath = partitionFacts(legacySidecar.factBatches);
  const repositoryFacts = legacyFacts.filter((fact) =>
    fact.factType === "node"
    && fact.filePath === undefined
    && fact.evidence.length === 0);
  const repositoryFactBatches = legacySidecar.factBatches.filter((batch) =>
    batch.facts.some((fact) => repositoryFacts.includes(fact)));
  if (
    repositoryFacts.length > 0
    && (
      repositoryFactBatches.length !== 1
      || repositoryFactBatches[0]!.facts.some((fact) => !repositoryFacts.includes(fact))
    )
  ) {
    throw new Error("TypeScript repository facts are not isolated in one producer batch");
  }
  let pythonFacts: PythonFacts | undefined;
  if (config.version === 2) {
    const pythonFiles = selectedAnalyzable
      .filter((candidate) => candidate.language === "python")
      .map((candidate) => filesByPath.get(candidate.relPath))
      .filter((file): file is DiscoveredFile => file !== undefined)
      .filter((file) => {
        if (isCanonicalRepositoryRelativePath(file.relPath)) return true;
        forcedOutcomes.set(file.relPath, "failed");
        forcedAnalysisReasons.set(file.relPath, [
          "PRODUCER_FAILED",
          "invalid-repository-relative-path",
        ]);
        return false;
      });
    if (pythonFiles.length > 0) {
      pythonFacts = buildPythonFacts(pythonFiles, repositoryIdentity);
    }
  }

  const perPath: PerPathAnalysis[] = [];
  for (const candidate of selectedAnalyzable) {
    const file = filesByPath.get(candidate.relPath);
    if (file === undefined) continue;
    if (candidate.language === "python") {
      if (config.version === 1) continue;
      if (forcedOutcomes.has(candidate.relPath)) {
        continue;
      }
      if (pythonFacts === undefined) {
        throw new Error("Python analysis did not return facts for an admitted scope");
      }
      const reasons = pythonFacts.reasonsByPath.get(candidate.relPath) ?? [];
      perPath.push({
        candidate,
        file,
        producer: PYTHON_PRODUCER,
        facts: pythonFacts.factsByPath.get(candidate.relPath) ?? [],
        analysisReasons: reasons,
        completenessClaim: reasons.length === 0 ? "producer-declared" : "partial",
        negativeEvidenceEligible: false,
        resolutionSemantics: "python-static-local-imports-v1",
      });
      continue;
    }
    if (
      candidate.language === "typescript"
      || candidate.language === "markdown"
      || candidate.language === "sql"
    ) {
      perPath.push({
        candidate,
        file,
        producer: TYPESCRIPT_PRODUCER,
        facts: legacyFactsByPath.get(candidate.relPath) ?? [],
        analysisReasons: [],
        completenessClaim: "producer-declared",
        negativeEvidenceEligible: false,
        resolutionSemantics: candidate.language === "typescript"
          ? "typescript-static-v1"
          : "structural-source-v1",
      });
    }
  }

  const provisionalArtifacts = mergeWorkspaceArtifacts(
    workspaceArtifacts(legacyAnalysis),
    workspaceArtifactsFromFacts(
      [...(pythonFacts?.factsByPath.values() ?? [])].flat(),
    ),
  );
  const workspaceProjection = analyzeWorkspaceSync({
    repositoryRoot: config.repositoryRoot,
    repositoryId: repositoryIdentity,
    artifacts: provisionalArtifacts,
  });
  const workspaceUnitByPath = workspaceUnitsByPath(
    workspaceProjection,
    provisionalArtifacts,
  );

  const capabilityProfiles: CapabilityProfile[] = [];
  const factBatches: FactBatchV1[] = [];
  const producerResults: ProducerResult[] = [];
  const completedByPath = new Map<string, {
    scope: ArtifactScope;
    producer: ProducerIdentity;
  }>();

  const repositoryBatchIds = new Set(
    repositoryFactBatches.map((batch) => batch.batchId),
  );
  const repositoryProfileIds = new Set(
    repositoryFactBatches.flatMap((batch) => batch.capabilityProfileIds),
  );
  capabilityProfiles.push(...legacySidecar.capabilityProfiles.filter((profile) =>
    repositoryProfileIds.has(profile.profileId)));
  factBatches.push(...repositoryFactBatches);
  producerResults.push(...legacySidecar.producerResults.filter((result) =>
    repositoryBatchIds.has(result.factBatchId)));

  const orderedPerPath = [...perPath].sort((left, right) =>
    compareText(left.candidate.relPath, right.candidate.relPath));
  for (const item of orderedPerPath) {
    const scope = scopeForCandidate(
      repositoryIdentity,
      item.candidate,
      item.file,
      workspaceUnitByPath.get(item.candidate.relPath),
    );
    const facts = canonicalizeFacts(item.facts);
    const factKinds = [...new Set(facts.map((fact) => fact.kind))].sort(compareText);
    const profiles = factKinds.map((factKind): CapabilityProfile => {
      const profileId = digestCanonical({
        factKind,
        scope,
        producer: item.producer,
        producerConfigurationDigest,
        factSchemaDigest,
      });
      return {
        profileId,
        factKind,
        scope,
        producer: item.producer,
        producerConfigurationDigest,
        factSchemaDigest,
        evidenceContract: "source-lines-v1",
        resolutionSemantics: item.resolutionSemantics,
        soundnessClaim: "best-effort-static",
        completenessClaim: item.completenessClaim,
        negativeEvidenceEligible: item.negativeEvidenceEligible,
        label: item.analysisReasons.length === 0 ? "structural" : "partial",
      };
    });
    const sourceDigest = scope.sourceStateDigest;
    const batchId = digestCanonical({
      scope,
      producer: item.producer,
      producerConfigurationDigest,
      factSchemaDigest,
      facts,
    });
    const batch: FactBatchV1 = {
      schemaVersion: 1,
      batchId,
      scope,
      producer: item.producer,
      producerConfigurationDigest,
      factSchemaDigest,
      sourceDigest,
      factKinds,
      capabilityProfileIds: profiles.map((profile) => profile.profileId),
      evidenceContract: "source-lines-v1",
      facts,
    };
    const result: ProducerResult = {
      resultId: digestCanonical({
        batchId,
        sourceDigest,
        producerConfigurationDigest,
        factSchemaDigest,
      }),
      status: "completed",
      producer: item.producer,
      scope,
      factBatchId: batchId,
    };
    capabilityProfiles.push(...profiles);
    factBatches.push(batch);
    producerResults.push(result);
    completedByPath.set(item.candidate.relPath, { scope, producer: item.producer });
  }

  const discoveryLedger = discovery.candidates
    .map((candidate): DiscoveryLedgerEntry => {
      const file = filesByPath.get(candidate.relPath);
      const completed = completedByPath.get(candidate.relPath);
      const outcome = forcedOutcomes.get(candidate.relPath)
        ?? candidate.analysisOutcome
        ?? (completed === undefined ? "failed" : "analyzed");
      const analysisReasons = outcome === "analyzed"
        ? perPath.find((item) => item.candidate.relPath === candidate.relPath)?.analysisReasons ?? []
        : outcome === "failed"
          ? forcedAnalysisReasons.get(candidate.relPath) ?? ["PRODUCER_FAILED"]
          : [candidate.reason];
      return normalizeDiscoveryLedgerEntry({
        candidateIdentity: `${candidate.language}:${candidate.relPath}`,
        scope: scopeForCandidate(
          repositoryIdentity,
          candidate,
          file,
          workspaceUnitByPath.get(candidate.relPath),
        ),
        selectionDecision: candidate.selectionDecision,
        analysisOutcome: outcome,
        selectionReasons: candidate.reason === "SELECTED" ? [] : [candidate.reason],
        analysisReasons,
        ...(completed === undefined ? {} : { selectedProducer: completed.producer }),
      });
    })
    .sort((left, right) => compareText(left.candidateIdentity, right.candidateIdentity));

  const assembled = config.version === 1
    ? legacyAnalysis
    : extendLegacyAnalysis(
        legacyAnalysis,
        factBatches
          .filter((batch) => batch.producer.identity === PYTHON_PRODUCER.identity)
          .flatMap((batch) => batch.facts),
        discovery.files.map((file) => file.relPath),
      );
  const analysis: AnalysisResult = assembled;
  const selectedPaths = discovery.candidates
    .filter((candidate) => candidate.selectionDecision === "selected")
    .map((candidate) => candidate.relPath)
    .sort(compareText);
  const sourceDigest = digestCanonical(discovery.files
    .map(sourceInput)
    .sort((left, right) => compareText(left.relPath, right.relPath)));
  const sidecar: PlaneASidecarV1 = {
    schemaVersion: 1,
    scope: {
      repositoryIdentity,
      sourceStateDigest: sourceDigest,
      selectedPathSetDigest: digestCanonical(selectedPaths),
      selectedPaths,
      language: "repository",
    },
    producerConfigurationDigest,
    factSchemaDigest,
    sourceDigest,
    capabilityProfiles: capabilityProfiles.sort((left, right) =>
      compareText(left.profileId, right.profileId)),
    discoveryLedger,
    producerResults: producerResults.sort((left, right) =>
      compareText(left.resultId, right.resultId)),
    factBatches: factBatches.sort((left, right) => compareText(left.batchId, right.batchId)),
  };
  attachPlaneASidecar(analysis, sidecar);

  return { analysis, sidecar, discoveryLedger, workspaceProjection };
}

function buildPythonFacts(
  files: readonly DiscoveredFile[],
  repositoryIdentity: string,
): PythonFacts {
  const extraction = extractPython(files.map((file) => ({
    relPath: file.relPath,
    source: file.content,
  })));
  const builder = new DeterministicGraphAssembler(files.map((file) => file.relPath));
  const filesByPath = new Map(files.map((file) => [file.relPath, file]));
  const moduleIds = new Map<string, string>();

  for (const module of extraction.modules) {
    const file = filesByPath.get(module.relPath);
    if (file === undefined) continue;
    const id = file.role === "test" ? testId(file.relPath) : moduleId(file.relPath);
    moduleIds.set(file.relPath, id);
    const sourceKind = file.role === "test" ? "test" : "code";
    const evidence: EvidenceRef[] = [{ filePath: file.relPath, sourceKind }];
    builder.node({
      id,
      kind: file.role === "test" ? "test" : "module",
      name: basename(file.relPath),
      filePath: file.relPath,
      evidence,
    });
    builder.edge("belongs_to", id, repositoryIdentity, evidence);
  }

  for (const symbol of extraction.symbols) {
    const ownerId = moduleIds.get(symbol.relPath);
    if (ownerId === undefined) continue;
    const file = filesByPath.get(symbol.relPath);
    const sourceKind = file?.role === "test" ? "test" : "code";
    const evidence: EvidenceRef[] = [{
      filePath: symbol.relPath,
      startLine: symbol.range.startLine,
      endLine: symbol.range.endLine,
      sourceKind,
    }];
    const tags = symbol.markers
      .filter((marker) => marker.tag === "tag")
      .map((marker) => marker.slug)
      .sort(compareText);
    const boundedContext = symbol.markers.find((marker) =>
      marker.tag === "boundedContext")?.slug;
    const id = symbolId(symbol.kind, symbol.relPath, symbol.name, symbol.range.startLine);
    builder.node({
      id,
      kind: symbol.kind,
      name: symbol.name,
      filePath: symbol.relPath,
      ...(boundedContext === undefined ? {} : { boundedContext }),
      evidence,
      tags,
    });
    builder.edge("declares", ownerId, id, evidence);
    for (const marker of symbol.markers) {
      addPythonMarker(builder, marker, id, evidence);
    }
  }

  const unresolvedByPath = new Map<string, string[]>();
  const resolvedImportEdges: ImportEdgeOccurrence[] = [];
  for (const item of extraction.imports) {
    const fromId = moduleIds.get(item.fromRelPath);
    if (fromId === undefined) continue;
    const targetPath = resolvePythonImport(item, [...moduleIds.keys()]);
    if (targetPath === undefined) {
      pushReason(
        unresolvedByPath,
        item.fromRelPath,
        `unresolved-import:${item.range.startLine}:${importDescriptor(item)}`,
      );
      continue;
    }
    const toId = moduleIds.get(targetPath);
    if (toId === undefined || toId === fromId) continue;
    const evidence: EvidenceRef = {
      filePath: item.fromRelPath,
      startLine: item.range.startLine,
      endLine: item.range.endLine,
      sourceKind: filesByPath.get(item.fromRelPath)?.role === "test" ? "test" : "code",
    };
    resolvedImportEdges.push({
      from: fromId,
      to: toId,
      evidence: [evidence],
      specifier: importDescriptor(item),
    });
  }
  addAggregatedImportEdges(builder, resolvedImportEdges);

  const factsByPath = new Map<string, PlaneAFact[]>();
  for (const fact of builder.facts()) {
    const path = fact.factType === "node"
      ? fact.filePath ?? fact.evidence[0]?.filePath
      : fact.evidence[0]?.filePath;
    if (path === undefined) continue;
    const group = factsByPath.get(path) ?? [];
    group.push(fact);
    factsByPath.set(path, group);
  }

  const reasonsByPath = limitationReasons(extraction, unresolvedByPath);
  return { factsByPath, reasonsByPath };
}

function addPythonMarker(
  builder: DeterministicGraphAssembler,
  marker: PythonMarker,
  symbolNodeId: string,
  evidence: readonly EvidenceRef[],
): void {
  if (marker.tag === "tag") return;
  const metadata: Readonly<Record<string, string>> =
    marker.statement === undefined ? {} : { statement: marker.statement };
  if (marker.tag === "capability") {
    const id = capabilityId(marker.slug);
    builder.node({ id, kind: "capability", name: marker.slug, evidence, tags: ["from-code"] });
    builder.edge("implements_capability", symbolNodeId, id, evidence);
  } else if (marker.tag === "invariant") {
    const id = invariantId(marker.slug);
    builder.node({ id, kind: "invariant", name: marker.slug, evidence, tags: ["from-code"], metadata });
    builder.edge("constrained_by", symbolNodeId, id, evidence);
  } else if (marker.tag === "contract") {
    const id = contractId(marker.slug);
    builder.node({ id, kind: "contract", name: marker.slug, evidence, tags: ["from-code"], metadata });
    builder.edge("declares", symbolNodeId, id, evidence);
  } else if (marker.tag === "risk") {
    const id = riskId(marker.slug);
    builder.node({ id, kind: "risk", name: marker.slug, evidence, tags: ["from-code"], metadata });
    builder.edge("related_to", symbolNodeId, id, evidence);
  } else {
    const id = boundedContextId(marker.slug);
    builder.node({ id, kind: "bounded_context", name: marker.slug, evidence });
    builder.edge("belongs_to", symbolNodeId, id, evidence);
  }
}

function resolvePythonImport(
  item: PythonImport,
  paths: readonly string[],
): string | undefined {
  const targetNames: string[] = [];
  if (item.relativeLevel > 0) {
    const importerModule = pythonModuleName(item.fromRelPath);
    const importerPackage = item.fromRelPath.endsWith("/__init__.py")
      ? importerModule
      : importerModule.split(".").slice(0, -1).join(".");
    const packageParts = importerPackage.split(".").filter(Boolean);
    const retained = packageParts.slice(0, Math.max(0, packageParts.length - item.relativeLevel + 1));
    if (item.module !== undefined) {
      targetNames.push([...retained, item.module].filter(Boolean).join("."));
    } else {
      for (const name of item.names) {
        if (name.name !== "*") targetNames.push([...retained, name.name].join("."));
      }
    }
  } else if (item.module !== undefined) {
    targetNames.push(item.module);
  }

  const matches = new Set<string>();
  for (const target of targetNames) {
    for (const path of paths) {
      const module = pythonModuleName(path);
      if (module === target) matches.add(path);
    }
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}

function pythonModuleName(relPath: string): string {
  return relPath
    .replace(/\.py$/u, "")
    .replace(/\/__init__$/u, "")
    .replaceAll("/", ".");
}

function importDescriptor(item: PythonImport): string {
  const prefix = ".".repeat(item.relativeLevel);
  const module = item.module ?? "";
  return `${prefix}${module}:${item.names.map((name) => name.name).join(",")}`;
}

function limitationReasons(
  extraction: PythonExtraction,
  additional: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, string[]>();
  for (const limitation of extraction.limitations) {
    pushReason(result, limitation.relPath, limitationReason(limitation));
  }
  for (const [path, reasons] of additional) {
    for (const reason of reasons) pushReason(result, path, reason);
  }
  for (const [path, reasons] of result) {
    result.set(path, [...new Set(reasons)].sort(compareText));
  }
  return result;
}

function limitationReason(limitation: PythonLimitation): string {
  return `${limitation.kind}:${limitation.range.startLine}:${limitation.detail}`;
}

function pushReason(map: Map<string, string[]>, path: string, reason: string): void {
  const reasons = map.get(path) ?? [];
  reasons.push(reason);
  map.set(path, reasons);
}

function partitionFacts(
  batches: readonly FactBatchV1[],
): ReadonlyMap<string, readonly PlaneAFact[]> {
  const result = new Map<string, PlaneAFact[]>();
  for (const fact of batches.flatMap((batch) => batch.facts)) {
    const path = fact.factType === "node"
      ? fact.filePath ?? fact.evidence[0]?.filePath
      : fact.evidence[0]?.filePath;
    if (path === undefined) continue;
    const group = result.get(path) ?? [];
    group.push(fact);
    result.set(path, group);
  }
  return result;
}

function scopeForCandidate(
  repositoryIdentity: string,
  candidate: DiscoveryCandidate,
  file: DiscoveredFile | undefined,
  workspaceUnitId: string | undefined,
): ArtifactScope {
  const selectedPaths = [candidate.relPath];
  return {
    repositoryIdentity,
    sourceStateDigest: digestCanonical(file === undefined ? candidate : sourceInput(file)),
    selectedPathSetDigest: digestCanonical(selectedPaths),
    selectedPaths,
    ...(workspaceUnitId === undefined ? {} : { workspaceUnitId }),
    language: candidate.language,
    ...(candidate.language === "typescript"
      ? { dialectVersion: TYPESCRIPT_DIALECT_VERSION }
      : {}),
    ...(candidate.language === "python" ? { dialectVersion: "<=3.12" } : {}),
  };
}

function sourceInput(file: DiscoveredFile) {
  return {
    relPath: file.relPath,
    role: file.role,
    language: file.language ?? null,
    content: canonicalSourceText(file.content),
  };
}

function workspaceArtifacts(analysis: AnalysisResult): WorkspaceArtifact[] {
  const artifacts = new Map<string, WorkspaceArtifact>();
  for (const node of analysis.graph.nodes) {
    if (
      node.filePath === undefined
      || (
        node.kind !== "module"
        && node.kind !== "test"
        && node.kind !== "document"
        && node.kind !== "migration"
      )
    ) continue;
    artifacts.set(node.id, {
      id: node.id,
      kind: node.kind,
      filePath: node.filePath,
    });
  }
  return [...artifacts.values()].sort((left, right) => compareText(left.id, right.id));
}

function workspaceArtifactsFromFacts(facts: readonly PlaneAFact[]): WorkspaceArtifact[] {
  const artifacts = new Map<string, WorkspaceArtifact>();
  for (const fact of facts) {
    if (
      fact.factType !== "node"
      || fact.filePath === undefined
      || (
        fact.kind !== "module"
        && fact.kind !== "test"
        && fact.kind !== "document"
        && fact.kind !== "migration"
      )
    ) continue;
    artifacts.set(fact.id, {
      id: fact.id,
      kind: fact.kind,
      filePath: fact.filePath,
    });
  }
  return [...artifacts.values()].sort((left, right) => compareText(left.id, right.id));
}

function mergeWorkspaceArtifacts(
  ...groups: readonly WorkspaceArtifact[][]
): WorkspaceArtifact[] {
  const artifacts = new Map<string, WorkspaceArtifact>();
  for (const artifact of groups.flat()) artifacts.set(artifact.id, artifact);
  return [...artifacts.values()].sort((left, right) => compareText(left.id, right.id));
}

function workspaceUnitsByPath(
  projection: WorkspaceProjection,
  artifacts: readonly WorkspaceArtifact[],
): ReadonlyMap<string, string> {
  const pathById = new Map(artifacts.map((artifact) => [artifact.id, artifact.filePath]));
  const result = new Map<string, string>();
  for (const edge of projection.edges) {
    if (edge.kind !== "contained_in_workspace") continue;
    const path = pathById.get(edge.from);
    if (path !== undefined) result.set(path, edge.to);
  }
  return result;
}

function compareFacts(left: PlaneAFact, right: PlaneAFact): number {
  const leftIdentity = left.factType === "node"
    ? left.id
    : `${left.kind}:${left.from}:${left.to}`;
  const rightIdentity = right.factType === "node"
    ? right.id
    : `${right.kind}:${right.from}:${right.to}`;
  return compareText(leftIdentity, rightIdentity)
    || compareText(digestCanonical({ ...left, ordinal: 0 }), digestCanonical({ ...right, ordinal: 0 }));
}

function canonicalizeFacts(facts: readonly PlaneAFact[]): PlaneAFact[] {
  return [...facts]
    .sort(compareFacts)
    .map((fact, ordinal) => ({ ...fact, ordinal }));
}

/**
 * Compatibility projector: retain every existing TypeScript/document/migration byte and append
 * only second-language facts through the validating assembler.
 */
function extendLegacyAnalysis(
  legacy: AnalysisResult,
  additionalFacts: readonly PlaneAFact[],
  selectedPaths: readonly string[],
): AnalysisResult {
  if (additionalFacts.length === 0) return legacy;
  const assembler = new DeterministicGraphAssembler(selectedPaths);
  let ordinal = 0;
  for (const node of legacy.graph.nodes) {
    assembler.addFact({
      factType: "node",
      ordinal: ordinal++,
      id: node.id,
      kind: node.kind,
      name: node.name,
      ...(node.filePath === undefined ? {} : { filePath: node.filePath }),
      ...(node.boundedContext === undefined ? {} : { boundedContext: node.boundedContext }),
      ...(node.exported === undefined ? {} : { exported: node.exported }),
      evidence: node.evidence,
      tags: node.tags,
      metadata: node.metadata,
    });
  }
  for (const edge of legacy.graph.edges) {
    // Every edge still in the legacy graph resolved on both endpoints, so re-feeding it as derived
    // cannot turn a resolved reference into a fatal one: extension only ever adds nodes.
    assembler.addFact({
      factType: "edge",
      ordinal: ordinal++,
      kind: edge.kind,
      from: edge.from,
      to: edge.to,
      evidence: edge.evidence,
      metadata: edge.metadata,
    });
  }
  for (const fact of canonicalizeFacts(additionalFacts)) {
    assembler.addFact({ ...fact, ordinal: ordinal++ });
  }
  const assembled = assembler.build();
  const legacyNodes = new Map(legacy.graph.nodes.map((node) => [node.id, node]));
  const legacyEdges = new Map(legacy.graph.edges.map((edge) => [edge.id, edge]));
  return {
    graph: {
      nodes: assembled.graph.nodes.map((node) => {
        const original = legacyNodes.get(node.id);
        return original === undefined
          ? node
          : {
              ...original,
              evidence: node.evidence,
              tags: node.tags,
              metadata: node.metadata,
              ...(node.boundedContext === undefined
                ? {}
                : { boundedContext: node.boundedContext }),
              ...(node.exported === undefined ? {} : { exported: node.exported }),
            };
      }),
      edges: assembled.graph.edges.map((edge) => {
        const original = legacyEdges.get(edge.id);
        return original === undefined
          ? edge
          : {
              ...original,
              evidence: edge.evidence,
              metadata: edge.metadata,
            };
      }),
    },
    evidence: assembled.evidence,
    // The legacy pass already removed its unresolved edges from `legacy.graph`, so this assembler
    // never sees them and cannot re-derive them. Carrying the legacy diagnostics forward is the
    // only thing that keeps a second language from erasing the first one's gaps.
    unresolvedReferences: mergeUnresolvedReferences(
      legacy.unresolvedReferences,
      assembled.unresolvedReferences,
    ),
  };
}

/** Union by edge identity, deterministically ordered. Both passes describe the same repository, so
 *  the same authored reference reported twice is one gap, not two. */
export function mergeUnresolvedReferences(
  ...groups: readonly (readonly UnresolvedReference[])[]
): UnresolvedReference[] {
  const byEdgeId = new Map<string, UnresolvedReference>();
  for (const group of groups) {
    for (const reference of group) {
      if (!byEdgeId.has(reference.edgeId)) byEdgeId.set(reference.edgeId, reference);
    }
  }
  return [...byEdgeId.values()].sort((left, right) => compareText(left.edgeId, right.edgeId));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isCanonicalRepositoryRelativePath(path: string): boolean {
  if (
    path.length === 0
    || path.includes("\\")
    || path.startsWith("/")
    || /^[A-Za-z]:/u.test(path)
  ) {
    return false;
  }
  return path.split("/").every((part) =>
    part.length > 0 && part !== "." && part !== "..");
}
