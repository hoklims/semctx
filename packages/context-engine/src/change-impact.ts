/**
 * Pure change-impact evaluation (ADR 0030). Joins a parsed diff with the indexed repository graph
 * and reports WHAT the change can affect, through WHICH link, and WHERE the analysis stops.
 *
 * It decides nothing about proof: no verdict, no test obligation, no proof level. Tiers are
 * defined by the kind of link that justifies them, never by a score:
 * - direct / transitive: behavioural links the graph resolves (a caller executes the changed code,
 *   a test imports it by name, a same-file statement references it);
 * - possible: a structural link only (the dependent imports the changed file), one hop, never
 *   expanded, so a widely imported file cannot flood the report;
 * - unresolved: every boundary where the modeled reach stops, typed and scoped.
 * Nothing is ever reported as unaffected: no producer is negative-evidence-eligible (ADR 0010).
 */

import { compareIds, parseSymbolId } from "@semantic-context/core";
import type {
  BlastRadius,
  ChangedFile,
  ChangeUnit,
  ExposedClaim,
  ImpactStep,
  ImpactTarget,
  ImpactTier,
  RepositoryNode,
  SurfaceDefinition,
  SurfaceImpact,
  SurfaceMap,
  UnresolvedImpact,
} from "@semantic-context/core";
import type { GraphIndex } from "./graph-index";
import { hunkTouchesRange, type DiffHunk, type ParsedDiffChanges } from "./verify-diff";

/** Structural subset of a top-level outline (ts-analyzer's `TopLevelOutline` satisfies it). */
export interface ImpactOutlineStatement {
  kind: string;
  startLine: number;
  endLine: number;
  leadingStartLine: number;
  declaredNames: readonly string[];
  referencedNames: readonly string[];
  sideEffectImport?: true;
  /** Syntax-tree digest without trivia; absent means formatting-only edits cannot be recognised. */
  digest?: string;
  /** Whether load-time evaluation can run code; absent means assumed for every non-inert kind. */
  executesOnLoad?: boolean;
  moduleSpecifier?: string;
  importBindings?: readonly { local: string; imported: string; typeOnly: boolean }[];
  /** For an import or re-export: whether it loads the module at run time; absent means derived from the bindings. */
  loadsModule?: "never" | "maybe" | "yes";
}

export interface ImpactFileOutline {
  statements: readonly ImpactOutlineStatement[];
  exportedNames: readonly string[];
  hasSyntaxErrors: boolean;
  /** Lines whose comment changes compilation or bundling; an edit there is never formatting-only. */
  directiveLines?: readonly number[];
  /** Lines holding a Plane-A marker; absent means any doc-comment edit may have edited one. */
  markerLines?: readonly number[];
}

export interface ImpactPackage {
  /** Repository-relative package root (never "."). */
  root: string;
  identity: string;
}

/**
 * A module link the index holds no `imports` edge for, read from the bound side of the diff: a
 * re-export (`export … from`), an `import()` or `require()`, or an import naming a workspace package
 * the indexer did not resolve to a file. Without these, a module reaching a change only through a
 * barrel would be absent from every tier while the reach still read as complete.
 */
export interface UnindexedModuleLink {
  /** Repository-relative path of the module that writes the link. */
  from: string;
  kind: "import" | "reexport" | "dynamic_import" | "require";
  line: number;
  /** A repository file, a workspace package (resolved to no file), or a non-literal load. */
  target: { path: string } | { package: string } | { nonLiteral: true };
}

/**
 * A module reading another one whole, read from the bound side of the diff: a namespace import
 * (`import * as`, which also has an `imports` edge), a star re-export (`export *`, `export * as`),
 * `import()` or `require()`. An export added to the module read changes what the reader sees
 * (`Object.keys(ns)`, `ns[name]`), although nothing names it.
 */
export interface WholeModuleRead {
  /** Repository-relative path of the module that reads the other one whole. */
  from: string;
  kind: UnindexedModuleLink["kind"];
  line: number;
  /** A repository file, or a workspace package (resolved to no file). */
  target: { path: string } | { package: string };
}

export interface ChangeImpactBounds {
  maxDistance: number;
  maxTargets: number;
}

export const DEFAULT_CHANGE_IMPACT_BOUNDS: ChangeImpactBounds = { maxDistance: 4, maxTargets: 250 };

export interface ComputeChangeImpactArgs {
  index: GraphIndex;
  diff: ParsedDiffChanges;
  /**
   * Diff side whose line coordinates match the indexed ranges, for the whole diff or per file
   * (keyed by the file's new path): an index built on a dirty tree carries the new side of the
   * files that were already dirty and the old side of the others.
   */
  rangeSide: "old" | "new" | ((path: string) => "old" | "new");
  /** Outlines keyed by path, for the bound side and for the other side of the diff. */
  outlines: {
    bound: ReadonlyMap<string, ImpactFileOutline>;
    other: ReadonlyMap<string, ImpactFileOutline>;
  };
  untrackedPaths: readonly string[];
  packages: readonly ImpactPackage[];
  surfaces: SurfaceMap | null;
  isPathSelected: (path: string) => boolean;
  /** False for a language whose producer emits no `calls`/`tested_by` edges (e.g. Python). */
  hasCallEdges: (path: string) => boolean;
  /**
   * Module links without an `imports` edge (see `UnindexedModuleLink`). `undefined` means they were
   * not scanned, so reach through them is reported as unknown rather than silently absent.
   */
  moduleLinks?: readonly UnindexedModuleLink[];
  /** Indexed files whose module links could not be read: reach through them is unknown. */
  moduleLinksUnread?: readonly string[];
  /**
   * Every module read whole by another (see `WholeModuleRead`). `undefined` means they were not
   * scanned, so any module may be read whole and an export added to it is not inert.
   */
  wholeModuleReads?: readonly WholeModuleRead[];
  /**
   * Untracked files the index read from disk and the binding proved unchanged since: they are new
   * files on the bound side, not unknowns.
   */
  unchangedSinceIndexing?: ReadonlySet<string>;
  bounds?: ChangeImpactBounds;
}

export interface ChangeImpactCore {
  files: ChangedFile[];
  units: ChangeUnit[];
  directlyAffected: ImpactTarget[];
  transitivelyAffected: ImpactTarget[];
  possiblyAffected: ImpactTarget[];
  markerClaims: ExposedClaim[];
  /** Strongest tier of every exposed graph node, claim nodes included, for authored-link joins. */
  exposure: Map<string, ImpactTier>;
  surfaces: SurfaceImpact[] | null;
  blastRadius: BlastRadius;
  unresolved: UnresolvedImpact[];
  complete: boolean;
}

const SYMBOL_KINDS: ReadonlySet<string> = new Set(["function", "class", "interface", "type", "enum"]);
const FILE_UNIT_KINDS: ReadonlySet<string> = new Set(["test", "document", "migration"]);
const CONTAINER_KINDS: ReadonlySet<string> = new Set(["module", "test", "document", "migration"]);
const TIER_RANK: Record<ImpactTier, number> = { changed: 0, direct: 1, transitive: 2, possible: 3 };

interface Span {
  start: number;
  end: number;
}

function strongest(left: ImpactTier, right: ImpactTier): ImpactTier {
  return TIER_RANK[left] <= TIER_RANK[right] ? left : right;
}

function evidenceSpans(node: RepositoryNode): Span[] {
  const spans: Span[] = [];
  for (const ref of node.evidence) {
    if (ref.startLine === undefined) continue;
    spans.push({ start: ref.startLine, end: ref.endLine ?? ref.startLine });
  }
  return spans;
}

function toSpans(lines: readonly number[]): Span[] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const spans: Span[] = [];
  for (const line of sorted) {
    const last = spans[spans.length - 1];
    if (last !== undefined && last.end + 1 === line) last.end = line;
    else spans.push({ start: line, end: line });
  }
  return spans;
}

function mergeSpans(spans: readonly Span[]): Span[] {
  const lines: number[] = [];
  for (const span of spans) for (let line = span.start; line <= span.end; line += 1) lines.push(line);
  return toSpans(lines);
}

/** A symbol whose qualified coordinate is shared: the analyzer drops every call touching it. */
function collisionBases(nodes: readonly RepositoryNode[]): Set<string> {
  const bases = new Set<string>();
  for (const node of nodes) {
    const hash = node.id.lastIndexOf("#");
    if (hash > node.id.lastIndexOf(":")) bases.add(node.id.slice(0, hash));
  }
  return bases;
}

function isCollision(nodeId: string, bases: ReadonlySet<string>): boolean {
  const hash = nodeId.lastIndexOf("#");
  return bases.has(hash > nodeId.lastIndexOf(":") ? nodeId.slice(0, hash) : nodeId);
}

function globMatch(pattern: string, path: string): boolean {
  return new Bun.Glob(pattern.replaceAll("\\", "/")).match(path);
}

/** Surfaces a unit or target belongs to. Symbol selectors apply only to symbol-level names. */
function surfacesOf(map: SurfaceMap | null, file: string | undefined, names: readonly string[] | undefined): string[] | undefined {
  if (map === null || file === undefined) return undefined;
  const matched: string[] = [];
  for (const surface of map.surfaces) {
    if (!surface.include.some((pattern) => globMatch(pattern, file))) continue;
    if ((surface.exclude ?? []).some((pattern) => globMatch(pattern, file))) continue;
    if (!symbolSelectorAdmits(surface, names)) continue;
    matched.push(surface.name);
  }
  return matched.sort(compareIds);
}

function symbolSelectorAdmits(surface: SurfaceDefinition, names: readonly string[] | undefined): boolean {
  if (surface.symbols === undefined || names === undefined) return true;
  return names.some((name) => surface.symbols!.some((pattern) => globMatch(pattern, name)));
}

function packageOf(packages: readonly ImpactPackage[], file: string | undefined): ImpactPackage | undefined {
  if (file === undefined) return undefined;
  let best: ImpactPackage | undefined;
  for (const pkg of packages) {
    if (pkg.root === "." || pkg.root.length === 0) continue;
    if (file !== pkg.root && !file.startsWith(`${pkg.root}/`)) continue;
    if (best === undefined || pkg.root.length > best.root.length) best = pkg;
  }
  return best;
}

interface UnitDraft {
  id: string;
  kind: ChangeUnit["kind"];
  file: string;
  side: "old" | "new";
  lines: Span[];
  names: Set<string>;
  declarationKind?: string;
  exported?: boolean | null;
  behavioral: boolean;
  runsOnLoad?: boolean;
  /** A doc-comment edit that reaches a marker line on either side. */
  touchesMarker?: boolean;
}

interface TargetDraft {
  node: RepositoryNode | undefined;
  id: string;
  kind: string;
  name: string;
  file?: string;
  tier: Exclude<ImpactTier, "changed">;
  distance: number;
  reason: string;
  via: ImpactStep[];
}

function edgeEvidence(file: string | undefined, line: number | undefined): ImpactStep["evidence"] {
  if (file === undefined) return undefined;
  return line === undefined ? { file } : { file, line };
}

function stepFromEdge(
  relation: ImpactStep["relation"],
  from: string,
  to: string,
  edge: { evidence: readonly { filePath: string; startLine?: number }[] } | undefined,
): ImpactStep {
  const ref = edge?.evidence[0];
  const evidence = edgeEvidence(ref?.filePath, ref?.startLine);
  return evidence === undefined ? { relation, from, to } : { relation, from, to, evidence };
}

