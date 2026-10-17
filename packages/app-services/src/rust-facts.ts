import { basename } from "node:path";
import {
  boundedContextId, capabilityId, contractId, invariantId, moduleId, riskId, symbolId, testId,
  type EvidenceRef, type SemctxConfig,
} from "@semantic-context/core";
import { addAggregatedImportEdges, DeterministicGraphAssembler, type ImportEdgeOccurrence, type PlaneAFact } from "@semantic-context/plane-a-internal";
import { extractRustSync, type RustExtraction, type RustMarker, type RustSymbol } from "@semantic-context/rust-analyzer";
import { degradeDivergentPlaneAFacts, detectMarkerDivergence, type DiscoveredFile, type MarkerDeclaration } from "@semantic-context/ts-analyzer";
import { captureRustInputs, rustEditionByPath } from "./rust-inputs";

export interface RustFacts {
  factsByPath: ReadonlyMap<string, readonly PlaneAFact[]>;
  reasonsByPath: ReadonlyMap<string, readonly string[]>;
  failedPaths: ReadonlySet<string>;
  navigation: boolean;
  editionsByPath: ReadonlyMap<string, string>;
}

export function buildRustFacts(files: readonly DiscoveredFile[], repositoryIdentity: string, config: SemctxConfig, retained?: ReadonlyMap<string, string>): RustFacts {
  const factsByPath = new Map<string, PlaneAFact[]>();
  const reasonsByPath = new Map<string, string[]>();
  const failedPaths = new Set<string>();
  const navigation = config.version === 2 ? config.rust : undefined;
  let editionsByPath: ReadonlyMap<string, string> = new Map();
  let extraction: RustExtraction;
  try {
    const inputs = captureRustInputs(config, retained);
    if (inputs.rejected.length > 0) throw new Error(inputs.rejected.join(";"));
    extraction = extractRustSync(files.map((file) => ({ relPath: file.relPath, source: file.content })), {
      metadata: inputs.files.map((file) => ({ relPath: file.path, source: file.content })), navigation,
    });
    editionsByPath = rustEditionByPath([...inputs.files, ...files.map((file) => ({ path: file.relPath, content: file.content }))],
      files.map((file) => file.relPath), extraction.symbols.filter((symbol) => !conditionallyUnqualified(symbol, extraction.symbols)));
  }
  catch (error) {
    for (const file of files) {
      failedPaths.add(file.relPath);
      reasonsByPath.set(file.relPath, ["PRODUCER_FAILED", ...new Set(error instanceof Error ? error.message.match(/RUST_[A-Z_]+/g) ?? ["RUST_WORKER_FAILED"] : ["RUST_WORKER_FAILED"])]);
    }
    return { factsByPath, reasonsByPath, failedPaths, navigation: false, editionsByPath };
  }
  for (const limitation of extraction.limitations) {
    if (limitation.kind === "parse-error") failedPaths.add(limitation.relPath);
    const reasons = reasonsByPath.get(limitation.relPath) ?? [];
    reasons.push(`rust:${limitation.kind}:${limitation.range.startLine}`);
    reasonsByPath.set(limitation.relPath, reasons);
  }
  const builder = new DeterministicGraphAssembler(files.map((file) => file.relPath));
  const filesByPath = new Map(files.map((file) => [file.relPath, file]));
  const symbols = extraction.symbols.filter((symbol) => !conditionallyUnqualified(symbol, extraction.symbols));
  const admittedSymbols = new Set(symbols);
  const symbolIds = rustSymbolIds(symbols);
  const declarations: MarkerDeclaration[] = [];
  for (const file of files) {
    if (failedPaths.has(file.relPath)) continue;
    if (!editionsByPath.has(file.relPath)) reasonsByPath.set(file.relPath, [...(reasonsByPath.get(file.relPath) ?? []), "RUST_EDITION_UNSUPPORTED"]);
    if (navigation === undefined) reasonsByPath.set(file.relPath, [...(reasonsByPath.get(file.relPath) ?? []), "RUST_NAVIGATION_DISABLED"]);
    const id = file.role === "test" ? testId(file.relPath) : moduleId(file.relPath);
    const evidence: EvidenceRef[] = [{ filePath: file.relPath, sourceKind: file.role === "test" ? "test" : "code" }];
    builder.node({ id, kind: file.role === "test" ? "test" : "module", name: basename(file.relPath), filePath: file.relPath, evidence, metadata: { language: "rust", grammar: "tree-sitter-rust@0.24.2", runtime: "web-tree-sitter@0.27.1" } });
    builder.edge("belongs_to", id, repositoryIdentity, evidence);
    if (file.role !== "test" && symbols.some((symbol) => symbol.relPath === file.relPath && isTestContext(symbol, symbols))) {
      builder.node({ id: testId(file.relPath), kind: "test", name: `${basename(file.relPath)} inline tests`, filePath: file.relPath,
        evidence: [{ filePath: file.relPath, sourceKind: "test" }], metadata: { language: "rust", testKind: "inline" } });
      builder.edge("belongs_to", testId(file.relPath), id, evidence);
    }
  }
  const imports: ImportEdgeOccurrence[] = [];
  for (const relation of extraction.navigation?.relations ?? []) {
    const query = extraction.queries[relation.queryIndex]!;
    const target = extraction.symbols[relation.symbolIndex]!;
    if (!admittedSymbols.has(target) || extraction.symbols.some((symbol) => !admittedSymbols.has(symbol)
      && symbol.relPath === query.relPath && symbol.range.startOffset <= query.range.startOffset && symbol.range.endOffset >= query.range.endOffset)) continue;
    if (failedPaths.has(query.relPath) || failedPaths.has(target.relPath)) continue;
    const source = filesByPath.get(query.relPath)!;
    const targetId = symbolIds.get(target)!;
    const owner = symbols.filter((symbol) => symbol.relPath === query.relPath
      && (symbol.kind === "function" || symbol.kind === "test") && symbol.range.startOffset <= query.range.startOffset && symbol.range.endOffset >= query.range.endOffset)
      .sort((a, b) => (a.range.endOffset - a.range.startOffset) - (b.range.endOffset - b.range.startOffset))[0];
    const fileId = source.role === "test" ? testId(query.relPath) : moduleId(query.relPath);
    const from = owner === undefined ? fileId : symbolIds.get(owner)!;
    if (/#\d+$/.test(targetId) || /#\d+$/.test(from)) {
      reasonsByPath.set(query.relPath, [...(reasonsByPath.get(query.relPath) ?? []), "RUST_AMBIGUOUS_DECLARATION"]);
      continue;
    }
    const evidence: EvidenceRef[] = [{ filePath: query.relPath, startLine: query.range.startLine, endLine: query.range.endLine,
      sourceKind: owner !== undefined && isTestContext(owner, symbols) || source.role === "test" ? "test" : "code", excerpt: source.content.slice(query.range.startOffset, query.range.endOffset) }];
    const metadata = { resolver: "rust-analyzer@2026-10-12", resolution: target.scope.some((part) => part.startsWith("trait ")) ? "trait-contract" : "source-declaration", inputIdentity: extraction.navigation!.identity };
    builder.edge("references", from, targetId, evidence, metadata);
    if (query.kind === "import") {
      const targetFile = filesByPath.get(target.relPath)!;
      const to = targetFile.role === "test" ? testId(target.relPath) : moduleId(target.relPath);
      if (to !== fileId) imports.push({ from: fileId, to, evidence, specifier: source.content.slice(query.range.startOffset, query.range.endOffset) });
    } else if (owner !== undefined) {
      builder.edge("calls", from, targetId, evidence, metadata);
      if (owner.kind === "test") {
        builder.edge("tested_by", targetId, testId(query.relPath), evidence, metadata);
        builder.edge("covers", testId(query.relPath), targetId, evidence, metadata);
      }
    }
  }
  addAggregatedImportEdges(builder, imports);
  for (const unresolved of extraction.navigation?.unresolved ?? []) {
    const query = extraction.queries[unresolved.queryIndex]!;
    reasonsByPath.set(query.relPath, [...(reasonsByPath.get(query.relPath) ?? []), `${unresolved.reason}:${query.range.startLine}`]);
  }
  for (const symbol of symbols) {
    if (failedPaths.has(symbol.relPath)) continue;
    const file = filesByPath.get(symbol.relPath)!;
    const id = symbolIds.get(symbol)!;
    const testContext = file.role === "test" || isTestContext(symbol, symbols);
    const evidence: EvidenceRef[] = [{
      filePath: symbol.relPath, startLine: symbol.range.startLine, endLine: symbol.range.endLine,
      sourceKind: testContext ? "test" : "code",
      excerpt: file.content.slice(symbol.range.startOffset, symbol.range.endOffset),
    }];
    const tags = symbol.markers.filter((marker) => marker.tag === "tag").map((marker) => marker.slug).sort();
    builder.node({
      id, kind: symbol.kind, name: symbol.name, filePath: symbol.relPath,
      exported: symbol.visibility === "pub" && !testContext, evidence, tags,
      metadata: { language: "rust", rustKind: symbol.rustKind, visibility: symbol.visibility,
        testContext,
        scope: symbol.scope.join("."), startOffset: symbol.range.startOffset, endOffset: symbol.range.endOffset,
        startByte: Buffer.byteLength(file.content.slice(0, symbol.range.startOffset)),
        endByte: Buffer.byteLength(file.content.slice(0, symbol.range.endOffset)),
        parser: "tree-sitter-rust@0.24.2/web-tree-sitter@0.27.1" },
    });
    builder.edge("declares", testContext ? testId(file.relPath) : moduleId(file.relPath), id, evidence);
    for (const marker of symbol.markers) {
      const markerEvidence: EvidenceRef[] = [{ filePath: symbol.relPath, startLine: marker.range.startLine,
        endLine: marker.range.endLine, sourceKind: testContext ? "test" : "code",
        excerpt: file.content.slice(marker.range.startOffset, marker.range.endOffset) }];
      declarations.push({ ...marker, relPath: symbol.relPath, startLine: marker.range.startLine });
      addRustMarker(builder, marker, id, markerEvidence);
    }
  }
  for (const fact of degradeDivergentPlaneAFacts(builder.facts(), detectMarkerDivergence(declarations))) {
    const path = fact.factType === "node" ? fact.filePath ?? fact.evidence[0]?.filePath : fact.evidence[0]?.filePath;
    if (path === undefined) continue;
    const group = factsByPath.get(path) ?? [];
    group.push(fact);
    factsByPath.set(path, group);
  }
  return { factsByPath, reasonsByPath, failedPaths, navigation: extraction.navigation !== undefined, editionsByPath };
}

