import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  repositoryId,
  moduleId,
  testId,
  documentId,
  migrationId,
  capabilityId,
  invariantId,
  contractId,
  decisionId,
  riskId,
  boundedContextId,
  compareIds,
  slugify,
  symbolScopePath,
} from "@semantic-context/core";
import type {
  SemctxConfig,
  RepositoryGraph,
  RepositoryNode,
  EvidenceRef,
  EvidenceRecord,
} from "@semantic-context/core";
import {
  addAggregatedImportEdges,
  DeterministicGraphAssembler,
  assertStableCapture,
  attachPlaneASidecar,
  canonicalSourceText,
  digestCanonical,
  type ArtifactScope,
  type CapabilityProfile,
  type FactBatchV1,
  type ImportEdgeOccurrence,
  type PlaneASidecarV1,
  type ProducerIdentity,
  type UnresolvedReference,
} from "@semantic-context/plane-a-internal";
import { discoverFiles, sourceLanguage, type DiscoveredFile } from "./discovery";
import {
  extractTypeScript,
  extractTypeScriptParallel,
  TYPESCRIPT_DIALECT_VERSION,
  type IndexWorkerSelection,
  type TsExtraction,
  type TypeScriptParallelism,
} from "./ts-symbols";
import { groupSymbols } from "./symbol-grouping";
import {
  degradeDivergentMarkerNodes,
  detectMarkerDivergence,
  type MarkerDeclaration,
} from "./markers";
import { extractDoc } from "./docs";
import { extractMigration } from "./migrations";

export interface AnalysisResult {
  graph: RepositoryGraph;
  evidence: EvidenceRecord[];
  /** Authored cross-references naming targets this repository does not contain. */
  unresolvedReferences: UnresolvedReference[];
}

export interface AsyncAnalysisResult {
  analysis: AnalysisResult;
  parallelism: TypeScriptParallelism;
}

type GraphBuilder = DeterministicGraphAssembler;

const TYPESCRIPT_PRODUCER: ProducerIdentity = {
  identity: "@semantic-context/ts-analyzer",
  version: "0.1.0",
};

const PLANE_A_FACT_SCHEMA = {
  schemaVersion: 1,
  facts: ["node", "edge"],
  evidence: "source-lines-v1",
} as const;

const SYMBOL_EDGE_EVIDENCE = (relPath: string, line: number, kind: EvidenceRef["sourceKind"]): EvidenceRef[] => [
  { filePath: relPath, startLine: line, sourceKind: kind },
];

export function analyzeRepository(config: SemctxConfig, discoveredFiles?: readonly DiscoveredFile[]): AnalysisResult {
  const files = discoveredFiles === undefined ? discoverFiles(config) : [...discoveredFiles];
  const tsFiles = files.filter(isTypeScriptSource);
  const extraction = extractTypeScript(
    tsFiles.map((file) => file.absPath),
    config.repositoryRoot,
  );
  return assembleRepository(config, files, extraction);
}

export async function analyzeRepositoryAsync(
  config: SemctxConfig,
  discoveredFiles?: readonly DiscoveredFile[],
  workers: IndexWorkerSelection = "auto",
): Promise<AsyncAnalysisResult> {
  const files = discoveredFiles === undefined ? discoverFiles(config) : [...discoveredFiles];
  const tsFiles = files.filter(isTypeScriptSource);
  const result = await extractTypeScriptParallel(
    tsFiles.map((file) => file.absPath),
    config.repositoryRoot,
    workers,
  );
  return {
    analysis: assembleRepository(config, files, result.extraction),
    parallelism: result.parallelism,
  };
}