/** Changed files as the diff states them, before any join with the index. */
export function changedFilesFromDiff(diff: ParsedDiffChanges, untrackedPaths: readonly string[]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const file of diff.files) {
    byPath.set(file.filePath, {
      path: file.filePath,
      ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}),
      status: file.status ?? "modified",
      hunks: file.hunks.length,
    });
  }
  for (const block of diff.unscoped) {
    if (block.reason === "rename_only" && block.paths.length === 2) {
      byPath.set(block.paths[1]!, { path: block.paths[1]!, oldPath: block.paths[0]!, status: "renamed", hunks: 0 });
      continue;
    }
    const status: ChangedFile["status"] = block.reason === "binary"
      ? "binary"
      : block.reason === "mode_only"
        ? "mode_only"
        : block.reason === "empty_added"
          ? "added"
          : block.reason === "empty_deleted"
            ? "deleted"
            : "unrecognized";
    for (const path of block.paths) if (!byPath.has(path)) byPath.set(path, { path, status, hunks: 0 });
  }
  for (const path of untrackedPaths) if (!byPath.has(path)) byPath.set(path, { path, status: "untracked", hunks: 0 });
  return [...byPath.values()].sort((a, b) => compareIds(a.path, b.path));
}

/** Evaluate the impact of a diff whose coordinates are bound to the index on `rangeSide`. */
export function computeChangeImpact(args: ComputeChangeImpactArgs): ChangeImpactCore {
  const { index, diff } = args;
  const rangeSide = args.rangeSide;
  const sideOf = (path: string): "old" | "new" => (typeof rangeSide === "function" ? rangeSide(path) : rangeSide);
  const bounds = args.bounds ?? DEFAULT_CHANGE_IMPACT_BOUNDS;
  const unresolved: UnresolvedImpact[] = [];
  const units = new Map<string, UnitDraft>();
  const files = changedFilesFromDiff(diff, args.untrackedPaths);

  const addUnit = (draft: Omit<UnitDraft, "names" | "lines"> & { names?: readonly string[]; lines: readonly Span[] }): void => {
    const key = `${draft.kind}\0${draft.id}\0${draft.side}`;
    const existing = units.get(key);
    if (existing === undefined) {
      units.set(key, { ...draft, names: new Set(draft.names ?? []), lines: [...draft.lines] });
      return;
    }
    existing.lines.push(...draft.lines);
    for (const name of draft.names ?? []) existing.names.add(name);
    existing.behavioral ||= draft.behavioral;
    if (draft.runsOnLoad === true) existing.runsOnLoad = true;
    if (draft.touchesMarker === true) existing.touchesMarker = true;
    if (draft.exported === true) existing.exported = true;
  };

  const gap = (entry: UnresolvedImpact): void => {
    unresolved.push(entry);
  };

  // Header-only blocks and untracked files: named, never silently dropped.
  for (const block of diff.unscoped) {
    if (block.reason === "binary") {
      for (const path of block.paths) {
        gap({ code: "CHANGED_PATH_NOT_ANALYZED", scope: "file", file: path, affects: "reach", detail: "binary change: content is not analysable" });
      }
    } else if (block.reason === "unrecognized") {
      gap({
        code: "UNRECOGNIZED_DIFF_BLOCK",
        scope: block.paths.length === 1 ? "file" : "run",
        ...(block.paths.length === 1 ? { file: block.paths[0]! } : {}),
        affects: "reach",
        detail: `a diff block without content headers could not be classified${block.paths.length === 0 ? " and names no unambiguous path" : ""}`,
      });
    } else if (block.reason === "mode_only") {
      for (const path of block.paths) {
        gap({ code: "METADATA_ONLY_CHANGE", scope: "file", file: path, affects: "none", detail: "file mode changed without a content change" });
      }
    }
  }
  // New files: `addedPaths` are absent from the index (old side bound), `indexedAddedPaths` are
  // described by it (new side bound). Either can take over an existing module's resolution.
  const addedPaths: string[] = [];
  const indexedAddedPaths: string[] = [];
  for (const path of args.untrackedPaths) {
    if (index.nodesByFilePath(path).length > 0 && args.unchangedSinceIndexing?.has(path) === true) {
      gap({ code: "UNTRACKED_PATH_NOT_DIFFED", scope: "file", file: path, affects: "none", detail: "untracked file the index read from disk, unchanged since: git diff does not include it, and committed code reaches it only through the changed files that import it" });
      indexedAddedPaths.push(path);
    } else if (index.nodesByFilePath(path).length > 0) {
      gap({ code: "UNTRACKED_PATH_NOT_DIFFED", scope: "file", file: path, affects: "reach", detail: "untracked file the index describes (it was read from disk): git diff does not include it, so whether it changed since indexing is unknown" });
    } else {
      gap({ code: "UNTRACKED_PATH_NOT_DIFFED", scope: "file", file: path, affects: "none", detail: "untracked file: neither the diff nor the index describes it, and no indexed edge points to it" });
      addedPaths.push(path);
    }
  }

  // --- 1. Attribute every hunk on the bound side -------------------------------------------------
  const fileContexts = new Map<string, { container: RepositoryNode | undefined; symbols: RepositoryNode[]; outline?: ImpactFileOutline }>();
  const topLevelByName = (path: string): Map<string, RepositoryNode[]> => {
    const byName = new Map<string, RepositoryNode[]>();
    for (const node of index.nodesByFilePath(path)) {
      if (!SYMBOL_KINDS.has(node.kind)) continue;
      const parsed = parseSymbolId(node.id);
      if (parsed === undefined || parsed.scope.length > 0) continue;
      const list = byName.get(parsed.name) ?? [];
      list.push(node);
      byName.set(parsed.name, list);
    }
    return byName;
  };
  const wholeReads = args.wholeModuleReads === undefined ? undefined : indexModuleLinks(args.wholeModuleReads, args.packages);
  const readWhole = (path: string): boolean => wholeReads === undefined || wholeReads.reaching(path).length > 0;
  const movedOrDeletedContainers: RepositoryNode[] = [];

  for (const block of diff.unscoped) {
    if (block.reason !== "empty_deleted" && block.reason !== "empty_added") continue;
    for (const path of block.paths) {
      const container = index.nodesByFilePath(path).find((node) => CONTAINER_KINDS.has(node.kind));
      if (block.reason === "empty_added") {
        if (sideOf(path) === "new") indexedAddedPaths.push(path);
        else if (container === undefined) addedPaths.push(path);
        continue;
      }
      if (sideOf(path) === "old" && container !== undefined) movedOrDeletedContainers.push(container);
      else if (sideOf(path) === "new") gap({ code: "REMOVED_PATH_NOT_INDEXED", scope: "file", file: path, affects: "reach", detail: "deleted file: the index describes the head only, so its former dependents are not visible" });
      else gap({ code: "CHANGED_PATH_NOT_ANALYZED", scope: "file", file: path, affects: "reach", detail: "deleted file the index holds no facts for" });
    }
  }

  const unscopedRenames = diff.unscoped.filter((block) => block.reason === "rename_only" && block.paths.length === 2);
  for (const block of unscopedRenames) {
    const [from, to] = block.paths as [string, string];
    if (sideOf(to) === "old") {
      const container = index.nodesByFilePath(from).find((node) => CONTAINER_KINDS.has(node.kind));
      if (container !== undefined) movedOrDeletedContainers.push(container);
    } else {
      gap({ code: "RENAMED_PATH_DEPENDENTS_NOT_VISIBLE", scope: "file", file: to, affects: "reach", detail: `renamed from ${from}: the index describes the head only, so dependents that still name the old path are not visible` });
    }
  }

  for (const file of diff.files) {
    const status = file.status ?? "modified";
    const side = sideOf(file.filePath);
    const boundPath = side === "old" ? (file.oldPath ?? file.filePath) : file.filePath;
    const otherPath = side === "old" ? file.filePath : (file.oldPath ?? file.filePath);
    const nodes = index.nodesByFilePath(boundPath);
    if (nodes.length === 0) {
      if (side === "old" && status === "added") {
        gap({ code: "ADDED_PATH_NOT_INDEXED", scope: "file", file: file.filePath, affects: "none", detail: "added file: the index describes the pre-change state, and no indexed edge points to it" });
        addedPaths.push(file.filePath);
      } else if (side === "new" && status === "deleted") {
        gap({ code: "REMOVED_PATH_NOT_INDEXED", scope: "file", file: boundPath, affects: "reach", detail: "deleted file: the index describes the head only, so its former dependents are not visible" });
      } else {
        gap({
          code: "CHANGED_PATH_NOT_ANALYZED",
          scope: "file",
          file: boundPath,
          affects: "reach",
          detail: args.isPathSelected(boundPath)
            ? "the path is selected but the index holds no facts for it (unsupported language, failed producer, or not indexed)"
            : "the path is outside the configured analysis selection",
        });
      }
      continue;
    }
    if (side === "new" && status === "renamed" && file.oldPath !== undefined) {
      gap({ code: "RENAMED_PATH_DEPENDENTS_NOT_VISIBLE", scope: "file", file: file.filePath, affects: "reach", detail: `renamed from ${file.oldPath}: dependents that still name the old path are not visible in the head index` });
    }
    if (side === "new" && status === "added") indexedAddedPaths.push(file.filePath);
    const container = nodes.find((node) => CONTAINER_KINDS.has(node.kind));
    const symbols = nodes.filter((node) => SYMBOL_KINDS.has(node.kind));
    const outline = args.outlines.bound.get(boundPath);
    fileContexts.set(boundPath, { container, symbols, ...(outline !== undefined ? { outline } : {}) });
    if (side === "old" && (status === "deleted" || status === "renamed") && container !== undefined) {
      movedOrDeletedContainers.push(container);
    }
    const exportedNames = outline === undefined ? undefined : new Set(outline.exportedNames);
    const exportedFor = (node: RepositoryNode): boolean | null => {
      const parsed = parseSymbolId(node.id);
      if (exportedNames !== undefined && parsed !== undefined) {
        if (parsed.scope.length === 0) return exportedNames.has(parsed.name);
        // A nested symbol is reached only through its enclosing top-level declaration.
        if (!exportedNames.has(parsed.scope[0]!)) return false;
      }
      return node.exported === true ? true : null;
    };
    const byName = topLevelByName(boundPath);

    for (const hunk of file.hunks) {
      attributeHunk({
        hunk,
        side,
        boundPath,
        otherPath,
        container,
        symbols,
        outline,
        otherOutline: args.outlines.other.get(otherPath),
        byName,
        exportedFor,
        readWhole: readWhole(boundPath),
        addUnit,
        gap,
      });
    }
  }

  const unitList = [...units.values()];
  const changedNodeIds = new Set<string>();
  for (const unit of unitList) {
    if (!unit.behavioral) continue;
    if (unit.kind === "symbol" || unit.kind === "file" || unit.kind === "module_statement") changedNodeIds.add(unit.id);
  }

  // --- 2. Direct targets -----------------------------------------------------------------------
  const targets = new Map<string, TargetDraft>();
  const addTarget = (draft: TargetDraft): boolean => {
    if (changedNodeIds.has(draft.id)) return false;
    const existing = targets.get(draft.id);
    if (existing !== undefined) {
      if (TIER_RANK[draft.tier] < TIER_RANK[existing.tier] || (draft.tier === existing.tier && draft.distance < existing.distance)) {
        targets.set(draft.id, draft);
        return true;
      }
      return false;
    }
    targets.set(draft.id, draft);
    return true;
  };
  const nodeTarget = (
    node: RepositoryNode,
    tier: TargetDraft["tier"],
    distance: number,
    reason: string,
    via: ImpactStep[],
  ): TargetDraft => ({
    node,
    id: node.id,
    kind: node.kind,
    name: node.name,
    ...(node.filePath !== undefined ? { file: node.filePath } : {}),
    tier,
    distance,
    reason,
    via,
  });

  const changedSymbolIds = unitList
    .filter((unit) => unit.kind === "symbol" && unit.behavioral)
    .map((unit) => unit.id)
    .sort(compareIds);
  for (const id of changedSymbolIds) {
    for (const edge of [...index.inEdges(id, ["calls"])].sort((a, b) => compareIds(a.from, b.from))) {
      const caller = index.node(edge.from);
      if (caller === undefined) continue;
      addTarget(nodeTarget(caller, "direct", 1, "CALLS_CHANGED", [stepFromEdge("called_by", id, caller.id, edge)]));
    }
    for (const edge of [...index.outEdges(id, ["tested_by"])].sort((a, b) => compareIds(a.to, b.to))) {
      const test = index.node(edge.to);
      if (test === undefined) continue;
      addTarget(nodeTarget(test, "direct", 1, "TEST_IMPORTS_CHANGED_BY_NAME", [stepFromEdge("tested_by", id, test.id, edge)]));
    }
  }

  // Same-file references the call graph cannot see: a constant read by a function, a function
  // passed as a value, module code reading a changed binding.
  const declarationTargets = new Map<string, { file: string; name: string; exported: boolean | null; via: ImpactStep[] }>();
  for (const [path, context] of [...fileContexts].sort((a, b) => compareIds(a[0], b[0]))) {
    if (context.outline === undefined || context.outline.hasSyntaxErrors) continue;
    propagateSameFile({
      path,
      context: context as { container: RepositoryNode | undefined; symbols: RepositoryNode[]; outline: ImpactFileOutline },
      units: unitList,
      byName: topLevelByName(path),
      changedNodeIds,
      addTarget,
      nodeTarget,
      declarationTargets,
    });
  }

  // --- 3. Transitive behavioural closure (reverse calls + test links), bounded -------------------
  let truncatedByCount = 0;
  const truncatedByDepth: string[] = [];
  let frontier = [...targets.values()]
    .filter((target) => target.node !== undefined && SYMBOL_KINDS.has(target.kind))
    .sort((a, b) => compareIds(a.id, b.id));
  while (frontier.length > 0) {
    const next: TargetDraft[] = [];
    for (let position = 0; position < frontier.length; position += 1) {
      const current = frontier[position]!;
      const callers = [...index.inEdges(current.id, ["calls"])].sort((a, b) => compareIds(a.from, b.from));
      const tests = [...index.outEdges(current.id, ["tested_by"])].sort((a, b) => compareIds(a.to, b.to));
      const pending = [
        ...callers.filter((edge) => !targets.has(edge.from) && !changedNodeIds.has(edge.from)),
        ...tests.filter((edge) => !targets.has(edge.to) && !changedNodeIds.has(edge.to)),
      ];
      if (pending.length === 0) continue;
      if (current.distance >= bounds.maxDistance) {
        truncatedByDepth.push(current.id);
        continue;
      }
      for (const edge of callers) {
        if (targets.size >= bounds.maxTargets) {
          truncatedByCount += 1;
          continue;
        }
        const caller = index.node(edge.from);
        if (caller === undefined) continue;
        const draft = nodeTarget(caller, "transitive", current.distance + 1, "CALLS_AFFECTED", [
          ...current.via,
          stepFromEdge("called_by", current.id, caller.id, edge),
        ]);
        if (addTarget(draft) && SYMBOL_KINDS.has(caller.kind)) next.push(draft);
      }
      for (const edge of tests) {
        if (targets.size >= bounds.maxTargets) {
          truncatedByCount += 1;
          continue;
        }
        const test = index.node(edge.to);
        if (test === undefined) continue;
        addTarget(nodeTarget(test, "transitive", current.distance + 1, "TEST_IMPORTS_AFFECTED_BY_NAME", [
          ...current.via,
          stepFromEdge("tested_by", current.id, test.id, edge),
        ]));
      }
    }
    frontier = next.sort((a, b) => compareIds(a.id, b.id));
  }
  if (truncatedByCount > 0) {
    gap({ code: "TRAVERSAL_TRUNCATED", scope: "run", affects: "reach", detail: `cause=count: ${truncatedByCount} further dependents were not expanded after reaching maxTargets=${bounds.maxTargets}` });
  }
  for (const id of [...new Set(truncatedByDepth)].sort(compareIds)) {
    gap({ code: "TRAVERSAL_TRUNCATED", scope: "node", nodeId: id, affects: "reach", detail: `cause=depth: dependents beyond maxDistance=${bounds.maxDistance} were not expanded` });
  }

  // --- 4. Reverse reach the graph cannot model, and the structural (possible) tier ---------------
  const collisions = collisionBases(index.nodesOfKind("function"));
  const representedFiles = new Set<string>();
  for (const unit of unitList) if (unit.behavioral) representedFiles.add(unit.file);
  for (const target of targets.values()) if (target.file !== undefined) representedFiles.add(target.file);

  const possible = new Map<string, TargetDraft>();
  const omittedPossible = new Set<string>();
  let possibleOmitted = 0;
  const viaKey = (via: readonly ImpactStep[]): string => via.map((step) => `${step.from}>${step.to}`).join("|");
  const addPossible = (node: RepositoryNode, distance: number, reason: string, via: ImpactStep[]): void => {
    if (changedNodeIds.has(node.id) || targets.has(node.id)) return;
    const existing = possible.get(node.id);
    if (existing !== undefined) {
      // The shortest chain wins, whatever order the changed units were visited in.
      if (distance < existing.distance || (distance === existing.distance && compareIds(`${reason}\0${viaKey(via)}`, `${existing.reason}\0${viaKey(existing.via)}`) < 0)) {
        possible.set(node.id, nodeTarget(node, "possible", distance, reason, via));
      }
      return;
    }
    if (node.filePath !== undefined && representedFiles.has(node.filePath) && !SYMBOL_KINDS.has(node.kind)) return;
    if (possible.size >= bounds.maxTargets) {
      // Not listed, but still exposed: claims anchored to it must not silently disappear.
      if (!omittedPossible.has(node.id)) possibleOmitted += 1;
      omittedPossible.add(node.id);
      return;
    }
    possible.set(node.id, nodeTarget(node, "possible", distance, reason, via));
  };
  const importersOf = (container: RepositoryNode | undefined) =>
    container === undefined
      ? []
      : [...index.inEdges(container.id, ["imports"])].sort((a, b) => compareIds(a.from, b.from));
  const containerOf = (path: string | undefined): RepositoryNode | undefined =>
    path === undefined ? undefined : index.nodesByFilePath(path).find((node) => CONTAINER_KINDS.has(node.kind));
  const links = indexModuleLinks(args.moduleLinks ?? [], args.packages);
  let exposedToDependents = false;
  // Dependents reaching `container` through a link the index has no edge for. A re-exporter passes
  // the exposure on, so its importers and its own re-exporters are listed too (still possible).
  const addLinkedDependents = (container: RepositoryNode, from: string, distance: number, via: ImpactStep[], seen: Set<string>): number => {
    let count = 0;
    for (const link of links.reaching(container.filePath)) {
      const linker = containerOf(link.from);
      if (linker === undefined || linker.id === container.id) continue;
      if (link.kind === "import" && "package" in link.target && importsIntoPackage(index, linker, links.packageRoot(link.target.package))) continue;
      count += 1;
      const step: ImpactStep = { relation: "imported_by", from, to: linker.id, evidence: { file: link.from, line: link.line } };
      addPossible(linker, distance, linkReason(link), [...via, step]);
      if (link.kind !== "reexport" || seen.has(linker.id)) continue;
      seen.add(linker.id);
      for (const edge of importersOf(linker)) {
        const importer = index.node(edge.from);
        if (importer === undefined || importer.id === linker.id) continue;
        count += 1;
        addPossible(importer, distance + 1, "IMPORTS_REEXPORTER_OF_CHANGED_FILE", [...via, step, stepFromEdge("imported_by", linker.id, importer.id, edge)]);
      }
      count += addLinkedDependents(linker, linker.id, distance + 1, [...via, step], seen);
    }
    return count;
  };
  /** `prefix` is the chain from a changed unit to `from`, so every via starts at the change. */
  const addImporters = (container: RepositoryNode | undefined, from: string, reason: string, prefix: ImpactStep[] = []): number => {
    let count = 0;
    const distance = prefix.length + 1;
    for (const edge of importersOf(container)) {
      const importer = index.node(edge.from);
      if (importer === undefined || importer.id === container?.id) continue;
      count += 1;
      addPossible(importer, distance, reason, [...prefix, stepFromEdge("imported_by", from, importer.id, edge)]);
    }
    if (container !== undefined) {
      exposedToDependents = true;
      count += addLinkedDependents(container, from, distance, prefix, new Set([container.id]));
    }
    return count;
  };
  const moduleInitialization = (container: RepositoryNode | undefined, unit: UnitDraft): void => {
    const importers = addImporters(container, unit.id, "IMPORTS_MODULE_EXECUTING_CHANGE");
    if (importers > 0) {
      gap({ code: "REVERSE_REACH_NOT_MODELED", scope: "node", nodeId: unit.id, file: unit.file, affects: "reach", detail: "cause=module_initialization: importers run this module's top-level code; only its direct importers are listed (possible tier)" });
    }
  };

  // Changed units whose change is visible to importers.
  for (const unit of unitList.sort((a, b) => compareIds(a.id, b.id))) {
    if (!unit.behavioral) continue;
    const context = fileContexts.get(unit.file);
    const container = context?.container ?? containerOf(unit.file);
    if (unit.kind === "unclassified") {
      addImporters(container, unit.id, "IMPORTS_FILE_WITH_UNCLASSIFIED_CHANGE");
      for (const sibling of (context?.symbols ?? []).filter((node) => parseSymbolId(node.id)?.scope.length === 0).sort((a, b) => compareIds(a.id, b.id))) {
        addPossible(sibling, 1, "SHARES_FILE_WITH_UNCLASSIFIED_CHANGE", [{ relation: "declared_in_same_file", from: unit.id, to: sibling.id }]);
      }
      continue;
    }
    if (unit.kind === "module_statement" || unit.runsOnLoad === true) {
      moduleInitialization(container, unit);
      continue;
    }
    if (unit.kind === "file") {
      addImporters(container, unit.id, "IMPORTS_FILE_OF_CHANGED_DECLARATION");
      continue;
    }
    if (unit.kind === "symbol" || unit.kind === "declaration" || unit.kind === "removed_declaration" || unit.kind === "added_declaration") {
      if (unit.exported === false) continue;
      const importers = addImporters(container, unit.id, "IMPORTS_FILE_OF_CHANGED_DECLARATION");
      const node = unit.kind === "symbol" ? index.node(unit.id) : undefined;
      const modeled = node !== undefined
        && node.kind === "function"
        && args.hasCallEdges(unit.file)
        && !isCollision(node.id, collisions);
      if (!modeled && (importers > 0 || !args.hasCallEdges(unit.file))) {
        gap({
          code: "REVERSE_REACH_NOT_MODELED",
          scope: "node",
          nodeId: unit.id,
          file: unit.file,
          affects: "reach",
          detail: `cause=${unmodeledCause(node, unit, args.hasCallEdges(unit.file), collisions)}: dependents outside this file are listed only as importers (possible tier)`,
        });
      }
    }
  }
  // A changed file with no unit of its own is the origin of its chains as `file:<path>`.
  for (const container of movedOrDeletedContainers) {
    addImporters(container, `file:${container.filePath ?? container.id}`, "IMPORTS_MOVED_OR_DELETED_FILE");
  }
  // A new file can take over the resolution of an existing specifier (`x.ts` over `x/index.ts`).
  for (const path of [...new Set(addedPaths)].sort(compareIds)) {
    for (const shadowed of shadowedContainers(index, path)) {
      const importers = addImporters(shadowed, `file:${path}`, "IMPORTS_SHADOWED_MODULE");
      if (importers > 0) {
        gap({ code: "ADDED_PATH_MAY_SHADOW_MODULE", scope: "file", file: path, affects: "reach", detail: `the new file may take over imports that resolved to ${shadowed.filePath ?? shadowed.id}; its importers are listed as possible` });
      }
    }
  }
  // On the new side the index already routes the taken-over imports to the new file itself.
  for (const path of [...new Set(indexedAddedPaths)].sort(compareIds)) {
    const shadowed = shadowedContainers(index, path);
    if (shadowed.length === 0) continue;
    const own = containerOf(path);
    const importers = own === undefined ? 0 : addImporters(own, `file:${path}`, "IMPORTS_SHADOWED_MODULE");
    if (importers > 0 || own === undefined) {
      gap({
        code: "ADDED_PATH_MAY_SHADOW_MODULE",
        scope: "file",
        file: path,
        affects: "reach",
        detail: `the new file may take over imports that resolved to ${shadowed.map((node) => node.filePath ?? node.id).join(", ")}; ${own === undefined ? "the index holds no module for it, so which importers it took over is unknown" : "its importers are listed as possible"}`,
      });
    }
  }
  // Affected declarations and targets whose own dependents cannot be followed by call edges.
  for (const [id, declaration] of [...declarationTargets].sort((a, b) => compareIds(a[0], b[0]))) {
    if (declaration.exported === false) continue;
    const importers = addImporters(containerOf(declaration.file), id, "IMPORTS_FILE_OF_UNMODELED_DEPENDENCY", declaration.via);
    if (importers > 0) {
      gap({ code: "REVERSE_REACH_NOT_MODELED", scope: "node", nodeId: id, file: declaration.file, affects: "reach", detail: "cause=non_call_reference: an exported declaration read by importers is not followed across files" });
    }
  }
  for (const target of [...targets.values()].sort((a, b) => compareIds(a.id, b.id))) {
    if (target.node === undefined) continue;
    const node = target.node;
    if (node.kind === "module") {
      const importers = addImporters(node, node.id, "IMPORTS_MODULE_EXECUTING_CHANGE", target.via);
      if (importers > 0) {
        gap({ code: "REVERSE_REACH_NOT_MODELED", scope: "node", nodeId: node.id, ...(node.filePath !== undefined ? { file: node.filePath } : {}), affects: "reach", detail: "cause=module_initialization: this module's top-level code runs affected code; only its direct importers are listed (possible tier)" });
      }
      continue;
    }
    if (!SYMBOL_KINDS.has(node.kind)) continue;
    const hasEdges = node.filePath === undefined ? true : args.hasCallEdges(node.filePath);
    const modeled = node.kind === "function" && hasEdges && !isCollision(node.id, collisions);
    if (modeled) continue;
    const importers = addImporters(containerOf(node.filePath), node.id, "IMPORTS_FILE_OF_UNMODELED_DEPENDENCY", target.via);
    if (importers > 0 || !hasEdges) {
      gap({
        code: "REVERSE_REACH_NOT_MODELED",
        scope: "node",
        nodeId: node.id,
        ...(node.filePath !== undefined ? { file: node.filePath } : {}),
        affects: "reach",
        detail: `cause=${unmodeledCause(node, undefined, hasEdges, collisions)}: its dependents are listed only as importers (possible tier)`,
      });
    }
  }
  if (exposedToDependents && args.moduleLinks === undefined) {
    gap({ code: "MODULE_LINKS_NOT_SCANNED", scope: "run", affects: "reach", detail: "re-exports, import() and require() were not read: modules reaching the change only through them are not listed" });
  }
  if (exposedToDependents) {
    for (const file of [...(args.moduleLinksUnread ?? [])].sort(compareIds)) {
      gap({ code: "MODULE_LINKS_NOT_SCANNED", scope: "file", file, affects: "reach", detail: "an indexed file whose re-exports, import() and require() could not be read" });
    }
    for (const file of links.nonLiteralFiles()) {
      gap({ code: "MODULE_LOAD_NOT_RESOLVED", scope: "file", file, affects: "reach", detail: "a non-literal import()/require() may load a changed module; what it loads is unknown" });
    }
  }
  if (possibleOmitted > 0) {
    gap({ code: "POSSIBLE_TIER_TRUNCATED", scope: "run", affects: "none", detail: `${possibleOmitted} possibly affected targets were omitted after reaching maxTargets=${bounds.maxTargets}` });
  }

  // --- 5. Projection --------------------------------------------------------------------------
  const complete = !unresolved.some((entry) => entry.affects === "reach");
  const decorate = (draft: TargetDraft): ImpactTarget => {
    const pkg = packageOf(args.packages, draft.file);
    const symbolLevel = draft.kind === "declaration" || SYMBOL_KINDS.has(draft.kind);
    const surfaces = surfacesOf(args.surfaces, draft.file, symbolLevel ? [draft.name] : undefined);
    return {
      id: draft.id,
      kind: draft.kind,
      name: draft.name,
      ...(draft.file !== undefined ? { file: draft.file } : {}),
      ...(pkg !== undefined ? { package: pkg.identity } : {}),
      ...(surfaces !== undefined ? { surfaces } : {}),
      distance: draft.distance,
      reason: draft.reason,
      via: draft.via,
    };
  };
  for (const [id, declaration] of declarationTargets) {
    if (targets.has(id)) continue;
    targets.set(id, {
      node: undefined,
      id,
      kind: "declaration",
      name: declaration.name,
      file: declaration.file,
      tier: tierAt(declaration.via.length),
      distance: declaration.via.length,
      reason: referenceReason(declaration.via.length),
      via: declaration.via,
    });
  }
  const byTier = (tier: TargetDraft["tier"]): ImpactTarget[] =>
    [...targets.values(), ...possible.values()]
      .filter((target) => target.tier === tier)
      .sort((a, b) => a.distance - b.distance || compareIds(a.id, b.id))
      .map(decorate);
  const directlyAffected = byTier("direct");
  const transitivelyAffected = byTier("transitive");
  const possiblyAffected = byTier("possible");

  const finalUnits: ChangeUnit[] = unitList
    .map((unit): ChangeUnit => {
      const symbolLevel = unit.kind === "symbol" || unit.kind === "declaration" || unit.kind === "doc_comment"
        || unit.kind === "added_declaration" || unit.kind === "removed_declaration";
      const surfaces = surfacesOf(args.surfaces, unit.file, symbolLevel && unit.names.size > 0 ? [...unit.names] : undefined);
      return {
        id: unit.id,
        kind: unit.kind,
        file: unit.file,
        side: unit.side,
        lines: mergeSpans(unit.lines),
        names: [...unit.names].sort(compareIds),
        ...(unit.declarationKind !== undefined ? { declarationKind: unit.declarationKind } : {}),
        ...(unit.exported !== undefined ? { exported: unit.exported } : {}),
        behavioral: unit.behavioral,
        ...(unit.behavioral && unit.runsOnLoad === true ? { runsOnLoad: true as const } : {}),
        ...(surfaces !== undefined ? { surfaces } : {}),
      };
    })
    .sort((a, b) => compareIds(a.file, b.file) || compareIds(a.kind, b.kind) || compareIds(a.id, b.id));

  // Exposure of every graph node, for marker claims and authored-link joins.
  const exposure = new Map<string, ImpactTier>();
  const expose = (id: string, tier: ImpactTier): void => {
    const current = exposure.get(id);
    exposure.set(id, current === undefined ? tier : strongest(current, tier));
  };
  for (const id of changedNodeIds) expose(id, "changed");
  // A behavioural change anywhere in a file possibly exposes what is anchored to the file as a
  // whole, even when the changed declaration has no node of its own. Never more than possible: the
  // rest of a mixed module is not shown to change.
  for (const unit of unitList) {
    const container = unit.behavioral ? fileContexts.get(unit.file)?.container : undefined;
    if (container !== undefined) expose(container.id, "possible");
  }
  for (const [tier, list] of [["direct", directlyAffected], ["transitive", transitivelyAffected], ["possible", possiblyAffected]] as const) {
    for (const target of list) if (index.has(target.id)) expose(target.id, tier);
  }
  for (const id of omittedPossible) expose(id, "possible");
  const markerEdits = new Set(unitList.filter((unit) => unit.kind === "doc_comment" && unit.touchesMarker === true).map((unit) => `${unit.id}\0${unit.side}`));
  const markerClaims = computeMarkerClaims(index, exposure, finalUnits, (unit) => markerEdits.has(`${unit.id}\0${unit.side}`));
  for (const claim of markerClaims) expose(claim.id, claim.exposure);

  // A truncated possible tier may hide the only link to a surface: no surface is then "not reached".
  const surfaces = surfaceImpacts(args.surfaces, finalUnits, { directlyAffected, transitivelyAffected, possiblyAffected }, complete && possibleOmitted === 0);
  const blastRadius = computeBlastRadius({
    units: finalUnits,
    known: [...directlyAffected, ...transitivelyAffected],
    possible: possiblyAffected,
    possibleOmitted,
    packages: args.packages,
    complete,
    unresolved,
  });

  return {
    files,
    units: finalUnits,
    directlyAffected,
    transitivelyAffected,
    possiblyAffected,
    markerClaims,
    exposure,
    surfaces,
    blastRadius,
    unresolved: sortUnresolved(unresolved),
    complete,
  };
}

