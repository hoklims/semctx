import ts from "typescript";
import { existsSync, statSync } from "node:fs";
import { posix, relative, resolve } from "node:path";
import { compareIds, normalizePath } from "@semantic-context/core";
import type { NodeKind } from "@semantic-context/core";
import { parseMarkers, type ParsedMarker } from "./markers";

/** Exact TypeScript runtime version bound into Plane A capability scopes. */
export const TYPESCRIPT_DIALECT_VERSION = ts.version;

export interface ExtractedSymbol {
  name: string;
  kind: Extract<NodeKind, "function" | "class" | "interface" | "type" | "enum">;
  relPath: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  jsdoc?: string;
  markers: ParsedMarker[];
}

export interface ExtractedImport {
  fromRelPath: string;
  moduleSpecifier: string;
  resolvedRelPath?: string;
  names: string[];
  line: number;
}

export interface ExtractedCall {
  callerRelPath: string;
  callerSymbol?: string;
  calleeName: string;
  calleeRelPath?: string;
  calleeSymbol?: string;
  line: number;
}

export interface TsExtraction {
  modules: string[];
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
  calls: ExtractedCall[];
}

export type IndexWorkerSelection = "auto" | number;

export interface TypeScriptParallelism {
  requested: IndexWorkerSelection;
  used: number;
  mode: "parallel" | "single" | "preflight-fallback" | "worker-unavailable-fallback";
  reason?: string;
}

export interface ParallelTsExtraction {
  extraction: TsExtraction;
  parallelism: TypeScriptParallelism;
}

interface ExtractionWorkerRequest {
  schemaVersion: 1;
  jobId: string;
  repoRoot: string;
  rootAbsPaths: string[];
  emitAbsPaths: string[];
}

interface ExtractionWorkerSuccess {
  schemaVersion: 1;
  jobId: string;
  ok: true;
  extraction: TsExtraction;
}

interface ExtractionWorkerFailure {
  schemaVersion: 1;
  jobId: string;
  ok: false;
  error: string;
}

type ExtractionWorkerResponse = ExtractionWorkerSuccess | ExtractionWorkerFailure;

interface ExtractionWorkerJob {
  promise: Promise<TsExtraction>;
  cancel: (error: unknown) => void;
}

type ExtractionWorkerFactory = () => Worker;
let extractionWorkerFactoryForTesting: ExtractionWorkerFactory | undefined;

/** Internal fault-injection seam; intentionally not exported from the package root. */
export function __setExtractionWorkerFactoryForTesting(factory: ExtractionWorkerFactory | undefined): void {
  extractionWorkerFactoryForTesting = factory;
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowJs: false,
  skipLibCheck: true,
  noEmit: true,
  strict: false,
};

function isExported(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

/** The closest preceding JSDoc block for a node, if any. */
function leadingJsDoc(sf: ts.SourceFile, node: ts.Node): string | undefined {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart());
  if (ranges === undefined) return undefined;
  let doc: string | undefined;
  for (const range of ranges) {
    const text = sf.text.slice(range.pos, range.end);
    if (text.startsWith("/**")) doc = text;
  }
  return doc;
}