/** Pure deterministic assembly seam shared by the synchronous and worker-backed extractors. */
export function assembleRepository(
  config: SemctxConfig,
  files: readonly DiscoveredFile[],
  extraction: TsExtraction,
): AnalysisResult {
  const tsFiles = files.filter(isTypeScriptSource);
  const analyzedFiles = files.filter((file) =>
    isTypeScriptSource(file) || file.role === "document" || file.role === "migration");
  const selectedPaths = analyzedFiles.map((file) => file.relPath).sort();
  const builder = new DeterministicGraphAssembler(selectedPaths);

  const repoNodeId = repositoryId(config.repositoryRoot);
  builder.node({
    id: repoNodeId,
    kind: "repository",
    name: basename(config.repositoryRoot) || "repository",
    metadata: { root: config.repositoryRoot },
  });

  const roleByRel = new Map<string, DiscoveredFile["role"]>();
  const nodeIdByRel = new Map<string, string>();
  for (const file of files) roleByRel.set(file.relPath, file.role);

  // Module / test nodes for every TS file.
  for (const file of tsFiles) {
    const isTest = file.role === "test";
    const id = isTest ? testId(file.relPath) : moduleId(file.relPath);
    nodeIdByRel.set(file.relPath, id);
    builder.node({
      id,
      kind: isTest ? "test" : "module",
      name: basename(file.relPath),
      filePath: file.relPath,
      evidence: [{ filePath: file.relPath, sourceKind: isTest ? "test" : "code" }],
    });
    builder.edge("belongs_to", id, repoNodeId, [{ filePath: file.relPath, sourceKind: "code" }]);
  }

  // Symbol nodes + declares edges. Grouping decides identity once (overload sets fold into one
  // node; genuine homonym collisions get an ordinal-suffixed, non-addressable id) so the graph
  // builder never has to guess.
  //
  // Two indexes, because two questions are being asked and conflating them is how an edge lands
  // on the wrong body. `byQualified` answers "which node *is* `outer.helper` in this file" — the
  // exact coordinate a call resolves to; a coordinate held by several declarations maps to several
  // nodes and yields no edge at all. `byImportableName` answers "which node does `import { helper }`
  // bring in", which only a file-scoped declaration can ever be.
  const byQualified = new Map<string, Map<string, RepositoryNode[]>>();
  const byImportableName = new Map<string, Map<string, RepositoryNode[]>>();
  // Collected across every symbol so divergence is judged repository-wide.
  const markerDeclarations: MarkerDeclaration[] = [];
  for (const sym of groupSymbols(extraction.symbols)) {
    const moduleNodeId = nodeIdByRel.get(sym.relPath);
    const node = builder.node({
      id: sym.id,
      kind: sym.kind,
      name: sym.name,
      filePath: sym.relPath,
      exported: sym.exported,
      // One evidence range per contributing declaration: an overload set is one node with three
      // ranges, not three nodes.
      evidence: sym.declarations.map((range) => ({
        filePath: sym.relPath,
        startLine: range.startLine,
        endLine: range.endLine,
        sourceKind: "code" as const,
      })),
      metadata: { exported: sym.exported, ...(sym.scope.length > 0 ? { scope: sym.scope.join(".") } : {}) },
    });
    if (moduleNodeId !== undefined) {
      builder.edge(
        "declares",
        moduleNodeId,
        sym.id,
        SYMBOL_EDGE_EVIDENCE(sym.relPath, sym.declarations[0]!.startLine, "code"),
      );
    }
    pushInto(byQualified, sym.relPath, symbolScopePath(sym.scope, sym.name), node);
    if (sym.scope.length === 0) pushInto(byImportableName, sym.relPath, sym.name, node);

    // Each marker keeps the coordinate of the declaration that carried it, not the group's first
    // declaration: an author sent to the group id finds nothing when the marker is on the second
    // overload signature.
    for (const marker of sym.markers) {
      markerDeclarations.push({
        tag: marker.tag,
        slug: marker.slug,
        ...(marker.statement !== undefined ? { statement: marker.statement } : {}),
        relPath: sym.relPath,
        startLine: marker.startLine,
      });
    }
    applyCodeMarkers(builder, sym.relPath, sym.markers, sym.id);
  }

  // Import edges.
  const importEdges: ImportEdgeOccurrence[] = [];
  for (const imp of extraction.imports) {
    const fromId = nodeIdByRel.get(imp.fromRelPath);
    if (fromId === undefined) continue;
    if (imp.resolvedRelPath === undefined) continue;
    const toId = nodeIdByRel.get(imp.resolvedRelPath);
    if (toId === undefined) continue;
    importEdges.push({
      from: fromId,
      to: toId,
      evidence: SYMBOL_EDGE_EVIDENCE(imp.fromRelPath, imp.line, "code"),
      specifier: imp.moduleSpecifier,
    });
  }
  addAggregatedImportEdges(builder, importEdges);

  // Call edges between resolved symbols (best-effort static). Both endpoints are matched on the
  // exact scope-qualified coordinate; anything that resolves to more than one node is dropped —
  // an approximate call edge is worse than a missing one.
  for (const call of extraction.calls) {
    if (call.calleeRelPath === undefined || call.calleeSymbolPath === undefined) continue;
    const callee = unique(byQualified.get(call.calleeRelPath)?.get(call.calleeSymbolPath));
    if (callee === undefined) continue;
    let fromId: string | undefined;
    if (call.callerSymbolPath !== undefined) {
      const caller = unique(byQualified.get(call.callerRelPath)?.get(call.callerSymbolPath));
      // A caller that cannot be identified exactly must not fall back to its module: that would
      // silently relabel a call made inside one of two homonyms as a call made by the file.
      if (caller === undefined) continue;
      fromId = caller.id;
    } else {
      fromId = nodeIdByRel.get(call.callerRelPath);
    }
    if (fromId === undefined) continue;
    builder.edge("calls", fromId, callee.id, SYMBOL_EDGE_EVIDENCE(call.callerRelPath, call.line, "code"));
  }

  // tested_by / covers via test-file imports resolving to symbols.
  for (const imp of extraction.imports) {
    if (roleByRel.get(imp.fromRelPath) !== "test") continue;
    if (imp.resolvedRelPath === undefined) continue;
    const testNodeId = nodeIdByRel.get(imp.fromRelPath);
    const perModule = byImportableName.get(imp.resolvedRelPath);
    if (testNodeId === undefined || perModule === undefined) continue;
    for (const name of imp.names) {
      const target = unique(perModule.get(name));
      if (target === undefined) continue;
      const ev = SYMBOL_EDGE_EVIDENCE(imp.fromRelPath, imp.line, "test");
      builder.edge("tested_by", target.id, testNodeId, ev);
      builder.edge("covers", testNodeId, target.id, ev);
    }
  }

  // Documents.
  for (const file of analyzedFiles.filter((f) => f.role === "document")) {
    ingestDocument(builder, file, repoNodeId);
  }

  // Migrations.
  for (const file of analyzedFiles.filter((f) => f.role === "migration")) {
    ingestMigration(builder, file, repoNodeId);
  }

  // Applied before the graph is built, so no consumer ever sees a contested slug carrying one of
  // its two statements — including the sidecar facts, which are derived from the same builder.
  const markerDivergences = detectMarkerDivergence(markerDeclarations);
  degradeDivergentMarkerNodes(builder.nodes.values(), markerDivergences);

  const analysis = builder.build();
  return attachPlaneASidecar(
    analysis,
    buildTypeScriptSidecar(config, analyzedFiles, builder, repoNodeId),
  );
}

