import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type ts from "typescript";

/**
 * Package-manager links for workspace members that are not installed in this checkout.
 *
 * pnpm, Bun and Yarn link a dependency declared with the `workspace:` protocol to the member's
 * own directory. Without that installed link, TypeScript cannot resolve a configuration such as
 * `"extends": "@scope/config/tsconfig/base.json"`, and every source governed by it fails. The
 * same link is derived here from repository manifests only: the workspace declaration, the
 * dependent's `workspace:` dependency and the member's package name. An installed package,
 * local or hoisted, always keeps precedence, and nothing is linked outside the workspace root,
 * the analyzed root or the repository (`.git`) boundary.
 */

interface WorkspaceDeclaration {
  readonly root: string;
  readonly patterns: readonly string[];
}

interface WorkspaceMembers {
  /** Package name → member directory; `null` marks a name declared by several members. */
  readonly byName: ReadonlyMap<string, string | null>;
  readonly directories: ReadonlySet<string>;
}

/**
 * Derived workspace facts for one analysis pass. Create one per pass and share it between the
 * resolutions of that pass; never keep it across passes, which may observe a changed workspace.
 */
export interface WorkspaceLinkResolver {
  /** Causal reads for freshness only; missing reads are not positive analysis evidence. */
  readonly inputs: Map<string, string | undefined>;
  readonly declarations: Map<string, WorkspaceDeclaration | null>;
  readonly members: Map<string, WorkspaceMembers>;
  readonly links: Map<string, ReadonlyMap<string, string>>;
}

export function createWorkspaceLinkResolver(): WorkspaceLinkResolver {
  return { inputs: new Map(), declarations: new Map(), members: new Map(), links: new Map() };
}

function slash(path: string): string {
  return path.replaceAll("\\", "/");
}

function canonical(path: string): string {
  return slash(resolve(path));
}

function readText(path: string, resolver: WorkspaceLinkResolver): string | undefined {
  let text: string | undefined;
  try {
    text = confinedSyntheticTarget(canonical(dirname(path)), path, undefined) ? readFileSync(path, "utf8") : undefined;
  } catch {
    text = undefined;
  }
  resolver.inputs.set(canonical(path), text);
  return text;
}

function readJsonRecord(path: string, resolver: WorkspaceLinkResolver): Record<string, unknown> | undefined {
  const text = readText(path, resolver);
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(entry => typeof entry === "string") ? value : undefined;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !slash(rel).startsWith("../"));
}

