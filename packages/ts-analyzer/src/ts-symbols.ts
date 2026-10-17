import ts from "typescript";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, posix, relative, resolve } from "node:path";
import { compareIds, normalizePath, symbolScopePath } from "@semantic-context/core";
import type { NodeKind } from "@semantic-context/core";
import { parseMarkers, type ParsedMarker } from "./markers";
import { createWorkspaceLinkResolver, workspaceLinkedSystem, type WorkspaceLinkResolver } from "./workspace-links";

/** Exact TypeScript runtime version bound into Plane A capability scopes. */
export const TYPESCRIPT_DIALECT_VERSION = ts.version;
/** The exact SDK library directory used by retained compiler hosts. */
export function typeScriptLibraryDirectory(): string { return dirname(ts.getDefaultLibFilePath(COMPILER_OPTIONS)); }
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
      directories.add(canonicalTypeScriptFileKey(directory));
      if (posix.dirname(directory) === directory) break;
    }
  }
  const libraryRoot = canonicalTypeScriptFileKey(typeScriptLibraryDirectory());
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
  bindingTargets?: { relPath: string; symbolPath: string; runtimeUsed?: boolean; unmodeledReason?: string }[];
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
  tsconfigPathMapping?: boolean;
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

/**
 * Opt-in behavior of one extraction pass. The default is the historical extraction, which callers
 * that cannot bind live configuration into their freshness identity must keep.
 */
export interface TypeScriptExtractionOptions {
  /**
   * Resolve the non-relative specifiers of a TypeScript-only, snapshot-free graph through the
   * `paths` and `baseUrl` of the nearest tsconfig, `extends` included, over the historical Bundler
   * resolution. Nothing else of that configuration is applied, and a specifier that no mapping
   * covers takes the historical resolution unchanged. Set it only where the analysis input identity
   * binds the configuration files read here: configuration v2 through its live configuration
   * inspection, configuration v1 through `pathMappingInputs`.
   */
  tsconfigPathMapping?: boolean;
}

/** Internal semantic context; intentionally not exported from the package root. */
export const extractionContext = {
  createProgram(
    this: void,
    rootAbsPaths: string[],
    snapshot?: CompilerInputSnapshot,
    repoRoot?: string,
    options: TypeScriptExtractionOptions = {},
    mapping: PathMappingPass | undefined = createPathMappingPassFor(rootAbsPaths, repoRoot, snapshot, options),
  ): ts.Program {
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
      const workspaceLinks = createWorkspaceLinkResolver();
      host.resolveModuleNames = (names, containingFile) => names.map(name =>
        resolveConfiguredModule(name, containingFile, undefined, system, workspaceLinks, repoRoot)?.resolvedModule);
    } else if (mapping !== undefined) {
      installPathMappedResolution(host, mapping, COMPILER_OPTIONS);
    }
    return ts.createProgram(rootAbsPaths, COMPILER_OPTIONS, host);
  },
};

/**
 * The Program must see what the extractor sees, or an aliased callee has no declaration to resolve
 * to. It is only replaced when a mapping governs some root: otherwise the Program is the
 * historical one by construction. Every specifier the mapping does not add a repository module for
 * is resolved as the compiler's default does, usage mode and cache included.
 */
function installPathMappedResolution(host: ts.CompilerHost, mapping: PathMappingPass, programOptions: ts.CompilerOptions): void {
  if (!mapping.governsAnyRoot()) return;
  const cache = ts.createModuleResolutionCache(host.getCurrentDirectory(), fileName => host.getCanonicalFileName(fileName), programOptions);
  host.resolveModuleNameLiterals = (literals, containingFile, redirectedReference, options, containingSourceFile) =>
    literals.map(literal => {
      const mode = ts.getModeForUsageLocation(containingSourceFile, literal, options);
      return resolvePathMappedModule(mapping, literal.text, containingFile, mode)
        ?? ts.resolveModuleName(literal.text, containingFile, options, host, cache, redirectedReference, mode);
    });
}

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

/** Transparent expression wrappers shared by semantic extraction and eligibility guards. */
export function unwrapStaticExpression(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression) || ts.isSatisfiesExpression(expression)) expression = expression.expression;
  return expression;
}

/** CallExpression domain: named callees, or import() handled separately as a module link. */
export function isModeledCallCallee(expression: ts.Expression): boolean {
  const callee = unwrapStaticExpression(expression);
  return nameOfCallee(callee) !== undefined || callee.kind === ts.SyntaxKind.ImportKeyword;
}

