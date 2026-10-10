import ts from "typescript";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";
import { compareIds, normalizePath, symbolScopePath } from "@semantic-context/core";
import type { NodeKind } from "@semantic-context/core";
import { parseMarkers, type ParsedMarker } from "./markers";

/** Exact TypeScript runtime version bound into Plane A capability scopes. */
export const TYPESCRIPT_DIALECT_VERSION = ts.version;
export type CompilerInputSnapshot = ReadonlyMap<string, string>;
const snapshotSystems = new WeakMap<CompilerInputSnapshot, ts.System>();

function snapshotSystem(snapshot: CompilerInputSnapshot): ts.System {
  const cached = snapshotSystems.get(snapshot);
  if (cached) return cached;
  const retained = new Map([...snapshot].map(([path, content]) => [canonicalTypeScriptFileKey(path), content]));
  const directories = new Set<string>();
  for (const path of retained.keys()) {
    for (let directory = posix.dirname(path); ; directory = posix.dirname(directory)) {
      directories.add(directory);
      if (posix.dirname(directory) === directory) break;
    }
  }
  const libraryRoot = canonicalTypeScriptFileKey(dirname(ts.getDefaultLibFilePath(COMPILER_OPTIONS)));
  const library = (path: string): boolean => canonicalTypeScriptFileKey(path).startsWith(`${libraryRoot}/`);
  const system: ts.System = {
    ...ts.sys,
    readFile: path => retained.get(canonicalTypeScriptFileKey(path)) ?? (library(path) ? ts.sys.readFile(path) : undefined),
    fileExists: path => retained.has(canonicalTypeScriptFileKey(path)) || (library(path) && ts.sys.fileExists(path)),
    directoryExists: path => {
      return directories.has(canonicalTypeScriptFileKey(path)) || (library(path) && ts.sys.directoryExists(path));
    },
    readDirectory: () => [],
  };
  snapshotSystems.set(snapshot, system);
  return system;
}

/** Internal read seam for diagnostics over the same retained compiler inputs. */
export function retainedCompilerSystem(snapshot: CompilerInputSnapshot): ts.System {
  return snapshotSystem(snapshot);
}

export interface ExtractedSymbol {
  name: string;
  kind: Extract<NodeKind, "function" | "class" | "interface" | "type" | "enum">;
  relPath: string;
  /** Enclosing named declarations, outermost first. Empty at file scope. */
  scope: string[];
  startLine: number;
  endLine: number;
  exported: boolean;
  /**
   * A TypeScript overload signature: a function declaration with no body. Exactly one member of an
   * overload set carries an implementation, which is what lets grouping tell an overload set apart
   * from two genuinely distinct declarations that happen to share a scope and a name.
   */
  signatureOnly?: boolean;
  jsdoc?: string;
  markers: ParsedMarker[];
}

export interface ExtractedImport {
  fromRelPath: string;
  moduleSpecifier: string;
  resolvedRelPath?: string;
  names: string[];
  /** Canonical value-binding owners, independent of the structurally imported module. */
  bindingTargets?: { relPath: string; symbolPath: string }[];
  line: number;
}

export interface ExtractedCall {
  callerRelPath: string;
  /**
   * Scope-qualified path of the enclosing symbol (`outer.helper`), not its bare name.
   *
   * A bare name cannot tell two nested homonyms apart, so the call graph used to attach an inner
   * helper's calls to whichever same-named symbol the index happened to hold.
   */
  callerSymbolPath?: string;
  callerUnmodeledReason?: string;
  calleeName: string;
  calleeRelPath?: string;
  /** Scope-qualified path of the resolved declaration, for the same reason as `callerSymbolPath`. */
  calleeSymbolPath?: string;
  /** Retained semantic endpoints whose declaration has no extracted owner coordinate. */
  calleeUnmodeledReason?: string;
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
  allowJs: true,
  jsx: ts.JsxEmit.Preserve,
  skipLibCheck: true,
  noEmit: true,
  strict: false,
};

