import { randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SemctxError, SemctxConfigSchema, createDefaultConfig } from "@semantic-context/core";
import type { SemctxConfig } from "@semantic-context/core";
import { SqliteRepositoryReader, SqliteRepositoryStore } from "./store";

export const SEMCTX_DIR = ".semctx";

export function semctxDir(root: string): string {
  return join(root, SEMCTX_DIR);
}

export function configPath(root: string): string {
  return join(semctxDir(root), "config.json");
}

export function dbPath(root: string): string {
  return join(semctxDir(root), "semctx.db");
}

export function contextPacksDir(root: string): string {
  return join(semctxDir(root), "context-packs");
}

/** Guarded-mode replay state written by `semctx verify` and read by the semantic check. */
export function verificationStatePath(root: string): string {
  return join(semctxDir(root), "verification-state.json");
}

export function isInitialized(root: string): boolean {
  return existsSync(configPath(root));
}

/**
 * Whether the entry at `path` is a symlink or junction. `lstat` reports the entry itself, so a
 * dangling link counts too (`existsSync` would follow it and report it absent); only a missing
 * entry is false.
 */
export function isLinkedEntry(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertNotLinked(path: string): void {
  if (isLinkedEntry(path)) {
    throw new SemctxError("CONFIG_INVALID", "linked .semctx entries are unsupported", { path });
  }
}

/**
 * Refuse a link at `path` or at any entry between `root` (exclusive) and `path`. `lstat` only
 * reports the last component, so a linked ancestor would otherwise carry every open below it
 * outside the repository. `path` must lie under `root`.
 */
export function assertUnlinkedBelow(root: string, path: string): void {
  const base = resolve(root);
  const inside = relative(base, resolve(path));
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new SemctxError("CONFIG_INVALID", "path escapes the repository root", { root: base, path });
  }
  let current = base;
  for (const segment of inside.split(sep)) {
    current = join(current, segment);
    assertNotLinked(current);
  }
}

function defaultTemporaryName(path: string): string {
  return `${path}.${randomBytes(9).toString("hex")}.tmp`;
}

/**
 * Replace `path` (under `root`) atomically without following a link at the destination, at any
 * ancestor below `root`, or at the temporary name. The temporary name is unguessable, checked
 * with `lstat` and then claimed with `O_CREAT | O_EXCL`; the check matters because Windows
 * `CREATE_NEW` follows a dangling link instead of failing on it as POSIX does. `rename` then
 * replaces the destination entry itself. `temporaryName` is a test seam for that check.
 */
export function writeFileNoFollow(
  root: string,
  path: string,
  content: string,
  temporaryName: (path: string) => string = defaultTemporaryName,
): void {
  assertUnlinkedBelow(root, path);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = temporaryName(path);
  assertNotLinked(temporary);
  const descriptor = openSync(temporary, "wx", 0o644);
  try {
    writeFileSync(descriptor, content, "utf8");
  } catch (error) {
    closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(descriptor);
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Nothing the workspace opens under `.semctx` may be a symlink or junction: the directory
 * itself, the context-pack directory, the config file, the database and the verification state.
 * Every open below follows links, so a checkout that planted one would have its configuration,
 * index, packs or replay state read from or written outside the repository. SQLite sidecars are
 * checked where the database is opened (`assertUnlinkedDatabase`).
 */
export function assertUnlinkedWorkspace(root: string): void {
  for (const path of [semctxDir(root), contextPacksDir(root), configPath(root), dbPath(root), verificationStatePath(root)]) {
    assertNotLinked(path);
  }
}

/**
 * Policy-only view of a config for disk. Machine `repositoryRoot` is never versioned — the
 * call/CLI root is the source of truth and is re-injected by `loadConfig`.
 */
export function toDiskConfig<T extends SemctxConfig>(config: T): Omit<T, "repositoryRoot"> {
  const { repositoryRoot: _repositoryRoot, ...policy } = config;
  return policy;
}

/** Create `.semctx/`, write config, return the resolved config. Idempotent-ish. */
export function initWorkspace(root: string, overrides?: Partial<SemctxConfig>): SemctxConfig {
  assertUnlinkedWorkspace(root);
  mkdirSync(semctxDir(root), { recursive: true });
  mkdirSync(contextPacksDir(root), { recursive: true });
  const repositoryRoot = realpathSync.native(resolve(root));
  // Validate policy shape (repositoryRoot is optional on disk / ignored at load).
  const policy = SemctxConfigSchema.parse({
    ...createDefaultConfig(repositoryRoot),
    ...overrides,
  });
  const config: SemctxConfig = { ...policy, repositoryRoot };
  saveConfig(root, config);
  return config;
}

export function saveConfig(root: string, config: SemctxConfig): void {
  assertUnlinkedWorkspace(root);
  writeFileNoFollow(root, configPath(root), `${JSON.stringify(toDiskConfig(config), null, 2)}\n`);
}

export function loadConfig(root: string): SemctxConfig {
  assertUnlinkedWorkspace(root);
  const path = configPath(root);
  if (!existsSync(path)) {
    throw new SemctxError("CONFIG_NOT_FOUND", `no semctx config at ${path}. Run 'semctx init' first.`, { root });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new SemctxError("CONFIG_INVALID", `config.json is not valid JSON`, { path, cause: String(cause) });
  }
  const parsed = SemctxConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SemctxError("CONFIG_INVALID", `config.json failed schema validation`, {
      path,
      issues: parsed.error.issues,
    });
  }
  // Call/CLI root is authoritative; on-disk repositoryRoot (legacy) is ignored.
  return { ...parsed.data, repositoryRoot: realpathSync.native(resolve(root)) };
}

export function openStore(root: string): SqliteRepositoryStore {
  assertUnlinkedWorkspace(root);
  mkdirSync(semctxDir(root), { recursive: true });
  return SqliteRepositoryStore.open(dbPath(root));
}

/**
 * Open the index read-only through the workspace guard. Readers that never call `loadConfig`
 * (readiness, the semantic check) go through here, so a linked `.semctx` is refused before
 * another repository's index could be served as this one's.
 */
export function openReader(root: string): SqliteRepositoryReader {
  assertUnlinkedWorkspace(root);
  return SqliteRepositoryReader.openExisting(dbPath(root));
}
