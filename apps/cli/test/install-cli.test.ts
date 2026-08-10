import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { parseArgs } from "../src/args";
import {
  executeInstall,
  DEFERRED_CODEX_CACHE_CLEANUP_SCRIPT,
  resolveCodexCacheEntry,
  resolveCodexHome,
  type CodexBundleProbe,
  type CodexCacheCleanupRequest,
  type CodexPayloadProbe,
  type CommandResult,
  type InstallRuntime,
  type SetupExecution,
} from "../src/commands/install";

const SEMCTX_SOURCE = "https://github.com/hoklims/semctx.git";
// Absolute on every platform, and never touched on disk: the fake runtime answers all probes.
const CODEX_HOME = join(tmpdir(), "semctx-fake-codex");
/** `source.path` from `codex plugin list --json` — the marketplace snapshot, NOT what Codex runs. */
const CODEX_SNAPSHOT_PATH = join(
  CODEX_HOME,
  ".tmp",
  "marketplaces",
  "semctx-stable",
  "plugins",
  "semctx-control",
);
/** The versioned cache Codex actually executes. */
const CODEX_CACHE_ROOT = join(CODEX_HOME, "plugins", "cache", "semctx-stable", "semctx-control");
const CODEX_CACHE_PATH = join(CODEX_CACHE_ROOT, "0.1.17");
const CODEX_OBSOLETE_CACHE_PATH = join(CODEX_CACHE_ROOT, "0.1.16");
const CODEX_ACTIVE_CACHE_LOCK =
  "failed to back up plugin cache entry: Accès refusé. (os error 5)";

function bundleDigests(
  overrides: Record<string, CodexBundleProbe> = {},
): Record<string, CodexBundleProbe> {
  return {
    "semctx-mcp.js": { status: "ok", sha256: "mcp-digest" },
    "semctx-shared.js": { status: "ok", sha256: "shared-digest" },
    "semctx.js": { status: "ok", sha256: "cli-digest" },
    ...overrides,
  };
}

function probe(
  version: string | undefined = "0.1.17",
  overrides: Record<string, CodexBundleProbe> = {},
): CodexPayloadProbe {
  return {
    ...(version === undefined ? {} : { version }),
    bundles: bundleDigests(overrides),
  };
}

/** Cache and snapshot both complete and byte-identical: the only shape that may be reconciled. */
function convergedPayloads(): Record<string, CodexPayloadProbe | null> {
  return { [CODEX_CACHE_PATH]: probe(), [CODEX_SNAPSHOT_PATH]: probe() };
}

interface FakeOptions {
  codex?: boolean;
  claude?: boolean;
  git?: boolean;
  codexMarketplaces?: unknown;
  codexPlugins?: unknown;
  codexPluginsAfter?: unknown;
  claudeMarketplaces?: unknown;
  claudePlugins?: unknown;
  claudePluginsAfter?: unknown;
  gitRoot?: string;
  failCommand?: string;
  failError?: string;
  deferFailure?: string;
  cacheDeferFailure?: string;
  codexPayloads?: Record<string, CodexPayloadProbe | null>;
  codexHome?: string | null;
  platform?: NodeJS.Platform;
  setup?: SetupExecution;
}

function fakeRuntime(
  options: FakeOptions = {},
): InstallRuntime & {
  commands: string[][];
  deferredCodexCleanups: string[][];
  deferredCacheCleanups: CodexCacheCleanupRequest[];
  payloadProbes: string[];
  setupRoots: string[];
} {
  const commands: string[][] = [];
  const deferredCodexCleanups: string[][] = [];
  const deferredCacheCleanups: CodexCacheCleanupRequest[] = [];
  const payloadProbes: string[] = [];
  const setupRoots: string[] = [];
  let codexPluginReads = 0;
  let claudePluginReads = 0;
  const ok = (out = ""): CommandResult => ({ code: 0, out, err: "" });
  const missing = (name: string): CommandResult => ({
    code: 1,
    out: "",
    err: `${name} not found`,
  });

  return {
    commands,
    run(command, _cwd) {
      const argv = [...command];
      commands.push(argv);
      const [program, ...args] = argv;

      if (program === "codex" && args[0] === "--version") {
        return options.codex === false ? missing("codex") : ok("codex-cli 0.144.6\n");
      }
      if (program === "claude" && args[0] === "--version") {
        return options.claude === true ? ok("2.1.220\n") : missing("claude");
      }
      if (program === "git" && args[0] === "rev-parse") {
        return options.git === false
          ? missing("git repository")
          : ok(`${options.gitRoot ?? "C:\\work\\project"}\n`);
      }
      if (argv.join(" ") === "codex plugin marketplace list --json") {
        return ok(JSON.stringify(options.codexMarketplaces ?? { marketplaces: [] }));
      }
      if (argv.join(" ") === "codex plugin list --json") {
        codexPluginReads += 1;
        const state = codexPluginReads === 1
          ? options.codexPlugins ?? { installed: [], available: [] }
          : options.codexPluginsAfter ?? {
            installed: [{
              pluginId: "semctx-control@semctx-stable",
              installed: true,
              enabled: true,
              version: "0.1.17",
            }],
            available: [],
          };
        return ok(JSON.stringify(state));
      }
      if (argv.join(" ") === "claude plugin marketplace list --json") {
        return ok(JSON.stringify(options.claudeMarketplaces ?? []));
      }
      if (argv.join(" ") === "claude plugin list --json") {
        claudePluginReads += 1;
        const state = claudePluginReads === 1
          ? options.claudePlugins ?? []
          : options.claudePluginsAfter ?? [{
            id: "semctx@semctx-stable",
            scope: "user",
            enabled: true,
            version: "0.1.17",
          }];
        return ok(JSON.stringify(state));
      }
      if (argv.join(" ") === options.failCommand) {
        return { code: 1, out: "", err: options.failError ?? "injected command failure" };
      }
      return ok("{}\n");
    },
    setup(root, dryRun) {
      if (dryRun) throw new Error("dry-run must not invoke setup");
      setupRoots.push(root);
      return options.setup ?? {
        code: 0,
        report: { check: { ok: true }, nodes: 12, claims: 4 },
        err: "",
      };
    },
    deferCodexCleanup(marketplaceNames) {
      deferredCodexCleanups.push([...marketplaceNames]);
      return options.deferFailure === undefined
        ? ok('{"pid":1234}\n')
        : { code: 1, out: "", err: options.deferFailure };
    },
    deferCodexCacheCleanup(request) {
      deferredCacheCleanups.push({ ...request });
      return options.cacheDeferFailure === undefined
        ? ok('{"pid":4321}\n')
        : { code: 1, out: "", err: options.cacheDeferFailure };
    },
    codexHome() {
      return options.codexHome === undefined ? CODEX_HOME : options.codexHome;
    },
    readCodexPluginPayload(path) {
      payloadProbes.push(path);
      return (options.codexPayloads ?? convergedPayloads())[path] ?? null;
    },
    get platform() {
      return options.platform ?? "win32";
    },
    deferredCodexCleanups,
    deferredCacheCleanups,
    payloadProbes,
    setupRoots,
  };
}