interface ModuleLinkIndex {
  reaching: (path: string | undefined) => UnindexedModuleLink[];
  packageRoot: (identity: string) => string | undefined;
  nonLiteralFiles: () => string[];
}

function indexModuleLinks(moduleLinks: readonly UnindexedModuleLink[], packages: readonly ImpactPackage[]): ModuleLinkIndex {
  const byPath = new Map<string, UnindexedModuleLink[]>();
  const byPackage = new Map<string, UnindexedModuleLink[]>();
  const nonLiteral = new Set<string>();
  for (const link of moduleLinks) {
    if ("path" in link.target) byPath.set(link.target.path, [...(byPath.get(link.target.path) ?? []), link]);
    else if ("package" in link.target) byPackage.set(link.target.package, [...(byPackage.get(link.target.package) ?? []), link]);
    else nonLiteral.add(link.from);
  }
  const rootOf = new Map(packages.map((pkg) => [pkg.identity, pkg.root]));
  const order = (a: UnindexedModuleLink, b: UnindexedModuleLink): number => compareIds(a.from, b.from) || a.line - b.line;
  return {
    reaching: (path) => {
      if (path === undefined) return [];
      const out = [...(byPath.get(path) ?? [])];
      for (const pkg of packages) {
        if (path.startsWith(`${pkg.root}/`)) out.push(...(byPackage.get(pkg.identity) ?? []));
      }
      return out.sort(order);
    },
    packageRoot: (identity) => rootOf.get(identity),
    nonLiteralFiles: () => [...nonLiteral].sort(compareIds),
  };
}

