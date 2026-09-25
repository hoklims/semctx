import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, posix, relative, resolve } from "node:path";
import {
  CHANGE_IMPACT_SCHEMA_VERSION,
  SemctxError,
  SurfaceMapSchema,
  compareIds,
  type ChangeImpactAnalysis,
  type ChangeImpactReport,
  type ExposedClaim,
  type ImpactTier,
  type RepositoryGraph,
  type SurfaceImpact,
  type SurfaceMap,
  type UnresolvedImpact,
} from "@semantic-context/core";
import { digestCanonical } from "@semantic-context/plane-a-internal";
import { loadConfig } from "@semantic-context/repository-store";
import { isPathSelected, outlineModuleLinks, outlineTopLevel, sourceLanguage } from "@semantic-context/ts-analyzer";
import {
  DEFAULT_CHANGE_IMPACT_BOUNDS,
  GraphIndex,
  changedFilesFromDiff,
  computeChangeImpact,
  parseUnifiedDiffChanges,
  sortUnresolved,
  type ChangeImpactBounds,
  type ChangeImpactCore,
  type ImpactFileOutline,
  type ImpactPackage,
  type ParsedDiffChanges,
  type UnindexedModuleLink,
  type WholeModuleRead,
} from "@semantic-context/context-engine";
import { loadSemanticModel, semanticExposure } from "@semantic-context/semantic-engine";
import { CLEAN_CONTROL_WORKING_DIFF_HASH } from "@semantic-context/control-model";
import { openReadyRepository } from "./readiness";
import {
  CONTROL_INDEX_SNAPSHOT_META_KEY,
  PLANE_A_INDEX_SNAPSHOT_META_KEY,
  captureGitStateEntries,
  fingerprintRepositoryFacts,
  fingerprintSemanticModel,
  hashGitStateEntries,
  isSemctxRuntimeArtifact,
  parseIndexedControlSnapshot,
  type GitStateEntry,
} from "./freshness";
import { parsePlaneAIndexSnapshot } from "./index-health";
import { observeIndexBinding, resolveSource } from "./verify";

/**
 * The Git-backed sources only: semctx computes the diff itself, so the analysed hunks are proven to
 * belong to the resolved commits. A caller-supplied diff could not be bound to any index and would
 * only ever yield a report with every index-derived set null.
 */
export type ChangeImpactRequest =
  | { kind: "working-tree"; head?: string }
  | { kind: "staged"; head?: string }
  | { kind: "range"; base: string; head?: string };

export interface ChangeImpactOptions {
  /** Explicit surface map (JSON). Surfaces are never inferred; without one, `surfaces` is null. */
  surfacesPath?: string;
  bounds?: ChangeImpactBounds;
}

/** Static limits of the analysis, true of every run. Stable codes; consumers may rely on them. */
const ANALYSIS_LIMITS: ChangeImpactAnalysis["limits"] = [
  {
    code: "NO_NEGATIVE_EVIDENCE",
    detail: "No producer is negative-evidence eligible (ADR 0010): a node absent from every tier is not shown to be unaffected.",
  },
  {
    code: "STATIC_REACH_ONLY",
    detail: "Reach follows statically resolved calls, same-file references, test imports and file imports; dynamic dispatch, reflection, configuration, data and runtime state are not modeled.",
  },
  {
    code: "CALLS_UNIQUELY_RESOLVED_ONLY",
    detail: "A `calls` edge exists only where the call site resolved to exactly one declaration; an ambiguous call is absent, not disproven.",
  },
  {
    code: "FUNCTION_VALUES_NOT_FOLLOWED",
    detail: "A function used as a value (callback, stored reference) forms no `calls` edge: such uses are covered only as importers of the changed declarations' own files (possible tier), not for functions further along the reach.",
  },
  {
    code: "TEST_LINK_IS_IMPORT_BY_NAME",
    detail: "A test is linked when it imports a symbol by name: it names the symbol, it is not shown to exercise the changed behaviour.",
  },
  {
    code: "CROSS_FILE_READS_ARE_FILE_LEVEL",
    detail: "Reads of exported constants, types and values across files are only visible as file imports, reported in the possible tier.",
  },
  {
    code: "MODULE_LINKS_BY_LITERAL_PATH",
    detail: "Re-exports, namespace imports, import() and require() are followed when their specifier is a relative path to an indexed file or a workspace package name; through path aliases and external packages only the imports the indexer resolved are followed, and a namespace import is not seen to read its module whole.",
  },
];