function pushInto(
  index: Map<string, Map<string, RepositoryNode[]>>,
  relPath: string,
  key: string,
  node: RepositoryNode,
): void {
  let perModule = index.get(relPath);
  if (perModule === undefined) {
    perModule = new Map<string, RepositoryNode[]>();
    index.set(relPath, perModule);
  }
  const bucket = perModule.get(key);
  if (bucket === undefined) perModule.set(key, [node]);
  else bucket.push(node);
}

/** The single node at a coordinate, or `undefined` when the coordinate does not identify one. */
function unique(nodes: readonly RepositoryNode[] | undefined): RepositoryNode | undefined {
  return nodes !== undefined && nodes.length === 1 ? nodes[0] : undefined;
}

function isTypeScriptSource(file: DiscoveredFile): boolean {
  return (file.role === "source" || file.role === "test")
    && (file.language === undefined || file.language === "typescript");
}

function buildTypeScriptSidecar(
  config: SemctxConfig,
  files: readonly DiscoveredFile[],
  builder: DeterministicGraphAssembler,
  repositoryIdentity: string,
): PlaneASidecarV1 {
  const selectedPaths = files.map((file) => file.relPath).sort();
  const sourceInputs = files
    .map((file) => ({
      relPath: file.relPath,
      role: file.role,
      language: file.language ?? null,
      content: canonicalSourceText(file.content),
    }))
    .sort((left, right) => compareIds(left.relPath, right.relPath));
  const sourceDigest = digestCanonical(sourceInputs);
  const producerConfigurationDigest = digestCanonical(config);
  const factSchemaDigest = digestCanonical(PLANE_A_FACT_SCHEMA);
  const currentSourceInputs = files
    .map((file) => {
      let content: string | null;
      try {
        content = readFileSync(file.absPath, "utf8");
      } catch {
        content = null;
      }
      return {
        relPath: file.relPath,
        role: file.role,
        language: file.language ?? null,
        content: content === null ? null : canonicalSourceText(content),
      };
    })
    .sort((left, right) => compareIds(left.relPath, right.relPath));
  assertStableCapture(
    {
      factSchemaDigest,
      producerConfigurationDigest,
      producerVersion: TYPESCRIPT_PRODUCER.version,
      sourceDigest,
    },
    {
      factSchemaDigest: digestCanonical(PLANE_A_FACT_SCHEMA),
      producerConfigurationDigest: digestCanonical(config),
      producerVersion: TYPESCRIPT_PRODUCER.version,
      sourceDigest: digestCanonical(currentSourceInputs),
    },
  );
  const scope: ArtifactScope = {
    repositoryIdentity,
    sourceStateDigest: sourceDigest,
    selectedPathSetDigest: digestCanonical(selectedPaths),
    selectedPaths,
    language: "repository",
  };
  const facts = builder.facts();
  const languageByPath = new Map(files.map((file) => [
    file.relPath,
    file.language ?? sourceLanguage(file.relPath),
  ]));
  const factsByLanguage = new Map<string, typeof facts extends readonly (infer T)[] ? T[] : never>();
  for (const fact of facts) {
    const path = fact.factType === "node"
      ? fact.filePath ?? fact.evidence[0]?.filePath
      : fact.evidence[0]?.filePath;
    const language = path === undefined ? "repository" : languageByPath.get(path) ?? "unknown";
    const group = factsByLanguage.get(language) ?? [];
    group.push(fact);
    factsByLanguage.set(language, group);
  }
  const capabilityProfiles: CapabilityProfile[] = [];
  const factBatches: FactBatchV1[] = [];
  const discoveryLedger: PlaneASidecarV1["discoveryLedger"][number][] = [];
  for (const [language, languageFacts] of [...factsByLanguage.entries()].sort(([left], [right]) =>
    compareIds(left, right))) {
    const languageFiles = files.filter((file) =>
      (file.language ?? sourceLanguage(file.relPath)) === language);
    const languagePaths = languageFiles.map((file) => file.relPath).sort();
    const languageSourceDigest = digestCanonical(sourceInputs.filter((input) =>
      languagePaths.includes(input.relPath)));
    const languageScope: ArtifactScope = {
      repositoryIdentity,
      sourceStateDigest: languageSourceDigest,
      selectedPathSetDigest: digestCanonical(languagePaths),
      selectedPaths: languagePaths,
      language,
      ...(language === "typescript"
        ? { dialectVersion: TYPESCRIPT_DIALECT_VERSION }
        : {}),
    };
    const factKinds = [...new Set(languageFacts.map((fact) => fact.kind))].sort();
    const profiles = factKinds.map((factKind): CapabilityProfile => ({
      profileId: `${language}:${factKind}:${languageScope.selectedPathSetDigest}:${factSchemaDigest}`,
      factKind,
      scope: languageScope,
      producer: TYPESCRIPT_PRODUCER,
      producerConfigurationDigest,
      factSchemaDigest,
      evidenceContract: "source-lines-v1",
      resolutionSemantics: language === "typescript"
        ? "typescript-static-v1"
        : "structural-source-v1",
      soundnessClaim: "best-effort-static",
      completenessClaim: "producer-declared",
      negativeEvidenceEligible: false,
      label: "structural",
    }));
    const batch: FactBatchV1 = {
      schemaVersion: 1,
      batchId: digestCanonical({
        scope: languageScope,
        producer: TYPESCRIPT_PRODUCER,
        producerConfigurationDigest,
        factSchemaDigest,
        facts: languageFacts,
      }),
      scope: languageScope,
      producer: TYPESCRIPT_PRODUCER,
      producerConfigurationDigest,
      factSchemaDigest,
      sourceDigest: languageSourceDigest,
      factKinds,
      capabilityProfileIds: profiles.map((profile) => profile.profileId),
      evidenceContract: "source-lines-v1",
      facts: languageFacts,
    };
    capabilityProfiles.push(...profiles);
    factBatches.push(batch);
    discoveryLedger.push({
      candidateIdentity: `${language}:${languageScope.selectedPathSetDigest}`,
      scope: languageScope,
      selectionDecision: "selected",
      analysisOutcome: "analyzed",
      selectionReasons: [],
      analysisReasons: [],
      selectedProducer: TYPESCRIPT_PRODUCER,
    });
  }
  return {
    schemaVersion: 1,
    scope,
    producerConfigurationDigest,
    factSchemaDigest,
    sourceDigest,
    capabilityProfiles,
    discoveryLedger,
    producerResults: factBatches.map((batch) => ({
      resultId: digestCanonical({
        batchId: batch.batchId,
        sourceDigest: batch.sourceDigest,
        producerConfigurationDigest,
        factSchemaDigest,
      }),
      status: "completed",
      producer: TYPESCRIPT_PRODUCER,
      scope: batch.scope,
      factBatchId: batch.batchId,
    })),
    factBatches,
  };
}