/** Internal resolver shared with discovery confinement; intentionally absent from the package root. */
export function resolveTypeScriptModule(
  specifier: string,
  containingFile: string,
  resolutionMode?: ts.ResolutionMode,
  configured = /\.(mjs|cjs|js|jsx)$/.test(containingFile),
  snapshot?: CompilerInputSnapshot,
  workspaceLinks?: WorkspaceLinkResolver,
  repositoryRoot?: string,
  pathMapping?: PathMappingPass,
): string | undefined {
  const system = snapshot === undefined ? ts.sys : snapshotSystem(snapshot);
  const resolved = configured
    ? resolveConfiguredModule(specifier, containingFile, resolutionMode, system, workspaceLinks, repositoryRoot)
    : (pathMapping !== undefined && snapshot === undefined
      ? resolvePathMappedModule(pathMapping, specifier, containingFile, resolutionMode)
      : undefined)
      ?? ts.resolveModuleName(specifier, containingFile, COMPILER_OPTIONS, system, undefined, undefined, resolutionMode);
  // A declaration companion describes the runtime module; dependency edges target the actual
  // source when it exists, rather than silently ending at the skipped .d.mts/.d.cts artifact.
  const declarationPath = resolved.resolvedModule?.resolvedFileName;
  if (configured && declarationPath !== undefined && /\.d\.(mts|cts|ts)$/.test(declarationPath)) {
    const runtimePath = declarationPath.replace(/\.d\.(mts|cts|ts)$/, (_, extension: string) =>
      extension === "mts" ? ".mjs" : extension === "cts" ? ".cjs" : ".js");
    if (system.fileExists(runtimePath)) {
      if (snapshot === undefined && repositoryRoot !== undefined) {
        try {
          if (!isContainedTypeScriptPath(canonicalFilesystemPath(repositoryRoot), canonicalFilesystemPath(runtimePath))) {
            workspaceLinks?.inputs.set(resolve(runtimePath).replaceAll("\\", "/"), undefined);
            return undefined;
          }
        } catch {
          workspaceLinks?.inputs.set(resolve(runtimePath).replaceAll("\\", "/"), undefined);
          return undefined;
        }
      }
      return runtimePath;
    }
  }
  return declarationPath;
}

function resolveConfiguredModule(
  specifier: string,
  containingFile: string,
  resolutionMode?: ts.ResolutionMode,
  system: ts.System = ts.sys,
  workspaceLinks: WorkspaceLinkResolver = createWorkspaceLinkResolver(),
  repositoryRoot?: string,
): ts.ResolvedModuleWithFailedLookupLocations {
  // Bind the analyzed root before the first live configuration lookup, not after
  // workspace metadata has already selected an enclosing declaration.
  const configurationSystem = system === ts.sys ? workspaceLinkedSystem(system, repositoryRoot, workspaceLinks) : system;
  const configured = nearestConfigurationOptions(dirname(containingFile), configurationSystem);
  return resolveWithOptions(
    specifier,
    containingFile,
    resolutionMode,
    configured === undefined ? COMPILER_OPTIONS : { ...COMPILER_OPTIONS, ...configured },
    system,
    configurationSystem,
    workspaceLinks,
    repositoryRoot,
  );
}

/** Options of the nearest readable tsconfig, `extends` included; `undefined` when none governs. */
function nearestConfigurationOptions(directory: string, configurationSystem: ts.System): ts.CompilerOptions | undefined {
  const configPath = ts.findConfigFile(directory, path => configurationSystem.fileExists(path));
  return configPath === undefined ? undefined : configurationOptions(configPath, configurationSystem);
}

function configurationOptions(configPath: string, configurationSystem: ts.System): ts.CompilerOptions | undefined {
  const config = ts.readConfigFile(configPath, path => configurationSystem.readFile(path));
  if (config.error !== undefined) return undefined;
  // Module resolution needs inherited options, not a redundant scan of every tsconfig input.
  // A live checkout may lack the installed link to a workspace member's shared configuration.
  return ts.parseJsonConfigFileContent(config.config, { ...configurationSystem, readDirectory: () => [] }, dirname(configPath)).options;
}