const TIER_RANK: Record<ImpactTier, number> = { changed: 0, direct: 1, transitive: 2, possible: 3 };

function git(root: string, args: string[]): { code: number; out: Uint8Array; err: string } {
  const proc = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode ?? 1, out: proc.stdout, err: new TextDecoder().decode(proc.stderr) };
}

function sha256(bytes: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function readSurfaceMap(root: string, path: string): { map: SurfaceMap; ref: { path: string; digest: string } } {
  const absolute = resolve(path);
  let bytes: Buffer;
  try {
    bytes = readFileSync(absolute);
  } catch (error) {
    throw new SemctxError("CONFIG_INVALID", `cannot read surface map "${path}"`, { cause: String(error) });
  }
  let parsed: SurfaceMap;
  try {
    parsed = SurfaceMapSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    throw new SemctxError("CONFIG_INVALID", `invalid surface map "${path}"`, { cause: String(error) });
  }
  const inside = relative(resolve(root), absolute);
  const label = inside.length > 0 && !inside.startsWith("..") && !isAbsolute(inside) ? inside.replace(/\\/g, "/") : absolute;
  return { map: parsed, ref: { path: label, digest: sha256(bytes) } };
}

/**
 * Where the post- and pre-image of each diff side are read from. `null` names the working tree on
 * disk and `""` the Git index (stage 0); anything else is a resolved commit object id.
 */
interface SideRevisions {
  old: string;
  new: string | null;
}

function readSide(root: string, revision: string | null, path: string): string | undefined {
  if (revision === null) {
    const absolute = resolve(root, path);
    return existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
  }
  const blob = git(root, ["cat-file", "blob", `${revision}:./${path}`]);
  return blob.code === 0 ? new TextDecoder().decode(blob.out) : undefined;
}

function outlinesFor(
  root: string,
  diff: ParsedDiffChanges,
  sideOf: (path: string) => "old" | "new",
  revisions: SideRevisions,
): { bound: Map<string, ImpactFileOutline>; other: Map<string, ImpactFileOutline> } {
  const bound = new Map<string, ImpactFileOutline>();
  const other = new Map<string, ImpactFileOutline>();
  for (const file of diff.files) {
    const rangeSide = sideOf(file.filePath);
    const oldPath = file.oldPath ?? file.filePath;
    const sides = [
      { side: "old" as const, path: oldPath, revision: revisions.old },
      { side: "new" as const, path: file.filePath, revision: revisions.new },
    ];
    for (const { side, path, revision } of sides) {
      if (sourceLanguage(path) !== "typescript") continue;
      const text = readSide(root, revision, path);
      if (text === undefined) continue;
      (side === rangeSide ? bound : other).set(path, outlineTopLevel(text, path));
    }
  }
  return { bound, other };
}

function untrackedPaths(root: string): string[] {
  const listed = git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."]);
  if (listed.code !== 0) {
    throw new SemctxError("GIT_ERROR", "cannot list untracked files", { stderr: listed.err.trim() });
  }
  return new TextDecoder()
    .decode(listed.out)
    .split("\0")
    .filter((path) => path.length > 0 && !isSemctxRuntimeArtifact(path))
    .sort(compareIds);
}

const TS_PATHSPECS = ["*.ts", "*.tsx", "*.mts", "*.cts"];
const RESOLUTION_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".cts", ".d.ts", "/index.ts", "/index.tsx"];

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Resolve a relative specifier the way a bundler would, against the files the index holds. */
function resolveRelativeSpecifier(from: string, specifier: string, indexed: ReadonlySet<string>): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const stems = [base];
  const js = /\.(m|c)?jsx?$/.exec(base);
  if (js !== null) stems.push(base.slice(0, -js[0].length));
  for (const stem of stems) {
    for (const suffix of RESOLUTION_SUFFIXES) {
      if (indexed.has(`${stem}${suffix}`)) return `${stem}${suffix}`;
    }
  }
  return undefined;
}