function nameOfCallee(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

function resolveModule(
  specifier: string,
  containingFile: string,
  resolutionMode?: ts.ResolutionMode,
): string | undefined {
  const resolved = ts.resolveModuleName(
    specifier,
    containingFile,
    COMPILER_OPTIONS,
    ts.sys,
    undefined,
    undefined,
    resolutionMode,
  );
  return resolved.resolvedModule?.resolvedFileName;
}

function canonicalTypeScriptFileKey(filePath: string): string {
  let canonical = filePath;
  if (ts.sys.realpath !== undefined) {
    try {
      canonical = ts.sys.realpath(filePath);
    } catch {
      // Resolution may hand back a path that disappeared between discovery and preflight.
      // The later drift gates still fail closed; identity comparison can use the lexical path.
    }
  }
  const normalized = normalizePath(canonical);
  return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
}

/** Extract modules, symbols, imports and best-effort resolved calls from source/test files. */
export function extractTypeScript(rootAbsPaths: string[], repoRoot: string): TsExtraction {
  const program = ts.createProgram(rootAbsPaths, COMPILER_OPTIONS);
  const checker = program.getTypeChecker();
  const rootSet = new Set(rootAbsPaths.map((p) => normalizePath(p)));

  const modules: string[] = [];
  const symbols: ExtractedSymbol[] = [];
  const imports: ExtractedImport[] = [];
  const calls: ExtractedCall[] = [];

  const relOf = (abs: string): string => normalizePath(relative(repoRoot, abs));

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    if (!rootSet.has(normalizePath(sf.fileName))) continue;
    const relPath = relOf(sf.fileName);
    modules.push(relPath);

    const symbolStack: string[] = [];

    const recordSymbol = (
      node: ts.Node,
      name: string,
      kind: ExtractedSymbol["kind"],
    ): void => {
      const jsdoc = leadingJsDoc(sf, node);
      symbols.push({
        name,
        kind,
        relPath,
        startLine: lineOf(sf, node.getStart()),
        endLine: lineOf(sf, node.getEnd()),
        exported: isExported(node),
        ...(jsdoc !== undefined ? { jsdoc } : {}),
        markers: jsdoc !== undefined ? parseMarkers(jsdoc) : [],
      });
    };

    const visit = (node: ts.Node): void => {
      let pushedSymbol: string | undefined;

      if (ts.isFunctionDeclaration(node) && node.name) {
        recordSymbol(node, node.name.text, "function");
        pushedSymbol = node.name.text;
      } else if (ts.isClassDeclaration(node) && node.name) {
        recordSymbol(node, node.name.text, "class");
        pushedSymbol = node.name.text;
      } else if (ts.isInterfaceDeclaration(node)) {
        recordSymbol(node, node.name.text, "interface");
      } else if (ts.isTypeAliasDeclaration(node)) {
        recordSymbol(node, node.name.text, "type");
      } else if (ts.isEnumDeclaration(node)) {
        recordSymbol(node, node.name.text, "enum");
      } else if (ts.isVariableStatement(node)) {
        const exported = isExported(node);
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer && isFunctionLike(decl.initializer)) {
            const jsdoc = leadingJsDoc(sf, node);
            symbols.push({
              name: decl.name.text,
              kind: "function",
              relPath,
              startLine: lineOf(sf, node.getStart()),
              endLine: lineOf(sf, decl.getEnd()),
              exported,
              ...(jsdoc !== undefined ? { jsdoc } : {}),
              markers: jsdoc !== undefined ? parseMarkers(jsdoc) : [],
            });
            pushedSymbol = decl.name.text;
          }
        }
      } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        const resolvedAbs = resolveModule(specifier, sf.fileName);
        const names = importedNames(node);
        imports.push({
          fromRelPath: relPath,
          moduleSpecifier: specifier,
          ...(resolvedAbs !== undefined ? { resolvedRelPath: relOf(resolvedAbs) } : {}),
          names,
          line: lineOf(sf, node.getStart()),
        });
      } else if (ts.isCallExpression(node)) {
        const calleeName = nameOfCallee(node.expression);
        if (calleeName !== undefined) {
          const resolved = resolveCallTarget(checker, node.expression, relOf);
          calls.push({
            callerRelPath: relPath,
            ...(symbolStack.length > 0 ? { callerSymbol: symbolStack[symbolStack.length - 1] } : {}),
            calleeName,
            ...(resolved?.relPath !== undefined ? { calleeRelPath: resolved.relPath } : {}),
            ...(resolved?.name !== undefined ? { calleeSymbol: resolved.name } : {}),
            line: lineOf(sf, node.getStart()),
          });
        }
      }

      if (pushedSymbol !== undefined) symbolStack.push(pushedSymbol);
      ts.forEachChild(node, visit);
      if (pushedSymbol !== undefined) symbolStack.pop();
    };

    ts.forEachChild(sf, visit);
  }

  return { modules, symbols, imports, calls };
}

/**
 * Parallel extraction is deliberately additive: synchronous callers keep the original one-program
 * semantics. The async CLI path partitions only repositories whose sources prove they are isolated
 * external modules. Declaration files are repeated in every program as shared type context.
 */