/** Whether `linker` already has an `imports` edge into the package: the edge-based reach covers it. */
function importsIntoPackage(index: GraphIndex, linker: RepositoryNode, root: string | undefined): boolean {
  if (root === undefined) return false;
  return index.outEdges(linker.id, ["imports"]).some((edge) => index.node(edge.to)?.filePath?.startsWith(`${root}/`) === true);
}

const TS_SOURCE_RE = /\.(?:d\.)?(?:ts|tsx|mts|cts)$/;

/** Indexed modules a new file at `path` can take the resolution from: `x.ts` over `x.tsx`, `x.d.ts`, `x/index.*`. */
function shadowedContainers(index: GraphIndex, path: string): RepositoryNode[] {
  if (!TS_SOURCE_RE.test(path) || path.endsWith(".d.ts")) return [];
  const stem = path.replace(TS_SOURCE_RE, "");
  const candidates = [".ts", ".tsx", ".d.ts", "/index.ts", "/index.tsx", "/index.d.ts"].map((suffix) => `${stem}${suffix}`).filter((candidate) => candidate !== path);
  return candidates.flatMap((candidate) => index.nodesByFilePath(candidate).filter((node) => CONTAINER_KINDS.has(node.kind)));
}

function linkReason(link: UnindexedModuleLink): string {
  const viaPackage = "package" in link.target;
  if (link.kind === "reexport") return viaPackage ? "REEXPORTS_PACKAGE_WITH_CHANGED_FILE" : "REEXPORTS_CHANGED_FILE";
  if (link.kind === "import") return "IMPORTS_PACKAGE_WITH_CHANGED_FILE";
  return viaPackage ? "LOADS_PACKAGE_WITH_CHANGED_FILE" : "LOADS_CHANGED_FILE";
}