/**
 * Read, on the bound side of the diff, every module link the index holds no `imports` edge for,
 * and every module read whole by another. One `git grep` narrows the candidates and one
 * `git cat-file --batch` reads them, so the cost is two processes however large the repository
 * is. Returns undefined when Git cannot be read: the engine then reports the reach through such
 * links as unknown instead of treating it as empty.
 */
function scanModuleLinks(
  root: string,
  revision: string | null,
  graph: RepositoryGraph,
  packages: readonly ImpactPackage[],
): { links: UnindexedModuleLink[]; unread: string[]; whole: WholeModuleRead[] } | undefined {
  const indexed = new Set(
    graph.nodes
      .filter((node) => (node.kind === "module" || node.kind === "test") && node.filePath !== undefined)
      .map((node) => node.filePath!),
  );
  const patterns = [
    "export[[:space:]]*(type[[:space:]]*)?(\\*|\\{)",
    "import[[:space:]]*\\(",
    "\\*[[:space:]]*as[[:space:]]",
    "require[[:space:]]*\\(",
    ...packages.map((pkg) => `['"]${escapeRegex(pkg.identity)}(/[^'"]*)?['"]`),
  ];
  const grep = git(root, [
    "grep", "--no-full-name", "-l", "-z", "-I", "-E",
    ...patterns.flatMap((pattern) => ["-e", pattern]),
    ...(revision === null ? [] : [revision]),
    "--", ...TS_PATHSPECS,
  ]);
  if (grep.code !== 0 && grep.code !== 1) return undefined;
  const prefix = revision === null ? "" : `${revision}:`;
  const candidates = new TextDecoder()
    .decode(grep.out)
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith(prefix) ? entry.slice(prefix.length) : entry))
    .filter((path) => indexed.has(path))
    .sort(compareIds);
  const texts = readTexts(root, revision, candidates);
  if (texts === undefined) return undefined;

  // Indexed files Git does not hold at this revision (untracked or ignored): discovery read them
  // from disk, so their links are read from disk too, and a file that is gone is reported unread.
  const listed = revision === null
    ? git(root, ["ls-files", "-z", "--", ...TS_PATHSPECS])
    : git(root, ["ls-tree", "-r", "-z", "--name-only", revision]);
  if (listed.code !== 0) return undefined;
  const universe = new Set(new TextDecoder().decode(listed.out).split("\0").filter((path) => path.length > 0));
  const unread: string[] = [];
  const gitBlind: string[] = [];
  for (const path of [...indexed].sort(compareIds)) {
    if (universe.has(path) || sourceLanguage(path) !== "typescript") continue;
    const text = readSide(root, null, path);
    if (text === undefined) unread.push(path);
    else {
      texts.set(path, text);
      gitBlind.push(path);
    }
  }

  const identities = new Set(packages.map((pkg) => pkg.identity));
  const packageOf = (specifier: string): string | undefined => {
    for (const identity of identities) {
      if (specifier === identity || specifier.startsWith(`${identity}/`)) return identity;
    }
    return undefined;
  };
  const links: UnindexedModuleLink[] = [];
  const whole: WholeModuleRead[] = [];
  for (const path of [...candidates, ...gitBlind]) {
    const text = texts.get(path);
    if (text === undefined) continue;
    for (const link of outlineModuleLinks(text, path)) {
      if (link.specifier === null) {
        if (link.kind !== "import") links.push({ from: path, kind: link.kind, line: link.line, target: { nonLiteral: true } });
        continue;
      }
      if (link.specifier.startsWith(".")) {
        const target = resolveRelativeSpecifier(path, link.specifier, indexed);
        if (target !== undefined && link.whole === true) whole.push({ from: path, kind: link.kind, line: link.line, target: { path: target } });
        // A relative import already has its edge; only the edgeless kinds are needed here.
        if (link.kind === "import") continue;
        if (target !== undefined) links.push({ from: path, kind: link.kind, line: link.line, target: { path: target } });
        continue;
      }
      const identity = packageOf(link.specifier);
      if (identity === undefined) continue;
      links.push({ from: path, kind: link.kind, line: link.line, target: { package: identity } });
      if (link.whole === true) whole.push({ from: path, kind: link.kind, line: link.line, target: { package: identity } });
    }
  }
  return { links, unread, whole };
}