/** Internal semantic context; intentionally not exported from the package root. */
export const extractionContext = {
  createProgram(this: void, rootAbsPaths: string[], snapshot?: CompilerInputSnapshot): ts.Program {
    const host = ts.createCompilerHost(COMPILER_OPTIONS);
    const system = snapshot === undefined ? ts.sys : snapshotSystem(snapshot);
    if (snapshot !== undefined) {
      host.readFile = path => system.readFile(path);
      host.fileExists = path => system.fileExists(path);
      host.directoryExists = path => system.directoryExists!(path);
    }
    // Match tsc's semantic parsing: retain type-error JSDoc, avoid prose ASTs in dependencies.
    // Semctx reads its JSDoc/markers from source text, independently of these compiler nodes.
    host.jsDocParsingMode = ts.JSDocParsingMode.ParseForTypeErrors;
    if (snapshot !== undefined || rootAbsPaths.some(path => /\.(mjs|cjs|js|jsx)$/.test(path))) {
      host.resolveModuleNames = (names, containingFile) => names.map(name =>
        resolveConfiguredModule(name, containingFile, undefined, system)?.resolvedModule);
    }
    return ts.createProgram(rootAbsPaths, COMPILER_OPTIONS, host);
  },
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

/** Internal resolver shared with discovery confinement; intentionally absent from the package root. */
export function resolveTypeScriptModule(
  specifier: string,
  containingFile: string,
  resolutionMode?: ts.ResolutionMode,
  configured = /\.(mjs|cjs|js|jsx)$/.test(containingFile),
  snapshot?: CompilerInputSnapshot,
): string | undefined {
  const system = snapshot === undefined ? ts.sys : snapshotSystem(snapshot);
  const resolved = configured
    ? resolveConfiguredModule(specifier, containingFile, resolutionMode, system)
    : ts.resolveModuleName(specifier, containingFile, COMPILER_OPTIONS, system, undefined, undefined, resolutionMode);
  // A declaration companion describes the runtime module; dependency edges target the actual
  // source when it exists, rather than silently ending at the skipped .d.mts/.d.cts artifact.
  const declarationPath = resolved.resolvedModule?.resolvedFileName;
  if (configured && declarationPath !== undefined && /\.d\.(mts|cts|ts)$/.test(declarationPath)) {
    const runtimePath = declarationPath.replace(/\.d\.(mts|cts|ts)$/, (_, extension: string) =>
      extension === "mts" ? ".mjs" : extension === "cts" ? ".cjs" : ".js");
    if (system.fileExists(runtimePath)) return runtimePath;
  }
  return declarationPath;
}

function resolveConfiguredModule(specifier: string, containingFile: string, resolutionMode?: ts.ResolutionMode, system: ts.System = ts.sys): ts.ResolvedModuleWithFailedLookupLocations {
  const configPath = ts.findConfigFile(dirname(containingFile), path => system.fileExists(path));
  let options = COMPILER_OPTIONS;
  if (configPath !== undefined) {
    const config = ts.readConfigFile(configPath, path => system.readFile(path));
    if (config.error === undefined) {
      // Module resolution needs inherited options, not a redundant scan of every tsconfig input.
      const parsed = ts.parseJsonConfigFileContent(config.config, { ...system, readDirectory: () => [] }, dirname(configPath));
      options = { ...COMPILER_OPTIONS, ...parsed.options };
    }
  }
  return ts.resolveModuleName(
    specifier,
    containingFile,
    options,
    system,
    undefined,
    undefined,
    resolutionMode ?? ts.getImpliedNodeFormatForFile(containingFile, undefined, system, options),
  );
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

function isContainedTypeScriptPath(repoRoot: string, filePath: string): boolean {
  const rel = relative(repoRoot, filePath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel));
}

/** Internal confinement helper shared with discovery; not part of the package root API. */
export function canonicalFilesystemPath(filePath: string): string {
  const absolute = resolve(filePath);
  let ancestor = absolute;
  for (;;) {
    try {
      // Extensionless imports may not exist yet; their existing parent still resolves aliases.
      return resolve(realpathSync.native(ancestor), relative(ancestor, absolute));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

/**
 * Refuse repository-authored relative dependency traversal before TypeScript can read the target.
 * Bare package imports, configured type packages and the standard library remain delegated to the
 * normal compiler host so the analyzer keeps the same TypeChecker environment for admitted input.
 */
function assertConfinedTypeScriptSources(rootAbsPaths: readonly string[], repoRoot: string, snapshot?: CompilerInputSnapshot): void {
  const canonicalRoot = canonicalFilesystemPath(repoRoot);
  const pending = [...rootAbsPaths];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop()!;
    const canonical = canonicalFilesystemPath(path);
    if (!isContainedTypeScriptPath(canonicalRoot, canonical)) {
      throw new Error(`SOURCE_LINK_OUTSIDE_REPOSITORY: ${normalizePath(relative(repoRoot, path))}`);
    }
    const key = canonicalTypeScriptFileKey(canonical);
    if (visited.has(key)) continue;
    visited.add(key);
    const source = snapshot === undefined ? readFileSync(path, "utf8") : snapshotSystem(snapshot).readFile(path);
    if (source === undefined) throw new Error(`SOURCE_SNAPSHOT_MISSING: ${normalizePath(relative(repoRoot, path))}`);
    const preprocessed = ts.preProcessFile(source, true, true);
    for (const imported of preprocessed.importedFiles) {
      if (!imported.fileName.startsWith(".")) continue;
      const lexical = resolve(dirname(path), imported.fileName);
      if (!isContainedTypeScriptPath(canonicalRoot, canonicalFilesystemPath(lexical))) {
        throw new Error(`IMPORT_OUTSIDE_REPOSITORY: ${imported.fileName}`);
      }
      const resolved = resolveTypeScriptModule(imported.fileName, path, undefined, snapshot !== undefined || /\.(mjs|cjs|js|jsx)$/.test(path), snapshot);
      if (resolved === undefined) continue;
      const resolvedCanonical = canonicalFilesystemPath(resolved);
      if (!isContainedTypeScriptPath(canonicalRoot, resolvedCanonical)) {
        throw new Error(`IMPORT_OUTSIDE_REPOSITORY: ${imported.fileName}`);
      }
      pending.push(resolved);
    }
    for (const referenced of preprocessed.referencedFiles) {
      const lexical = resolve(dirname(path), referenced.fileName);
      if (!isContainedTypeScriptPath(canonicalRoot, canonicalFilesystemPath(lexical))) {
        throw new Error(`REFERENCE_OUTSIDE_REPOSITORY: ${referenced.fileName}`);
      }
      const referencedCanonical = canonicalFilesystemPath(lexical);
      if (!isContainedTypeScriptPath(canonicalRoot, referencedCanonical)) {
        throw new Error(`REFERENCE_OUTSIDE_REPOSITORY: ${referenced.fileName}`);
      }
      // A retained analysis cannot enqueue or read a reference omitted from its snapshot.
      // Qualified admission reports that missing dependency as a structured scope rejection.
      if (snapshot === undefined ? existsSync(lexical) : snapshotSystem(snapshot).fileExists(lexical)) pending.push(lexical);
    }
  }
}

/** Extract modules, symbols, imports and best-effort resolved calls from source/test files. */
export function extractTypeScript(rootAbsPaths: string[], repoRoot: string, suppliedSnapshot?: CompilerInputSnapshot): TsExtraction {
  const snapshot = suppliedSnapshot === undefined ? undefined : new Map(suppliedSnapshot);
  assertConfinedTypeScriptSources(rootAbsPaths, repoRoot, snapshot);
  const program = extractionContext.createProgram(rootAbsPaths, snapshot);
  const checker = program.getTypeChecker();
  const rootSet = new Set(rootAbsPaths.map(canonicalTypeScriptFileKey));
  const javascriptEnabled = rootAbsPaths.some(path => /\.(mjs|cjs|js|jsx)$/.test(path));
  // A retained qualified snapshot needs complete static module links even in a TS-only graph.
  // Keep the historical no-snapshot TS extraction unchanged for legacy callers.
  const staticModuleLinksEnabled = javascriptEnabled || snapshot !== undefined;

  const modules: string[] = [];
  const symbols: ExtractedSymbol[] = [];
  const imports: ExtractedImport[] = [];
  const calls: ExtractedCall[] = [];

  const canonicalRoot = canonicalFilesystemPath(repoRoot);
  const relOf = (abs: string): string => normalizePath(relative(canonicalRoot, canonicalFilesystemPath(abs)));

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    if (!rootSet.has(canonicalTypeScriptFileKey(sf.fileName))) continue;
    const relPath = relOf(sf.fileName);
    modules.push(relPath);
    const exportedDeclarations = new Set<ts.Declaration>();
    const namespaceReferences = staticModuleLinksEnabled ? namespaceCallReferences(sf, checker) : undefined;
    if (staticModuleLinksEnabled) {
      const moduleSymbol = checker.getSymbolAtLocation(sf);
      if (moduleSymbol !== undefined) {
        for (let symbol of checker.getExportsOfModule(moduleSymbol)) {
          if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
          for (const declaration of symbol.getDeclarations() ?? []) exportedDeclarations.add(declaration);
        }
      }
    }

    // Scope-qualified paths of the enclosing extracted symbols, innermost last. Distinct from
    // `scopeStack`, which only tracks what can *contain*: a method is a scope but is not itself an
    // extracted symbol, so it can never be the caller of a call.
    const symbolPathStack: string[] = [];
    // A scope is anything that can contain another declaration — methods and namespaces included —
    // because two locals named the same inside two methods of one class are two symbols, not one.
    const scopeStack: string[] = [];

    const recordSymbol = (
      node: ts.Node,
      name: string,
      kind: ExtractedSymbol["kind"],
      signatureOnly = false,
    ): void => {
      const jsdoc = leadingJsDoc(sf, node);
      symbols.push({
        name,
        kind,
        relPath,
        scope: [...scopeStack],
        startLine: lineOf(sf, node.getStart()),
        endLine: lineOf(sf, node.getEnd()),
        exported: isExported(node) || exportedDeclarations.has(node as ts.Declaration),
        ...(signatureOnly ? { signatureOnly: true } : {}),
        ...(jsdoc !== undefined ? { jsdoc } : {}),
        markers: jsdoc !== undefined ? parseMarkers(jsdoc) : [],
      });
    };

    const visit = (node: ts.Node): void => {
      let pushedSymbol: string | undefined;
      let pushedScope: string | undefined;

      if (ts.isFunctionDeclaration(node) && scopeNameOf(node) !== undefined) {
        const name = scopeNameOf(node)!;
        recordSymbol(node, name, "function", node.body === undefined);
        pushedSymbol = symbolScopePath(scopeStack, name);
        pushedScope = name;
      } else if (ts.isClassDeclaration(node) && scopeNameOf(node) !== undefined) {
        const name = scopeNameOf(node)!;
        recordSymbol(node, name, "class");
        pushedSymbol = symbolScopePath(scopeStack, name);
        pushedScope = name;
      } else if (ts.isInterfaceDeclaration(node)) {
        recordSymbol(node, node.name.text, "interface");
      } else if (ts.isTypeAliasDeclaration(node)) {
        recordSymbol(node, node.name.text, "type");
      } else if (ts.isEnumDeclaration(node)) {
        recordSymbol(node, node.name.text, "enum");
      } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
        // Not itself an extracted symbol today, but it *is* a scope: without it, a local in
        // `Service.read` and a local in `Service.write` would share one id.
        pushedScope = node.name.text;
      } else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
        pushedScope = node.name.text;
      } else if (ts.isVariableStatement(node)) {
        // Each declarator owns its own scope. `const first = () => …, second = () => …` used to
        // push one name for the whole statement, so `first`'s body was walked under `second`'s
        // scope and every nested declaration inside it was given the wrong identity.
        const exported = isExported(node);
        const jsdoc = leadingJsDoc(sf, node);
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer && isFunctionLike(decl.initializer)) {
            symbols.push({
              name: decl.name.text,
              kind: "function",
              relPath,
              scope: [...scopeStack],
              startLine: lineOf(sf, node.getStart()),
              endLine: lineOf(sf, decl.getEnd()),
              exported: exported || exportedDeclarations.has(decl),
              ...(jsdoc !== undefined ? { jsdoc } : {}),
              markers: jsdoc !== undefined ? parseMarkers(jsdoc) : [],
            });
            symbolPathStack.push(symbolScopePath(scopeStack, decl.name.text));
            scopeStack.push(decl.name.text);
            ts.forEachChild(decl, visit);
            scopeStack.pop();
            symbolPathStack.pop();
          } else {
            ts.forEachChild(decl, visit);
          }
        }
        return;
      } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        const resolvedAbs = resolveTypeScriptModule(specifier, sf.fileName, undefined, javascriptEnabled || snapshot !== undefined, snapshot);
        const names = importedNames(node, staticModuleLinksEnabled);
        const namespace = node.importClause?.namedBindings;
        const namespaceSymbol = node.importClause?.isTypeOnly !== true && namespace !== undefined && ts.isNamespaceImport(namespace)
          ? checker.getSymbolAtLocation(namespace.name) : undefined;
        const references = [...valueImportBindings(node), ...(namespaceSymbol === undefined ? [] : namespaceReferences?.get(namespaceSymbol) ?? [])];
        const bindingTargets = staticModuleLinksEnabled ? references.flatMap(binding => {
          const target = resolveCallTarget(checker, binding, relOf, javascriptEnabled, snapshot);
          return target?.relPath !== undefined && target.symbolPath !== undefined ? [{ relPath: target.relPath, symbolPath: target.symbolPath }] : [];
        }) : undefined;
        imports.push({
          fromRelPath: relPath,
          moduleSpecifier: specifier,
          ...(resolvedAbs !== undefined ? { resolvedRelPath: relOf(resolvedAbs) } : {}),
          names,
          ...(bindingTargets === undefined ? {} : { bindingTargets }),
          line: lineOf(sf, node.getStart()),
        });
      } else if (staticModuleLinksEnabled && ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        const resolvedAbs = resolveTypeScriptModule(specifier, sf.fileName, undefined, javascriptEnabled || snapshot !== undefined, snapshot);
        imports.push({
          fromRelPath: relPath,
          moduleSpecifier: specifier,
          ...(resolvedAbs !== undefined ? { resolvedRelPath: relOf(resolvedAbs) } : {}),
          names: [],
          line: lineOf(sf, node.getStart()),
        });
      } else if (ts.isCallExpression(node)) {
        if (staticModuleLinksEnabled && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!)) {
          const specifier = (node.arguments[0] as ts.StringLiteral).text;
          const resolvedAbs = resolveTypeScriptModule(specifier, sf.fileName, ts.ModuleKind.ESNext, javascriptEnabled || snapshot !== undefined, snapshot);
          imports.push({ fromRelPath: relPath, moduleSpecifier: specifier,
            ...(resolvedAbs !== undefined ? { resolvedRelPath: relOf(resolvedAbs) } : {}),
            names: [], line: lineOf(sf, node.getStart()) });
        }
        let callee: ts.Expression = node.expression;
        if (staticModuleLinksEnabled) {
          while (ts.isParenthesizedExpression(callee) || ts.isAsExpression(callee) || ts.isTypeAssertionExpression(callee)
            || ts.isNonNullExpression(callee) || ts.isSatisfiesExpression(callee)) callee = callee.expression;
        }
        const calleeName = nameOfCallee(callee);
        if (calleeName !== undefined) {
          const resolved = resolveCallTarget(checker, callee, relOf, javascriptEnabled, snapshot);
          calls.push({
            callerRelPath: relPath,
            ...(snapshot !== undefined && hasObjectLiteralMemberAncestor(node) ? { callerUnmodeledReason: "OBJECT_LITERAL_MEMBER" } : {}),
            ...(symbolPathStack.length > 0
              ? { callerSymbolPath: symbolPathStack[symbolPathStack.length - 1] }
              : {}),
            calleeName,
            ...(resolved?.relPath !== undefined ? { calleeRelPath: resolved.relPath } : {}),
            ...(resolved?.symbolPath !== undefined ? { calleeSymbolPath: resolved.symbolPath } : {}),
            ...(resolved?.unmodeledReason !== undefined ? { calleeUnmodeledReason: resolved.unmodeledReason } : {}),
            line: lineOf(sf, node.getStart()),
          });
        }
      }

      if (pushedSymbol !== undefined) symbolPathStack.push(pushedSymbol);
      if (pushedScope !== undefined) scopeStack.push(pushedScope);
      ts.forEachChild(node, visit);
      if (pushedScope !== undefined) scopeStack.pop();
      if (pushedSymbol !== undefined) symbolPathStack.pop();
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
  snapshot?: CompilerInputSnapshot,
): Promise<ParallelTsExtraction> {
  if (snapshot !== undefined) {
    return { extraction: extractTypeScript(rootAbsPaths, repoRoot, snapshot), parallelism: { requested, used: 1, mode: "preflight-fallback", reason: "retained compiler input snapshot requires one semantic Program" } };
  }
  assertConfinedTypeScriptSources(rootAbsPaths, repoRoot);
  const workerLimit = resolveWorkerCount(requested, rootAbsPaths.length);
  if (workerLimit > 1 && rootAbsPaths.some(path => /\.(mjs|cjs|js|jsx)$/.test(path))) {
    return {
      extraction: extractTypeScript(rootAbsPaths, repoRoot),
      parallelism: { requested, used: 1, mode: "preflight-fallback", reason: "mixed JavaScript/TypeScript extraction requires one semantic Program" },
    };
  }
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
  // The exact macos-15 Apple Silicon benchmark currently shows both higher wall time and retained
  // RSS with multiple Workers. Keep automatic selection safe there until real-repository evidence
  // establishes a crossover; explicit worker counts remain available for operator experiments.
  if (process.platform === "darwin") return 1;
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
      const resolved = resolveTypeScriptModule(usage.literal.text, source.fileName, resolutionMode);
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
      && stringArray(item["scope"])
      && line(item["startLine"])
      && line(item["endLine"])
      && item["endLine"] >= item["startLine"]
      && typeof item["exported"] === "boolean"
      && (item["signatureOnly"] === undefined || typeof item["signatureOnly"] === "boolean")
      && optionalString(item["jsdoc"])
      && Array.isArray(item["markers"])
      && item["markers"].every(marker))
    && dto["imports"].every((item) => isRecord(item)
      && owned(item["fromRelPath"])
      && typeof item["moduleSpecifier"] === "string"
      && (item["resolvedRelPath"] === undefined || inRepository(item["resolvedRelPath"]))
      && stringArray(item["names"])
      && (item["bindingTargets"] === undefined || (Array.isArray(item["bindingTargets"])
        && item["bindingTargets"].every(target => isRecord(target) && inRepository(target["relPath"])
          && typeof target["symbolPath"] === "string")))
      && line(item["line"]))
    && dto["calls"].every((item) => isRecord(item)
      && owned(item["callerRelPath"])
      && optionalString(item["callerSymbolPath"])
      && typeof item["calleeName"] === "string"
      && (item["calleeRelPath"] === undefined || inRepository(item["calleeRelPath"]))
      && optionalString(item["calleeSymbolPath"])
      && optionalString(item["calleeUnmodeledReason"])
      && optionalString(item["callerUnmodeledReason"])
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
function importedNames(node: ts.ImportDeclaration, canonical = false): string[] {
  const clause = node.importClause;
  if (clause === undefined) return [];
  if (clause.isTypeOnly) return [];
  const names: string[] = [];
  if (clause.name) names.push(canonical ? "default" : clause.name.text);
  const bindings = clause.namedBindings;
  if (bindings) {
    if (ts.isNamespaceImport(bindings)) {
      names.push(bindings.name.text);
    } else {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        names.push(canonical ? (element.propertyName ?? element.name).text : element.name.text);
      }
    }
  }
  return names;
}