/** Codex reports the plugin already installed at `version`, on the stable marketplace. */
function stableCodexOptions(version: string): FakeOptions {
  return {
    codex: true,
    claude: false,
    codexMarketplaces: {
      marketplaces: [{
        name: "semctx-stable",
        marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE },
      }],
    },
    codexPlugins: {
      installed: [{
        pluginId: "semctx-control@semctx-stable",
        installed: true,
        enabled: true,
        version,
      }],
    },
  };
}

/** What `codex plugin list --json` returns on the read-back after the add. */
function codexPluginsAfter(
  overrides: Record<string, unknown>,
  extraEntries: unknown[] = [],
): Record<string, unknown> {
  return {
    installed: [
      ...extraEntries,
      {
        pluginId: "semctx-control@semctx-stable",
        installed: true,
        enabled: true,
        version: "0.1.17",
        source: { source: "local", path: CODEX_SNAPSHOT_PATH },
        ...overrides,
      },
    ],
    available: [],
  };
}

function installWithLockedAdd(options: FakeOptions): ReturnType<typeof fakeRuntime> {
  return fakeRuntime({
    ...stableCodexOptions("0.1.16"),
    failCommand: "codex plugin add semctx-control@semctx-stable --json",
    failError: CODEX_ACTIVE_CACHE_LOCK,
    ...options,
  });
}