function readTexts(root: string, revision: string | null, paths: readonly string[]): Map<string, string> | undefined {
  const texts = new Map<string, string>();
  if (paths.length === 0) return texts;
  if (revision === null) {
    for (const path of paths) {
      const text = readSide(root, null, path);
      if (text !== undefined) texts.set(path, text);
    }
    return texts;
  }
  const top = git(root, ["rev-parse", "--show-prefix"]);
  if (top.code !== 0) return undefined;
  const repoPrefix = new TextDecoder().decode(top.out).trim();
  const proc = Bun.spawnSync(["git", "cat-file", "--batch"], {
    cwd: root,
    stdin: new TextEncoder().encode(paths.map((path) => `${revision}:${repoPrefix}${path}\n`).join("")),
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((proc.exitCode ?? 1) !== 0) return undefined;
  const out = proc.stdout;
  const decoder = new TextDecoder();
  let offset = 0;
  for (const path of paths) {
    const newline = out.indexOf(10, offset);
    if (newline < 0) return undefined;
    const header = decoder.decode(out.subarray(offset, newline));
    offset = newline + 1;
    const match = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
    if (match === null) continue;
    const size = Number(match[2]);
    if (match[1] === "blob") texts.set(path, decoder.decode(out.subarray(offset, offset + size)));
    offset += size + 1;
  }
  return texts;
}

function workspacePackages(raw: string | undefined): ImpactPackage[] {
  const workspace = parsePlaneAIndexSnapshot(raw)?.workspace;
  if (workspace === undefined) return [];
  return workspace.nodes
    .filter((node) => node.kind === "package" && node.root !== "." && node.root !== "")
    .map((node) => ({ root: node.root, identity: node.identity }))
    .sort((a, b) => compareIds(a.root, b.root));
}

interface SemanticJoin {
  layer: ChangeImpactAnalysis["semanticLayer"];
  claims: ExposedClaim[];
  gaps: UnresolvedImpact[];
  modelHash: string | null;
}

function joinSemanticLayer(root: string, core: ChangeImpactCore, facts: Parameters<typeof semanticExposure>[0]["facts"]): SemanticJoin {
  let loaded: ReturnType<typeof loadSemanticModel>;
  try {
    loaded = loadSemanticModel(root);
  } catch (error) {
    return {
      layer: "unavailable",
      claims: [],
      gaps: [{ code: "SEMANTIC_MODEL_UNAVAILABLE", scope: "run", detail: `the authored model could not be loaded: ${String(error)}`, affects: "claims" }],
      modelHash: null,
    };
  }
  if (loaded.model.nodes.length === 0 && loaded.diagnostics.length === 0 && loaded.duplicateIds.length === 0) {
    return { layer: "absent", claims: [], gaps: [], modelHash: null };
  }
  const errors = loaded.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0 || loaded.duplicateIds.length > 0) {
    const detail = errors.length > 0
      ? `${errors.length} parse error(s) in the authored model; run \`semctx semantic check\``
      : `duplicate authored ids: ${loaded.duplicateIds.join(", ")}`;
    return { layer: "unavailable", claims: [], gaps: [{ code: "SEMANTIC_MODEL_UNAVAILABLE", scope: "run", detail, affects: "claims" }], modelHash: null };
  }
  const joined = semanticExposure({ model: loaded.model, facts, exposure: core.exposure });
  const modelHash = fingerprintSemanticModel(loaded.model);
  let reread: string | null;
  try {
    reread = fingerprintSemanticModel(loadSemanticModel(root).model);
  } catch {
    reread = null;
  }
  if (reread !== modelHash) {
    return {
      layer: "unavailable",
      claims: [],
      gaps: [{ code: "SEMANTIC_MODEL_UNAVAILABLE", scope: "run", detail: "the authored model changed while it was being joined; re-run to join a stable model", affects: "claims" }],
      modelHash: null,
    };
  }
  const gaps: UnresolvedImpact[] = [
    ...joined.unresolvedLinks.map((link): UnresolvedImpact => ({
      code: "SEMANTIC_LINK_UNRESOLVED",
      scope: "node",
      nodeId: link.ownerId,
      detail: `${link.kind}:${link.ref} does not resolve against the index (${link.reasonCode}); its exposure is unknown`,
      affects: "claims",
    })),
    ...joined.unjoinableLinks.map((link): UnresolvedImpact => ({
      code: "SEMANTIC_LINK_NOT_POSITIONAL",
      scope: "node",
      nodeId: link.ownerId,
      detail: `${link.kind}:${link.ref} names a claim or evidence record, which has no code position to expose`,
      affects: "claims",
    })),
    ...joined.unanchoredInvariants.map((id): UnresolvedImpact => ({
      code: "SEMANTIC_INVARIANT_UNANCHORED",
      scope: "node",
      nodeId: id,
      detail: "the invariant has no repository link; whether any change exposes it is unknown",
      affects: "claims",
    })),
  ];
  return { layer: "joined", claims: joined.claims, gaps, modelHash };
}

function unknownSurfaces(map: SurfaceMap | null): SurfaceImpact[] | null {
  if (map === null) return null;
  return map.surfaces.map((surface) => ({
    name: surface.name,
    ...(surface.description !== undefined ? { description: surface.description } : {}),
    exposure: "unknown" as const,
    counts: { changed: 0, direct: 0, transitive: 0, possible: 0 },
  }));
}

/**
 * The control snapshot as a fresh reader sees it now. The analysis store is an immutable SQLite
 * reader, which never observes a rebuild made after it opened; a store that cannot be reopened
 * (a writer holds it, or it is gone) is not proven unchanged.
 */
function currentIndexSnapshotHash(root: string): string | null {
  let reader: ReturnType<typeof openReadyRepository> | undefined;
  try {
    reader = openReadyRepository(root);
    return digestCanonical(reader.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY) ?? null);
  } catch {
    return null;
  } finally {
    reader?.close();
  }
}