function unmodeledCause(
  node: RepositoryNode | undefined,
  unit: UnitDraft | undefined,
  hasCallEdges: boolean,
  collisions: ReadonlySet<string>,
): string {
  if (!hasCallEdges) return "language_has_no_call_edges";
  if (node !== undefined && isCollision(node.id, collisions)) return "ambiguous_identity";
  if (node !== undefined) return `symbol_kind_${node.kind}`;
  return unit?.kind === "declaration" ? "non_call_reference" : "declaration";
}

interface AttributeHunkArgs {
  hunk: DiffHunk;
  side: "old" | "new";
  boundPath: string;
  otherPath: string;
  container: RepositoryNode | undefined;
  symbols: readonly RepositoryNode[];
  outline: ImpactFileOutline | undefined;
  otherOutline: ImpactFileOutline | undefined;
  byName: ReadonlyMap<string, RepositoryNode[]>;
  exportedFor: (node: RepositoryNode) => boolean | null;
  /** Another module reads this file whole, or whether one does is unknown. */
  readWhole: boolean;
  addUnit: (draft: Omit<UnitDraft, "names" | "lines"> & { names?: readonly string[]; lines: readonly Span[] }) => void;
  gap: (entry: UnresolvedImpact) => void;
}

/** Declarations whose evaluation never runs code, when the outline cannot say (hand-built outlines). */
const NEVER_RUN_ON_LOAD: ReadonlySet<string> = new Set(["function", "interface", "type"]);
/** Declarations that bind no runtime value: a module read whole does not see them. */
const TYPE_ONLY_KINDS: ReadonlySet<string> = new Set(["interface", "type"]);
/** Kinds whose top-level evaluation is the load-time behaviour of the module. */
const LOAD_TIME_KINDS: ReadonlySet<string> = new Set(["variable", "class", "enum", "namespace", "export"]);

function runsOnLoad(statement: ImpactOutlineStatement): boolean {
  return statement.executesOnLoad ?? !NEVER_RUN_ON_LOAD.has(statement.kind);
}

const LOAD_RANK = { never: 0, maybe: 1, yes: 2 } as const;

/** Whether an import or re-export loads its module: 0 never, 1 depending on the compiler configuration, 2 yes. */
function loadsOf(statement: ImpactOutlineStatement): number {
  if (statement.loadsModule !== undefined) return LOAD_RANK[statement.loadsModule];
  if (statement.sideEffectImport === true) return 2;
  if (!runsOnLoad(statement)) return 0;
  const bindings = statement.importBindings;
  return bindings === undefined || bindings.some((binding) => !binding.typeOnly) ? 2 : 1;
}

function loadsModuleStatement(statement: ImpactOutlineStatement): boolean {
  return (statement.kind === "import" || statement.kind === "export") && statement.moduleSpecifier !== undefined;
}

/** How surely a file loads `specifier`, over all its imports and re-exports of it. */
function moduleLoadStatus(outline: ImpactFileOutline | undefined, specifier: string): number {
  let status = 0;
  for (const statement of outline?.statements ?? []) {
    if (loadsModuleStatement(statement) && statement.moduleSpecifier === specifier) status = Math.max(status, loadsOf(statement));
  }
  return status;
}

/** Whether the modules both sides load are evaluated in a different order (ESM runs them in import order). */
function loadOrderChanged(left: ImpactFileOutline, right: ImpactFileOutline): boolean {
  const order = (outline: ImpactFileOutline): string[] => {
    const seen: string[] = [];
    for (const statement of outline.statements) {
      if (loadsModuleStatement(statement) && loadsOf(statement) > 0 && !seen.includes(statement.moduleSpecifier!)) seen.push(statement.moduleSpecifier!);
    }
    return seen;
  };
  const leftOrder = order(left);
  const rightOrder = order(right);
  const shared = (from: string[], other: string[]): string => from.filter((specifier) => other.includes(specifier)).join("\0");
  return shared(leftOrder, rightOrder) !== shared(rightOrder, leftOrder);
}

function intersects(left: Span, right: Span): boolean {
  return left.start <= right.end && right.start <= left.end;
}

function linesIn(span: Span, range: Span): number[] {
  const lines: number[] = [];
  for (let line = Math.max(span.start, range.start); line <= Math.min(span.end, range.end); line += 1) lines.push(line);
  return lines;
}

/**
 * Statements a hunk side touches: by its lines, or strictly around an insertion point (after line
 * `point`) — leading comments included either way.
 */
function statementsAt(outline: ImpactFileOutline, span: Span | undefined, point: number): ImpactOutlineStatement[] {
  if (span !== undefined) return outline.statements.filter((statement) => intersects({ start: statement.leadingStartLine, end: statement.endLine }, span));
  return outline.statements.filter((statement) => statement.leadingStartLine <= point && point < statement.endLine);
}

/** Whether a hunk side reaches the statement's code, not only its leading comment. */
function touchesCode(statement: ImpactOutlineStatement, span: Span | undefined, point: number): boolean {
  return span === undefined ? statement.startLine <= point : intersects({ start: statement.startLine, end: statement.endLine }, span);
}

function sameNames(left: ImpactOutlineStatement, right: ImpactOutlineStatement): boolean {
  return left.declaredNames.join("\0") === right.declaredNames.join("\0");
}

/**
 * The statements on both sides of a hunk when the hunk edits only comments and formatting inside
 * them: same statements, same kinds and names, same syntax-tree digests, no directive comment, and
 * each pair reached the same way — code on one side is never paired with a comment on the other.
 */
function formattingOnlyStatements(
  args: AttributeHunkArgs,
  boundSpan: Span | undefined,
  boundPoint: number,
  otherSpan: Span | undefined,
  otherPoint: number,
): { bound: ImpactOutlineStatement[]; other: ImpactOutlineStatement[] } | undefined {
  const { outline, otherOutline } = args;
  if (outline === undefined || otherOutline === undefined || outline.hasSyntaxErrors || otherOutline.hasSyntaxErrors) return undefined;
  const directive = (source: ImpactFileOutline, span: Span | undefined): boolean =>
    span !== undefined && (source.directiveLines ?? []).some((line) => span.start <= line && line <= span.end);
  if (directive(outline, boundSpan) || directive(otherOutline, otherSpan)) return undefined;
  const bound = statementsAt(outline, boundSpan, boundPoint);
  const other = statementsAt(otherOutline, otherSpan, otherPoint);
  if (bound.length === 0 || bound.length !== other.length) return undefined;
  for (let position = 0; position < bound.length; position += 1) {
    const left = bound[position]!;
    const right = other[position]!;
    if (left.digest === undefined || left.digest !== right.digest || left.kind !== right.kind || !sameNames(left, right)) return undefined;
    if (touchesCode(left, boundSpan, boundPoint) !== touchesCode(right, otherSpan, otherPoint)) return undefined;
  }
  return { bound, other };
}

function statementId(args: AttributeHunkArgs, statement: ImpactOutlineStatement): { id: string; kind: string } {
  const nodes = statement.declaredNames.flatMap((name) => args.byName.get(name) ?? []);
  return { id: nodes[0]?.id ?? declarationId(args.boundPath, statement), kind: nodes[0]?.kind ?? statement.kind };
}

