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
  edgeId,
  evidenceId,
  slugify,
  compareIds,
} from "@semantic-context/core";
import type {
  SemctxConfig,
  RepositoryGraph,
  RepositoryNode,
  RepositoryEdge,
  EvidenceRef,
  EvidenceRecord,
  EdgeKind,
  NodeKind,
  MetadataValue,
} from "@semantic-context/core";
import { discoverFiles, type DiscoveredFile } from "./discovery";
import { extractTypeScript } from "./ts-symbols";
import { extractDoc } from "./docs";
import { extractMigration } from "./migrations";

export interface AnalysisResult {
  graph: RepositoryGraph;
  evidence: EvidenceRecord[];
}

class GraphBuilder {
  readonly nodes = new Map<string, RepositoryNode>();
  readonly edges = new Map<string, RepositoryEdge>();
  readonly evidence = new Map<string, EvidenceRecord>();

  ev(ref: EvidenceRef): string {
    const id = evidenceId(ref.sourceKind, ref.filePath, ref.startLine, ref.endLine);
    if (!this.evidence.has(id)) this.evidence.set(id, { id, ...ref });
    return id;
  }

  node(input: {
    id: string;
    kind: NodeKind;
    name: string;
    filePath?: string;
    boundedContext?: string;
    exported?: boolean;
    evidence?: EvidenceRef[];
    tags?: string[];
    metadata?: Record<string, MetadataValue>;
  }): RepositoryNode {
    const evidence = input.evidence ?? [];
    for (const ref of evidence) this.ev(ref);
    const existing = this.nodes.get(input.id);
    if (existing !== undefined) {
      existing.evidence.push(...evidence);
      for (const tag of input.tags ?? []) if (!existing.tags.includes(tag)) existing.tags.push(tag);
      for (const [key, value] of Object.entries(input.metadata ?? {})) {
        if (!(key in existing.metadata)) existing.metadata[key] = value;
      }
      if (input.boundedContext !== undefined && existing.boundedContext === undefined) {
        existing.boundedContext = input.boundedContext;
      }
      if (input.exported === true) existing.exported = true;
      return existing;
    }
    const node: RepositoryNode = {
      id: input.id,
      kind: input.kind,
      name: input.name,
      ...(input.filePath !== undefined ? { filePath: input.filePath } : {}),
      ...(input.boundedContext !== undefined ? { boundedContext: input.boundedContext } : {}),
      ...(input.exported !== undefined ? { exported: input.exported } : {}),
      evidence: [...evidence],
      tags: [...(input.tags ?? [])],
      metadata: { ...(input.metadata ?? {}) },
    };
    this.nodes.set(node.id, node);
    return node;
  }

  edge(
    kind: EdgeKind,
    from: string,
    to: string,
    evidence: EvidenceRef[],
    metadata: Record<string, MetadataValue> = {},
  ): void {
    const id = edgeId(kind, from, to);
    for (const ref of evidence) this.ev(ref);
    const existing = this.edges.get(id);
    if (existing !== undefined) {
      existing.evidence.push(...evidence);
      return;
    }
    this.edges.set(id, { id, kind, from, to, evidence: [...evidence], metadata: { ...metadata } });
  }

  build(): AnalysisResult {
    const nodes = [...this.nodes.values()].sort((a, b) => compareIds(a.id, b.id));
    const edges = [...this.edges.values()].sort((a, b) => compareIds(a.id, b.id));
    const evidence = [...this.evidence.values()].sort((a, b) => compareIds(a.id, b.id));
    return { graph: { nodes, edges }, evidence };
  }
}

const SYMBOL_EDGE_EVIDENCE = (relPath: string, line: number, kind: EvidenceRef["sourceKind"]): EvidenceRef[] => [
  { filePath: relPath, startLine: line, sourceKind: kind },
];