function confidenceOf(broken: boolean, unresolved: readonly UnresolvedImpact[]): ChangeImpactAnalysis["confidence"] {
  if (broken) return { level: "none", reasons: ["INDEX_BINDING_BROKEN"] };
  const reachGaps = [...new Set(unresolved.filter((gap) => gap.affects === "reach").map((gap) => gap.code))].sort(compareIds);
  if (reachGaps.length > 0) return { level: "low", reasons: reachGaps };
  return { level: "moderate", reasons: ["STATIC_REACH_CEILING"] };
}

/** Beyond this many local changes the subset search below is not attempted. */
const MAX_DIRTY_ENTRIES_SEARCHED = 12;

/**
 * Which of today's local changes already existed, byte for byte, when a dirty tree was indexed.
 * The index keeps only a hash of that tree's local changes, so each hypothesis "these entries
 * existed then, the others are newer" is tested against it. A file changed since it was indexed
 * dirty matches no hypothesis: `undefined` then means no diff side carries its indexed coordinates.
 */
function indexedDirtyPaths(entries: readonly GitStateEntry[], indexedHash: string): Set<string> | "no_match" | "not_searched" {
  const pathsOf = (kept: readonly GitStateEntry[]): Set<string> => new Set(kept.flatMap((entry) => entry.paths));
  if (hashGitStateEntries(entries) === indexedHash) return pathsOf(entries);
  if (entries.length > MAX_DIRTY_ENTRIES_SEARCHED) return "not_searched";
  for (let dropped = 1; dropped < 2 ** entries.length; dropped += 1) {
    const kept = entries.filter((_, position) => (dropped & (2 ** position)) === 0);
    if (hashGitStateEntries(kept) === indexedHash) return pathsOf(kept);
  }
  return "no_match";
}