function attributeHunk(args: AttributeHunkArgs): void {
  const { hunk, side, boundPath, container, symbols } = args;
  const boundStart = side === "old" ? hunk.oldStart : hunk.newStart;
  const boundLines = side === "old" ? hunk.oldLines : hunk.newLines;
  const otherSide = side === "old" ? "new" : "old";
  const otherStart = side === "old" ? hunk.newStart : hunk.oldStart;
  const otherLines = side === "old" ? hunk.newLines : hunk.oldLines;
  const hunkSpan: Span = boundLines === 0
    ? { start: boundStart, end: boundStart }
    : { start: boundStart, end: boundStart + boundLines - 1 };
  const otherSpan: Span | undefined = otherLines === 0 ? undefined : { start: otherStart, end: otherStart + otherLines - 1 };

  // Imports now evaluated in another order run their modules' top-level code in another order.
  if (args.outline !== undefined && args.otherOutline !== undefined && !args.outline.hasSyntaxErrors && !args.otherOutline.hasSyntaxErrors) {
    const reachesImport = (outline: ImpactFileOutline, span: Span | undefined): boolean =>
      span !== undefined && outline.statements.some((statement) => loadsModuleStatement(statement) && intersects({ start: statement.startLine, end: statement.endLine }, span));
    if ((reachesImport(args.outline, boundLines === 0 ? undefined : hunkSpan) || reachesImport(args.otherOutline, otherSpan)) && loadOrderChanged(args.outline, args.otherOutline)) {
      const [unitSide, span] = boundLines > 0 || otherSpan === undefined ? [side, hunkSpan] as const : [otherSide, otherSpan] as const;
      args.addUnit({ id: container?.id ?? `module:${boundPath}`, kind: "module_statement", file: boundPath, side: unitSide, lines: [span], declarationKind: "import", behavioral: true });
    }
  }

  // Comments and formatting inside statements: the syntax tree is the same on both sides.
  const formatting = formattingOnlyStatements(args, boundLines === 0 ? undefined : hunkSpan, boundStart, otherSpan, otherStart);
  if (formatting !== undefined) {
    const onBound = boundLines > 0 || otherSpan === undefined;
    const [unitSide, span, statements] = onBound
      ? [side, hunkSpan, formatting.bound] as const
      : [otherSide, otherSpan, formatting.other] as const;
    const covered = new Set<number>();
    const [spanOutline, oppositeOutline] = onBound ? [args.outline, args.otherOutline] : [args.otherOutline, args.outline];
    // An insertion point is no edited line: a marker next to it is not edited.
    const oppositeSpan = onBound ? otherSpan : boundLines > 0 ? hunkSpan : undefined;
    statements.forEach((statement, position) => {
      const { id, kind } = statementId(args, statement);
      const leading = linesIn(span, { start: statement.leadingStartLine, end: statement.startLine - 1 });
      const body = linesIn(span, { start: statement.startLine, end: statement.endLine });
      leading.forEach((line) => covered.add(line));
      body.forEach((line) => covered.add(line));
      const opposite = (onBound ? formatting.other : formatting.bound)[position]!;
      const oppositeLeading = oppositeSpan === undefined ? [] : linesIn(oppositeSpan, { start: opposite.leadingStartLine, end: opposite.startLine - 1 });
      const oppositeBody = oppositeSpan === undefined ? [] : linesIn(oppositeSpan, { start: opposite.startLine, end: opposite.endLine });
      const touchesMarker = markerHit(spanOutline, leading) || markerHit(oppositeOutline, oppositeLeading);
      if (leading.length > 0) args.addUnit({ id, kind: "doc_comment", file: boundPath, side: unitSide, lines: toSpans(leading), names: statement.declaredNames, declarationKind: kind, behavioral: false, touchesMarker });
      if (body.length > 0) {
        args.addUnit({ id, kind: "trivia", file: boundPath, side: unitSide, lines: toSpans(body), names: statement.declaredNames, declarationKind: kind, behavioral: false });
        // A marker edited inside the statement documents a nested declaration.
        if (markerHit(spanOutline, body) || markerHit(oppositeOutline, oppositeBody)) {
          const boundStatement = onBound ? statement : opposite;
          const reference = boundLines > 0 ? Math.max(hunkSpan.start, boundStatement.startLine) : boundStart;
          nestedDocComment(args, reference, unitSide, body);
        }
      }
    });
    const rest = linesIn(span, span).filter((line) => !covered.has(line));
    if (rest.length > 0) args.addUnit({ id: `trivia:${boundPath}`, kind: "trivia", file: boundPath, side: unitSide, lines: toSpans(rest), behavioral: false });
    return;
  }

  const touched = symbols.filter((node) => evidenceSpans(node).some((span) => hunkTouchesRange(hunk, span, side)));
  for (const node of touched) {
    args.addUnit({
      id: node.id,
      kind: "symbol",
      file: boundPath,
      side,
      lines: [hunkSpan],
      names: [node.name],
      declarationKind: node.kind,
      exported: args.exportedFor(node),
      behavioral: true,
      ...(symbolRunsOnLoad(args, node) ? { runsOnLoad: true } : {}),
    });
  }
  // A marker edited inside a symbol, next to code edits, documents a nested declaration (only an
  // outline locates markers; without one the symbol unit stands for the whole edit).
  if (touched.length > 0) {
    const markerAt = (outline: ImpactFileOutline | undefined, line: number): boolean => outline?.markerLines?.includes(line) === true;
    const boundMarkers = boundLines > 0 ? linesIn(hunkSpan, hunkSpan).filter((line) => markerAt(args.outline, line)) : [];
    const otherMarkers = otherSpan === undefined ? [] : linesIn(otherSpan, otherSpan).filter((line) => markerAt(args.otherOutline, line));
    if (boundMarkers.length > 0) nestedDocComment(args, Math.min(...boundMarkers), side, boundMarkers);
    else if (otherMarkers.length > 0) nestedDocComment(args, boundLines > 0 ? hunkSpan.start : boundStart, otherSide, otherMarkers);
  }

  // Lines of the hunk that no touched symbol range covers.
  let residual: number[] = [];
  if (boundLines > 0) {
    const covered = touched.flatMap(evidenceSpans);
    for (let line = hunkSpan.start; line <= hunkSpan.end; line += 1) {
      if (!covered.some((span) => span.start <= line && line <= span.end)) residual.push(line);
    }
  } else if (touched.length === 0) {
    residual = [boundStart];
  }

  if (container !== undefined && FILE_UNIT_KINDS.has(container.kind)) {
    if (residual.length > 0) args.addUnit({ id: container.id, kind: "file", file: boundPath, side, lines: toSpans(residual), declarationKind: container.kind, behavioral: true });
    return;
  }

  const outline = args.outline;
  if (outline === undefined || outline.hasSyntaxErrors) {
    if (residual.length === 0) return;
    args.addUnit({ id: `unclassified:${boundPath}`, kind: "unclassified", file: boundPath, side, lines: toSpans(residual), behavioral: true });
    args.gap({
      code: "CHANGE_NOT_CLASSIFIED",
      scope: "file",
      file: boundPath,
      affects: "reach",
      detail: outline === undefined
        ? "lines outside every indexed symbol, in a language without a top-level outline"
        : "lines outside every indexed symbol, in a file whose outline has syntax errors",
    });
    return;
  }

  if (boundLines === 0) {
    if (residual.length === 0) return;
    const point = boundStart;
    const enclosing = outline.statements.find((statement) => statement.startLine <= point && point < statement.endLine);
    if (enclosing !== undefined) {
      classifyStatement(args, enclosing, side, [{ start: point, end: point }], outline);
      return;
    }
    // Text that exists only on the other side: added (old bound) or removed (new bound).
    if (otherSpan === undefined) return;
    const otherOutline = args.otherOutline;
    if (otherOutline === undefined || otherOutline.hasSyntaxErrors) {
      notClassifiedOnOtherSide(args, otherSide, otherSpan);
      return;
    }
    classifyOtherSide(args, otherOutline, otherSpan, otherSide, point);
    return;
  }

  const buckets = new Map<ImpactOutlineStatement, number[]>();
  const leading = new Map<ImpactOutlineStatement, number[]>();
  const trivia: number[] = [];
  for (const line of residual) {
    const statement = outline.statements.find((candidate) => candidate.startLine <= line && line <= candidate.endLine);
    if (statement !== undefined) {
      buckets.set(statement, [...(buckets.get(statement) ?? []), line]);
      continue;
    }
    const owner = outline.statements.find((candidate) => candidate.leadingStartLine <= line && line < candidate.startLine);
    if (owner !== undefined) leading.set(owner, [...(leading.get(owner) ?? []), line]);
    else trivia.push(line);
  }
  for (const [statement, lines] of buckets) classifyStatement(args, statement, side, toSpans(lines), outline);
  // A directive comment outside any statement changes how the file compiles or bundles.
  const directives = new Set(outline.directiveLines ?? []);
  const directiveLines = [...leading.values()].flat().concat(trivia).filter((line) => directives.has(line));
  if (directiveLines.length > 0) directiveChanged(args, side, directiveLines);
  for (const [statement, all] of leading) {
    const lines = all.filter((line) => !directives.has(line));
    if (lines.length === 0) continue;
    const { id, kind } = statementId(args, statement);
    const counterpart = counterpartOf(args, statement);
    const touchesMarker = markerHit(outline, lines)
      || (otherSpan !== undefined && markerHit(args.otherOutline, counterpart === undefined ? linesIn(otherSpan, otherSpan) : linesIn(otherSpan, { start: counterpart.leadingStartLine, end: counterpart.startLine - 1 })));
    args.addUnit({ id, kind: "doc_comment", file: boundPath, side, lines: toSpans(lines), names: statement.declaredNames, declarationKind: kind, behavioral: false, touchesMarker });
  }
  const plainTrivia = trivia.filter((line) => !directives.has(line));
  if (plainTrivia.length > 0) {
    args.addUnit({ id: `trivia:${boundPath}`, kind: "trivia", file: boundPath, side, lines: toSpans(plainTrivia), behavioral: false });
  }

  // A replacement hunk: what the other side holds in place of these lines. Text there that is not
  // one of the statements already classified on this side is code that appears or disappears —
  // uncommenting a call, replacing a blank line with a statement — and is never mere trivia.
  if (otherSpan === undefined) return;
  const otherOutline = args.otherOutline;
  if (otherOutline === undefined || otherOutline.hasSyntaxErrors) {
    if (buckets.size === 0 && touched.length === 0) notClassifiedOnOtherSide(args, otherSide, otherSpan);
    return;
  }
  const otherDirectives = new Set(otherOutline.directiveLines ?? []);
  const outsideCode = linesIn(otherSpan, otherSpan).filter((line) =>
    otherDirectives.has(line) && !otherOutline.statements.some((statement) => statement.startLine <= line && line <= statement.endLine));
  if (outsideCode.length > 0) directiveChanged(args, otherSide, outsideCode);
  const boundNames = new Set<string>();
  for (const node of touched) {
    const parsed = parseSymbolId(node.id);
    if (parsed !== undefined) boundNames.add(parsed.scope[0] ?? parsed.name);
  }
  for (const statement of buckets.keys()) statement.declaredNames.forEach((name) => boundNames.add(name));
  const boundSpecifiers = new Set([...buckets.keys()].flatMap((statement) => (statement.kind === "import" && statement.moduleSpecifier !== undefined ? [statement.moduleSpecifier] : [])));
  const boundRunsModule = [...buckets.keys()].some((statement) => statement.kind === "statement" || statement.sideEffectImport === true);
  for (const statement of otherOutline.statements) {
    const lines = linesIn(otherSpan, { start: statement.startLine, end: statement.endLine });
    if (lines.length === 0) continue;
    if (statement.declaredNames.length > 0 && statement.declaredNames.every((name) => boundNames.has(name))) continue;
    if (statement.kind === "import" && statement.moduleSpecifier !== undefined && boundSpecifiers.has(statement.moduleSpecifier)) continue;
    if ((statement.kind === "statement" || statement.sideEffectImport === true) && boundRunsModule) continue;
    classifyOtherStatement(args, statement, toSpans(lines), otherSide, otherOutline, otherSpan, hunkSpan);
  }
}

/**
 * A comment edited inside an indexed symbol, before bound line `reference`'s first following
 * nested declaration, documents that declaration: its markers are anchored to it, not to the
 * enclosing symbol.
 */
function nestedDocComment(args: AttributeHunkArgs, reference: number, side: "old" | "new", lines: readonly number[]): void {
  const pathOf = (node: RepositoryNode): string[] | undefined => {
    const parsed = parseSymbolId(node.id);
    return parsed === undefined ? undefined : [...parsed.scope, parsed.name];
  };
  const firstLine = (node: RepositoryNode): number => Math.min(...evidenceSpans(node).map((span) => span.start));
  let enclosing: { node: RepositoryNode; path: string[] } | undefined;
  for (const node of args.symbols) {
    const path = pathOf(node);
    if (path === undefined || !evidenceSpans(node).some((span) => span.start <= reference && reference <= span.end)) continue;
    if (enclosing === undefined || path.length > enclosing.path.length) enclosing = { node, path };
  }
  if (enclosing === undefined) return;
  const parent = enclosing.path.join("\0");
  let documented: RepositoryNode | undefined;
  for (const node of args.symbols) {
    const path = pathOf(node);
    if (path === undefined || path.slice(0, -1).join("\0") !== parent || firstLine(node) <= reference) continue;
    if (documented === undefined || firstLine(node) < firstLine(documented)) documented = node;
  }
  if (documented === undefined) return;
  args.addUnit({ id: documented.id, kind: "doc_comment", file: args.boundPath, side, lines: toSpans(lines), names: [documented.name], declarationKind: documented.kind, behavioral: false, touchesMarker: true });
}

/** Whether `lines` hold a marker; an outline that does not say is assumed to. */
function markerHit(outline: ImpactFileOutline | undefined, lines: readonly number[]): boolean {
  if (lines.length === 0) return false;
  if (outline?.markerLines === undefined) return true;
  return lines.some((line) => outline.markerLines!.includes(line));
}

/** A directive comment changed outside any statement: its effect on the file is not modeled. */
function directiveChanged(args: AttributeHunkArgs, side: "old" | "new", lines: readonly number[]): void {
  args.addUnit({ id: `unclassified:${args.boundPath}`, kind: "unclassified", file: args.boundPath, side, lines: toSpans(lines), behavioral: true });
  args.gap({ code: "CHANGE_NOT_CLASSIFIED", scope: "file", file: args.boundPath, affects: "reach", detail: "a compiler or bundler directive comment changed outside any statement: its effect on the file is not modeled" });
}

function notClassifiedOnOtherSide(args: AttributeHunkArgs, otherSide: "old" | "new", span: Span): void {
  args.addUnit({ id: `unclassified:${args.boundPath}`, kind: "unclassified", file: args.boundPath, side: otherSide, lines: [span], behavioral: true });
  args.gap({ code: "CHANGE_NOT_CLASSIFIED", scope: "file", file: args.boundPath, affects: "reach", detail: `${otherSide === "new" ? "inserted" : "removed"} text could not be outlined` });
}

/** A top-level class, enum or namespace symbol whose own evaluation runs code when its module loads. */
function symbolRunsOnLoad(args: AttributeHunkArgs, node: RepositoryNode): boolean {
  const parsed = parseSymbolId(node.id);
  if (parsed === undefined || parsed.scope.length > 0 || args.outline === undefined) return false;
  const statement = args.outline.statements.find((candidate) => candidate.declaredNames.includes(parsed.name));
  return statement !== undefined && LOAD_TIME_KINDS.has(statement.kind) && runsOnLoad(statement);
}