describe("semctx install — no-brain host + repository bootstrap", () => {
  test("installs the Codex marketplace and plugin, then prepares the current repository", () => {
    const runtime = fakeRuntime({ codex: true, claude: false });
    const report = executeInstall("C:\\work\\project", parseArgs(["install"]), runtime);

    expect(report.ok).toBe(true);
    expect(report.hosts.codex.status).toBe("installed");
    expect(report.hosts.claude.status).toBe("not-detected");
    expect(report.workspace.status).toBe("ready");
    expect(runtime.commands).toContainEqual([
      "codex",
      "plugin",
      "marketplace",
      "add",
      "hoklims/semctx",
      "--ref",
      "stable",
      "--json",
    ]);
    expect(runtime.commands).toContainEqual([
      "codex",
      "plugin",
      "add",
      "semctx-control@semctx-stable",
      "--json",
    ]);
  });

  test("updates an existing Codex installation and reloads the plugin registration", () => {
    const runtime = fakeRuntime({
      codex: true,
      codexMarketplaces: {
        marketplaces: [
          {
            name: "semctx-stable",
            marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE },
          },
        ],
      },
      codexPlugins: {
        installed: [{ pluginId: "semctx-control@semctx-stable", installed: true, version: "0.1.10" }],
      },
    });
    const report = executeInstall("C:\\work\\project", parseArgs(["install"]), runtime);

    expect(report.ok).toBe(true);
    expect(report.hosts.codex.status).toBe("updated");
    expect(runtime.commands).toContainEqual([
      "codex",
      "plugin",
      "marketplace",
      "upgrade",
      "semctx-stable",
      "--json",
    ]);
    expect(runtime.commands).not.toContainEqual([
      "codex",
      "plugin",
      "remove",
      "semctx-control@semctx-stable",
      "--json",
    ]);
    expect(runtime.commands).toContainEqual([
      "codex",
      "plugin",
      "add",
      "semctx-control@semctx-stable",
      "--json",
    ]);
  });

  test("migrates the legacy Codex marketplace name from personal to semctx-stable", () => {
    const runtime = fakeRuntime({
      codex: true,
      codexMarketplaces: {
        marketplaces: [
          {
            name: "personal",
            marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE },
          },
        ],
      },
      codexPlugins: {
        installed: [{ pluginId: "semctx-control@personal", installed: true, version: "0.1.10" }],
      },
    });
    const report = executeInstall("C:\\work\\project", parseArgs(["install"]), runtime);

    expect(report.ok).toBe(true);
    expect(report.hosts.codex.status).toBe("migrated");
    expect(runtime.commands).toContainEqual([
      "codex",
      "plugin",
      "remove",
      "semctx-control@personal",
      "--json",
    ]);
    expect(runtime.commands).toContainEqual([
      "codex",
      "plugin",
      "marketplace",
      "remove",
      "personal",
      "--json",
    ]);
    expect(runtime.commands).toContainEqual([
      "codex",
      "plugin",
      "add",
      "semctx-control@semctx-stable",
      "--json",
    ]);
    const installNew = runtime.commands.findIndex(
      (command) => command.join(" ") === "codex plugin add semctx-control@semctx-stable --json",
    );
    const removeLegacy = runtime.commands.findIndex(
      (command) => command.join(" ") === "codex plugin remove semctx-control@personal --json",
    );
    expect(installNew).toBeGreaterThanOrEqual(0);
    expect(removeLegacy).toBeGreaterThan(installNew);
  });

  test("finishes a partial Codex migration when legacy and stable registrations both exist", () => {
    const runtime = fakeRuntime({
      codex: true,
      codexMarketplaces: {
        marketplaces: [
          {
            name: "semctx",
            marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE },
          },
          {
            name: "semctx-stable",
            marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE },
          },
        ],
      },
      codexPlugins: {
        installed: [
          {
            pluginId: "semctx-control@semctx",
            installed: true,
            enabled: true,
            version: "0.1.10",
          },
          {
            pluginId: "semctx-control@semctx-stable",
            installed: true,
            enabled: true,
            version: "0.1.10",
          },
        ],
      },
    });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(true);
    expect(report.hosts.codex.status).toBe("migrated");
    expect(runtime.commands).toContainEqual([
      "codex",
      "plugin",
      "marketplace",
      "upgrade",
      "semctx-stable",
      "--json",
    ]);
    expect(runtime.commands).toContainEqual([
      "codex",
      "plugin",
      "remove",
      "semctx-control@semctx",
      "--json",
    ]);
    expect(runtime.commands).toContainEqual([
      "codex",
      "plugin",
      "marketplace",
      "remove",
      "semctx",
      "--json",
    ]);
  });

  test("does not remove a legacy Codex marketplace while another installed plugin still uses it", () => {
    const runtime = fakeRuntime({
      codex: true,
      codexMarketplaces: {
        marketplaces: [
          {
            name: "personal",
            marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE },
          },
        ],
      },
      codexPlugins: {
        installed: [
          { pluginId: "semctx-control@personal", installed: true, version: "0.1.10" },
          { pluginId: "another-plugin@personal", installed: true, version: "1.0.0" },
        ],
      },
    });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(false);
    expect(report.hosts.codex.status).toBe("conflict");
    expect(report.hosts.codex.error).toContain("another-plugin@personal");
    expect(runtime.commands.some((command) => command.includes("remove"))).toBe(false);
  });

  test("keeps the working legacy Codex plugin when replacement installation fails", () => {
    const runtime = fakeRuntime({
      codex: true,
      codexMarketplaces: {
        marketplaces: [{
          name: "personal",
          marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE },
        }],
      },
      codexPlugins: {
        installed: [{
          pluginId: "semctx-control@personal",
          installed: true,
          enabled: true,
          version: "0.1.10",
        }],
      },
      failCommand: "codex plugin add semctx-control@semctx-stable --json",
    });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(false);
    expect(report.hosts.codex.status).toBe("failed");
    expect(runtime.commands).not.toContainEqual([
      "codex",
      "plugin",
      "remove",
      "semctx-control@personal",
      "--json",
    ]);
    expect(runtime.commands).not.toContainEqual([
      "codex",
      "plugin",
      "marketplace",
      "remove",
      "personal",
      "--json",
    ]);
  });

  test("defers a locked legacy Codex cleanup after the replacement verifies", () => {
    const runtime = fakeRuntime({
      codex: true,
      claude: false,
      codexMarketplaces: {
        marketplaces: [{
          name: "personal",
          marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE },
        }],
      },
      codexPlugins: {
        installed: [{
          pluginId: "semctx-control@personal",
          installed: true,
          enabled: true,
          version: "0.1.10",
        }],
      },
      failCommand: "codex plugin remove semctx-control@personal --json",
      failError:
        "failed to remove existing plugin cache entry: file is used by another process (os error 32)",
    });

    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(true);
    expect(report.hosts.codex.status).toBe("migrated");
    expect(report.hosts.codex.restartRequired).toBe(true);
    expect(report.hosts.codex.steps).toContainEqual(expect.objectContaining({
      action: "remove legacy Codex plugin",
      status: "deferred",
    }));
    expect(runtime.deferredCodexCleanups).toEqual([["personal"]]);
    expect(runtime.commands).not.toContainEqual([
      "codex",
      "plugin",
      "marketplace",
      "remove",
      "personal",
      "--json",
    ]);
  });

  test("keeps unexpected legacy cleanup failures blocking", () => {
    const runtime = fakeRuntime({
      codex: true,
      claude: false,
      codexMarketplaces: {
        marketplaces: [{
          name: "personal",
          marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE },
        }],
      },
      codexPlugins: {
        installed: [{
          pluginId: "semctx-control@personal",
          installed: true,
          enabled: true,
          version: "0.1.10",
        }],
      },
      failCommand: "codex plugin remove semctx-control@personal --json",
      failError: "permission denied",
    });

    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(false);
    expect(report.hosts.codex.status).toBe("failed");
    expect(runtime.deferredCodexCleanups).toEqual([]);
  });

  test("fails honestly when locked cleanup cannot be deferred", () => {
    const runtime = fakeRuntime({
      codex: true,
      claude: false,
      codexMarketplaces: {
        marketplaces: [{
          name: "personal",
          marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE },
        }],
      },
      codexPlugins: {
        installed: [{
          pluginId: "semctx-control@personal",
          installed: true,
          enabled: true,
          version: "0.1.10",
        }],
      },
      failCommand: "codex plugin remove semctx-control@personal --json",
      failError:
        "failed to remove existing plugin cache entry: file is used by another process (os error 32)",
      deferFailure: "cannot start background cleanup",
    });

    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(false);
    expect(report.hosts.codex.status).toBe("failed");
    expect(report.hosts.codex.error).toContain("cannot start background cleanup");
    expect(runtime.deferredCodexCleanups).toEqual([["personal"]]);
  });

  /**
   * `codex plugin add` writes the new payload before archiving the one it replaces, so on Windows it
   * can converge and still exit non-zero while a live task maps the old cache entry (#91).
   *
   * Three states are distinct and must never be conflated: the marketplace *snapshot*
   * (`source.path`), the versioned *cache* Codex actually executes, and the version a running
   * session has *loaded*. Only a cache that is complete and byte-identical to the approved snapshot
   * may override the host's non-zero exit.
   */
  test("reconciles a Codex update whose executed cache is proven identical to the snapshot", () => {
    const runtime = installWithLockedAdd({ codexPluginsAfter: codexPluginsAfter({}) });

    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(true);
    expect(report.hosts.codex.status).toBe("updated");
    expect(report.hosts.codex.cleanupDeferred).toBe(true);
    expect(report.hosts.codex.restartRequired).toBe(true);
    expect(report.hosts.codex.error).toBeUndefined();
    expect(report.hosts.codex.steps).toContainEqual(expect.objectContaining({
      action: "refresh Semctx Codex plugin",
      status: "deferred",
    }));

    // The executed cache is proven, not merely the snapshot Codex points at.
    expect(runtime.payloadProbes).toContain(CODEX_CACHE_PATH);
    expect(runtime.payloadProbes).toContain(CODEX_SNAPSHOT_PATH);

    // Exactly one deferral, carrying its own reason and whether a retry was scheduled.
    expect(report.hosts.codex.deferrals).toEqual([
      expect.objectContaining({ kind: "obsolete-plugin-cache", scheduled: true }),
    ]);

    // The obsolete cache — and only it — is scheduled for removal.
    expect(runtime.deferredCacheCleanups).toEqual([{
      cacheRoot: CODEX_CACHE_ROOT,
      path: CODEX_OBSOLETE_CACHE_PATH,
      version: "0.1.16",
      keepVersion: "0.1.17",
    }]);
    expect(runtime.deferredCodexCleanups).toEqual([]);
    expect(report.next.join(" ")).toContain("previous cache entry");
  });

  test("schedules no cache cleanup when there is no obsolete version to remove", () => {
    // Fresh install: nothing was installed before, so nothing is obsolete.
    const runtime = fakeRuntime({
      codex: true,
      claude: false,
      codexMarketplaces: {
        marketplaces: [{
          name: "semctx-stable",
          marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE },
        }],
      },
      codexPlugins: { installed: [] },
      codexPluginsAfter: codexPluginsAfter({}),
      failCommand: "codex plugin add semctx-control@semctx-stable --json",
      failError: CODEX_ACTIVE_CACHE_LOCK,
    });

    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(true);
    expect(runtime.deferredCacheCleanups).toEqual([]);
    expect(report.hosts.codex.cleanupDeferred).toBeUndefined();
    expect(report.hosts.codex.deferrals).toBeUndefined();
  });

  test("never targets the expected version, even when the host reports it as the old one", () => {
    // A host that claims the pre-update version is already 0.1.17 must not get its live cache wiped.
    const runtime = installWithLockedAdd({
      ...stableCodexOptions("0.1.17"),
      codexPluginsAfter: codexPluginsAfter({}),
      failCommand: "codex plugin add semctx-control@semctx-stable --json",
      failError: CODEX_ACTIVE_CACHE_LOCK,
    });

    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(true);
    expect(runtime.deferredCacheCleanups).toEqual([]);
  });

  test("keeps the install successful when the cache janitor cannot be scheduled", () => {
    const runtime = installWithLockedAdd({
      codexPluginsAfter: codexPluginsAfter({}),
      cacheDeferFailure: "cannot start background cache cleanup",
    });

    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    // The update itself converged; a janitor that failed to start does not un-prove it.
    expect(report.ok).toBe(true);
    expect(report.hosts.codex.deferrals).toEqual([
      expect.objectContaining({ kind: "obsolete-plugin-cache", scheduled: false }),
    ]);
    expect(report.hosts.codex.deferrals?.[0]?.detail).toContain(
      "cannot start background cache cleanup",
    );
  });

  test("represents an active-cache deferral and a legacy deferral together without loss", () => {
    const runtime = fakeRuntime({
      codex: true,
      claude: false,
      codexMarketplaces: {
        marketplaces: [
          { name: "semctx-stable", marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE } },
          { name: "personal", marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE } },
        ],
      },
      codexPlugins: {
        installed: [
          {
            pluginId: "semctx-control@semctx-stable",
            installed: true,
            enabled: true,
            version: "0.1.16",
          },
          { pluginId: "semctx-control@personal", installed: true, enabled: true, version: "0.1.10" },
        ],
      },
      codexPluginsAfter: codexPluginsAfter({}),
      failCommand: "codex plugin add semctx-control@semctx-stable --json",
      failError: CODEX_ACTIVE_CACHE_LOCK,
    });
    // The legacy removal is locked too, so both obligations are outstanding at once.
    const baseRun = runtime.run.bind(runtime);
    runtime.run = (command, cwd) => {
      const joined = [...command].join(" ");
      if (joined === "codex plugin remove semctx-control@personal --json") {
        baseRun(command, cwd);
        return {
          code: 1,
          out: "",
          err: "failed to remove existing plugin cache entry: file is used by another process (os error 32)",
        };
      }
      return baseRun(command, cwd);
    };

    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(true);
    expect(report.hosts.codex.cleanupDeferred).toBe(true);
    // Additive and deterministic: neither obligation erases the other.
    expect(report.hosts.codex.deferrals?.map((entry) => entry.kind)).toEqual([
      "obsolete-plugin-cache",
      "legacy-marketplace",
    ]);
    expect(runtime.deferredCodexCleanups).toEqual([["personal"]]);
    expect(runtime.deferredCacheCleanups).toEqual([{
      cacheRoot: CODEX_CACHE_ROOT,
      path: CODEX_OBSOLETE_CACHE_PATH,
      version: "0.1.16",
      keepVersion: "0.1.17",
    }]);
  });

  test("survives a malformed plugin list with a structured failure", () => {
    const runtime = installWithLockedAdd({
      codexPlugins: { installed: [null, { pluginId: "semctx-control@semctx-stable", installed: true, enabled: true, version: "0.1.16" }] },
      codexPluginsAfter: codexPluginsAfter({}, [null, "not-an-object"]),
    });

    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    // Malformed entries are dropped, not dereferenced: no exception, and the real entry still wins.
    expect(report.ok).toBe(true);
    expect(report.hosts.codex.status).toBe("updated");
  });

  test("fails structurally when every plugin entry is malformed", () => {
    const runtime = installWithLockedAdd({
      codexPluginsAfter: { installed: [null, 42], available: [] },
    });

    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(false);
    expect(report.hosts.codex.status).toBe("failed");
    expect(report.hosts.codex.error).toContain("not installed");
  });

  const blocking: Array<{ name: string; options: FakeOptions; reason: string }> = [
    {
      name: "the expected version is absent",
      options: { codexPluginsAfter: { installed: [], available: [] } },
      reason: "the expected plugin is not installed",
    },
    {
      name: "the installed version is still the old one",
      options: { codexPluginsAfter: codexPluginsAfter({ version: "0.1.16" }) },
      reason: "expected plugin v0.1.17, found v0.1.16",
    },
    {
      name: "the plugin is installed but disabled",
      options: { codexPluginsAfter: codexPluginsAfter({ enabled: false }) },
      reason: "installed but not enabled",
    },
    {
      name: "Codex reports no snapshot path",
      options: { codexPluginsAfter: codexPluginsAfter({ source: undefined }) },
      reason: "reported no marketplace snapshot path",
    },
    {
      name: "Codex reports the installed cache itself as its snapshot",
      options: {
        codexPluginsAfter: codexPluginsAfter({ source: { path: CODEX_CACHE_PATH } }),
        codexPayloads: { [CODEX_CACHE_PATH]: probe() },
      },
      reason: "unexpected marketplace snapshot path",
    },
    {
      name: "the snapshot is valid but the executed cache is absent",
      options: {
        codexPluginsAfter: codexPluginsAfter({}),
        codexPayloads: { [CODEX_SNAPSHOT_PATH]: probe() },
      },
      reason: "cannot read the installed plugin cache",
    },
    {
      name: "the executed cache is missing a bundle",
      options: {
        codexPluginsAfter: codexPluginsAfter({}),
        codexPayloads: {
          [CODEX_SNAPSHOT_PATH]: probe(),
          [CODEX_CACHE_PATH]: probe("0.1.17", { "semctx-shared.js": { status: "missing" } }),
        },
      },
      reason: "semctx-shared.js is missing",
    },
    {
      name: "a cached bundle is empty",
      options: {
        codexPluginsAfter: codexPluginsAfter({}),
        codexPayloads: {
          [CODEX_SNAPSHOT_PATH]: probe(),
          [CODEX_CACHE_PATH]: probe("0.1.17", { "semctx.js": { status: "empty" } }),
        },
      },
      reason: "semctx.js is empty",
    },
    {
      name: "a cached bundle is not a regular file",
      options: {
        codexPluginsAfter: codexPluginsAfter({}),
        codexPayloads: {
          [CODEX_SNAPSHOT_PATH]: probe(),
          [CODEX_CACHE_PATH]: probe("0.1.17", { "semctx-mcp.js": { status: "not-a-file" } }),
        },
      },
      reason: "semctx-mcp.js is not-a-file",
    },
    {
      name: "the cache manifest declares another version",
      options: {
        codexPluginsAfter: codexPluginsAfter({}),
        codexPayloads: { [CODEX_SNAPSHOT_PATH]: probe(), [CODEX_CACHE_PATH]: probe("0.1.16") },
      },
      reason: "declares v0.1.16, expected v0.1.17",
    },
    {
      name: "the marketplace snapshot manifest declares another version",
      options: {
        codexPluginsAfter: codexPluginsAfter({}),
        codexPayloads: { [CODEX_SNAPSHOT_PATH]: probe("0.1.16"), [CODEX_CACHE_PATH]: probe() },
      },
      reason: "snapshot at",
    },
    {
      name: "a cached bundle digest diverges from the approved snapshot",
      options: {
        codexPluginsAfter: codexPluginsAfter({}),
        codexPayloads: {
          [CODEX_SNAPSHOT_PATH]: probe(),
          [CODEX_CACHE_PATH]: probe("0.1.17", {
            "semctx-shared.js": { status: "ok", sha256: "tampered" },
          }),
        },
      },
      reason: "semctx-shared.js does not match the marketplace snapshot",
    },
    {
      name: "the snapshot itself cannot be read",
      options: {
        codexPluginsAfter: codexPluginsAfter({}),
        codexPayloads: { [CODEX_CACHE_PATH]: probe() },
      },
      reason: "cannot read the marketplace snapshot",
    },
    {
      name: "the Codex cache root cannot be located",
      options: { codexPluginsAfter: codexPluginsAfter({}), codexHome: null },
      reason: "cannot locate the Codex plugin cache",
    },
    {
      name: "the host runs on a platform without this cache-lock behaviour",
      options: { codexPluginsAfter: codexPluginsAfter({}), platform: "linux" },
      reason: "not an active-cache lock",
    },
    {
      name: "the error code is os error 50",
      options: {
        codexPluginsAfter: codexPluginsAfter({}),
        failError: "failed to back up plugin cache entry: something else (os error 50)",
      },
      reason: "not an active-cache lock",
    },
    {
      name: "the error code is os error 320",
      options: {
        codexPluginsAfter: codexPluginsAfter({}),
        failError: "failed to back up plugin cache entry: something else (os error 320)",
      },
      reason: "not an active-cache lock",
    },
    {
      name: "the failure is an arbitrary permission error",
      options: {
        codexPluginsAfter: codexPluginsAfter({}),
        failError: "Accès refusé. (os error 5)",
      },
      reason: "not an active-cache lock",
    },
  ];

  for (const scenario of blocking) {
    test(`stays fail-closed when ${scenario.name}`, () => {
      const runtime = installWithLockedAdd(scenario.options);

      const report = executeInstall(
        "C:\\work\\project",
        parseArgs(["install", "--skip-setup"]),
        runtime,
      );

      expect(report.ok).toBe(false);
      expect(report.hosts.codex.status).toBe("failed");
      expect(report.hosts.codex.cleanupDeferred).toBeUndefined();
      expect(report.hosts.codex.deferrals).toBeUndefined();
      expect(report.hosts.codex.restartRequired).toBe(false);
      expect(report.hosts.codex.error).toContain(scenario.reason);
      // Nothing is ever scheduled against a cache we could not prove.
      expect(runtime.deferredCacheCleanups).toEqual([]);
    });
  }

  test("never probes a payload when the failure is not an active-cache lock", () => {
    const runtime = installWithLockedAdd({
      failError: "Accès refusé. (os error 5)",
      codexPluginsAfter: codexPluginsAfter({}),
    });

    executeInstall("C:\\work\\project", parseArgs(["install", "--skip-setup"]), runtime);

    expect(runtime.payloadProbes).toEqual([]);
  });

  test("installs or updates Claude Code at user scope", () => {
    const fresh = fakeRuntime({ codex: false, claude: true });
    const freshReport = executeInstall("C:\\work\\project", parseArgs(["install"]), fresh);
    expect(freshReport.hosts.claude.status).toBe("installed");
    expect(fresh.commands).toContainEqual([
      "claude",
      "plugin",
      "marketplace",
      "add",
      "hoklims/semctx@stable",
      "--scope",
      "user",
    ]);
    expect(fresh.commands).toContainEqual([
      "claude",
      "plugin",
      "install",
      "semctx@semctx-stable",
      "--scope",
      "user",
    ]);

    const existing = fakeRuntime({
      codex: false,
      claude: true,
      claudeMarketplaces: [{ name: "semctx-stable", source: "github", repo: "hoklims/semctx" }],
      claudePlugins: [{ id: "semctx@semctx-stable", scope: "user", enabled: true, version: "0.1.10" }],
    });
    const existingReport = executeInstall("C:\\work\\project", parseArgs(["install"]), existing);
    expect(existingReport.hosts.claude.status).toBe("updated");
    expect(existing.commands).toContainEqual([
      "claude",
      "plugin",
      "marketplace",
      "update",
      "semctx-stable",
    ]);
    expect(existing.commands).toContainEqual([
      "claude",
      "plugin",
      "update",
      "semctx@semctx-stable",
      "--scope",
      "user",
    ]);
  });

  test("migrates Claude from the old marketplace only after the stable plugin verifies", () => {
    const runtime = fakeRuntime({
      codex: false,
      claude: true,
      claudeMarketplaces: [{ name: "semctx", source: "github", repo: "hoklims/semctx" }],
      claudePlugins: [{
        id: "semctx@semctx",
        scope: "user",
        enabled: true,
        version: "0.1.10",
      }],
    });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(true);
    expect(report.hosts.claude.status).toBe("migrated");
    const installStable = runtime.commands.findIndex(
      (command) => command.join(" ")
        === "claude plugin install semctx@semctx-stable --scope user",
    );
    const verifyStable = runtime.commands.findIndex(
      (command, index) => index > installStable
        && command.join(" ") === "claude plugin list --json",
    );
    const removeLegacy = runtime.commands.findIndex(
      (command) => command.join(" ")
        === "claude plugin marketplace remove semctx --scope user",
    );
    expect(installStable).toBeGreaterThanOrEqual(0);
    expect(verifyStable).toBeGreaterThan(installStable);
    expect(removeLegacy).toBeGreaterThan(verifyStable);
  });

  test("finishes a partial Claude migration when legacy and stable registrations both exist", () => {
    const runtime = fakeRuntime({
      codex: false,
      claude: true,
      claudeMarketplaces: [
        { name: "semctx", source: "github", repo: "hoklims/semctx" },
        { name: "semctx-stable", source: "github", repo: "hoklims/semctx" },
      ],
      claudePlugins: [
        {
          id: "semctx@semctx",
          scope: "user",
          enabled: true,
          version: "0.1.10",
        },
        {
          id: "semctx@semctx-stable",
          scope: "user",
          enabled: true,
          version: "0.1.10",
        },
      ],
    });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(true);
    expect(report.hosts.claude.status).toBe("migrated");
    expect(runtime.commands).toContainEqual([
      "claude",
      "plugin",
      "marketplace",
      "update",
      "semctx-stable",
    ]);
    expect(runtime.commands).toContainEqual([
      "claude",
      "plugin",
      "update",
      "semctx@semctx-stable",
      "--scope",
      "user",
    ]);
    expect(runtime.commands).toContainEqual([
      "claude",
      "plugin",
      "marketplace",
      "remove",
      "semctx",
      "--scope",
      "user",
    ]);
  });

  test("never removes a Claude marketplace declaration outside user scope", () => {
    const runtime = fakeRuntime({
      codex: false,
      claude: true,
      claudeMarketplaces: [
        { name: "semctx", source: "github", repo: "hoklims/semctx" },
        { name: "semctx-stable", source: "github", repo: "hoklims/semctx" },
      ],
      claudePlugins: [
        {
          id: "semctx@semctx",
          scope: "project",
          enabled: true,
          version: "0.1.10",
        },
        {
          id: "semctx@semctx-stable",
          scope: "user",
          enabled: true,
          version: "0.1.10",
        },
      ],
    });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(true);
    expect(runtime.commands).toContainEqual([
      "claude",
      "plugin",
      "marketplace",
      "remove",
      "semctx",
      "--scope",
      "user",
    ]);
    expect(runtime.commands).not.toContainEqual([
      "claude",
      "plugin",
      "marketplace",
      "remove",
      "semctx",
    ]);
    expect(runtime.commands.some(
      (command) => command[0] === "claude"
        && command[1] === "plugin"
        && command[2] === "uninstall",
    )).toBe(false);
  });

  test("re-enables an installed Claude plugin instead of leaving a successful-looking dead state", () => {
    const runtime = fakeRuntime({
      codex: false,
      claude: true,
      claudeMarketplaces: [{ name: "semctx-stable", source: "github", repo: "hoklims/semctx" }],
      claudePlugins: [{ id: "semctx@semctx-stable", scope: "user", enabled: false, version: "0.1.10" }],
    });
    const report = executeInstall("C:\\work\\project", parseArgs(["install"]), runtime);

    expect(report.ok).toBe(true);
    expect(runtime.commands).toContainEqual([
      "claude",
      "plugin",
      "enable",
      "semctx@semctx-stable",
      "--scope",
      "user",
    ]);
  });

  test("fails closed when Codex still exposes an old plugin version after a successful command", () => {
    const runtime = fakeRuntime({
      codex: true,
      claude: false,
      codexPluginsAfter: {
        installed: [{
          pluginId: "semctx-control@semctx-stable",
          installed: true,
          enabled: true,
          version: "0.1.10",
        }],
      },
    });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(false);
    expect(report.hosts.codex.status).toBe("failed");
    expect(report.hosts.codex.error).toContain("expected plugin v0.1.17");
  });

  test("fails closed when Claude remains disabled after the enable command succeeds", () => {
    const runtime = fakeRuntime({
      codex: false,
      claude: true,
      claudeMarketplaces: [{ name: "semctx-stable", source: "github", repo: "hoklims/semctx" }],
      claudePlugins: [{
        id: "semctx@semctx-stable",
        scope: "user",
        enabled: false,
        version: "0.1.10",
      }],
      claudePluginsAfter: [{
        id: "semctx@semctx-stable",
        scope: "user",
        enabled: false,
        version: "0.1.17",
      }],
    });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(false);
    expect(report.hosts.claude.status).toBe("failed");
    expect(report.hosts.claude.error).toContain("not enabled");
  });

  test("dry-run probes state but performs no mutation or repository setup", () => {
    const runtime = fakeRuntime({ codex: true, claude: true });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--dry-run"]),
      runtime,
    );

    expect(report.ok).toBe(true);
    expect(report.dryRun).toBe(true);
    expect(report.workspace.status).toBe("planned");
    expect(runtime.commands.some((command) => command.includes("add"))).toBe(false);
    expect(runtime.commands.some((command) => command.includes("install"))).toBe(false);
    expect(runtime.commands.some((command) => command.includes("update"))).toBe(false);
    expect(runtime.commands.some((command) => command.includes("upgrade"))).toBe(false);
    expect(runtime.commands.some((command) => command.includes("remove"))).toBe(false);
  });

  test("does not write workspace state when invoked outside a Git repository", () => {
    const runtime = fakeRuntime({ codex: true, git: false });
    const report = executeInstall("C:\\Users\\Ada", parseArgs(["install"]), runtime);

    expect(report.ok).toBe(true);
    expect(report.workspace.status).toBe("not-a-repository");
    expect(report.workspace.next).toContain("semctx setup");
  });

  test("prepares the repository root when invoked from a nested directory", () => {
    const runtime = fakeRuntime({
      codex: true,
      gitRoot: "C:\\work\\project",
    });
    const report = executeInstall(
      "C:\\work\\project\\packages\\api",
      parseArgs(["install"]),
      runtime,
    );

    expect(report.ok).toBe(true);
    expect(report.workspace.root).toBe("C:\\work\\project");
    expect(runtime.setupRoots).toEqual(["C:\\work\\project"]);
  });

  test("fails honestly when an explicitly requested host is unavailable", () => {
    const runtime = fakeRuntime({ codex: false, claude: false });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--host", "codex", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(false);
    expect(report.hosts.codex.status).toBe("missing");
    expect(report.hosts.claude.status).toBe("not-requested");
  });

  test("refuses to overwrite an unrelated Codex marketplace named semctx-stable", () => {
    const runtime = fakeRuntime({
      codex: true,
      codexMarketplaces: {
        marketplaces: [
          {
            name: "semctx-stable",
            marketplaceSource: {
              sourceType: "git",
              source: "https://github.com/someone-else/semctx.git",
            },
          },
        ],
      },
    });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(false);
    expect(report.hosts.codex.status).toBe("conflict");
    expect(report.next.join(" ")).toContain("marketplace");
    expect(runtime.commands.some((command) => command.includes("remove"))).toBe(false);
    expect(runtime.commands.some((command) => command.includes("add"))).toBe(false);
  });

  test("keeps --json machine-readable for invalid installer input", () => {
    const entrypoint = resolve(import.meta.dir, "../src/index.ts");
    const process = Bun.spawnSync(
      ["bun", entrypoint, "install", "--host", "nope", "--json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = new TextDecoder().decode(process.stdout);

    expect(process.exitCode).toBe(1);
    expect(new TextDecoder().decode(process.stderr)).toBe("");
    expect(JSON.parse(out)).toMatchObject({
      ok: false,
      version: "0.1.17",
      error: { code: "INVALID_TASK_INPUT" },
    });
  });

  test("rejects a valueless --host instead of silently falling back to auto", () => {
    const entrypoint = resolve(import.meta.dir, "../src/index.ts");
    const process = Bun.spawnSync(
      ["bun", entrypoint, "install", "--host", "--json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = new TextDecoder().decode(process.stdout);

    expect(process.exitCode).toBe(1);
    expect(new TextDecoder().decode(process.stderr)).toBe("");
    expect(JSON.parse(out)).toMatchObject({
      ok: false,
      version: "0.1.17",
      error: {
        code: "INVALID_TASK_INPUT",
        message: "--host requires auto|codex|claude|all",
      },
    });
  });
});

/**
 * The version segment of a cache path comes from the host, so it is untrusted. Anything that could
 * escape `<codexHome>/plugins/cache/<marketplace>/<plugin>/` must resolve to `null` — the caller
 * then stays fail-closed instead of inspecting, or worse scheduling a removal for, an arbitrary path.
 */
describe("Codex cache entry confinement", () => {
  test("accepts only an absolute configured CODEX_HOME", () => {
    expect(resolveCodexHome("relative/.codex", tmpdir())).toBeNull();
    expect(resolveCodexHome(`  ${CODEX_HOME}  `, tmpdir())).toBe(CODEX_HOME);
    expect(resolveCodexHome(undefined, tmpdir())).toBe(resolve(join(tmpdir(), ".codex")));
  });

  test("resolves the versioned entry under the Codex cache root", () => {
    expect(resolveCodexCacheEntry(CODEX_HOME, "0.1.17")).toBe(CODEX_CACHE_PATH);
    expect(resolveCodexCacheEntry(CODEX_HOME, "0.1.16")).toBe(CODEX_OBSOLETE_CACHE_PATH);
    // Shapes a real Codex version can legitimately take.
    expect(resolveCodexCacheEntry(CODEX_HOME, "0.2.8-13ceeea1f599")).not.toBeNull();
    expect(resolveCodexCacheEntry(CODEX_HOME, "26.805.11740")).not.toBeNull();
  });

  test("refuses a version that is not a single safe path segment", () => {
    const rejected = [
      "",
      "   ",
      "..",
      "../0.1.16",
      "..\\0.1.16",
      "0.1.16/../../../etc",
      "0.1.16\\nested",
      "0.1.16\nnested",
      "/0.1.16",
      "C:\\evil",
      "C:0.1.16",
      ".",
      ".hidden",
      "0.1.16 ",
      "0.1.16\u0000",
      "0.1.17.",
      "0.1.17+",
      "CON",
      "aux",
    ];

    for (const version of rejected) {
      expect({ version, entry: resolveCodexCacheEntry(CODEX_HOME, version) })
        .toEqual({ version, entry: null });
    }
  });

  test("refuses to guess when the Codex home is unknown or relative", () => {
    expect(resolveCodexCacheEntry(null, "0.1.17")).toBeNull();
    expect(resolveCodexCacheEntry("", "0.1.17")).toBeNull();
    expect(resolveCodexCacheEntry("relative/.codex", "0.1.17")).toBeNull();
  });
});

/**
 * The detached janitor runs for real here, against a throwaway cache tree. These cases prove the
 * properties the report promises — bounded to the obsolete version, idempotent, never touching the
 * expected one — instead of asserting only that a request was handed to the runtime.
 */
describe("obsolete Codex cache janitor", () => {
  const trees: string[] = [];

  afterEach(() => {
    for (const tree of trees.splice(0)) rmSync(tree, { recursive: true, force: true });
  });

  function cacheTree(
    versions: string[],
  ): { home: string; root: string; entry: (version: string) => string } {
    const home = mkdtempSync(join(tmpdir(), "semctx-janitor-"));
    trees.push(home);
    const root = join(home, "plugins", "cache", "semctx-stable", "semctx-control");
    const entry = (version: string) => join(root, version);
    for (const version of versions) {
      mkdirSync(join(entry(version), "dist"), { recursive: true });
      writeFileSync(join(entry(version), "dist", "semctx.js"), `// ${version}\n`);
    }
    return { home, root, entry };
  }

  function codexShim(): { directory: string; script: string; counter: string } {
    const directory = mkdtempSync(join(tmpdir(), "semctx-janitor-codex-"));
    trees.push(directory);
    const script = join(directory, "codex-shim.js");
    const counter = join(directory, "counter.txt");
    writeFileSync(
      script,
      `const { readFileSync, writeFileSync } = await import("node:fs");
const versions = JSON.parse(process.env.SEMCTX_JANITOR_SELECTED_VERSIONS ?? "[]");
let index = 0;
try { index = Number(readFileSync(process.env.SEMCTX_JANITOR_COUNTER, "utf8")); } catch {}
const version = versions[Math.min(index, Math.max(versions.length - 1, 0))];
writeFileSync(process.env.SEMCTX_JANITOR_COUNTER, String(index + 1));
process.stdout.write(JSON.stringify({ installed: [{
  pluginId: "semctx-control@semctx-stable",
  installed: true,
  enabled: true,
  version,
}] }));
`,
    );
    if (process.platform === "win32") {
      writeFileSync(
        join(directory, "codex.cmd"),
        "@echo off\r\n\"%SEMCTX_JANITOR_BUN%\" \"%SEMCTX_JANITOR_SHIM%\" %*\r\n",
      );
    } else {
      const executable = join(directory, "codex");
      writeFileSync(
        executable,
        "#!/bin/sh\n\"$SEMCTX_JANITOR_BUN\" \"$SEMCTX_JANITOR_SHIM\" \"$@\"\n",
      );
      chmodSync(executable, 0o755);
    }
    return { directory, script, counter };
  }

  function runJanitor(
    request: Record<string, string>,
    selectedVersions: string | string[] = request["keepVersion"] ?? "",
  ): number {
    const payload = Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
    const shim = codexShim();
    const versions = Array.isArray(selectedVersions) ? selectedVersions : [selectedVersions];
    const child = Bun.spawnSync(
      [process.execPath, "-e", DEFERRED_CODEX_CACHE_CLEANUP_SCRIPT, payload],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PATH: `${shim.directory}${delimiter}${process.env["PATH"] ?? ""}`,
          SEMCTX_JANITOR_BUN: process.execPath,
          SEMCTX_JANITOR_COUNTER: shim.counter,
          SEMCTX_JANITOR_SELECTED_VERSIONS: JSON.stringify(versions),
          SEMCTX_JANITOR_SHIM: shim.script,
        },
      },
    );
    return child.exitCode ?? 1;
  }

  test("retires only the obsolete entry and is idempotent", () => {
    const { root, entry } = cacheTree(["0.1.16", "0.1.17"]);
    const request = {
      cacheRoot: root,
      path: entry("0.1.16"),
      version: "0.1.16",
      keepVersion: "0.1.17",
    };

    expect(runJanitor(request)).toBe(0);
    expect(existsSync(entry("0.1.16"))).toBe(false);
    expect(existsSync(join(entry("0.1.17"), "dist", "semctx.js"))).toBe(true);

    // Re-running against an already-retired entry is a no-op success, not an error.
    expect(runJanitor(request)).toBe(0);
    expect(existsSync(join(entry("0.1.17"), "dist", "semctx.js"))).toBe(true);
  });

  test("sweeps a leftover from an interrupted attempt", () => {
    const { root, entry } = cacheTree(["0.1.16", "0.1.17"]);
    const abandoned = `${entry("0.1.16")}.semctx-obsolete`;
    mkdirSync(abandoned, { recursive: true });
    writeFileSync(join(abandoned, "stale.js"), "// stale\n");

    expect(runJanitor({ cacheRoot: root, path: entry("0.1.16"), version: "0.1.16", keepVersion: "0.1.17" })).toBe(0);
    expect(existsSync(abandoned)).toBe(false);
    expect(existsSync(entry("0.1.16"))).toBe(false);
    expect(existsSync(entry("0.1.17"))).toBe(true);
  });

  test("aborts without deleting when the expected version is not there", () => {
    const { root, entry } = cacheTree(["0.1.16"]);

    expect(runJanitor({ cacheRoot: root, path: entry("0.1.16"), version: "0.1.16", keepVersion: "0.1.17" })).toBe(1);
    // The obsolete entry survives: with no proven replacement, removing it would strand the host.
    expect(existsSync(join(entry("0.1.16"), "dist", "semctx.js"))).toBe(true);
  });

  test("refuses a request whose path is not inside the Codex plugin cache", () => {
    const { home, root, entry } = cacheTree(["0.1.16", "0.1.17"]);
    const outside = join(home, "elsewhere", "0.1.16");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "keep.js"), "// keep\n");

    expect(runJanitor({ cacheRoot: root, path: outside, version: "0.1.16", keepVersion: "0.1.17" })).toBe(2);
    expect(existsSync(join(outside, "keep.js"))).toBe(true);
    expect(existsSync(entry("0.1.16"))).toBe(true);
  });

  test("refuses to retire the version it is told to keep", () => {
    const { root, entry } = cacheTree(["0.1.17"]);

    expect(runJanitor({ cacheRoot: root, path: entry("0.1.17"), version: "0.1.17", keepVersion: "0.1.17" })).toBe(2);
    expect(existsSync(join(entry("0.1.17"), "dist", "semctx.js"))).toBe(true);
  });

  test("refuses a request whose basename disagrees with the declared version", () => {
    const { root, entry } = cacheTree(["0.1.16", "0.1.17"]);

    expect(runJanitor({ cacheRoot: root, path: entry("0.1.16"), version: "0.1.15", keepVersion: "0.1.17" })).toBe(2);
    expect(existsSync(entry("0.1.16"))).toBe(true);
  });

  test("refuses a valid cache suffix under a different root", () => {
    const { root, entry } = cacheTree(["0.1.16", "0.1.17"]);
    const fakeHome = mkdtempSync(join(tmpdir(), "semctx-janitor-fake-root-"));
    trees.push(fakeHome);
    const outside = join(
      fakeHome,
      "plugins",
      "cache",
      "semctx-stable",
      "semctx-control",
      "0.1.16",
    );
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "keep.js"), "// keep\n");

    expect(runJanitor({ cacheRoot: root, path: outside, version: "0.1.16", keepVersion: "0.1.17" })).toBe(2);
    expect(existsSync(join(outside, "keep.js"))).toBe(true);
    expect(existsSync(entry("0.1.16"))).toBe(true);
  });

  test("preserves a retired fallback when the expected version disappeared", () => {
    const { root, entry } = cacheTree([]);
    const retired = `${entry("0.1.16")}.semctx-obsolete`;
    mkdirSync(retired, { recursive: true });
    writeFileSync(join(retired, "fallback.js"), "// fallback\n");

    expect(runJanitor({ cacheRoot: root, path: entry("0.1.16"), version: "0.1.16", keepVersion: "0.1.17" })).toBe(1);
    expect(existsSync(join(retired, "fallback.js"))).toBe(true);
  });

  test("aborts when Codex reselected the version that was previously obsolete", () => {
    const { root, entry } = cacheTree(["0.1.16", "0.1.17"]);

    expect(
      runJanitor(
        { cacheRoot: root, path: entry("0.1.16"), version: "0.1.16", keepVersion: "0.1.17" },
        "0.1.16",
      ),
    ).toBe(1);
    expect(existsSync(join(entry("0.1.16"), "dist", "semctx.js"))).toBe(true);
    expect(existsSync(join(entry("0.1.17"), "dist", "semctx.js"))).toBe(true);
  });

  test("restores the obsolete entry when Codex changes selection after rename", () => {
    const { root, entry } = cacheTree(["0.1.16", "0.1.17"]);
    const retired = `${entry("0.1.16")}.semctx-obsolete`;

    expect(
      runJanitor(
        { cacheRoot: root, path: entry("0.1.16"), version: "0.1.16", keepVersion: "0.1.17" },
        ["0.1.17", "0.1.16"],
      ),
    ).toBe(1);
    expect(existsSync(join(entry("0.1.16"), "dist", "semctx.js"))).toBe(true);
    expect(existsSync(retired)).toBe(false);
    expect(existsSync(join(entry("0.1.17"), "dist", "semctx.js"))).toBe(true);
  });
});