function valueImportBindings(node: ts.ImportDeclaration): ts.Identifier[] {
  const clause = node.importClause;
  if (clause === undefined || clause.isTypeOnly) return [];
  const bindings: ts.Identifier[] = clause.name === undefined ? [] : [clause.name];
  if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
    for (const element of clause.namedBindings.elements) if (!element.isTypeOnly) bindings.push(element.name);
  }
  return bindings;
}

/** Called member references keyed by their actual lexical receiver binding, never its spelling. */
function namespaceCallReferences(source: ts.SourceFile, checker: ts.TypeChecker): Map<ts.Symbol, ts.Expression[]> {
  const references = new Map<ts.Symbol, ts.Expression[]>();
  const unwrap = (expression: ts.Expression): ts.Expression => {
    while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)
      || ts.isNonNullExpression(expression) || ts.isSatisfiesExpression(expression)) expression = expression.expression;
    return expression;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const member = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(member)) {
        let target = checker.getSymbolAtLocation(member);
        if (target !== undefined && (target.flags & ts.SymbolFlags.Alias) !== 0) target = checker.getAliasedSymbol(target);
        const declaration = target?.getDeclarations()?.[0];
        // Only owners already extracted as callable symbols can supply coverage. Property,
        // method and callback origins cannot borrow a same-named file-level coordinate.
        const modeled = declaration !== undefined && (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)
          || (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined && isFunctionLike(declaration.initializer)));
        if (!modeled) { ts.forEachChild(node, visit); return; }
        let receiver = unwrap(member.expression);
        while (ts.isPropertyAccessExpression(receiver)) receiver = unwrap(receiver.expression);
        const binding = checker.getSymbolAtLocation(receiver);
        if (binding !== undefined) {
          const targets = references.get(binding) ?? [];
          targets.push(member); references.set(binding, targets);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

/**
 * The name a declaration contributes to the scope path of everything inside it.
 *
 * Mirrors exactly the pushes the extraction walk makes, so a scope path derived from a declaration
 * node here and one accumulated during the walk describe the same coordinate. A divergence between
 * the two would put callers and callees in different address spaces.
 */
function scopeNameOf(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
    return node.name?.text ?? ((ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Default) !== 0 ? "default" : undefined);
  }
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  if (
    ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.initializer !== undefined
    && isFunctionLike(node.initializer)
  ) {
    return node.name.text;
  }
  return undefined;
}