function applyCodeMarkers(
  builder: GraphBuilder,
  relPath: string,
  markers: readonly import("./symbol-grouping").SymbolMarkerDeclaration[],
  symbolNodeId: string,
): void {
  for (const marker of markers) {
    const ev = SYMBOL_EDGE_EVIDENCE(relPath, marker.startLine, "code");
    if (marker.tag === "tag") {
      const symbolNode = builder.nodes.get(symbolNodeId);
      if (symbolNode !== undefined && !symbolNode.tags.includes(marker.slug)) {
        symbolNode.tags.push(marker.slug);
      }
    } else if (marker.tag === "capability") {
      const id = capabilityId(marker.slug);
      builder.node({
        id,
        kind: "capability",
        name: marker.slug,
        evidence: ev,
        tags: ["from-code"],
        ...(marker.statement !== undefined ? { metadata: { statement: marker.statement } } : {}),
      });
      builder.edge("implements_capability", symbolNodeId, id, ev);
    } else if (marker.tag === "invariant") {
      const id = invariantId(marker.slug);
      builder.node({
        id,
        kind: "invariant",
        name: marker.slug,
        evidence: ev,
        tags: ["from-code"],
        ...(marker.statement !== undefined ? { metadata: { statement: marker.statement } } : {}),
      });
      builder.edge("constrained_by", symbolNodeId, id, ev);
    } else if (marker.tag === "contract") {
      const id = contractId(marker.slug);
      builder.node({
        id,
        kind: "contract",
        name: marker.slug,
        evidence: ev,
        tags: ["from-code"],
        ...(marker.statement !== undefined ? { metadata: { statement: marker.statement } } : {}),
      });
      builder.edge("declares", symbolNodeId, id, ev);
    } else if (marker.tag === "risk") {
      const id = riskId(marker.slug);
      builder.node({
        id,
        kind: "risk",
        name: marker.slug,
        evidence: ev,
        tags: ["from-code"],
        ...(marker.statement !== undefined ? { metadata: { statement: marker.statement } } : {}),
      });
      builder.edge("related_to", symbolNodeId, id, ev);
    } else if (marker.tag === "boundedContext") {
      const id = boundedContextId(marker.slug);
      builder.node({ id, kind: "bounded_context", name: marker.slug, evidence: ev });
      builder.edge("belongs_to", symbolNodeId, id, ev);
      const symbolNode = builder.nodes.get(symbolNodeId);
      if (symbolNode !== undefined && symbolNode.boundedContext === undefined) {
        symbolNode.boundedContext = marker.slug;
      }
    }
  }
}