/**
 * Shared CLI/MCP change-impact use case (ADR 0030). It reports what a Git-computed change can
 * affect, through which link, and where the modeled reach stops. It never decides whether the
 * change is safe, which proof it needs, or whether it may proceed.
 *
 * The index is joined only on the diff side whose line coordinates it provably carries: the old
 * side for a working-tree or staged diff against the indexed clean commit, the new side for a range
 * ending at the indexed commit or for a working-tree diff whose dirty state is exactly the indexed
 * one. Any other combination — or any break the shared binding probe observes — nulls every
 * index-derived set rather than joining hunks with ranges from another source state.
 */
export function runChangeImpact(root: string, source: ChangeImpactRequest, options: ChangeImpactOptions = {}): ChangeImpactReport {
  const surfaceInput = options.surfacesPath === undefined ? null : readSurfaceMap(root, options.surfacesPath);
  const bounds = options.bounds ?? DEFAULT_CHANGE_IMPACT_BOUNDS;
  const store = openReadyRepository(root);
  try {
    const config = loadConfig(root);
    const rawControlSnapshot = store.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY);
    const indexSnapshotHash = digestCanonical(rawControlSnapshot ?? null);
    let indexedWorkingDiffHash: string | null = null;
    try {
      indexedWorkingDiffHash = parseIndexedControlSnapshot(rawControlSnapshot)?.workingDiffHash ?? null;
    } catch {
      indexedWorkingDiffHash = null;
    }
    // An index built on a dirty tree carries, for each file dirty at that moment, the coordinates of
    // that dirty content — the new side of a working-tree diff if the file has not changed since,
    // and no side of a staged or range diff. Every other file carries its committed coordinates.
    const indexedDirty = indexedWorkingDiffHash !== null && indexedWorkingDiffHash !== CLEAN_CONTROL_WORKING_DIFF_HASH;
    // Bracket every read of mutable local state (worktree and Git index): it must be the same
    // before and after the analysis. The status entries include the index blob ids.
    const bracketed = source.kind !== "range" || indexedDirty;
    const treeBefore = bracketed ? captureGitStateEntries(root).entries : null;

    const resolved = resolveSource(root, source, false);
    const diffText = resolved.diffText ?? "";
    if (resolved.identity.kind !== "commits") {
      throw new SemctxError("GIT_ERROR", "change impact requires a Git-computed diff");
    }
    const headOid = resolved.identity.commits[0]!;
    const revisions: SideRevisions = source.kind === "range"
      ? { old: resolved.git.mergeBase!, new: headOid }
      : { old: headOid, new: source.kind === "staged" ? "" : null };

    const graph = store.loadGraph();
    const claims = store.loadClaims();
    const evidence = store.loadEvidence();
    const facts = { graph, claims, evidence };
    const diff = parseUnifiedDiffChanges(diffText);

    const breaks: string[] = [];
    const committedSide: "old" | "new" = source.kind === "range" ? "new" : "old";
    let sideOf = (_path: string): "old" | "new" => committedSide;
    let unchangedSinceIndexing: ReadonlySet<string> | undefined;
    if (indexedDirty) {
      const dirtyAtIndexing = treeBefore === null ? "no_match" : indexedDirtyPaths(treeBefore, indexedWorkingDiffHash!);
      const indexedPaths = new Set(graph.nodes.flatMap((node) => (node.filePath === undefined ? [] : [node.filePath])));
      const committedRevision = committedSide === "old" ? revisions.old : revisions.new;
      if (dirtyAtIndexing === "not_searched") {
        breaks.push("DIRTY_INDEX_SEARCH_BOUND_EXCEEDED");
      } else if (dirtyAtIndexing === "no_match") {
        breaks.push("INDEX_COORDINATES_NOT_ON_DIFF_SIDE");
      } else if (source.kind === "working-tree") {
        sideOf = (path) => (dirtyAtIndexing.has(path) ? "new" : "old");
        unchangedSinceIndexing = dirtyAtIndexing;
      } else if ([...dirtyAtIndexing].some((path) =>
        indexedPaths.has(path)
        // A committed file absent from the worktree at indexing: the graph lacks it and its edges.
        || (sourceLanguage(path) !== "unknown" && isPathSelected(config, path) && readSide(root, committedRevision, path) !== undefined))) {
        // The graph was read from uncommitted content: it describes neither side of a staged or
        // range diff, whether or not the diff itself touches those files.
        breaks.push("INDEX_COORDINATES_NOT_ON_DIFF_SIDE");
      }
    }
    const unscopedPaths = diff.unscoped.flatMap((block) => (block.reason === "rename_only" && block.paths.length === 2 ? [block.paths[1]!] : block.paths));
    const fileSides = new Set([...diff.files.map((file) => file.filePath), ...unscopedPaths].map((path) => sideOf(path)));
    const rangeSide: "old" | "new" | "mixed" = fileSides.size > 1 ? "mixed" : ([...fileSides][0] ?? committedSide);

    const untracked = source.kind === "working-tree" ? untrackedPaths(root) : [];
    const packages = workspacePackages(store.getMeta(PLANE_A_INDEX_SNAPSHOT_META_KEY));
    // Unchanged files read the same on disk as at indexing (clean then, or dirty and untouched since).
    const scanRevision = indexedDirty && source.kind === "working-tree" ? null : committedSide === "old" ? revisions.old : revisions.new;
    const scan = breaks.length > 0 ? undefined : scanModuleLinks(root, scanRevision, graph, packages);
    const core = breaks.length > 0
      ? null
      : computeChangeImpact({
          index: new GraphIndex(graph),
          diff,
          rangeSide: sideOf,
          outlines: outlinesFor(root, diff, sideOf, revisions),
          untrackedPaths: untracked,
          packages,
          surfaces: surfaceInput?.map ?? null,
          isPathSelected: (path) => isPathSelected(config, path),
          hasCallEdges: (path) => sourceLanguage(path) === "typescript",
          ...(scan !== undefined ? { moduleLinks: scan.links, moduleLinksUnread: scan.unread, wholeModuleReads: scan.whole } : {}),
          ...(unchangedSinceIndexing !== undefined ? { unchangedSinceIndexing } : {}),
          bounds,
        });

    // Probed after the analysis, as `verify` does, so the binding describes the index just used.
    const semanticInputHashes: string[] = [];
    const observed = observeIndexBinding(root, store, resolved.identity, (hash) => semanticInputHashes.push(hash));
    breaks.push(...observed.breaks);
    if (bracketed) {
      const treeAfter = captureGitStateEntries(root).entries;
      if (treeBefore === null || treeAfter === null || hashGitStateEntries(treeBefore) !== hashGitStateEntries(treeAfter)) {
        breaks.push("WORKING_TREE_CHANGED_DURING_ANALYSIS");
      }
    }
    if (currentIndexSnapshotHash(root) !== indexSnapshotHash) {
      breaks.push("INDEX_CHANGED_DURING_ANALYSIS");
    }
    const uniqueBreaks = [...new Set(breaks)];
    const broken = core === null || uniqueBreaks.length > 0;

    const subject: ChangeImpactReport["subject"] = {
      source: source.kind,
      base: source.kind === "range" ? source.base : null,
      head: source.head ?? "HEAD",
      headOid,
      mergeBaseOid: source.kind === "range" ? resolved.git.mergeBase : null,
      diffDigest: sha256(diffText),
      inputs: {
        indexSnapshotHash,
        repositoryFactsHash: fingerprintRepositoryFacts(facts),
        configHash: digestCanonical(config),
        semanticInputHashes: [...new Set(semanticInputHashes)],
        semanticModelHash: null,
        surfaceMap: surfaceInput?.ref ?? null,
      },
    };
    const binding: ChangeImpactAnalysis["binding"] = {
      status: broken ? "broken" : "bound",
      rangeSide: broken ? null : rangeSide,
      breaks: uniqueBreaks,
      freshness: observed.freshness === null
        ? null
        : { verdict: observed.freshness.verdict, reasons: [...observed.freshness.reasons] },
    };

    if (broken || core === null) {
      // Re-indexing cannot bind a staged or range diff while the index reads uncommitted files.
      const remedy = source.kind !== "working-tree" && indexedDirty && uniqueBreaks.includes("INDEX_COORDINATES_NOT_ON_DIFF_SIDE")
        ? "Rebuild the index on a tree whose analysed files are all committed (commit or stash first), then retry."
        : "Re-run `semctx index`, then retry.";
      const unresolved: UnresolvedImpact[] = [{
        code: "INDEX_BINDING_BROKEN",
        scope: "run",
        detail: `the index is not bound to this diff (${uniqueBreaks.join(", ")}); no index-derived reach holds. ${remedy}`,
        affects: "reach",
      }];
      return {
        schemaVersion: CHANGE_IMPACT_SCHEMA_VERSION,
        kind: "change_impact",
        subject,
        analysis: {
          binding,
          confidence: confidenceOf(true, unresolved),
          bounds: { ...bounds },
          semanticLayer: "not_computed",
          limits: ANALYSIS_LIMITS.map((limit) => ({ ...limit })),
        },
        changes: { files: changedFilesFromDiff(diff, untracked), units: null },
        directlyAffected: null,
        transitivelyAffected: null,
        possiblyAffected: null,
        explicitlyUnaffected: [],
        exposedClaims: null,
        surfaces: unknownSurfaces(surfaceInput?.map ?? null),
        blastRadius: {
          scope: "unknown",
          complete: false,
          known: { files: [], packages: [], surfaces: [] },
          possible: { files: 0, packages: [], surfaces: [], omitted: 0 },
          rationale: ["INDEX_BINDING_BROKEN"],
        },
        unresolved,
      };
    }

    const semantic = joinSemanticLayer(root, core, facts);
    subject.inputs.semanticModelHash = semantic.modelHash;
    const unresolved = sortUnresolved([...core.unresolved, ...semantic.gaps]);
    const exposedClaims = [...core.markerClaims, ...semantic.claims]
      .sort((a, b) => TIER_RANK[a.exposure] - TIER_RANK[b.exposure] || compareIds(a.id, b.id));
    return {
      schemaVersion: CHANGE_IMPACT_SCHEMA_VERSION,
      kind: "change_impact",
      subject,
      analysis: {
        binding,
        confidence: confidenceOf(false, unresolved),
        bounds: { ...bounds },
        semanticLayer: semantic.layer,
        limits: ANALYSIS_LIMITS.map((limit) => ({ ...limit })),
      },
      changes: { files: core.files, units: core.units },
      directlyAffected: core.directlyAffected,
      transitivelyAffected: core.transitivelyAffected,
      possiblyAffected: core.possiblyAffected,
      explicitlyUnaffected: [],
      exposedClaims,
      surfaces: core.surfaces,
      blastRadius: core.blastRadius,
      unresolved,
    };
  } finally {
    store.close();
  }
}