export async function extractTypeScriptParallel(
  rootAbsPaths: string[],
  repoRoot: string,
  requested: IndexWorkerSelection = "auto",
): Promise<ParallelTsExtraction> {
  const workerLimit = resolveWorkerCount(requested, rootAbsPaths.length);
  if (workerLimit <= 1 || rootAbsPaths.length <= 1) {
    return {
      extraction: extractTypeScript(rootAbsPaths, repoRoot),
      parallelism: { requested, used: 1, mode: "single" },
    };
  }

  const preflight = preflightParallelSafety(rootAbsPaths, repoRoot);
  if (!preflight.safe) {
    return {
      extraction: extractTypeScript(rootAbsPaths, repoRoot),
      parallelism: {
        requested,
        used: 1,
        mode: "preflight-fallback",
        reason: preflight.reason,
      },
    };
  }

  const declarationPaths = rootAbsPaths.filter((path) => path.endsWith(".d.ts"));
  const chunks = weightedComponentChunks(preflight.components, workerLimit);
  if (chunks.length <= 1) {
    return {
      extraction: extractTypeScript(rootAbsPaths, repoRoot),
      parallelism: {
        requested,
        used: 1,
        mode: "single",
        reason: "TypeScript root module graph has one connected component",
      },
    };
  }

  let launched = false;
  const workers: Worker[] = [];
  const jobs: ExtractionWorkerJob[] = [];
  try {
    for (const [index, chunk] of chunks.entries()) {
      const worker = createExtractionWorker();
      workers.push(worker);
      launched = true;
      const jobId = `typescript-chunk-${index + 1}-of-${chunks.length}`;
      jobs.push(runExtractionWorker(worker, {
        schemaVersion: 1,
        jobId,
        repoRoot,
        rootAbsPaths: [...chunk, ...declarationPaths],
        emitAbsPaths: chunk,
      }));
    }
    const responses = await Promise.all(jobs.map((job) => job.promise));
    return {
      extraction: mergeExtractions(responses, preflight.emitAbsOrder, repoRoot),
      parallelism: { requested, used: chunks.length, mode: "parallel" },
    };
  } catch (error) {
    for (const job of jobs) job.cancel(error);
    for (const worker of workers.slice(jobs.length)) worker.terminate();
    await Promise.allSettled(jobs.map((job) => job.promise));
    if (!launched) {
      return {
        extraction: extractTypeScript(rootAbsPaths, repoRoot),
        parallelism: {
          requested,
          used: 1,
          mode: "worker-unavailable-fallback",
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
    throw error;
  }
}

export function resolveWorkerCount(requested: IndexWorkerSelection, fileCount: number): number {
  if (requested !== "auto") {
    if (!Number.isInteger(requested) || requested < 1 || requested > 8) {
      throw new Error("workers must be 'auto' or an integer from 1 through 8");
    }
    return Math.min(requested, Math.max(1, fileCount));
  }
  // Isolated-process measurements show the worker path trading wall time for substantially lower
  // retained RSS on large corpora. Keep auto single-core until that memory trade-off is relevant,
  // then use two cores; higher counts remain an explicit operator choice.
  if (fileCount < 1_000) return 1;
  const available = typeof navigator === "undefined" ? 1 : navigator.hardwareConcurrency;
  return Math.min(2, Math.max(1, available - 1), Math.max(1, fileCount));
}

function preflightParallelSafety(rootAbsPaths: readonly string[], repoRoot: string):
  | { safe: true; emitAbsOrder: string[]; components: string[][] }
  | { safe: false; reason: string } {
  // Safety inspection needs source ordering and syntax only. Avoid loading the standard library
  // and type packages here: each Worker builds the real semantic Program for its own chunk.
  const program = ts.createProgram([...rootAbsPaths], {
    ...COMPILER_OPTIONS,
    noLib: true,
    types: [],
  });
  const rootSet = new Set(rootAbsPaths.map(canonicalTypeScriptFileKey));
  const roots = program.getSourceFiles().filter((source) => rootSet.has(canonicalTypeScriptFileKey(source.fileName)));
  if (roots.length !== rootSet.size) return { safe: false, reason: "program omitted an extraction root" };
  const repositoryKey = canonicalTypeScriptFileKey(repoRoot);
  if (roots.some((source) => !isRepositoryGraphFile(canonicalTypeScriptFileKey(source.fileName), repositoryKey))) {
    return { safe: false, reason: "extraction root is outside the repository module graph boundary" };
  }
  for (const sf of roots) {
    const path = sf.fileName;
    const diagnostics = (sf as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
    if (diagnostics.length > 0) return { safe: false, reason: `parse diagnostics: ${path}` };
    if (sf.referencedFiles.length > 0 || sf.typeReferenceDirectives.length > 0 || sf.libReferenceDirectives.length > 0) {
      return { safe: false, reason: `triple-slash directive: ${path}` };
    }
    if (!sf.isDeclarationFile && !ts.isExternalModule(sf)) {
      return { safe: false, reason: `global script: ${path}` };
    }
    let augmentation = false;
    const visit = (node: ts.Node): void => {
      if (ts.isModuleDeclaration(node)) {
        if ((node.flags & ts.NodeFlags.GlobalAugmentation) !== 0 || ts.isStringLiteral(node.name)) {
          augmentation = true;
        }
      }
      if (!augmentation) ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
    if (augmentation) return { safe: false, reason: `global or module augmentation: ${path}` };
  }
  return {
    safe: true,
    emitAbsOrder: roots.filter((source) => !source.isDeclarationFile).map((source) => source.fileName),
    components: rootModuleComponents(program, roots, repositoryKey),
  };
}

function isRepositoryGraphFile(fileKey: string, repositoryKey: string): boolean {
  const prefix = repositoryKey.endsWith("/") ? repositoryKey : `${repositoryKey}/`;
  if (!fileKey.startsWith(prefix)) return false;
  return !fileKey.slice(prefix.length).split("/").includes("node_modules");
}

function rootModuleComponents(
  program: ts.Program,
  roots: readonly ts.SourceFile[],
  repositoryKey: string,
): string[][] {
  const selectedRoots = new Map(
    roots.filter((source) => !source.isDeclarationFile)
      .map((source) => [canonicalTypeScriptFileKey(source.fileName), source.fileName]),
  );
  const loadedSources = new Map(
    program.getSourceFiles()
      .map((source) => [canonicalTypeScriptFileKey(source.fileName), source] as const)
      .filter(([key]) => isRepositoryGraphFile(key, repositoryKey)),
  );
  const parent = new Map([...loadedSources.keys()].map((path) => [path, path]));
  const find = (path: string): string => {
    let root = path;
    while (parent.get(root)! !== root) root = parent.get(root)!;
    let current = path;
    while (current !== root) {
      const next = parent.get(current)!;
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    if (compareIds(leftRoot, rightRoot) <= 0) parent.set(rightRoot, leftRoot);
    else parent.set(leftRoot, rightRoot);
  };

  for (const source of loadedSources.values()) {
    const from = canonicalTypeScriptFileKey(source.fileName);
    for (const usage of literalModuleSpecifiers(source)) {
      const resolutionMode = usage.resolutionMode
        ?? program.getModeForUsageLocation(source, usage.literal);
      const resolved = resolveModule(usage.literal.text, source.fileName, resolutionMode);
      if (resolved === undefined) continue;
      const target = canonicalTypeScriptFileKey(resolved);
      if (loadedSources.has(target)) union(from, target);
    }
  }

  const byRoot = new Map<string, string[]>();
  for (const [key, absolute] of selectedRoots) {
    const root = find(key);
    const component = byRoot.get(root) ?? [];
    component.push(absolute);
    byRoot.set(root, component);
  }
  return [...byRoot.values()]
    .map((component) => component.sort(compareIds))
    .sort(comparePathLists);
}

interface ModuleSpecifierUsage {
  literal: ts.StringLiteralLike;
  resolutionMode?: ts.ResolutionMode;
}

function literalModuleSpecifiers(source: ts.SourceFile): ModuleSpecifierUsage[] {
  const specifiers: ModuleSpecifierUsage[] = [];
  const visit = (node: ts.Node): void => {
    let literal: ts.StringLiteralLike | undefined;
    let resolutionMode: ts.ResolutionMode | undefined;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier !== undefined
      && ts.isStringLiteralLike(node.moduleSpecifier)) {
      literal = node.moduleSpecifier;
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression !== undefined
      && ts.isStringLiteralLike(node.moduleReference.expression)) {
      literal = node.moduleReference.expression;
    } else if (ts.isCallExpression(node)
      && node.arguments.length > 0
      && ts.isStringLiteralLike(node.arguments[0]!)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      literal = node.arguments[0]!;
      // getModeForUsageLocation accepts import-like syntax but not a raw require() argument.
      if (ts.isIdentifier(node.expression)) resolutionMode = ts.ModuleKind.CommonJS;
    } else if (ts.isImportTypeNode(node)
      && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteralLike(node.argument.literal)) {
      literal = node.argument.literal;
    }
    if (literal !== undefined) {
      specifiers.push({ literal, ...(resolutionMode === undefined ? {} : { resolutionMode }) });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return specifiers;
}

function weightedComponentChunks(components: readonly (readonly string[])[], requestedCount: number): string[][] {
  const count = Math.min(requestedCount, components.length);
  const chunks = Array.from({ length: count }, () => ({ weight: 0, paths: [] as string[] }));
  const weighted = components.map((paths) => ({
    paths: [...paths].sort(compareIds),
    weight: paths.reduce((total, path) => total + statSync(path).size, 0),
  })).sort((left, right) => right.weight - left.weight || comparePathLists(left.paths, right.paths));
  for (const item of weighted) {
    chunks.sort((left, right) => left.weight - right.weight || comparePathLists(left.paths, right.paths));
    chunks[0]!.paths.push(...item.paths);
    chunks[0]!.weight += item.weight;
  }
  return chunks.map((chunk) => chunk.paths.sort(compareIds)).filter((chunk) => chunk.length > 0);
}

/** Internal deterministic partition witness; intentionally not exported from the package root. */
export function __partitionTypeScriptRootsForTesting(
  rootAbsPaths: readonly string[],
  repoRoot: string,
  count: number,
): string[][] {
  const preflight = preflightParallelSafety(rootAbsPaths, repoRoot);
  if (!preflight.safe) throw new Error(preflight.reason);
  return weightedComponentChunks(preflight.components, count);
}

function comparePathLists(left: readonly string[], right: readonly string[]): number {
  return compareIds(left[0] ?? "", right[0] ?? "");
}

function createExtractionWorker(): Worker {
  if (extractionWorkerFactoryForTesting !== undefined) return extractionWorkerFactoryForTesting();
  const packaged = resolve(import.meta.dir, "semctx-index-worker.js");
  return new Worker(existsSync(packaged) ? packaged : resolve(import.meta.dir, "index-worker.ts"));
}

function runExtractionWorker(worker: Worker, request: ExtractionWorkerRequest): ExtractionWorkerJob {
  let cancel: (error: unknown) => void = () => {};
  const promise = new Promise<TsExtraction>((resolvePromise, reject) => {
    let settled = false;
    const timeout = setTimeout(() => fail(new Error(`index worker timed out: ${request.jobId}`)), 300_000);
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.terminate();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    cancel = fail;
    worker.onerror = (event) => fail(new Error(`index worker crashed: ${event.message}`));
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (settled) return;
      const response = event.data;
      if (!isExtractionWorkerResponse(response, request)) {
        fail(new Error("index worker returned a malformed extraction DTO"));
        return;
      }
      if (!response.ok) {
        fail(new Error(`index worker failed: ${response.error}`));
        return;
      }
      settled = true;
      clearTimeout(timeout);
      worker.terminate();
      resolvePromise(response.extraction);
    };
    worker.postMessage(request);
  });
  return { promise, cancel };
}

function isExtractionWorkerResponse(
  value: unknown,
  request: ExtractionWorkerRequest,
): value is ExtractionWorkerResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (
    record["schemaVersion"] !== 1
    || record["jobId"] !== request.jobId
    || typeof record["ok"] !== "boolean"
  ) return false;
  if (record["ok"] === false) return typeof record["error"] === "string";
  const extraction = record["extraction"];
  if (typeof extraction !== "object" || extraction === null) return false;
  const dto = extraction as Record<string, unknown>;
  if (!(Array.isArray(dto["modules"])
    && Array.isArray(dto["symbols"])
    && Array.isArray(dto["imports"])
    && Array.isArray(dto["calls"]))) return false;
  const emitPaths = new Set(request.emitAbsPaths.map((path) => normalizePath(relative(request.repoRoot, path))));
  const modules = dto["modules"];
  if (!modules.every((path) => typeof path === "string" && emitPaths.has(path))) return false;
  if (new Set(modules).size !== modules.length || modules.length !== emitPaths.size) return false;
  const owned = (path: unknown): path is string => typeof path === "string" && emitPaths.has(path);
  const inRepository = (path: unknown): path is string => {
    if (typeof path !== "string" || path.length === 0 || path.includes("\\") || path.startsWith("/")) return false;
    if (/^[A-Za-z]:/.test(path) || path === ".." || path.startsWith("../")) return false;
    return posix.normalize(path) === path;
  };
  const line = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 1;
  const optionalString = (value: unknown): value is string | undefined => value === undefined || typeof value === "string";
  const stringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === "string");
  const symbolKinds = new Set(["function", "class", "interface", "type", "enum"]);
  const markerTags = new Set(["capability", "invariant", "contract", "risk", "boundedContext", "tag"]);
  const marker = (value: unknown): boolean => isRecord(value)
    && typeof value["tag"] === "string"
    && markerTags.has(value["tag"])
    && typeof value["slug"] === "string"
    && optionalString(value["statement"]);
  return dto["symbols"].every((item) => isRecord(item)
      && typeof item["name"] === "string"
      && typeof item["kind"] === "string"
      && symbolKinds.has(item["kind"])
      && owned(item["relPath"])
      && line(item["startLine"])
      && line(item["endLine"])
      && item["endLine"] >= item["startLine"]
      && typeof item["exported"] === "boolean"
      && optionalString(item["jsdoc"])
      && Array.isArray(item["markers"])
      && item["markers"].every(marker))
    && dto["imports"].every((item) => isRecord(item)
      && owned(item["fromRelPath"])
      && typeof item["moduleSpecifier"] === "string"
      && (item["resolvedRelPath"] === undefined || inRepository(item["resolvedRelPath"]))
      && stringArray(item["names"])
      && line(item["line"]))
    && dto["calls"].every((item) => isRecord(item)
      && owned(item["callerRelPath"])
      && optionalString(item["callerSymbol"])
      && typeof item["calleeName"] === "string"
      && (item["calleeRelPath"] === undefined || inRepository(item["calleeRelPath"]))
      && optionalString(item["calleeSymbol"])
      && line(item["line"]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function mergeExtractions(
  extractions: readonly TsExtraction[],
  expectedSourcePaths: readonly string[],
  repoRoot: string,
): TsExtraction {
  const order = new Map(expectedSourcePaths.map((path, index) => [normalizePath(relative(repoRoot, path)), index]));
  const rank = (path: string): number => order.get(path) ?? Number.MAX_SAFE_INTEGER;
  const merged: TsExtraction = {
    modules: extractions.flatMap((value) => value.modules).sort((left, right) => rank(left) - rank(right)),
    symbols: extractions.flatMap((value) => value.symbols).sort((left, right) =>
      rank(left.relPath) - rank(right.relPath) || left.startLine - right.startLine),
    imports: extractions.flatMap((value) => value.imports).sort((left, right) =>
      rank(left.fromRelPath) - rank(right.fromRelPath) || left.line - right.line),
    calls: extractions.flatMap((value) => value.calls).sort((left, right) =>
      rank(left.callerRelPath) - rank(right.callerRelPath) || left.line - right.line),
  };
  const actual = [...merged.modules].sort();
  const expected = expectedSourcePaths.map((path) => normalizePath(relative(repoRoot, path)));
  if (new Set(actual).size !== actual.length || actual.join("\n") !== expected.sort().join("\n")) {
    throw new Error("parallel TypeScript extraction did not cover every source path exactly once");
  }
  return merged;
}

function isFunctionLike(node: ts.Node): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/**
 * Value-imported binding names only. Type-only imports (`import type { X }` or
 * `import { type X }`) execute nothing, so they must NOT create tested_by coverage.
 * Structural `imports` edges do not use these names, so they are unaffected.
 */
function importedNames(node: ts.ImportDeclaration): string[] {
  const clause = node.importClause;
  if (clause === undefined) return [];
  if (clause.isTypeOnly) return [];
  const names: string[] = [];
  if (clause.name) names.push(clause.name.text);
  const bindings = clause.namedBindings;
  if (bindings) {
    if (ts.isNamespaceImport(bindings)) {
      names.push(bindings.name.text);
    } else {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        names.push(element.name.text);
      }
    }
  }
  return names;
}

function resolveCallTarget(
  checker: ts.TypeChecker,
  expr: ts.Expression,
  relOf: (abs: string) => string,
): { relPath?: string; name?: string } | undefined {
  let symbol = checker.getSymbolAtLocation(expr);
  if (symbol === undefined) return undefined;
  // Follow import aliases to the real declaration (imported functions call across files).
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  const declarations = symbol.getDeclarations();
  if (declarations === undefined || declarations.length === 0) return undefined;
  const decl = declarations[0];
  if (decl === undefined) return undefined;
  const sf = decl.getSourceFile();
  if (sf.isDeclarationFile) return { name: symbol.getName() };
  return { relPath: relOf(sf.fileName), name: symbol.getName() };
}