function conditionallyUnqualified(symbol: RustSymbol, symbols: readonly RustSymbol[]): boolean {
  return symbols.some((candidate) => candidate.relPath === symbol.relPath
    && candidate.range.startOffset <= symbol.range.startOffset && candidate.range.endOffset >= symbol.range.endOffset
    && candidate.attributes.some((attribute) => /^#\[\s*cfg(?:_attr)?\s*\(/.test(attribute)
      && !/^#\[\s*cfg\s*\(\s*test\s*\)\s*\]$/.test(attribute)));
}

function isTestContext(symbol: RustSymbol, symbols: readonly RustSymbol[]): boolean {
  return symbol.kind === "test" || symbols.some((candidate) => candidate.relPath === symbol.relPath
    && candidate.range.startOffset <= symbol.range.startOffset && candidate.range.endOffset >= symbol.range.endOffset
    && candidate.attributes.some((attribute) => /^#\[\s*cfg\s*\(\s*test\s*\)\s*\]$/.test(attribute)));
}

function rustSymbolIds(symbols: readonly RustSymbol[]): Map<RustSymbol, string> {
  const groups = new Map<string, RustSymbol[]>();
  for (const symbol of symbols) {
    const key = symbolId(symbol.kind, symbol.relPath, symbol.name, symbol.scope);
    const group = groups.get(key) ?? [];
    group.push(symbol);
    groups.set(key, group);
  }
  const ids = new Map<RustSymbol, string>();
  for (const [id, group] of groups) {
    for (const [index, symbol] of group.entries()) ids.set(symbol, group.length === 1 ? id : `${id}#${index + 1}`);
  }
  return ids;
}

function addRustMarker(builder: DeterministicGraphAssembler, marker: RustMarker, from: string, evidence: EvidenceRef[]): void {
  if (marker.tag === "tag") return;
  const kind = marker.tag === "boundedContext" ? "bounded_context" : marker.tag;
  const id = marker.tag === "capability" ? capabilityId(marker.slug)
    : marker.tag === "invariant" ? invariantId(marker.slug)
    : marker.tag === "contract" ? contractId(marker.slug)
    : marker.tag === "risk" ? riskId(marker.slug) : boundedContextId(marker.slug);
  const relation = marker.tag === "capability" ? "implements_capability"
    : marker.tag === "invariant" ? "constrained_by"
    : marker.tag === "contract" ? "declares" : marker.tag === "risk" ? "related_to" : "belongs_to";
  builder.node({ id, kind, name: marker.slug, evidence, tags: ["from-code"], metadata: marker.statement === undefined ? {} : { statement: marker.statement } });
  builder.edge(relation, from, id, evidence);
}