function resolveWithOptions(
  specifier: string,
  containingFile: string,
  resolutionMode: ts.ResolutionMode | undefined,
  options: ts.CompilerOptions,
  system: ts.System,
  configurationSystem: ts.System,
  workspaceLinks: WorkspaceLinkResolver,
  repositoryRoot: string | undefined,
  cache?: ts.ModuleResolutionCache,
): ts.ResolvedModuleWithFailedLookupLocations {
  // Final source resolution must obey the same root without admitting new synthetic
  // source-package links: only configuration inheritance uses those virtual paths.
  const liveRoot = system === ts.sys && repositoryRoot !== undefined
    ? { lexical: resolve(repositoryRoot), canonical: canonicalFilesystemPath(repositoryRoot) } : undefined;
  const admitted = (path: string): boolean => {
    if (liveRoot === undefined) return true;
    try {
      if (isContainedTypeScriptPath(liveRoot.lexical, resolve(path))
        && isContainedTypeScriptPath(liveRoot.canonical, canonicalFilesystemPath(path))) return true;
    } catch { /* Unobservable module inputs are not admitted. */ }
    workspaceLinks.inputs.set(resolve(path).replaceAll("\\", "/"), undefined);
    return false;
  };
  const resolutionSystem: ts.System = liveRoot !== undefined ? {
    ...configurationSystem,
    fileExists: path => admitted(path) && system.fileExists(path) && configurationSystem.fileExists(path),
    readFile: (path, encoding) => admitted(path) && system.fileExists(path) ? configurationSystem.readFile(path, encoding) : undefined,
    directoryExists: path => admitted(path) && (system.directoryExists?.(path) ?? false) && (configurationSystem.directoryExists?.(path) ?? false),
    realpath: path => admitted(path) && (system.fileExists(path) || (system.directoryExists?.(path) ?? false))
      ? configurationSystem.realpath?.(path) ?? path : path,
  } : system;
  return ts.resolveModuleName(
    specifier,
    containingFile,
    options,
    resolutionSystem,
    cache,
    undefined,
    resolutionMode ?? ts.getImpliedNodeFormatForFile(containingFile, undefined, resolutionSystem, options),
  );
}

/** The `paths`/`baseUrl` a tsconfig governs a directory with; nothing else of it is applied. */
interface PathMapping {
  readonly options: ts.CompilerOptions;
  /** `paths` keys TypeScript can match: at most one `*`, as it ignores any other. */
  readonly patterns: readonly string[];
  /**
   * Case-folded names directly below `baseUrl`, listed at most once per pass; `null` when they
   * cannot be listed under confinement, which keeps every specifier a candidate.
   */
  baseUrlEntries?: readonly string[] | null;
  /**
   * The compiler's own resolution cache for this mapping's options. It is keyed by importing
   * directory and usage mode, so a `package.json` `imports` entry, a self-name reference or a
   * `node_modules` lookup that depends on where the importer sits is never shared across directories.
   */
  readonly cache: ts.ModuleResolutionCache;
  /**
   * Specifiers (with usage mode and importer extension) this mapping has been seen to add no
   * repository module for. What a mapping adds comes from its `paths` and `baseUrl` candidates,
   * which are the same from every directory; what depends on the importing directory (a
   * `package.json` `imports` entry, a self-name reference, a `node_modules` lookup) is resolved by
   * the historical resolution as well, so skipping the attempt loses none of it. Only this absence
   * is shared across directories, never a resolution.
   */
  readonly addsNothing: Set<string>;
}

/**
 * The tsconfig `paths`/`baseUrl` resolution of one analysis pass. It is created per pass and holds
 * every derived mapping and cache, so no state outlives the pass that read the configuration: a
 * later pass observes a changed tsconfig.
 */
interface PathMappingPass {
  readonly repositoryRoot: string;
  /**
   * Canonical keys of the selected roots. Only their nearest configuration is bound into the
   * analysis input identity, so only imports written in a root are mapped: a file the Program loads
   * through an alias keeps the historical resolution for its own specifiers.
   */
  readonly roots: ReadonlySet<string>;
  readonly workspaceLinks: WorkspaceLinkResolver;
  readonly configurationSystem: ts.System;
  readonly byDirectory: Map<string, PathMapping | null>;
  readonly byConfiguration: Map<string, PathMapping | null>;
  readonly selected: Map<string, boolean>;
  /** Whether some root's nearest configuration declares `paths` or `baseUrl`. */
  governsAnyRoot(): boolean;
}

/**
 * The pass of a TypeScript-only, snapshot-free extraction that opted in. A retained snapshot and a
 * JavaScript-enabled graph already apply the complete nearest configuration, and without the
 * analyzed root nothing can be confined, so nothing is mapped.
 */
