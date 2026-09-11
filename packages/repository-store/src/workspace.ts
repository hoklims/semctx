import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SemctxError, SemctxConfigSchema, createDefaultConfig } from "@semantic-context/core";
import type { SemctxConfig } from "@semantic-context/core";
import { SqliteRepositoryStore } from "./store";

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

export function isInitialized(root: string): boolean {
  return existsSync(configPath(root));
}

function assertNotLinked(path: string): void {
  // `existsSync` follows links, so a dangling link reads as absent and is never opened.
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new SemctxError("CONFIG_INVALID", "linked .semctx entries are unsupported", { path });
  }
}

/**
 * Nothing the workspace opens under `.semctx` may be a symlink or junction: the directory
 * itself, the context-pack directory, the config file and the database. Every open below
 * follows links, so a checkout that planted one would have its configuration, index or packs
 * written outside the repository.
 */
export function assertUnlinkedWorkspace(root: string): void {
  for (const path of [semctxDir(root), contextPacksDir(root), configPath(root), dbPath(root)]) assertNotLinked(path);
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
  mkdirSync(semctxDir(root), { recursive: true });
  writeFileSync(configPath(root), `${JSON.stringify(toDiskConfig(config), null, 2)}\n`, "utf8");
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
