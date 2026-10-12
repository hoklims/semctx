import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import type ts from "typescript";

/**
 * Package-manager links for workspace members that are not installed in this checkout.
 *
 * pnpm, Bun and Yarn link a dependency declared with the `workspace:` protocol to the member's
 * own directory. Without that installed link, TypeScript cannot resolve a configuration such as
 * `"extends": "@scope/config/tsconfig/base.json"`, and every source governed by it fails. The
 * same link is derived here from repository manifests only: the workspace declaration, the
 * dependent's `workspace:` dependency and the member's package name. An installed path always
 * keeps precedence, and nothing is linked across the repository (`.git`) boundary.
 */

interface WorkspaceDeclaration {
  readonly root: string;
  readonly source: string;
  readonly patterns: readonly string[];
}

interface WorkspaceMembers {
  readonly source: string;
  /** Package name → member directory; `null` marks a name declared by several members. */
  readonly byName: ReadonlyMap<string, string | null>;
  readonly directories: ReadonlySet<string>;
}

/** Derived member maps, revalidated against the live declaration and member manifests on use. */
const membersByWorkspaceRoot = new Map<string, WorkspaceMembers>();

function slash(path: string): string {
  return path.replaceAll("\\", "/");
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function readJsonRecord(path: string): Record<string, unknown> | undefined {
  const text = readText(path);
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(entry => typeof entry === "string") ? value : undefined;
}

function declarationAt(directory: string): WorkspaceDeclaration | undefined {
  const pnpm = readText(join(directory, "pnpm-workspace.yaml"));
  if (pnpm !== undefined) {
    let parsed: unknown;
    try {
      parsed = Bun.YAML.parse(pnpm);
    } catch {
      return undefined;
    }
    const patterns = typeof parsed === "object" && parsed !== null
      ? stringList((parsed as Record<string, unknown>).packages)
      : undefined;
    return patterns === undefined ? undefined : { root: directory, source: `pnpm\0${pnpm}`, patterns };
  }
  const manifestText = readText(join(directory, "package.json"));
  if (manifestText === undefined) return undefined;
  const manifest = readJsonRecord(join(directory, "package.json"));
  const workspaces = manifest?.workspaces;
  const patterns = stringList(workspaces)
    ?? (typeof workspaces === "object" && workspaces !== null
      ? stringList((workspaces as Record<string, unknown>).packages)
      : undefined);
  return patterns === undefined ? undefined : { root: directory, source: `package\0${manifestText}`, patterns };
}

/** Nearest workspace declaration at or above `start`, without crossing `boundary` or a `.git` marker. */
function findDeclaration(start: string, boundary: string | undefined): WorkspaceDeclaration | undefined {
  let directory = start;
  for (;;) {
    if (boundary !== undefined && !isWithin(boundary, directory)) return undefined;
    const declaration = declarationAt(directory);
    if (declaration !== undefined) return declaration;
    if (directory === boundary || existsSync(join(directory, ".git"))) return undefined;
    const parent = slash(dirname(directory));
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !slash(rel).startsWith("../"));
}

function buildMembers(declaration: WorkspaceDeclaration): WorkspaceMembers {
  const included = declaration.patterns.filter(pattern => !pattern.startsWith("!")).map(pattern => pattern.replace(/\/+$/, ""));
  const excluded = declaration.patterns.filter(pattern => pattern.startsWith("!")).map(pattern => new Bun.Glob(pattern.slice(1).replace(/\/+$/, "")));
  const directories = new Set<string>();
  for (const pattern of included) {
    for (const manifest of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: declaration.root, onlyFiles: true })) {
      const member = slash(dirname(slash(manifest)));
      if (member.split("/").includes("node_modules") || excluded.some(glob => glob.match(member))) continue;
      directories.add(`${declaration.root}/${member}`);
    }
  }
  const byName = new Map<string, string | null>();
  for (const directory of [...directories].sort()) {
    const name = readJsonRecord(join(directory, "package.json"))?.name;
    if (typeof name !== "string") continue;
    byName.set(name, byName.has(name) ? null : directory);
  }
  return { source: declaration.source, byName, directories };
}

function membersOf(declaration: WorkspaceDeclaration, refresh = false): WorkspaceMembers {
  const cached = membersByWorkspaceRoot.get(declaration.root);
  if (!refresh && cached !== undefined && cached.source === declaration.source) return cached;
  const members = buildMembers(declaration);
  membersByWorkspaceRoot.set(declaration.root, members);
  return members;
}