function ingestDocument(builder: GraphBuilder, file: DiscoveredFile, repoNodeId: string): void {
  const doc = extractDoc(file.relPath, file.content);
  const docId = documentId(doc.relPath);
  const ev: EvidenceRef[] = [{ filePath: doc.relPath, startLine: 1, sourceKind: "document" }];
  builder.node({
    id: docId,
    kind: "document",
    name: doc.title,
    filePath: doc.relPath,
    ...(doc.boundedContext !== undefined ? { boundedContext: doc.boundedContext } : {}),
    evidence: ev,
    tags: doc.deprecated ? ["deprecated"] : [],
    metadata: {
      type: doc.type,
      deprecated: doc.deprecated,
      ...(doc.status !== undefined ? { status: doc.status } : {}),
    },
  });
  builder.edge("belongs_to", docId, repoNodeId, ev);

  for (const cap of doc.capabilities) {
    const id = capabilityId(cap);
    builder.node({ id, kind: "capability", name: cap, evidence: ev, tags: ["from-doc"] });
    builder.edge("documents", docId, id, ev);
  }
  for (const inv of doc.invariants) {
    const id = invariantId(inv);
    builder.node({ id, kind: "invariant", name: inv, evidence: ev, tags: ["from-doc"] });
    builder.edge("documents", docId, id, ev);
  }
  if (doc.type === "adr" || doc.decision !== undefined) {
    const decName = doc.decision ?? doc.title;
    const id = decisionId(slugify(doc.relPath));
    builder.node({
      id,
      kind: "decision",
      name: doc.title,
      filePath: doc.relPath,
      ...(doc.boundedContext !== undefined ? { boundedContext: doc.boundedContext } : {}),
      evidence: ev,
      metadata: { statement: decName },
    });
    builder.edge("decides", docId, id, ev);
  }
  if (doc.boundedContext !== undefined) {
    const id = boundedContextId(doc.boundedContext);
    builder.node({ id, kind: "bounded_context", name: doc.boundedContext, evidence: ev });
    builder.edge("belongs_to", docId, id, ev);
  }
  for (const target of doc.contradicts) {
    const targetId = documentId(target);
    // The document itself names the contradicted target; the repository need not contain it.
    builder.edge("contradicts", docId, targetId, ev, {}, "authored");
  }
}

function ingestMigration(builder: GraphBuilder, file: DiscoveredFile, repoNodeId: string): void {
  const migration = extractMigration(file.relPath, file.content);
  const migId = migrationId(migration.relPath);
  const ev: EvidenceRef[] = [{ filePath: migration.relPath, startLine: 1, sourceKind: "code" }];
  builder.node({
    id: migId,
    kind: "migration",
    name: basename(migration.relPath),
    filePath: migration.relPath,
    evidence: ev,
    metadata: { tables: migration.tables.join(",") },
  });
  builder.edge("belongs_to", migId, repoNodeId, ev);
  for (const constraint of migration.constraints) {
    const invId = invariantId(constraint.invariantSlug);
    const cev: EvidenceRef[] = [{ filePath: migration.relPath, startLine: constraint.line, sourceKind: "code" }];
    builder.node({
      id: invId,
      kind: "invariant",
      name: constraint.invariantSlug,
      evidence: cev,
      tags: ["from-migration"],
      ...(constraint.statement !== undefined ? { metadata: { statement: constraint.statement } } : {}),
    });
    builder.edge("related_to", migId, invId, cev);
  }
}