function declarationId(path: string, statement: ImpactOutlineStatement): string {
  return `decl:${path}:${statement.declaredNames[0] ?? `${statement.kind}@${statement.startLine}`}`;
}

/** The statement on the other side that declares the same names, if any. */
function counterpartOf(args: AttributeHunkArgs, statement: ImpactOutlineStatement): ImpactOutlineStatement | undefined {
  if (statement.declaredNames.length === 0 || args.otherOutline === undefined) return undefined;
  return args.otherOutline.statements.find((candidate) => candidate.kind === statement.kind && sameNames(candidate, statement));
}

function classifyStatement(
  args: AttributeHunkArgs,
  statement: ImpactOutlineStatement,
  side: "old" | "new",
  lines: Span[],
  outline: ImpactFileOutline,
): void {
  const { boundPath, container } = args;
  if (statement.kind === "statement" || statement.sideEffectImport === true) {
    args.addUnit({ id: container?.id ?? `module:${boundPath}`, kind: "module_statement", file: boundPath, side, lines, declarationKind: statement.kind, behavioral: true });
    return;
  }
  if (statement.kind === "import" && statement.importBindings !== undefined && args.otherOutline !== undefined && !args.otherOutline.hasSyntaxErrors) {
    classifyImport(args, statement, side, lines, args.otherOutline);
    return;
  }
  const counterpart = counterpartOf(args, statement);
  const onLoad = LOAD_TIME_KINDS.has(statement.kind) && (runsOnLoad(statement) || (counterpart !== undefined && runsOnLoad(counterpart)));
  const nodes = statement.declaredNames.flatMap((name) => args.byName.get(name) ?? []);
  if (nodes.length > 0) {
    for (const node of nodes) {
      args.addUnit({ id: node.id, kind: "symbol", file: boundPath, side, lines, names: [node.name], declarationKind: node.kind, exported: args.exportedFor(node), behavioral: true, ...(onLoad ? { runsOnLoad: true } : {}) });
    }
    return;
  }
  const exportedNames = new Set(outline.exportedNames);
  const exported = statement.kind === "export" || statement.declaredNames.some((name) => exportedNames.has(name));
  args.addUnit({
    id: declarationId(boundPath, statement),
    kind: "declaration",
    file: boundPath,
    side,
    lines,
    names: statement.declaredNames,
    declarationKind: statement.kind,
    exported,
    behavioral: true,
    ...(onLoad ? { runsOnLoad: true } : {}),
  });
}

/**
 * An edited import changes only the bindings it no longer holds, or holds from elsewhere. Bindings
 * the other side adds cannot be depended on by code indexed before them.
 */
function classifyImport(
  args: AttributeHunkArgs,
  statement: ImpactOutlineStatement,
  side: "old" | "new",
  lines: Span[],
  otherOutline: ImpactFileOutline,
): void {
  const key = (binding: { local: string; imported: string; typeOnly: boolean }): string => `${binding.local}\0${binding.imported}\0${String(binding.typeOnly)}`;
  const mine = statement.importBindings ?? [];
  const theirs = otherOutline.statements
    .filter((candidate) => candidate.kind === "import" && candidate.moduleSpecifier === statement.moduleSpecifier)
    .flatMap((candidate) => candidate.importBindings ?? []);
  const theirKeys = new Set(theirs.map(key));
  const myKeys = new Set(mine.map(key));
  const changed = mine.filter((binding) => !theirKeys.has(key(binding))).map((binding) => binding.local);
  const appeared = theirs.filter((binding) => !myKeys.has(key(binding))).map((binding) => binding.local);
  const id = declarationId(args.boundPath, statement);
  // `import type` becoming a value import (or the reverse) starts or stops loading the module.
  if (statement.moduleSpecifier !== undefined && moduleLoadStatus(args.outline, statement.moduleSpecifier) !== moduleLoadStatus(otherOutline, statement.moduleSpecifier)) {
    args.addUnit({ id: args.container?.id ?? `module:${args.boundPath}`, kind: "module_statement", file: args.boundPath, side, lines, declarationKind: "import", behavioral: true });
  }
  if (changed.length === 0 && appeared.length === 0) {
    args.addUnit({ id, kind: "trivia", file: args.boundPath, side, lines, names: statement.declaredNames, declarationKind: "import", behavioral: false });
    return;
  }
  if (changed.length > 0) {
    args.addUnit({ id, kind: "declaration", file: args.boundPath, side, lines, names: changed, declarationKind: "import", exported: changed.some((name) => new Set(args.outline?.exportedNames ?? []).has(name)), behavioral: true });
  }
  if (appeared.length > 0) {
    const otherSide = side === "old" ? "new" : "old";
    // Inert unless code on this side reads one of these names as a global the binding now shadows
    // (or, for a binding the other side no longer holds, falls back to).
    const rebinds = readsAsFree(args.outline, appeared).length > 0;
    args.addUnit({ id, kind: otherSide === "new" ? "added_declaration" : "removed_declaration", file: args.boundPath, side, lines, names: appeared, declarationKind: "import", exported: false, behavioral: rebinds });
  }
}

/**
 * Names that code in `outline` reads without the file declaring them: a declaration appearing or
 * disappearing under one of them changes what that code reads (the global it now shadows, or the
 * global it falls back to). References are by identifier text, so this over-approximates.
 */
function readsAsFree(outline: ImpactFileOutline | undefined, names: readonly string[]): string[] {
  if (outline === undefined || names.length === 0) return [];
  const declared = new Set(outline.statements.flatMap((statement) => statement.declaredNames));
  return names.filter((name) => !declared.has(name) && outline.statements.some((statement) => statement.referencedNames.includes(name)));
}

function classifyOtherSide(
  args: AttributeHunkArgs,
  otherOutline: ImpactFileOutline,
  span: Span,
  otherSide: "old" | "new",
  boundPoint: number,
): void {
  const { boundPath } = args;
  const trivia: number[] = [];
  const statements = new Map<ImpactOutlineStatement, number[]>();
  for (let line = span.start; line <= span.end; line += 1) {
    const statement = otherOutline.statements.find((candidate) => candidate.startLine <= line && line <= candidate.endLine);
    if (statement === undefined) trivia.push(line);
    else statements.set(statement, [...(statements.get(statement) ?? []), line]);
  }
  for (const [statement, lines] of statements) {
    classifyOtherStatement(args, statement, toSpans(lines), otherSide, otherOutline, span, { start: boundPoint, end: boundPoint });
  }
  const directives = new Set(otherOutline.directiveLines ?? []);
  const directiveLines = trivia.filter((line) => directives.has(line));
  if (directiveLines.length > 0) directiveChanged(args, otherSide, directiveLines);
  const plain = trivia.filter((line) => !directives.has(line));
  if (plain.length > 0) {
    args.addUnit({ id: `trivia:${boundPath}`, kind: "trivia", file: boundPath, side: otherSide, lines: toSpans(plain), behavioral: false });
  }
}

/**
 * A statement of the other side that the hunk touches. When it reaches beyond the hunk it existed on
 * both sides, so this is an edit of it (a decorator, a continuation line), not new or vanished code.
 */
function classifyOtherStatement(
  args: AttributeHunkArgs,
  statement: ImpactOutlineStatement,
  lines: Span[],
  otherSide: "old" | "new",
  otherOutline: ImpactFileOutline,
  otherSpan: Span,
  boundAnchor: Span,
): void {
  const outline = args.outline;
  if (outline !== undefined && (statement.startLine < otherSpan.start || statement.endLine > otherSpan.end)) {
    const counterpart = outline.statements.find((candidate) =>
      candidate.kind === statement.kind
      && (statement.declaredNames.length > 0
        ? sameNames(candidate, statement)
        : candidate.startLine <= boundAnchor.end + 1 && boundAnchor.start - 1 <= candidate.endLine));
    if (counterpart !== undefined) {
      classifyStatement(args, counterpart, otherSide === "new" ? "old" : "new", [boundAnchor], outline);
      return;
    }
  }
  classifyAppearedStatement(args, statement, lines, otherSide, otherOutline);
}

/**
 * A statement present on one side only. Added code is inert only when evaluating it runs nothing
 * at load, it merges with nothing that already existed, it cannot shadow a re-exported name, and it
 * exports no value from a module another one reads whole; removed code matters when it was
 * exported or ran at load.
 */
function classifyAppearedStatement(
  args: AttributeHunkArgs,
  statement: ImpactOutlineStatement,
  lines: Span[],
  otherSide: "old" | "new",
  otherOutline: ImpactFileOutline,
): void {
  const { boundPath, container } = args;
  if (statement.kind === "statement" || statement.sideEffectImport === true) {
    args.addUnit({ id: container?.id ?? `module:${boundPath}`, kind: "module_statement", file: boundPath, side: otherSide, lines, declarationKind: statement.kind, behavioral: true });
    return;
  }
  const removed = otherSide === "old";
  const exported = statement.kind === "export" || statement.declaredNames.some((name) => otherOutline.exportedNames.includes(name));
  const boundStatements = args.outline?.statements ?? [];
  // Existing code reading one of its names as a global now reads this declaration (or, once it is
  // removed, the global again).
  const rebinds = readsAsFree(args.outline, statement.declaredNames).length > 0;
  let onLoad: boolean;
  let behavioral: boolean;
  if (statement.kind === "import") {
    // Loading a module the file did not surely load before (or no longer loads) runs its top-level code.
    onLoad = statement.moduleSpecifier === undefined
      ? loadsOf(statement) > 0
      : moduleLoadStatus(otherOutline, statement.moduleSpecifier) !== moduleLoadStatus(args.outline, statement.moduleSpecifier);
    behavioral = onLoad || rebinds;
  } else {
    onLoad = LOAD_TIME_KINDS.has(statement.kind) && runsOnLoad(statement);
    const merges = boundStatements.some((candidate) => candidate.declaredNames.some((name) => statement.declaredNames.includes(name)));
    const shadowsReexport = exported && boundStatements.some((candidate) => candidate.kind === "export" && candidate.moduleSpecifier !== undefined);
    // A module reading this one whole (`Object.keys(ns)`, `ns[name]`) sees a new value export.
    const seenWhole = exported && !TYPE_ONLY_KINDS.has(statement.kind) && args.readWhole;
    behavioral = statement.kind === "export" || onLoad || merges || rebinds || (removed ? exported : shadowsReexport || seenWhole);
  }
  args.addUnit({
    id: declarationId(boundPath, statement),
    kind: removed ? "removed_declaration" : "added_declaration",
    file: boundPath,
    side: otherSide,
    lines,
    names: statement.declaredNames,
    declarationKind: statement.kind,
    exported,
    behavioral,
    ...(onLoad ? { runsOnLoad: true } : {}),
  });
}

interface SameFileArgs {
  path: string;
  context: { container: RepositoryNode | undefined; symbols: RepositoryNode[]; outline: ImpactFileOutline };
  units: readonly UnitDraft[];
  byName: ReadonlyMap<string, RepositoryNode[]>;
  changedNodeIds: ReadonlySet<string>;
  addTarget: (draft: TargetDraft) => boolean;
  nodeTarget: (node: RepositoryNode, tier: TargetDraft["tier"], distance: number, reason: string, via: ImpactStep[]) => TargetDraft;
  declarationTargets: Map<string, { file: string; name: string; exported: boolean | null; via: ImpactStep[] }>;
}

function tierAt(distance: number): TargetDraft["tier"] {
  return distance <= 1 ? "direct" : "transitive";
}