/** Enclosing scope names of a declaration, outermost first, excluding the declaration itself. */
function enclosingScopeOf(node: ts.Node, retainInterfaceOwners = false): string[] {
  const scope: string[] = [];
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    const name = retainInterfaceOwners && ts.isInterfaceDeclaration(current) ? current.name.text : scopeNameOf(current);
    if (name !== undefined) scope.unshift(name);
  }
  return scope;
}

function resolveCallTarget(
  checker: ts.TypeChecker,
  expr: ts.Expression,
  relOf: (abs: string) => string,
  javascriptEnabled = false,
  snapshot?: CompilerInputSnapshot,
): { relPath?: string; symbolPath?: string; unmodeledReason?: string } | undefined {
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
  const symbolName = javascriptEnabled || snapshot !== undefined ? scopeNameOf(decl) ?? symbol.getName() : symbol.getName();
  if (sf.isDeclarationFile) {
    if (javascriptEnabled && /\.d\.(mts|cts|ts)$/.test(sf.fileName)) {
      const runtimePath = sf.fileName.replace(/\.d\.(mts|cts|ts)$/, (_, extension: string) =>
        extension === "mts" ? ".mjs" : extension === "cts" ? ".cjs" : ".js");
      if (snapshot === undefined ? existsSync(runtimePath) : snapshotSystem(snapshot).fileExists(runtimePath)) return { relPath: relOf(runtimePath), symbolPath: symbolScopePath(enclosingScopeOf(decl, snapshot !== undefined), symbolName) };
    }
    return { symbolPath: symbolScopePath(enclosingScopeOf(decl, snapshot !== undefined), symbolName) };
  }
  return {
    relPath: relOf(sf.fileName),
    symbolPath: symbolScopePath(enclosingScopeOf(decl, snapshot !== undefined), symbolName),
    ...(snapshot !== undefined && ts.isObjectLiteralExpression(decl.parent)
      ? { unmodeledReason: "OBJECT_LITERAL_MEMBER" } : {}),
  };
}

function hasObjectLiteralMemberAncestor(node: ts.Node): boolean {
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (parent.parent !== undefined && ts.isObjectLiteralExpression(parent.parent)
      && (ts.isMethodDeclaration(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent))) return true;
    if (isFunctionLike(parent)) {
      let owner = parent.parent;
      while (owner !== undefined && (ts.isParenthesizedExpression(owner) || ts.isAsExpression(owner)
        || ts.isTypeAssertionExpression(owner) || ts.isNonNullExpression(owner) || ts.isSatisfiesExpression(owner))) owner = owner.parent;
      if (owner !== undefined && ts.isPropertyAssignment(owner) && ts.isObjectLiteralExpression(owner.parent)) return true;
    }
  }
  return false;
}