function createPathMappingPassFor(
  rootAbsPaths: readonly string[],
  repositoryRoot: string | undefined,
  snapshot: CompilerInputSnapshot | undefined,
  options: TypeScriptExtractionOptions,
  workspaceLinks: WorkspaceLinkResolver = createWorkspaceLinkResolver(),
): PathMappingPass | undefined {
  if (options.tsconfigPathMapping !== true || snapshot !== undefined || repositoryRoot === undefined
    || rootAbsPaths.some(path => /\.(mjs|cjs|js|jsx)$/.test(path))) return undefined;
  const pass: PathMappingPass = {
    repositoryRoot,
    roots: new Set(rootAbsPaths.map(canonicalTypeScriptFileKey)),
    workspaceLinks,
    // The same confined, link-aware reads the configured resolution uses, so a tsconfig outside
    // the analyzed root or behind an escaping link is never consumed.
    configurationSystem: workspaceLinkedSystem(ts.sys, repositoryRoot, workspaceLinks),
    byDirectory: new Map(),
    byConfiguration: new Map(),
    selected: new Map(),
    governsAnyRoot: () => rootAbsPaths.some(path => governingPathMapping(pass, dirname(path)) !== null),
  };
  return pass;
}

/**
 * The configuration files an extraction of these roots reads to map their imports, with the content
 * read (`undefined` for a refused or unreadable input), or an empty map when no mapping applies:
 * no selected root is governed by `paths` or `baseUrl`, a root is JavaScript, or nothing can be
 * confined. It is the freshness input of a caller whose analysis identity does not otherwise bind
 * live configuration; the extraction reads exactly these files through the same pass.
 */
export function pathMappingInputs(
  rootAbsPaths: readonly string[],
  repositoryRoot: string,
): ReadonlyMap<string, string | undefined> {
  const workspaceLinks = createWorkspaceLinkResolver();
  const pass = createPathMappingPassFor([...rootAbsPaths], repositoryRoot, undefined, { tsconfigPathMapping: true }, workspaceLinks);
  return pass !== undefined && pass.governsAnyRoot() ? workspaceLinks.inputs : new Map();
}

function governingPathMapping(pass: PathMappingPass, directory: string): PathMapping | null {
  const known = pass.byDirectory.get(directory);
  if (known !== undefined) return known;
  const configPath = ts.findConfigFile(directory, path => pass.configurationSystem.fileExists(path));
  let mapping: PathMapping | null = null;
  if (configPath !== undefined) {
    const cached = pass.byConfiguration.get(configPath);
    if (cached !== undefined) mapping = cached;
    else {
      const options = configurationOptions(configPath, pass.configurationSystem);
      mapping = options === undefined ? null : pathMappingOf(options, pass.repositoryRoot);
      pass.byConfiguration.set(configPath, mapping);
    }
  }
  pass.byDirectory.set(directory, mapping);
  return mapping;
}