/** A Git boundary is the marker itself, even when its symlink target is missing. */
function hasGitMarker(directory: string): boolean {
  try {
    lstatSync(join(directory, ".git"));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** Synthetic links never follow filesystem links, including an ancestor junction. */
function confinedSyntheticTarget(member: string, candidate: string, boundary: string | undefined): boolean {
  const target = canonical(candidate);
  if (!isWithin(member, target) || (boundary !== undefined && !isWithin(boundary, target))) return false;
  try {
    for (let directory = target; ; directory = canonical(dirname(directory))) {
      if (lstatSync(directory).isSymbolicLink()) return false;
      if (directory === boundary || canonical(dirname(directory)) === directory) break;
    }
    return boundary === undefined || isWithin(canonical(realpathSync.native(boundary)), canonical(realpathSync.native(target)));
  } catch {
    return false;
  }
}

/** Installed package links keep precedence when both the package and read target stay in root. */
function confinedInstalledTarget(root: string, candidate: string): boolean {
  const parts = slash(relative(root, candidate)).split("/");
  if (!isWithin(root, candidate)) return false;
  for (let marker = parts.indexOf("node_modules"); marker >= 0; marker = parts.indexOf("node_modules", marker + 1)) {
    const name = parts[marker + 1];
    if (name === undefined || name.length === 0) continue;
    const nameLength = name.startsWith("@") ? 2 : 1;
    const packageRoot = join(root, ...parts.slice(0, marker + 1 + nameLength));
    try {
      if (isDirectory(packageRoot) && isWithin(root, canonical(realpathSync.native(packageRoot)))
        && isWithin(root, canonical(realpathSync.native(candidate)))) return true;
    } catch { /* Missing and escaped installed inputs are not admitted. */ }
  }
  return false;
}

/** An existing `pnpm-workspace.yaml` is the declaration; without usable `packages` it declares no member. */
function pnpmDeclarationAt(directory: string, resolver: WorkspaceLinkResolver): WorkspaceDeclaration | undefined {
  const pnpm = readText(join(directory, "pnpm-workspace.yaml"), resolver);
  if (pnpm === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(pnpm);
  } catch {
    return { root: directory, patterns: [] };
  }
  const patterns = typeof parsed === "object" && parsed !== null
    ? stringList((parsed as Record<string, unknown>).packages)
    : undefined;
  return { root: directory, patterns: patterns ?? [] };
}

function packageDeclarationAt(directory: string, resolver: WorkspaceLinkResolver): WorkspaceDeclaration | undefined {
  const workspaces = readJsonRecord(join(directory, "package.json"), resolver)?.workspaces;
  const patterns = stringList(workspaces)
    ?? (typeof workspaces === "object" && workspaces !== null
      ? stringList((workspaces as Record<string, unknown>).packages)
      : undefined);
  return patterns === undefined ? undefined : { root: directory, patterns };
}

/** First declaration at or above `start`, without crossing `boundary` or a `.git` marker. */
function searchUpward(
  start: string,
  boundary: string | undefined,
  declarationAt: (directory: string) => WorkspaceDeclaration | undefined,
): WorkspaceDeclaration | undefined {
  for (let directory = start; ;) {
    if (boundary !== undefined && !isWithin(boundary, directory)) return undefined;
    const found = declarationAt(directory);
    if (found !== undefined) return found;
    if (directory === boundary || hasGitMarker(directory)) return undefined;
    const parent = canonical(dirname(directory));
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * The governing workspace declaration: an enclosing `pnpm-workspace.yaml` wins over any nearer
 * `package.json` `workspaces` field, as pnpm ignores the latter; otherwise the nearest one.
 */
function findDeclaration(resolver: WorkspaceLinkResolver, start: string, boundary: string | undefined): WorkspaceDeclaration | undefined {
  const key = `${boundary ?? ""}\0${start}`;
  const cached = resolver.declarations.get(key);
  if (cached !== undefined) return cached ?? undefined;
  const found = searchUpward(start, boundary, directory => pnpmDeclarationAt(directory, resolver))
    ?? searchUpward(start, boundary, directory => packageDeclarationAt(directory, resolver));
  resolver.declarations.set(key, found ?? null);
  return found;
}

/** Workspace patterns are root-relative; `./` prefixes and trailing slashes do not change them. */
function normalizePattern(pattern: string): string {
  return pattern.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
}

/** Like discovery, a nested Git worktree or repository below the workspace root holds no member. */
function insideNestedRepository(root: string, memberPath: string): boolean {
  let directory = root;
  for (const segment of memberPath.split("/")) {
    directory = join(directory, segment);
    if (hasGitMarker(directory)) return true;
  }
  return false;
}

function membersOf(resolver: WorkspaceLinkResolver, declaration: WorkspaceDeclaration): WorkspaceMembers {
  const cached = resolver.members.get(declaration.root);
  if (cached !== undefined) return cached;
  const included = declaration.patterns.filter(pattern => !pattern.startsWith("!")).map(normalizePattern);
  const excluded = declaration.patterns.filter(pattern => pattern.startsWith("!")).map(pattern => new Bun.Glob(normalizePattern(pattern.slice(1))));
  const directories = new Set<string>();
  for (const pattern of included) {
    for (const manifest of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: declaration.root, onlyFiles: true })) {
      const member = canonical(join(declaration.root, dirname(manifest)));
      const memberPath = slash(relative(declaration.root, member));
      // A traversal pattern such as `../outside/*` cannot add a member outside the workspace.
      if (memberPath === "" || !isWithin(declaration.root, member) || memberPath.split("/").includes("node_modules")) continue;
      if (excluded.some(glob => glob.match(memberPath)) || insideNestedRepository(declaration.root, memberPath)) continue;
      directories.add(member);
    }
  }
  const byName = new Map<string, string | null>();
  // The workspace root is itself a workspace package that members can depend on.
  for (const directory of [declaration.root, ...[...directories].sort()]) {
    const name = readJsonRecord(join(directory, "package.json"), resolver)?.name;
    if (typeof name !== "string") continue;
    byName.set(name, byName.has(name) ? null : directory);
  }
  const members = { byName, directories };
  resolver.members.set(declaration.root, members);
  return members;
}

// A peer dependency is installed only conditionally (e.g. pnpm `autoInstallPeers: false`): no link.
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

/** Ranges declared through `workspace:`, by name; aliases (`workspace:name@range`) and paths are excluded. */
function workspaceDependencies(directory: string, resolver: WorkspaceLinkResolver): ReadonlyMap<string, string> {
  const manifest = readJsonRecord(join(directory, "package.json"), resolver);
  const ranges = new Map<string, string>();
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest?.[field];
    if (typeof dependencies !== "object" || dependencies === null) continue;
    for (const [name, specifier] of Object.entries(dependencies)) {
      const match = typeof specifier === "string" ? /^workspace:([^@/\\]*)$/.exec(specifier) : null;
      if (match?.[1] !== undefined) ranges.set(name, match[1].trim());
    }
  }
  return ranges;
}

const COMPARATOR = /^(?:[<>]=?|=|\^|~)?v?(?:0|[1-9]\d*|[xX*])(?:\.(?:0|[1-9]\d*|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** A conservative semver range grammar; a range outside it is not linked. */
function isSemverRange(range: string): boolean {
  return range.split("||").every((set) => {
    const parts = set.trim().split(/\s+/).filter(part => part.length > 0);
    if (parts.length === 3 && parts[1] === "-") return COMPARATOR.test(parts[0]!) && COMPARATOR.test(parts[2]!);
    return parts.length > 0 && parts.every(part => COMPARATOR.test(part));
  });
}

/** pnpm links a `workspace:` dependency only when the member's version satisfies its range. */
function satisfiesWorkspaceRange(member: string, range: string, resolver: WorkspaceLinkResolver): boolean {
  if (range === "" || range === "*" || range === "^" || range === "~") return true;
  // Comparator whitespace is valid semver syntax; keep aliases and other unsupported
  // grammar excluded by the same conservative range check after normalization.
  const normalizedRange = range.replace(/([<>]=?|[=^~])\s+(?=v?(?:\d|[xX*]))/g, "$1");
  const version = readJsonRecord(join(member, "package.json"), resolver)?.version;
  return typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version)
    && isSemverRange(normalizedRange) && Bun.semver.satisfies(version, normalizedRange);
}

/** Whether Node resolution from `directory` reaches an installed `name`, locally or hoisted. */
function installedFrom(directory: string, name: string): boolean {
  for (let current = directory; ; current = canonical(dirname(current))) {
    if (isDirectory(join(current, "node_modules", name))) return true;
    if (canonical(dirname(current)) === current) return false;
  }
}

function linksAt(resolver: WorkspaceLinkResolver, directory: string, boundary: string | undefined): ReadonlyMap<string, string> {
  const key = `${boundary ?? ""}\0${directory}`;
  const cached = resolver.links.get(key);
  if (cached !== undefined) return cached;
  const links = new Map<string, string>();
  if (boundary !== undefined && !isWithin(boundary, directory)) {
    resolver.inputs.set(canonical(join(directory, "package.json")), undefined);
    resolver.links.set(key, links);
    return links;
  }
  const dependencies = workspaceDependencies(directory, resolver);
  const declaration = dependencies.size === 0 ? undefined : findDeclaration(resolver, directory, boundary);
  if (declaration !== undefined) {
    const members = membersOf(resolver, declaration);
    const isMember = directory === declaration.root || members.directories.has(directory);
    const names = isMember ? [...dependencies.keys()].sort() : [];
    for (const name of names) {
      const member = members.byName.get(name);
      if (member === undefined || member === null || installedFrom(directory, name)) continue;
      if (!satisfiesWorkspaceRange(member, dependencies.get(name)!, resolver)) continue;
      if (boundary !== undefined && !isWithin(boundary, member)) continue;
      links.set(name, member);
    }
  }
  resolver.links.set(key, links);
  return links;
}

/**
 * Wrap a compiler system so `<dir>/node_modules/<member>/...` reads the member directory when
 * `<dir>` is the workspace root or a member that declares `<member>` as a `workspace:` dependency
 * and Node resolution from `<dir>` finds no installed package of that name. `boundary` (the
 * analyzed repository root) confines every link.
 */
export function workspaceLinkedSystem(
  system: ts.System,
  boundary?: string,
  resolver: WorkspaceLinkResolver = createWorkspaceLinkResolver(),
): ts.System {
  const confinedBoundary = boundary === undefined ? undefined : canonical(boundary);

  /** Map one path through a workspace link, or `undefined` when no link applies. */
  const linked = (path: string): string | undefined => {
    const normalized = slash(path);
    // Any `node_modules` segment may be the linking one, e.g. when the repository itself sits below
    // an ancestor named `node_modules`: the first directory that declares the name decides.
    for (let marker = normalized.indexOf("/node_modules/"); marker > 0; marker = normalized.indexOf("/node_modules/", marker + 1)) {
      const segments = normalized.slice(marker + "/node_modules/".length).split("/");
      const nameLength = segments[0]?.startsWith("@") ? 2 : 1;
      if (segments.length < nameLength || segments.slice(0, nameLength).some(segment => segment.length === 0)) continue;
      const member = linksAt(resolver, canonical(normalized.slice(0, marker)), confinedBoundary).get(segments.slice(0, nameLength).join("/"));
      if (member === undefined) continue;
      const rest = segments.slice(nameLength);
      const target = rest.length === 0 ? member : `${member}/${rest.join("/")}`;
      if (confinedSyntheticTarget(member, target, confinedBoundary)) return target;
      resolver.inputs.set(canonical(target), undefined);
      return undefined;
    }
    return undefined;
  };

  // TypeScript resolves relative extends from the member's physical configuration path.
  // Those subsequent direct reads must retain the synthetic link's confinement too.
  const allowedDirect = (path: string, reading = false): boolean => {
    const normalized = canonical(path);
    const root = confinedBoundary ?? [...resolver.declarations.values()].find(declaration => declaration !== null)?.root;
    // Apply the repository boundary before either existing reads or virtual probes.
    if (root !== undefined && !isWithin(root, normalized)) {
      resolver.inputs.set(normalized, undefined);
      return false;
    }
    if (![...resolver.links.values()].some(links => links.size > 0)
      || (reading && slash(path).endsWith("/tsconfig.json") && system.fileExists(path))) {
      if (!reading || root === undefined) return true;
      // Initial configurations can have ordinary in-root aliases, but their real bytes
      // must be confined before a read even when no workspace link has been observed.
      try {
        if (isWithin(canonical(realpathSync.native(root)), canonical(realpathSync.native(normalized)))) return true;
      } catch { /* An unreadable initial input is not admitted. */ }
      resolver.inputs.set(normalized, undefined);
      return false;
    }
    if (root === undefined) return false;
    // Missing node_modules paths may be virtual workspace probes. Existing physical
    // configurations, including installed ones, retain precedence but must be confined.
    if (slash(relative(root, normalized)).split("/").includes("node_modules")
      && !system.fileExists(path) && !(system.directoryExists?.(path) ?? false)) return true;
    if (confinedInstalledTarget(root, normalized)) return true;
    if (confinedSyntheticTarget(root, normalized, root)) return true;
    resolver.inputs.set(normalized, undefined);
    return false;
  };
  const installed = (path: string): boolean => allowedDirect(path) && (system.fileExists(path) || (system.directoryExists?.(path) ?? false));

  return {
    ...system,
    fileExists: path => {
      // Keep the closest present configuration visible so a refused read becomes an
      // invalid configuration, rather than falling back to a parent/default config.
      if (confinedBoundary !== undefined && isWithin(confinedBoundary, canonical(path))
        && slash(path).endsWith("/tsconfig.json") && system.fileExists(path)) return true;
      if (!allowedDirect(path)) return false;
      if (system.fileExists(path)) return true;
      const target = linked(path);
      return target !== undefined && system.fileExists(target);
    },
    readFile: (path, encoding) => {
      if (!allowedDirect(path, true)) { resolver.inputs.set(canonical(path), undefined); return undefined; }
      const target = system.fileExists(path) ? path : linked(path);
      const content = target === undefined ? undefined : system.readFile(target, encoding);
      resolver.inputs.set(canonical(target ?? path), content);
      return content;
    },
    directoryExists: path => {
      if (!allowedDirect(path)) return false;
      if (system.directoryExists?.(path) ?? false) return true;
      const normalized = slash(path);
      if (normalized.endsWith("/node_modules")) {
        return linksAt(resolver, canonical(normalized.slice(0, -"/node_modules".length)), confinedBoundary).size > 0;
      }
      const target = linked(path);
      return target !== undefined && (system.directoryExists?.(target) ?? false);
    },
    realpath: path => {
      if (!allowedDirect(path, true)) return path;
      const target = installed(path) ? undefined : linked(path);
      const resolved = target ?? path;
      return system.realpath === undefined ? resolved : system.realpath(resolved);
    },
  };
}