export function analyzeRepository(config: SemctxConfig, discoveredFiles?: readonly DiscoveredFile[]): AnalysisResult {
  const files = discoveredFiles === undefined ? discoverFiles(config) : [...discoveredFiles];
  const builder = new GraphBuilder();

  const repoNodeId = repositoryId(config.repositoryRoot);
  builder.node({
    id: repoNodeId,
    kind: "repository",
    name: basename(config.repositoryRoot) || "repository",
    metadata: { root: config.repositoryRoot },
  });

  const tsFiles = files.filter((f) => f.role === "source" || f.role === "test");
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

  const extraction = extractTypeScript(
    tsFiles.map((f) => f.absPath),
    config.repositoryRoot,
  );

  // Symbol nodes + declares edges, indexed by (relPath -> name -> node).
  const symbolIndex = new Map<string, Map<string, RepositoryNode>>();
  for (const sym of extraction.symbols) {
    const moduleNodeId = nodeIdByRel.get(sym.relPath);
    const id = `sym:${sym.kind}:${sym.relPath}:${sym.name}:${sym.startLine}`;
    const node = builder.node({
      id,
      kind: sym.kind,
      name: sym.name,
      filePath: sym.relPath,
      exported: sym.exported,
      evidence: [{ filePath: sym.relPath, startLine: sym.startLine, endLine: sym.endLine, sourceKind: "code" }],
      metadata: { exported: sym.exported },
    });
    if (moduleNodeId !== undefined) {
      builder.edge("declares", moduleNodeId, id, SYMBOL_EDGE_EVIDENCE(sym.relPath, sym.startLine, "code"));
    }
    let perModule = symbolIndex.get(sym.relPath);
    if (perModule === undefined) {
      perModule = new Map<string, RepositoryNode>();
      symbolIndex.set(sym.relPath, perModule);
    }
    perModule.set(sym.name, node);

    applyCodeMarkers(builder, sym, node.id);
  }

  // Import edges.
  for (const imp of extraction.imports) {
    const fromId = nodeIdByRel.get(imp.fromRelPath);
    if (fromId === undefined) continue;
    if (imp.resolvedRelPath === undefined) continue;
    const toId = nodeIdByRel.get(imp.resolvedRelPath);
    if (toId === undefined) continue;
    builder.edge("imports", fromId, toId, SYMBOL_EDGE_EVIDENCE(imp.fromRelPath, imp.line, "code"), {
      specifier: imp.moduleSpecifier,
    });
  }

  // Call edges between resolved symbols (best-effort static).
  for (const call of extraction.calls) {
    if (call.calleeRelPath === undefined || call.calleeSymbol === undefined) continue;
    const callee = symbolIndex.get(call.calleeRelPath)?.get(call.calleeSymbol);
    if (callee === undefined) continue;
    const caller =
      call.callerSymbol !== undefined
        ? symbolIndex.get(call.callerRelPath)?.get(call.callerSymbol)
        : undefined;
    const fromId = caller?.id ?? nodeIdByRel.get(call.callerRelPath);
    if (fromId === undefined) continue;
    builder.edge("calls", fromId, callee.id, SYMBOL_EDGE_EVIDENCE(call.callerRelPath, call.line, "code"));
  }

  // tested_by / covers via test-file imports resolving to symbols.
  for (const imp of extraction.imports) {
    if (roleByRel.get(imp.fromRelPath) !== "test") continue;
    if (imp.resolvedRelPath === undefined) continue;
    const testNodeId = nodeIdByRel.get(imp.fromRelPath);
    const perModule = symbolIndex.get(imp.resolvedRelPath);
    if (testNodeId === undefined || perModule === undefined) continue;
    for (const name of imp.names) {
      const target = perModule.get(name);
      if (target === undefined) continue;
      const ev = SYMBOL_EDGE_EVIDENCE(imp.fromRelPath, imp.line, "test");
      builder.edge("tested_by", target.id, testNodeId, ev);
      builder.edge("covers", testNodeId, target.id, ev);
    }
  }

  // Documents.
  for (const file of files.filter((f) => f.role === "document")) {
    ingestDocument(builder, file, repoNodeId);
  }

  // Migrations.
  for (const file of files.filter((f) => f.role === "migration")) {
    ingestMigration(builder, file, repoNodeId);
  }

  return builder.build();
}

function applyCodeMarkers(builder: GraphBuilder, sym: { relPath: string; startLine: number; markers: import("./markers").ParsedMarker[] }, symbolNodeId: string): void {
  for (const marker of sym.markers) {
    const ev = SYMBOL_EDGE_EVIDENCE(sym.relPath, sym.startLine, "code");
    if (marker.tag === "tag") {
      const symbolNode = builder.nodes.get(symbolNodeId);
      if (symbolNode !== undefined && !symbolNode.tags.includes(marker.slug)) {
        symbolNode.tags.push(marker.slug);
      }
    } else if (marker.tag === "capability") {
      const id = capabilityId(marker.slug);
      builder.node({ id, kind: "capability", name: marker.slug, evidence: ev, tags: ["from-code"] });
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
    builder.edge("contradicts", docId, targetId, ev, { declared: true });
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