function referenceReason(distance: number): string {
  return distance <= 1 ? "REFERENCES_CHANGED_DECLARATION" : "REFERENCES_AFFECTED_DECLARATION";
}

function propagateSameFile(args: SameFileArgs): void {
  const { path, context, byName } = args;
  const outline = context.outline;
  const exportedNames = new Set(outline.exportedNames);
  // name -> id of the changed unit it stands for, plus the path that made it changed.
  const changed = new Map<string, { id: string; via: ImpactStep[] }>();
  for (const unit of args.units) {
    if (!unit.behavioral || unit.file !== path) continue;
    if (unit.kind === "symbol") {
      const parsed = parseSymbolId(unit.id);
      if (parsed !== undefined && parsed.scope.length === 0) changed.set(parsed.name, { id: unit.id, via: [] });
    } else if (unit.kind === "declaration") {
      for (const name of unit.names) changed.set(name, { id: unit.id, via: [] });
    } else if (unit.kind === "added_declaration" || unit.kind === "removed_declaration") {
      // Only the names this side reads as globals: those reads now resolve elsewhere.
      for (const name of readsAsFree(outline, [...unit.names])) if (!changed.has(name)) changed.set(name, { id: unit.id, via: [] });
    }
  }
  if (changed.size === 0) return;

  const nodeBearing = (statement: ImpactOutlineStatement): RepositoryNode[] =>
    statement.declaredNames.flatMap((name) => byName.get(name) ?? []);
  const referenced = (statement: ImpactOutlineStatement): string | undefined =>
    [...statement.referencedNames].sort(compareIds).find((name) => changed.has(name));

  // Declarations without a node that derive from a changed binding change with it.
  let grew = true;
  while (grew) {
    grew = false;
    for (const statement of outline.statements) {
      if (statement.kind !== "variable" || nodeBearing(statement).length > 0) continue;
      if (statement.declaredNames.every((name) => changed.has(name))) continue;
      const source = referenced(statement);
      if (source === undefined) continue;
      const origin = changed.get(source)!;
      for (const name of statement.declaredNames) {
        if (changed.has(name)) continue;
        const id = `decl:${path}:${name}`;
        const via = [...origin.via, { relation: "referenced_by" as const, from: origin.id, to: id }];
        changed.set(name, { id, via });
        args.declarationTargets.set(id, { file: path, name, exported: exportedNames.has(name), via });
        grew = true;
      }
    }
  }

  for (const statement of outline.statements) {
    const source = referenced(statement);
    if (source === undefined) continue;
    const origin = changed.get(source)!;
    if (statement.kind === "statement") {
      if (context.container === undefined || args.changedNodeIds.has(context.container.id)) continue;
      const distance = origin.via.length + 1;
      args.addTarget(args.nodeTarget(context.container, tierAt(distance), distance, referenceReason(distance), [
        ...origin.via,
        { relation: "referenced_by", from: origin.id, to: context.container.id },
      ]));
      continue;
    }
    for (const node of nodeBearing(statement)) {
      if (args.changedNodeIds.has(node.id) || node.id === origin.id) continue;
      const distance = origin.via.length + 1;
      args.addTarget(args.nodeTarget(node, tierAt(distance), distance, referenceReason(distance), [
        ...origin.via,
        { relation: "referenced_by", from: origin.id, to: node.id },
      ]));
    }
  }
}

function computeMarkerClaims(
  index: GraphIndex,
  exposure: ReadonlyMap<string, ImpactTier>,
  units: readonly ChangeUnit[],
  editsMarker: (unit: ChangeUnit) => boolean,
): ExposedClaim[] {
  const claims = new Map<string, ExposedClaim>();
  const anchor = (claimNode: RepositoryNode, nodeId: string, tier: ImpactTier, relation: string): void => {
    const existing = claims.get(claimNode.id);
    const entry = { nodeId, exposure: tier, relation };
    if (existing === undefined) {
      const statement = claimNode.metadata["statement"];
      claims.set(claimNode.id, {
        id: claimNode.id,
        source: "marker",
        kind: claimNode.kind,
        ...(typeof statement === "string" ? { statement } : {}),
        tags: [...claimNode.tags].sort(compareIds),
        exposure: tier,
        anchors: [entry],
      });
      return;
    }
    existing.exposure = strongest(existing.exposure, tier);
    if (!existing.anchors.some((item) => item.nodeId === nodeId && item.relation === relation)) existing.anchors.push(entry);
  };
  const markerTargets = (nodeId: string): { node: RepositoryNode; relation: string }[] => {
    const out: { node: RepositoryNode; relation: string }[] = [];
    for (const edge of index.outEdges(nodeId, ["constrained_by", "implements_capability", "related_to", "declares"])) {
      const target = index.node(edge.to);
      if (target === undefined) continue;
      if (edge.kind === "declares" && target.kind !== "contract") continue;
      if (!["invariant", "capability", "contract", "risk"].includes(target.kind)) continue;
      out.push({ node: target, relation: edge.kind });
    }
    return out;
  };
  for (const [nodeId, tier] of [...exposure].sort((a, b) => compareIds(a[0], b[0]))) {
    const node = index.node(nodeId);
    if (node === undefined) continue;
    if (node.kind === "document" || node.kind === "migration") {
      // A changed document or migration re-states its claims; its body edit is not proof that the
      // claim changed, so the exposure is capped at `possible`.
      const kinds = node.kind === "document" ? (["documents"] as const) : (["related_to"] as const);
      for (const edge of index.outEdges(nodeId, [...kinds])) {
        const target = index.node(edge.to);
        if (target === undefined || !["invariant", "capability"].includes(target.kind)) continue;
        anchor(target, nodeId, "possible", edge.kind);
      }
      continue;
    }
    for (const { node: target, relation } of markerTargets(nodeId)) anchor(target, nodeId, tier, relation);
  }
  // A changed leading comment may have edited the markers themselves: "changed" when the edit
  // reaches a marker line on either side, else "possible" — prose next to a marker is not the claim.
  for (const unit of units) {
    if (unit.kind !== "doc_comment" || !index.has(unit.id)) continue;
    const tier: ImpactTier = editsMarker(unit) ? "changed" : "possible";
    for (const { node: target } of markerTargets(unit.id)) anchor(target, unit.id, tier, "doc_comment");
  }
  return [...claims.values()]
    .map((claim) => ({ ...claim, anchors: claim.anchors.sort((a, b) => TIER_RANK[a.exposure] - TIER_RANK[b.exposure] || compareIds(a.nodeId, b.nodeId)) }))
    .sort((a, b) => TIER_RANK[a.exposure] - TIER_RANK[b.exposure] || compareIds(a.id, b.id));
}

function surfaceImpacts(
  map: SurfaceMap | null,
  units: readonly ChangeUnit[],
  tiers: { directlyAffected: readonly ImpactTarget[]; transitivelyAffected: readonly ImpactTarget[]; possiblyAffected: readonly ImpactTarget[] },
  complete: boolean,
): SurfaceImpact[] | null {
  if (map === null) return null;
  return map.surfaces.map((surface): SurfaceImpact => {
    const counts = {
      changed: units.filter((unit) => unit.behavioral && (unit.surfaces ?? []).includes(surface.name)).length,
      direct: tiers.directlyAffected.filter((target) => (target.surfaces ?? []).includes(surface.name)).length,
      transitive: tiers.transitivelyAffected.filter((target) => (target.surfaces ?? []).includes(surface.name)).length,
      possible: tiers.possiblyAffected.filter((target) => (target.surfaces ?? []).includes(surface.name)).length,
    };
    const exposure: SurfaceImpact["exposure"] = counts.changed > 0
      ? "changed"
      : counts.direct > 0
        ? "direct"
        : counts.transitive > 0
          ? "transitive"
          : counts.possible > 0
            ? "possible"
            : complete
              ? "not_reached"
              : "unknown";
    return {
      name: surface.name,
      ...(surface.description !== undefined ? { description: surface.description } : {}),
      exposure,
      counts,
    };
  });
}

function computeBlastRadius(args: {
  units: readonly ChangeUnit[];
  known: readonly ImpactTarget[];
  possible: readonly ImpactTarget[];
  possibleOmitted: number;
  packages: readonly ImpactPackage[];
  complete: boolean;
  unresolved: readonly UnresolvedImpact[];
}): BlastRadius {
  const behavioral = args.units.filter((unit) => unit.behavioral);
  const changedFiles = new Set(behavioral.map((unit) => unit.file));
  const knownFiles = new Set(changedFiles);
  for (const target of args.known) if (target.file !== undefined) knownFiles.add(target.file);
  const packagesOf = (paths: Iterable<string>): { identities: Set<string>; unresolved: number } => {
    const identities = new Set<string>();
    let unresolved = 0;
    for (const path of paths) {
      const pkg = packageOf(args.packages, path);
      if (pkg === undefined) unresolved += 1;
      else identities.add(pkg.identity);
    }
    return { identities, unresolved };
  };
  const knownPackages = packagesOf(knownFiles);
  const changedPackages = packagesOf(changedFiles);
  const knownSurfaces = new Set<string>();
  for (const unit of behavioral) for (const surface of unit.surfaces ?? []) knownSurfaces.add(surface);
  for (const target of args.known) for (const surface of target.surfaces ?? []) knownSurfaces.add(surface);
  const possibleFiles = new Set<string>();
  const possibleSurfaces = new Set<string>();
  for (const target of args.possible) {
    if (target.file !== undefined && !knownFiles.has(target.file)) possibleFiles.add(target.file);
    for (const surface of target.surfaces ?? []) possibleSurfaces.add(surface);
  }
  const possiblePackages = packagesOf(possibleFiles);

  let scope: BlastRadius["scope"];
  const rationale: string[] = [];
  if (!args.complete) {
    scope = "unknown";
    rationale.push(...[...new Set(args.unresolved.filter((entry) => entry.affects === "reach").map((entry) => entry.code))].sort(compareIds));
  } else if ([...knownFiles].every((file) => changedFiles.has(file))) {
    scope = "local";
    rationale.push(behavioral.length === 0 ? "NO_BEHAVIORAL_CHANGE" : "WITHIN_CHANGED_FILES");
  } else if (
    knownPackages.unresolved === 0
    && changedPackages.unresolved === 0
    && [...knownPackages.identities].every((identity) => changedPackages.identities.has(identity))
  ) {
    scope = "package";
    rationale.push("WITHIN_CHANGED_PACKAGES");
  } else {
    scope = "repository";
    rationale.push(knownPackages.unresolved > 0 || changedPackages.unresolved > 0 ? "FILES_WITHOUT_PACKAGE_BOUNDARY" : "BEYOND_CHANGED_PACKAGES");
  }
  return {
    scope,
    complete: args.complete,
    known: {
      files: [...knownFiles].sort(compareIds),
      packages: [...knownPackages.identities].sort(compareIds),
      surfaces: [...knownSurfaces].sort(compareIds),
    },
    possible: {
      files: possibleFiles.size,
      packages: [...possiblePackages.identities].sort(compareIds),
      surfaces: [...possibleSurfaces].sort(compareIds),
      omitted: args.possibleOmitted,
    },
    rationale,
  };
}

/** Deduplicate and order gaps deterministically (code, scope, file, node, detail). */
export function sortUnresolved(entries: readonly UnresolvedImpact[]): UnresolvedImpact[] {
  const seen = new Set<string>();
  const out: UnresolvedImpact[] = [];
  for (const entry of entries) {
    const key = `${entry.code}\0${entry.scope}\0${entry.file ?? ""}\0${entry.nodeId ?? ""}\0${entry.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out.sort((a, b) =>
    compareIds(a.code, b.code)
    || compareIds(a.scope, b.scope)
    || compareIds(a.file ?? "", b.file ?? "")
    || compareIds(a.nodeId ?? "", b.nodeId ?? ""));
}