function pathMappingOf(options: ts.CompilerOptions, repositoryRoot: string): PathMapping | null {
  const { paths, baseUrl } = options;
  if (paths === undefined && baseUrl === undefined) return null;
  const pathsBasePath = (options as { pathsBasePath?: string }).pathsBasePath;
  const mapped = {
    ...(paths === undefined ? {} : { paths }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    // Internal to TypeScript: the directory `paths` entries are relative to when no baseUrl is set,
    // which an inherited mapping keeps as the directory of the configuration that declared it.
    ...(pathsBasePath === undefined ? {} : { pathsBasePath }),
  } as ts.CompilerOptions;
  return {
    options: mapped,
    patterns: Object.keys(paths ?? {}).filter(pattern => pattern.split("*").length <= 2),
    cache: ts.createModuleResolutionCache(repositoryRoot, foldFileName, { ...COMPILER_OPTIONS, ...mapped }),
    addsNothing: new Set(),
  };
}

const foldFileName = (name: string): string => ts.sys.useCaseSensitiveFileNames ? name : name.toLowerCase();

/**
 * Whether `baseUrl` can contribute a candidate for a specifier no `paths` key matches. Every
 * candidate TypeScript tries lies below the entry named by the specifier's first segment, with or
 * without a source extension, so a first segment that no entry starts with cannot resolve there
 * and the historical resolution, with its caches, applies unchanged.
 */
function baseUrlMayResolve(mapping: PathMapping, specifier: string, repositoryRoot: string): boolean {
  const baseUrl = mapping.options.baseUrl;
  if (baseUrl === undefined) return false;
  if (mapping.baseUrlEntries === undefined) {
    try {
      // A directory outside the root is never listed: resolution through it is refused and recorded.
      mapping.baseUrlEntries = isContainedTypeScriptPath(resolve(repositoryRoot), resolve(baseUrl))
        && isContainedTypeScriptPath(canonicalFilesystemPath(repositoryRoot), canonicalFilesystemPath(baseUrl))
        ? readdirSync(baseUrl).map(foldFileName) : null;
    } catch {
      mapping.baseUrlEntries = null;
    }
  }
  if (mapping.baseUrlEntries === null) return true;
  const first = foldFileName(specifier.split(/[\\/]/, 1)[0]!.replace(/\.(?:[cm]?[jt]sx?|json)$/i, ""));
  return mapping.baseUrlEntries.some(entry => entry.startsWith(first));
}

function matchesPathPattern(pattern: string, specifier: string): boolean {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === specifier;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return specifier.length >= prefix.length + suffix.length && specifier.startsWith(prefix) && specifier.endsWith(suffix);
}

/**
 * Resolve a non-relative specifier written in a selected root through the nearest tsconfig's
 * `paths` or `baseUrl`, over the historical Bundler options, with the confinement of configured
 * resolution. The mapping only ever adds a repository module: `undefined` means it does not, and the
 * historical resolution applies unchanged with its own caches. That covers a specifier no mapping
 * governs, one the mapping cannot reach, and one that resolves to an installed package or, under
 * confinement, to nothing: a `node_modules` hoisted above the root stays the compiler's to resolve.
 */
function resolvePathMappedModule(
  pass: PathMappingPass,
  specifier: string,
  containingFile: string,
  resolutionMode: ts.ResolutionMode | undefined,
): ts.ResolvedModuleWithFailedLookupLocations | undefined {
  if (ts.isExternalModuleNameRelative(specifier)) return undefined;
  let selected = pass.selected.get(containingFile);
  if (selected === undefined) {
    selected = pass.roots.has(canonicalTypeScriptFileKey(containingFile));
    pass.selected.set(containingFile, selected);
  }
  if (!selected) return undefined;
  const mapping = governingPathMapping(pass, dirname(containingFile));
  if (mapping === null) return undefined;
  if (!mapping.patterns.some(pattern => matchesPathPattern(pattern, specifier))
    && !baseUrlMayResolve(mapping, specifier, pass.repositoryRoot)) return undefined;
  const key = `${resolutionMode ?? ""}\0${extname(containingFile).toLowerCase()}\0${specifier}`;
  if (mapping.addsNothing.has(key)) return undefined;
  const result = resolveWithOptions(
    specifier,
    containingFile,
    resolutionMode,
    { ...COMPILER_OPTIONS, ...mapping.options },
    ts.sys,
    pass.configurationSystem,
    pass.workspaceLinks,
    pass.repositoryRoot,
    mapping.cache,
  );
  const resolved = result.resolvedModule;
  if (resolved !== undefined && resolved.isExternalLibraryImport !== true) return result;
  mapping.addsNothing.add(key);
  return undefined;
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
 * A repository file a tsconfig mapping reaches from a root is repository-authored traversal as well:
 * its own relative imports and references are held to the same confinement as the relative import
 * that would reach it, so an alias never lets the Program read what a relative path may not.
 */
function assertConfinedTypeScriptSources(
  rootAbsPaths: readonly string[],
  repoRoot: string,
  snapshot?: CompilerInputSnapshot,
  mapping?: PathMappingPass,
): void {
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
    if (mapping !== undefined && mapping.roots.has(key)) {
      // Match the Program's usage mode without loading dependencies before confinement succeeds.
      // Following both conditional branches can reject an escaping import the Program never uses.
      const parsed = ts.createSourceFile(path, source, {
        languageVersion: COMPILER_OPTIONS.target!,
        impliedNodeFormat: ts.getImpliedNodeFormatForFile(path, undefined, ts.sys, COMPILER_OPTIONS),
      }, true);
      for (const usage of literalModuleSpecifiers(parsed)) {
        const mode = usage.resolutionMode ?? ts.getModeForUsageLocation(parsed, usage.literal, COMPILER_OPTIONS);
        const target = resolvePathMappedModule(mapping, usage.literal.text, path, mode)?.resolvedModule?.resolvedFileName;
        if (target !== undefined) pending.push(target);
      }
    }
    for (const imported of preprocessed.importedFiles) {
      // The Program applies `paths`/`baseUrl` to exactly the names TypeScript does not call relative;
      // this walk must classify with the same predicate, or a dot-named alias escapes the confinement.
      if (!ts.isExternalModuleNameRelative(imported.fileName)) {
        continue;
      }
      const lexical = resolve(dirname(path), imported.fileName);
      if (!isContainedTypeScriptPath(canonicalRoot, canonicalFilesystemPath(lexical))) {
        throw new Error(`IMPORT_OUTSIDE_REPOSITORY: ${imported.fileName}`);
      }
      const resolved = resolveTypeScriptModule(imported.fileName, path, undefined, snapshot !== undefined || /\.(mjs|cjs|js|jsx)$/.test(path), snapshot, undefined, repoRoot);
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
export function extractTypeScript(
  rootAbsPaths: string[],
  repoRoot: string,
  suppliedSnapshot?: CompilerInputSnapshot,
  options: TypeScriptExtractionOptions = {},
): TsExtraction {
  const snapshot = suppliedSnapshot === undefined ? undefined : new Map(suppliedSnapshot);
  const pathMapping = createPathMappingPassFor(rootAbsPaths, repoRoot, snapshot, options);
  assertConfinedTypeScriptSources(rootAbsPaths, repoRoot, snapshot, pathMapping);
  // The confinement walk, the Program and the extractor share one mapping pass, and so its caches.
  const program = extractionContext.createProgram(rootAbsPaths, snapshot, repoRoot, options, pathMapping);
  // One analysis pass shares the derived workspace links of its configured resolutions.
  const workspaceLinks = createWorkspaceLinkResolver();
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
    const namespaceReferences = staticModuleLinksEnabled ? namespaceMemberReferences(sf, checker, snapshot !== undefined) : undefined;
    const runtimeReferences = snapshot === undefined ? undefined : runtimeReferenceSymbols(sf, checker);
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
        const resolvedAbs = resolveTypeScriptModule(specifier, sf.fileName, undefined, javascriptEnabled || snapshot !== undefined, snapshot, workspaceLinks, repoRoot, pathMapping);
        const names = importedNames(node, staticModuleLinksEnabled);
        const namespace = node.importClause?.namedBindings;
        const namespaceSymbol = node.importClause?.isTypeOnly !== true && namespace !== undefined && ts.isNamespaceImport(namespace)
          ? checker.getSymbolAtLocation(namespace.name) : undefined;
        const references: { expression: ts.Expression; targetSymbol?: ts.Symbol }[] = [...valueImportBindings(node).map(expression => ({ expression })), ...(namespaceSymbol === undefined ? [] : namespaceReferences?.get(namespaceSymbol) ?? [])];
        const bindingTargets = staticModuleLinksEnabled ? references.flatMap(binding => {
          const target = resolveCallTarget(checker, binding.expression, relOf, javascriptEnabled, snapshot, binding.targetSymbol);
          return target?.relPath !== undefined && target.symbolPath !== undefined ? [{ relPath: target.relPath, symbolPath: target.symbolPath,
            ...(runtimeReferences !== undefined && ts.isIdentifier(binding.expression) && binding.targetSymbol === undefined
              && !runtimeReferences.has(checker.getSymbolAtLocation(binding.expression)!) ? { runtimeUsed: false } : {}),
            ...(target.unmodeledReason === undefined ? {} : { unmodeledReason: target.unmodeledReason }),
          }] : [];
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
        const resolvedAbs = resolveTypeScriptModule(specifier, sf.fileName, undefined, javascriptEnabled || snapshot !== undefined, snapshot, workspaceLinks, repoRoot, pathMapping);
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
          const resolvedAbs = resolveTypeScriptModule(specifier, sf.fileName, ts.ModuleKind.ESNext, javascriptEnabled || snapshot !== undefined, snapshot, workspaceLinks, repoRoot, pathMapping);
          imports.push({ fromRelPath: relPath, moduleSpecifier: specifier,
            ...(resolvedAbs !== undefined ? { resolvedRelPath: relOf(resolvedAbs) } : {}),
            names: [], line: lineOf(sf, node.getStart()) });
        }
        const callee = staticModuleLinksEnabled ? unwrapStaticExpression(node.expression) : node.expression;
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
  options: TypeScriptExtractionOptions = {},
): Promise<ParallelTsExtraction> {
  if (snapshot !== undefined) {
    return { extraction: extractTypeScript(rootAbsPaths, repoRoot, snapshot), parallelism: { requested, used: 1, mode: "preflight-fallback", reason: "retained compiler input snapshot requires one semantic Program" } };
  }
  const pathMapping = createPathMappingPassFor(rootAbsPaths, repoRoot, undefined, options);
  assertConfinedTypeScriptSources(rootAbsPaths, repoRoot, undefined, pathMapping);
  // Every fallback is the same single Program, so it carries the same extraction options.
  const serial = (): TsExtraction => extractTypeScript(rootAbsPaths, repoRoot, undefined, options);
  const workerLimit = resolveWorkerCount(requested, rootAbsPaths.length);
  if (workerLimit > 1 && rootAbsPaths.some(path => /\.(mjs|cjs|js|jsx)$/.test(path))) {
    return {
      extraction: serial(),
      parallelism: { requested, used: 1, mode: "preflight-fallback", reason: "mixed JavaScript/TypeScript extraction requires one semantic Program" },
    };
  }
  if (workerLimit <= 1 || rootAbsPaths.length <= 1) {
    return {
      extraction: serial(),
      parallelism: { requested, used: 1, mode: "single" },
    };
  }

  const preflight = preflightParallelSafety(rootAbsPaths, repoRoot, pathMapping);
  if (!preflight.safe) {
    return {
      extraction: serial(),
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
      extraction: serial(),
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
        ...(options.tsconfigPathMapping === true ? { tsconfigPathMapping: true } : {}),
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
        extraction: serial(),
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

function preflightParallelSafety(rootAbsPaths: readonly string[], repoRoot: string, pathMapping?: PathMappingPass):
  | { safe: true; emitAbsOrder: string[]; components: string[][] }
  | { safe: false; reason: string } {
  // Safety inspection needs source ordering and syntax only. Avoid loading the standard library
  // and type packages here: each Worker builds the real semantic Program for its own chunk.
  const preflightOptions: ts.CompilerOptions = { ...COMPILER_OPTIONS, noLib: true, types: [] };
  // Source order is part of the extraction's identity: resolve aliases here as the extraction will.
  const preflightHost = pathMapping === undefined ? undefined : ts.createCompilerHost(preflightOptions);
  if (preflightHost !== undefined && pathMapping !== undefined) installPathMappedResolution(preflightHost, pathMapping, preflightOptions);
  const program = ts.createProgram([...rootAbsPaths], preflightOptions, preflightHost);
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
    components: rootModuleComponents(program, roots, repositoryKey, pathMapping),
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
  pathMapping?: PathMappingPass,
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

  // Files joined only by a path alias belong to one component, as the extraction will see them.
  for (const source of loadedSources.values()) {
    const from = canonicalTypeScriptFileKey(source.fileName);
    for (const usage of literalModuleSpecifiers(source)) {
      const resolutionMode = usage.resolutionMode
        ?? program.getModeForUsageLocation(source, usage.literal);
      const resolved = resolveTypeScriptModule(
        usage.literal.text, source.fileName, resolutionMode, undefined, undefined, undefined, repositoryKey, pathMapping);
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
  options: TypeScriptExtractionOptions = {},
): string[][] {
  const preflight = preflightParallelSafety(rootAbsPaths, repoRoot,
    createPathMappingPassFor(rootAbsPaths, repoRoot, undefined, options));
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
          && typeof target["symbolPath"] === "string"
          && (target["runtimeUsed"] === undefined || typeof target["runtimeUsed"] === "boolean")
          && optionalString(target["unmodeledReason"]))))
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

/** Runtime lexical uses; declaration/type/shadow occurrences never prove a value read. */
function runtimeReferenceSymbols(source: ts.SourceFile, checker: ts.TypeChecker): Set<ts.Symbol> {
  const symbols = new Set<ts.Symbol>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
      || (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword))) return;
    if (ts.isTypeNode(node)) {
      if (ts.isExpressionWithTypeArguments(node) && ts.isHeritageClause(node.parent) && node.parent.token === ts.SyntaxKind.ExtendsKeyword
        && (ts.isClassDeclaration(node.parent.parent) || ts.isClassExpression(node.parent.parent))) visit(node.expression);
      return;
    }
    if (ts.isExportDeclaration(node) && node.isTypeOnly || ts.isExportSpecifier(node) && node.isTypeOnly) return;
    if (ts.isIdentifier(node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent) ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : ts.isExportSpecifier(node.parent) ? checker.getExportSpecifierLocalTargetSymbol(node.parent) : checker.getSymbolAtLocation(node);
      if (symbol !== undefined) symbols.add(symbol);
    }
    ts.forEachChild(node, visit);
  };
  visit(source); return symbols;
}

/** Static member references keyed by their actual lexical receiver binding, never its spelling. */
function namespaceMemberReferences(source: ts.SourceFile, checker: ts.TypeChecker, retainUnmodeled = false): Map<ts.Symbol, { expression: ts.Expression; targetSymbol?: ts.Symbol }[]> {
  const references = new Map<ts.Symbol, { expression: ts.Expression; targetSymbol?: ts.Symbol }[]>();
  const unwrap = unwrapStaticExpression;
  const add = (binding: ts.Symbol | undefined, expression: ts.Expression, target: ts.Symbol | undefined): void => {
    if (target !== undefined && (target.flags & ts.SymbolFlags.Alias) !== 0) target = checker.getAliasedSymbol(target);
    const declaration = target?.getDeclarations()?.[0];
    const modeled = declaration !== undefined && (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)
      || (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined && isFunctionLike(declaration.initializer)));
    const unmodeledValue = retainUnmodeled && declaration !== undefined
      && (ts.isVariableDeclaration(declaration) || ts.isEnumDeclaration(declaration) || ts.isEnumMember(declaration));
    if (binding === undefined || (!modeled && !unmodeledValue)) return;
    const targets = references.get(binding) ?? [];
    targets.push({ expression, targetSymbol: target }); references.set(binding, targets);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return;
    if (ts.isPropertyAccessExpression(node) || (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))) {
      const member = node;
      let receiver = unwrap(member.expression);
      while (ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver)) receiver = unwrap(receiver.expression);
      add(checker.getSymbolAtLocation(receiver), member, checker.getSymbolAtLocation(member));
    } else if (ts.isBindingElement(node) && node.dotDotDotToken === undefined && ts.isIdentifier(node.name)
      && ts.isObjectBindingPattern(node.parent) && ts.isVariableDeclaration(node.parent.parent) && node.parent.parent.initializer !== undefined) {
      const receiver = unwrap(node.parent.parent.initializer);
      const binding = checker.getSymbolAtLocation(receiver);
      if (binding?.getDeclarations()?.some(declaration => ts.isNamespaceImport(declaration))) {
        const property = node.propertyName ?? node.name;
        if (ts.isIdentifier(property) || ts.isStringLiteralLike(property)) add(binding, node.name, checker.getPropertyOfType(checker.getTypeAtLocation(receiver), property.text));
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

/** Private proof coordinate: the same declaration domain and scope used by extraction. */
export function retainedFunctionOwnerCoordinate(declaration: ts.FunctionDeclaration, root: string): { relPath: string; symbolPath: string } | undefined {
  const name = scopeNameOf(declaration);
  if (declaration.body === undefined || name === undefined) return undefined;
  return { relPath: relative(root, declaration.getSourceFile().fileName).replaceAll("\\", "/"),
    symbolPath: symbolScopePath(enclosingScopeOf(declaration, true), name) };
}

function resolveCallTarget(
  checker: ts.TypeChecker,
  expr: ts.Expression,
  relOf: (abs: string) => string,
  javascriptEnabled = false,
  snapshot?: CompilerInputSnapshot,
  targetSymbol?: ts.Symbol,
): { relPath?: string; symbolPath?: string; unmodeledReason?: string } | undefined {
  let symbol = targetSymbol ?? checker.getSymbolAtLocation(expr);
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
    ...(snapshot !== undefined && ts.isObjectLiteralExpression(decl.parent) ? { unmodeledReason: "OBJECT_LITERAL_MEMBER" }
      : snapshot !== undefined && (ts.isEnumDeclaration(decl) || ts.isEnumMember(decl)) ? { unmodeledReason: "ENUM_VALUE" }
      : snapshot !== undefined && ts.isVariableDeclaration(decl) && (decl.initializer === undefined || !isFunctionLike(decl.initializer)) ? { unmodeledReason: "VALUE_DECLARATION" } : {}),
  };
}

/** Private semantic-policy seam: reuse the extractor's canonical declaration coordinate. */
export function retainedCallableCoordinate(checker: ts.TypeChecker, expression: ts.Expression, root: string, snapshot: CompilerInputSnapshot): ReturnType<typeof resolveCallTarget> {
  let receiver = unwrapStaticExpression(expression);
  while (ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver)) receiver = unwrapStaticExpression(receiver.expression);
  if (checker.getSymbolAtLocation(receiver)?.getDeclarations()?.some(origin => (ts.isImportSpecifier(origin) && origin.isTypeOnly)
    || (ts.isImportClause(origin) && origin.isTypeOnly) || (ts.isNamespaceImport(origin) && origin.parent.isTypeOnly))) return undefined;
  let symbol = checker.getSymbolAtLocation(expression);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  if (!symbol?.getDeclarations()?.some(declaration => (ts.isFunctionDeclaration(declaration) && declaration.body !== undefined)
    || ts.isClassDeclaration(declaration) || (ts.isMethodDeclaration(declaration) && ts.isClassLike(declaration.parent))
    || (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name) && declaration.initializer !== undefined
      && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))))) return undefined;
  return resolveCallTarget(checker, expression, abs => normalizePath(relative(root, abs)), true, snapshot);
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