/** The member directory for `name`, after confirming its manifest still declares that name. */
function memberDirectory(declaration: WorkspaceDeclaration, name: string): string | undefined {
  for (const refresh of [false, true]) {
    const directory = membersOf(declaration, refresh).byName.get(name);
    if (directory === null) return undefined;
    if (directory !== undefined && readJsonRecord(join(directory, "package.json"))?.name === name) return directory;
  }
  return undefined;
}

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

/** Names the manifest at `directory` declares through a plain `workspace:` range (aliases excluded). */
function workspaceDependencies(directory: string): ReadonlySet<string> {
  const manifest = readJsonRecord(join(directory, "package.json"));
  const names = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest?.[field];
    if (typeof dependencies !== "object" || dependencies === null) continue;
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (typeof specifier === "string" && /^workspace:(?:\*|\^|~|[\^~]?\d[^@/\\]*)?$/.test(specifier)) names.add(name);
    }
  }
  return names;
}

/**
 * Wrap a compiler system so `<dir>/node_modules/<member>/...` reads the member directory when
 * `<dir>` is the workspace root or a member that declares `<member>` as a `workspace:` dependency
 * and no installed path exists. `boundary` (the analyzed repository root) confines every link.
 */
export function workspaceLinkedSystem(system: ts.System, boundary?: string): ts.System {
  const confinedBoundary = boundary === undefined ? undefined : slash(boundary);
  const linksByDirectory = new Map<string, ReadonlyMap<string, string>>();

  const linksAt = (directory: string): ReadonlyMap<string, string> => {
    const cached = linksByDirectory.get(directory);
    if (cached !== undefined) return cached;
    const links = new Map<string, string>();
    const dependencies = workspaceDependencies(directory);
    const declaration = dependencies.size === 0 ? undefined : findDeclaration(directory, confinedBoundary);
    if (declaration !== undefined) {
      const isMember = directory === declaration.root || membersOf(declaration).directories.has(directory)
        || membersOf(declaration, true).directories.has(directory);
      for (const name of isMember ? [...dependencies].sort() : []) {
        const member = memberDirectory(declaration, name);
        if (member !== undefined && (confinedBoundary === undefined || isWithin(confinedBoundary, member))) links.set(name, member);
      }
    }
    linksByDirectory.set(directory, links);
    return links;
  };

  /** Map one path through a workspace link, or `undefined` when no link applies. */
  const linked = (path: string): string | undefined => {
    const normalized = slash(path);
    const marker = normalized.indexOf("/node_modules/");
    if (marker <= 0) return undefined;
    const directory = normalized.slice(0, marker);
    const segments = normalized.slice(marker + "/node_modules/".length).split("/");
    const nameLength = segments[0]?.startsWith("@") ? 2 : 1;
    if (segments.length < nameLength || segments.slice(0, nameLength).some(segment => segment.length === 0)) return undefined;
    const member = linksAt(directory).get(segments.slice(0, nameLength).join("/"));
    if (member === undefined) return undefined;
    const rest = segments.slice(nameLength);
    return rest.length === 0 ? member : `${member}/${rest.join("/")}`;
  };

  const installed = (path: string): boolean => system.fileExists(path) || (system.directoryExists?.(path) ?? false);

  return {
    ...system,
    fileExists: path => {
      if (system.fileExists(path)) return true;
      const target = linked(path);
      return target !== undefined && system.fileExists(target);
    },
    readFile: (path, encoding) => {
      if (system.fileExists(path)) return system.readFile(path, encoding);
      const target = linked(path);
      return target === undefined ? undefined : system.readFile(target, encoding);
    },
    directoryExists: path => {
      if (system.directoryExists?.(path) ?? false) return true;
      const normalized = slash(path);
      if (normalized.endsWith("/node_modules")) return linksAt(normalized.slice(0, -"/node_modules".length)).size > 0;
      const target = linked(path);
      return target !== undefined && (system.directoryExists?.(target) ?? false);
    },
    realpath: path => {
      const target = installed(path) ? undefined : linked(path);
      const resolved = target ?? path;
      return system.realpath === undefined ? resolved : system.realpath(resolved);
    },
  };
}
