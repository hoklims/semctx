import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve, sep } from "node:path";
import { parseArgs } from "../src/args";
import packageJson from "../package.json";
import {
  executeInstall,
  DEFERRED_CODEX_CACHE_CLEANUP_SCRIPT,
  resolveInstallHostCommand,
  resolveCodexCacheEntry,
  resolveCodexHome,
  setupExecutionFromCommandResult,
  type CodexBundleProbe,
  type CodexCacheCleanupRequest,
  type CodexPayloadProbe,
  type CommandResult,
  type InstallRuntime,
  type InstallReport,
  type SetupExecution,
} from "../src/commands/install";
import {
  readClaudePluginMetadataInventory,
  type CodexPluginMetadataInventory,
  type ClaudePluginMetadataInventory,
} from "@semantic-context/app-services";

const newerVersionParts = packageJson.version.split(".").map(Number);
const newerFixtureVersion = `${newerVersionParts[0]}.${newerVersionParts[1]}.${newerVersionParts[2]! + 1}`;

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
const CODEX_CACHE_PATH = join(CODEX_CACHE_ROOT, packageJson.version);
const CODEX_OBSOLETE_CACHE_PATH = join(CODEX_CACHE_ROOT, "0.1.17");
const CODEX_ACTIVE_CACHE_LOCK =
  "failed to back up plugin cache entry: Accès refusé. (os error 5)";

function fixtureEnvironmentWithPath(
  directory: string,
  source: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {};
  let inheritedPath = "";
  for (const [name, value] of Object.entries(source)) {
    if (name.toUpperCase() === "PATH") {
      inheritedPath ||= value ?? "";
    } else {
      environment[name] = value;
    }
  }
  environment["PATH"] = `${directory}${delimiter}${inheritedPath}`;
  return environment;
}

function bundleDigests(
  overrides: Record<string, CodexBundleProbe> = {},
): Record<string, CodexBundleProbe> {
  return {
    "semctx-index-worker.js": { status: "ok", sha256: "worker-digest" },
    "semctx-mcp.js": { status: "ok", sha256: "mcp-digest" },
    "semctx-shared.js": { status: "ok", sha256: "shared-digest" },
    "semctx.js": { status: "ok", sha256: "cli-digest" },
    ...overrides,
  };
}

function probe(
  version: string | undefined = packageJson.version,
  overrides: Record<string, CodexBundleProbe> = {},
): CodexPayloadProbe {
  return {
    ...(version === undefined ? {} : {
      identity: { name: "semctx-control", version },
      version,
    }),
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
  preflight?: SetupExecution;
  claudeMetadata?: ClaudePluginMetadataInventory | null;
  codexMetadata?: CodexPluginMetadataInventory | null;
  /** Per-command outcome overrides, keyed by the joined argv, applied before any hardcoded branch. */
  queryOutcomes?: Record<string, Partial<CommandResult>>;
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
  let codexMutated = false;
  let claudeMutated = false;
  const ok = (out = ""): CommandResult => ({ code: 0, out, err: "" });
  const missing = (name: string): CommandResult => ({
    code: 1,
    out: "",
    err: `${name} not found`,
  });

  return {
    commands,
    ...(Object.prototype.hasOwnProperty.call(options, "claudeMetadata")
      ? {
          readClaudePluginMetadata: () => options.claudeMetadata ?? null,
        }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(options, "codexMetadata")
      ? { readCodexPluginMetadata: () => options.codexMetadata ?? null }
      : {}),
    run(command, _cwd) {
      const argv = [...command];
      commands.push(argv);
      const [program, ...args] = argv;
      const override = options.queryOutcomes?.[argv.join(" ")];
      if (override !== undefined) {
        return { code: 1, out: "", err: "", ...override };
      }

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
        const state = codexMutated
          ? options.codexPluginsAfter ?? {
            installed: [{
              pluginId: "semctx-control@semctx-stable",
              installed: true,
              enabled: true,
              version: packageJson.version,
            }],
            available: [],
          }
          : options.codexPlugins ?? { installed: [], available: [] };
        return ok(JSON.stringify(state));
      }
      if (argv.join(" ") === "claude plugin marketplace list --json") {
        return ok(JSON.stringify(options.claudeMarketplaces ?? []));
      }
      if (argv.join(" ") === "claude plugin list --json") {
        const state = claudeMutated
          ? options.claudePluginsAfter ?? [{
            id: "semctx@semctx-stable",
            scope: "user",
            enabled: true,
            version: packageJson.version,
          }]
          : options.claudePlugins ?? [];
        return ok(JSON.stringify(state));
      }
      if (argv.join(" ") === options.failCommand) {
        return { code: 1, out: "", err: options.failError ?? "injected command failure" };
      }
      if (program === "codex" && args[0] === "plugin") codexMutated = true;
      if (program === "claude" && args[0] === "plugin") claudeMutated = true;
      return ok("{}\n");
    },
    setup(root, dryRun) {
      if (dryRun) {
        return options.preflight ?? {
          code: 0,
          report: {
            kind: "setup_plan",
            verdict: "SETUP_PLANNED",
            plannedChanges: [".semctx/config.json"],
            analysisReady: "unknown",
            setupReady: "unknown",
          },
          err: "",
        };
      }
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
        version: packageJson.version,
        source: { source: "local", path: CODEX_SNAPSHOT_PATH },
        ...overrides,
      },
    ],
    available: [],
  };
}

function installWithLockedAdd(options: FakeOptions): ReturnType<typeof fakeRuntime> {
  return fakeRuntime({
    ...stableCodexOptions("0.1.17"),
    failCommand: "codex plugin add semctx-control@semctx-stable --json",
    failError: CODEX_ACTIVE_CACHE_LOCK,
    ...options,
  });
}

describe("semctx install — no-brain host + repository bootstrap", () => {
  test("fixture PATH replaces a Windows-style Path key instead of creating an ambiguous duplicate", () => {
    const environment = fixtureEnvironmentWithPath("C:\\fixture-bin", {
      Path: "C:\\system-bin",
      CLAUDE_CONFIG_DIR: "C:\\profile",
    });

    expect(Object.keys(environment).filter((name) => name.toUpperCase() === "PATH")).toEqual(["PATH"]);
    expect(environment["PATH"]).toBe(`C:\\fixture-bin${delimiter}C:\\system-bin`);
    expect(environment["CLAUDE_CONFIG_DIR"]).toBe("C:\\profile");
  });

  test("resolves a Windows npm Codex shim to Node and preserves argv boundaries", () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-codex-launcher-"));
    const launcher = join(root, "codex.cmd");
    const batchLauncher = join(root, "codex.bat");
    const node = process.platform === "win32" ? process.execPath : join(root, "node.exe");
    if (process.platform !== "win32") {
      copyFileSync(process.execPath, node);
      chmodSync(node, 0o755);
    }
    const entrypoint = join(root, "node_modules", "@openai", "codex", "bin", "codex.js");
    const args = ["plugin", "marketplace", "add", "source with spaces", "--ref", "stable&literal"];
    mkdirSync(resolve(entrypoint, ".."), { recursive: true });
    writeFileSync(launcher, "@echo off\r\nexit /b 99\r\n");
    writeFileSync(batchLauncher, "@echo off\r\nexit /b 99\r\n");
    writeFileSync(entrypoint, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    try {
      const resolved = resolveInstallHostCommand(
        ["codex", ...args],
        "win32",
        (name) => name === "codex" ? launcher : name === "node" ? node : null,
      );
      expect(resolved).toEqual([node, entrypoint, ...args]);
      const child = Bun.spawnSync([...resolved!], { stdout: "pipe", stderr: "pipe" });
      expect(child.exitCode).toBe(0);
      expect(JSON.parse(new TextDecoder().decode(child.stdout))).toEqual(args);
      expect(resolveInstallHostCommand(
        ["codex", ...args],
        "win32",
        (name) => name === "codex" ? batchLauncher : name === "node" ? node : null,
      )).toEqual([node, entrypoint, ...args]);
      expect(resolveInstallHostCommand(
        ["codex", ...args],
        "win32",
        (name) => name === "codex" ? launcher : null,
      )).toBeNull();
      rmSync(entrypoint);
      expect(resolveInstallHostCommand(
        ["codex", ...args],
        "win32",
        (name) => name === "codex" ? launcher : name === "node" ? node : null,
      )).toBeNull();
      expect(resolveInstallHostCommand(["codex", ...args], "linux", () => launcher))
        .toEqual(["codex", ...args]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves a structured nonzero setup report instead of flattening it into stderr", () => {
    const report = {
      kind: "setup_conflict",
      verdict: "SETUP_REFUSED",
      conflict: { code: "CONFIG_INVALID", message: "linked sidecar", details: { path: "semctx.db-wal" } },
    };
    expect(setupExecutionFromCommandResult({ code: 1, out: JSON.stringify(report), err: "" })).toEqual({
      code: 1,
      report,
      err: "",
    });
    expect(setupExecutionFromCommandResult({ code: 1, out: "not json", err: "" })).toEqual({
      code: 1,
      report: null,
      err: "not json",
    });
  });

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

  test("reports interfaceUnsupported and a host-CLI upgrade remedy when the host CLI rejects the plugin inventory query", () => {
    const runtime = fakeRuntime({
      codex: true,
      claude: false,
      queryOutcomes: {
        "codex plugin marketplace list --json": {
          code: 2,
          err: "error: unexpected argument 'marketplace' found\n\nUsage: codex plugin <COMMAND>\n",
        },
      },
    });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(false);
    expect(report.hosts.codex.status).toBe("failed");
    expect(report.hosts.codex.interfaceUnsupported).toBe(true);
    expect(report.next.some((step) => step.includes("does not support the plugin commands"))).toBe(true);
    expect(report.next).not.toContain("resolve the Codex command error above, then re-run");
    expect(runtime.commands.filter((command) => command[0] === "codex")).toEqual([
      ["codex", "--version"],
      ["codex", "plugin", "marketplace", "list", "--json"],
      ["codex", "plugin", "list", "--json"],
    ]);
  });

  test("an unsupported Codex inventory prevents every requested host mutation", () => {
    const runtime = fakeRuntime({
      codex: true,
      claude: true,
      queryOutcomes: {
        "codex plugin marketplace list --json": {
          code: 2,
          err: "error: unexpected argument 'marketplace' found",
        },
      },
    });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--host", "all", "--skip-setup"]),
      runtime,
    );
    expect(report.ok).toBe(false);
    expect(report.hosts.codex.status).toBe("failed");
    expect(report.hosts.codex.interfaceUnsupported).toBe(true);
    expect(report.hosts.claude.status).toBe("planned");
    expect(runtime.commands.some((command) => command.includes("install"))).toBe(false);
    expect(runtime.commands.filter((command) => command[0] === "codex")).toEqual([
      ["codex", "--version"],
      ["codex", "plugin", "marketplace", "list", "--json"],
      ["codex", "plugin", "list", "--json"],
    ]);
  });

  test("an unsupported Claude inventory prevents Codex and Claude mutations", () => {
    const runtime = fakeRuntime({
      codex: true,
      claude: true,
      queryOutcomes: {
        "claude plugin marketplace list --json": {
          code: 1,
          err: "error: unknown command 'plugin'",
        },
      },
    });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--host", "all", "--skip-setup"]),
      runtime,
    );
    expect(report.ok).toBe(false);
    expect(report.hosts.codex.status).toBe("planned");
    expect(report.hosts.claude.status).toBe("failed");
    expect(report.hosts.claude.interfaceUnsupported).toBe(true);
    expect(runtime.commands.some((command) => command.includes("add") || command.includes("install")
      || command.includes("update") || command.includes("upgrade") || command.includes("remove")
      || command.includes("enable"))).toBe(false);
    expect(report.next.some((step) => step.includes("does not support the plugin commands"))).toBe(true);
    expect(runtime.commands.filter((command) => command[0] === "claude")).toEqual([
      ["claude", "--version"],
      ["claude", "plugin", "marketplace", "list", "--json"],
      ["claude", "plugin", "list", "--json"],
    ]);
  });

  test("Claude dry-run reads declarative metadata without launching plugin list commands", () => {
    const runtime = fakeRuntime({
      codex: false,
      claude: true,
      claudeMetadata: { marketplaces: [], plugins: [], settingsValid: true, effectiveEnablement: {} },
    });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--host", "claude", "--dry-run", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(true);
    expect(report.hosts.claude.status).toBe("planned");
    expect(runtime.commands.filter((command) => command[0] === "claude")).toEqual([
      ["claude", "--version"],
    ]);
    expect(runtime.commands.some((command) => command.includes("install") || command.includes("add")))
      .toBe(false);
  });

  test("unavailable Claude declarative metadata fails closed without launching Claude plugin queries", () => {
    const runtime = fakeRuntime({ codex: false, claude: true, claudeMetadata: null });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--host", "claude", "--dry-run", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(false);
    expect(report.hosts.claude.status).toBe("failed");
    expect(report.hosts.claude.error).toContain("declarative plugin metadata safely");
    expect(runtime.commands.filter((command) => command[0] === "claude")).toEqual([
      ["claude", "--version"],
    ]);
  });

  test("a fresh Claude profile dry-run plans from proven empty metadata and writes no profile file", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "semctx-install-fresh-claude-")));
    const profile = join(root, "profile");
    const bin = join(root, "bin");
    const unexpected = join(root, "unexpected-plugin-query");
    mkdirSync(profile);
    mkdirSync(bin);
    const script = join(bin, "claude-shim.js");
    writeFileSync(
      script,
      `const fs = require("node:fs");\n`
        + `if (process.argv.slice(2).join(" ") === "--version") { console.log("2.1.229"); process.exit(0); }\n`
        + `fs.writeFileSync(${JSON.stringify(unexpected)}, "called"); process.exit(9);\n`,
    );
    if (process.platform === "win32") {
      const compiled = Bun.spawnSync(
        [process.execPath, "build", "--compile", script, "--outfile", join(bin, "claude.exe")],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(compiled.exitCode).toBe(0);
    } else {
      writeFileSync(join(bin, "claude"), `#!/bin/sh\n"${process.execPath}" "${script}" "$@"\n`);
      chmodSync(join(bin, "claude"), 0o755);
    }
    const environment = fixtureEnvironmentWithPath(bin);
    environment["CLAUDE_CONFIG_DIR"] = profile;
    const entrypoint = resolve(import.meta.dir, "../src/index.ts");
    try {
      const child = Bun.spawnSync([
        process.execPath,
        entrypoint,
        "install",
        "--host",
        "claude",
        "--dry-run",
        "--skip-setup",
        "--json",
      ], { env: environment, stdout: "pipe", stderr: "pipe" });
      const report = JSON.parse(new TextDecoder().decode(child.stdout)) as InstallReport;
      expect(child.exitCode).toBe(0);
      expect(report.hosts.claude.status).toBe("planned");
      expect(existsSync(unexpected)).toBe(false);
      expect(existsSync(join(profile, "plugins"))).toBe(false);
      expect(readdirSync(profile)).toEqual([]);

      const settings = join(profile, "settings.json");
      writeFileSync(settings, "{not-json");
      const malformed = Bun.spawnSync([
        process.execPath,
        entrypoint,
        "install",
        "--host",
        "claude",
        "--dry-run",
        "--skip-setup",
        "--json",
      ], { env: environment, stdout: "pipe", stderr: "pipe" });
      const malformedReport = JSON.parse(
        new TextDecoder().decode(malformed.stdout),
      ) as InstallReport;
      expect(malformed.exitCode).toBe(1);
      expect(malformedReport.hosts.claude.status).toBe("failed");
      expect(malformedReport.hosts.claude.error).toContain("settings layer is malformed");
      expect(existsSync(unexpected)).toBe(false);
      expect(readdirSync(profile)).toEqual(["settings.json"]);
      expect(readFileSync(settings, "utf8")).toBe("{not-json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Codex dry-run never starts the host CLI and leaves fresh or malformed profiles intact", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "semctx-install-readonly-codex-")));
    const profile = join(root, "profile");
    const project = join(root, "project");
    const bin = join(root, "bin");
    const unexpected = join(root, "unexpected-codex-invocation");
    mkdirSync(profile);
    mkdirSync(bin);
    mkdirSync(join(project, ".git"), { recursive: true });
    writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
    const script = join(bin, "codex-shim.js");
    writeFileSync(script,
      `require("node:fs").writeFileSync(${JSON.stringify(unexpected)}, "called"); process.exit(9);\n`);
    if (process.platform === "win32") {
      const compiled = Bun.spawnSync(
        [process.execPath, "build", "--compile", script, "--outfile", join(bin, "codex.exe")],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(compiled.exitCode).toBe(0);
    } else {
      writeFileSync(join(bin, "codex"), `#!/bin/sh\n"${process.execPath}" "${script}" "$@"\n`);
      chmodSync(join(bin, "codex"), 0o755);
    }
    const environment = fixtureEnvironmentWithPath(bin);
    environment["CODEX_HOME"] = profile;
    environment["HOME"] = join(root, "home");
    // The read-only Windows OS query requires an existing home, never startup-created caller state.
    mkdirSync(environment["HOME"]);
    environment["USERPROFILE"] = environment["HOME"];
    const entrypoint = resolve(import.meta.dir, "../src/index.ts");
    const run = (dryRun = true) => Bun.spawnSync([
      process.execPath, entrypoint, "install", "--root", project, "--host", "codex",
      ...(dryRun ? ["--dry-run"] : []), "--skip-setup", "--json",
    ], { env: environment, stdout: "pipe", stderr: "pipe" });
    try {
      const fresh = run();
      if (fresh.exitCode !== 0) {
        console.error("Codex read-only fixture child failed", JSON.stringify({
          exitCode: fresh.exitCode,
          stdout: new TextDecoder().decode(fresh.stdout).slice(0, 8192),
          stderr: new TextDecoder().decode(fresh.stderr).slice(0, 8192),
        }));
      }
      expect(fresh.exitCode).toBe(0);
      expect((JSON.parse(new TextDecoder().decode(fresh.stdout)) as InstallReport).hosts.codex.status)
        .toBe("planned");
      expect((JSON.parse(new TextDecoder().decode(fresh.stdout)) as InstallReport).hosts.codex.version)
        .toBeNull();
      expect(existsSync(unexpected)).toBe(false);
      expect(readdirSync(profile)).toEqual([]);

      const config = join(profile, "config.toml");
      writeFileSync(config, "[plugins.'semctx-control@semctx-stable'\n");
      const malformed = run();
      expect(malformed.exitCode).toBe(1);
      expect((JSON.parse(new TextDecoder().decode(malformed.stdout)) as InstallReport).hosts.codex.error)
        .toContain("declarative plugin metadata safely");
      expect(existsSync(unexpected)).toBe(false);
      expect(readdirSync(profile)).toEqual(["config.toml"]);
      expect(readFileSync(config, "utf8")).toBe("[plugins.'semctx-control@semctx-stable'\n");

      const foreign = `[marketplaces.semctx-stable]\nsource_type = 'git'\nsource = 'someone/else'\n`;
      writeFileSync(config, foreign);
      const manifestRoot = join(profile, ".tmp", "marketplaces", "semctx-stable", ".agents", "plugins");
      mkdirSync(manifestRoot, { recursive: true });
      writeFileSync(join(manifestRoot, "marketplace.json"), JSON.stringify({ name: "semctx-stable", plugins: [] }));
      const conflict = run();
      expect(conflict.exitCode).toBe(1);
      expect((JSON.parse(new TextDecoder().decode(conflict.stdout)) as InstallReport).hosts.codex.status)
        .toBe("conflict");
      expect(existsSync(unexpected)).toBe(false);
      expect(readFileSync(config, "utf8")).toBe(foreign);

      const canonical = `[marketplaces.semctx-stable]\nsource_type = 'git'\nsource = 'hoklims/semctx'\n`;
      writeFileSync(config, canonical);
      const pluginRoot = join(profile, ".tmp", "marketplaces", "semctx-stable", "plugins", "semctx-control");
      mkdirSync(pluginRoot, { recursive: true });
      const manifest = (products: string[] | null) => ({
        name: "semctx-stable",
        plugins: [{
          name: "semctx-control",
          source: { source: "local", path: "./plugins/semctx-control" },
          policy: { installation: "AVAILABLE", products },
        }],
      });
      for (const products of [[], ["CHATGPT"]]) {
        writeFileSync(join(manifestRoot, "marketplace.json"), JSON.stringify(manifest(products)));
        for (const dryRun of [true, false]) {
          const excluded = run(dryRun);
          const excludedReport = JSON.parse(new TextDecoder().decode(excluded.stdout)) as InstallReport;
          expect(excluded.exitCode).toBe(1);
          expect(excludedReport.hosts.codex.status).toBe("failed");
          expect(existsSync(unexpected)).toBe(false);
        }
      }
      writeFileSync(join(manifestRoot, "marketplace.json"), JSON.stringify(manifest(["CODEX"])));
      const supported = run();
      expect(supported.exitCode).toBe(0);
      expect((JSON.parse(new TextDecoder().decode(supported.stdout)) as InstallReport).hosts.codex.status)
        .toBe("planned");
      expect(existsSync(unexpected)).toBe(false);
      for (const directory of ["local", packageJson.version]) {
        const cacheRoot = join(profile, "plugins", "cache", "semctx-stable", "semctx-control", directory);
        mkdirSync(join(cacheRoot, ".codex-plugin"), { recursive: true });
        const cacheManifest = join(cacheRoot, ".codex-plugin", "plugin.json");
        writeFileSync(cacheManifest, JSON.stringify({ name: "semctx-control", version: packageJson.version }));
        for (const dryRun of [true, false]) {
          const orphan = run(dryRun);
          const orphanReport = JSON.parse(new TextDecoder().decode(orphan.stdout)) as InstallReport;
          expect(orphan.exitCode).toBe(1);
          expect(orphanReport.hosts.codex.status).toBe("conflict");
          expect(orphanReport.hosts.codex.error).toContain(directory === "local"
            ? "local Semctx development cache overrides" : "without a plugin registration");
          expect(existsSync(unexpected)).toBe(false);
        }
        for (const name of [undefined, 123, "foreign-control"]) {
          writeFileSync(cacheManifest, JSON.stringify({ name, version: packageJson.version }));
          for (const dryRun of [true, false]) {
            const malformedCache = run(dryRun);
            const cacheReport = JSON.parse(new TextDecoder().decode(malformedCache.stdout)) as InstallReport;
            expect(malformedCache.exitCode).toBe(1);
            expect(cacheReport.hosts.codex.status).toBe("failed");
            expect(existsSync(unexpected)).toBe(false);
          }
        }
        rmSync(cacheRoot, { recursive: true, force: true });
      }
      const foreignCache = join(root, "foreign-cache");
      mkdirSync(foreignCache);
      rmSync(join(profile, "plugins"), { recursive: true, force: true });
      symlinkSync(foreignCache, join(profile, "plugins"), process.platform === "win32" ? "junction" : "dir");
      for (const dryRun of [true, false]) {
        const linkedCache = run(dryRun);
        expect(linkedCache.exitCode).toBe(1);
        expect(existsSync(unexpected)).toBe(false);
        expect(readdirSync(foreignCache)).toEqual([]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a local Codex development cache conflicts explicitly before stable installation", () => {
    const runtime = fakeRuntime({ codexMetadata: {
      marketplaces: [{ name: "semctx-stable", marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE } }],
      plugins: [{ pluginId: "semctx-control@semctx-stable", installed: true, enabled: true,
        version: "0.3.4", cacheDirectory: "local" }],
    } });
    const report = executeInstall("C:\\work\\project",
      parseArgs(["install", "--host", "codex", "--dry-run", "--skip-setup"]), runtime);
    expect(report.ok).toBe(false);
    expect(report.hosts.codex.status).toBe("conflict");
    expect(report.hosts.codex.error).toContain("local Semctx development cache overrides");
    expect(runtime.commands.filter((command) => command[0] === "codex")).toEqual([["codex", "--version"]]);
  });

  test("malformed Claude project identity blocks dry-run and apply before every mutation", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "semctx-install-identity-claude-")));
    const project = join(root, "project");
    const profile = join(root, "profile");
    const plugins = join(profile, "plugins");
    const bin = join(root, "bin");
    const unexpected = join(root, "unexpected-plugin-mutation");
    mkdirSync(project);
    mkdirSync(plugins, { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(profile, "settings.json"), "{}");
    const installed = join(plugins, "installed_plugins.json");
    const marketplace = join(plugins, "known_marketplaces.json");
    const installedBytes = JSON.stringify({
      version: 2,
      plugins: {
        "semctx@semctx-stable": [{
          scope: "project",
          projectPath: "\0",
          installPath: join(plugins, "cache", "semctx-stable", "semctx", packageJson.version),
          version: packageJson.version,
        }],
      },
    });
    writeFileSync(installed, installedBytes);
    const script = join(bin, "claude-shim.js");
    writeFileSync(
      script,
      `const fs = require("node:fs");\n`
        + `if (process.argv.slice(2).join(" ") === "--version") { console.log("2.1.229"); process.exit(0); }\n`
        + `fs.writeFileSync(${JSON.stringify(unexpected)}, "called"); process.exit(9);\n`,
    );
    if (process.platform === "win32") {
      const compiled = Bun.spawnSync(
        [process.execPath, "build", "--compile", script, "--outfile", join(bin, "claude.exe")],
        { stdout: "pipe", stderr: "pipe", timeout: 10_000 },
      );
      expect(compiled.exitCode).toBe(0);
    } else {
      writeFileSync(join(bin, "claude"), `#!/bin/sh\n"${process.execPath}" "${script}" "$@"\n`);
      chmodSync(join(bin, "claude"), 0o755);
    }
    const environment = fixtureEnvironmentWithPath(bin);
    environment["CLAUDE_CONFIG_DIR"] = profile;
    const entrypoint = resolve(import.meta.dir, "../src/index.ts");
    const run = (
      dryRun: boolean,
      env: Record<string, string | undefined> = environment,
    ): { child: ReturnType<typeof Bun.spawnSync>; report: InstallReport } => {
      const child = Bun.spawnSync([
        process.execPath,
        entrypoint,
        "install",
        "--root",
        project,
        "--host",
        "claude",
        ...(dryRun ? ["--dry-run"] : []),
        "--skip-setup",
        "--json",
      ], { env, stdout: "pipe", stderr: "pipe", timeout: 5_000 });
      return {
        child,
        report: JSON.parse(new TextDecoder().decode(child.stdout)) as InstallReport,
      };
    };
    try {
      for (const dryRun of [true, false]) {
        const { child, report } = run(dryRun);
        expect(child.exitCode).toBe(1);
        expect(report.hosts.claude.status).toBe("failed");
        expect(report.hosts.claude.error).toContain("declarative plugin metadata safely");
        expect(existsSync(unexpected)).toBe(false);
        expect(readFileSync(installed, "utf8")).toBe(installedBytes);
        expect(readdirSync(project)).toEqual([]);
      }

      const emptyInstalledBytes = '{"version":2,"plugins":{}}';
      const directoryMarketplaceBytes = JSON.stringify({
        "semctx-stable": {
          source: { source: "directory", path: "hoklims/semctx" },
          installLocation: join(plugins, "marketplaces", "semctx-stable"),
          lastUpdated: "2026-09-26T00:00:00Z",
        },
      });
      writeFileSync(installed, emptyInstalledBytes);
      writeFileSync(marketplace, directoryMarketplaceBytes);
      for (const dryRun of [true, false]) {
        const { child, report } = run(dryRun);
        expect(child.exitCode).toBe(1);
        expect(report.hosts.claude.status).toBe("failed");
        expect(report.hosts.claude.error).toContain("declarative plugin metadata safely");
        expect(existsSync(unexpected)).toBe(false);
        expect(readFileSync(installed, "utf8")).toBe(emptyInstalledBytes);
        expect(readFileSync(marketplace, "utf8")).toBe(directoryMarketplaceBytes);
        expect(readdirSync(project)).toEqual([]);
      }

      const localDirectory = join(root, "hoklims", "semctx");
      mkdirSync(localDirectory, { recursive: true });
      const localDirectoryMarketplaceBytes = JSON.stringify({
        "semctx-stable": {
          source: { source: "directory", path: localDirectory },
          installLocation: join(plugins, "marketplaces", "semctx-stable"),
          lastUpdated: "2026-09-26T00:00:00Z",
        },
      });
      writeFileSync(marketplace, localDirectoryMarketplaceBytes);
      for (const dryRun of [true, false]) {
        const { child, report } = run(dryRun);
        expect(child.exitCode).toBe(1);
        expect(report.hosts.claude.status).toBe("conflict");
        expect(report.hosts.claude.error).toContain("already points to another source");
        expect(existsSync(unexpected)).toBe(false);
        expect(readFileSync(marketplace, "utf8")).toBe(localDirectoryMarketplaceBytes);
        expect(readdirSync(project)).toEqual([]);
      }

      const canonicalGithub = { source: "github", repo: "hoklims/semctx", ref: "stable" };
      const canonicalGit = {
        source: "git",
        url: "https://github.com/hoklims/semctx.git",
        ref: "stable",
      };
      const fullyQualifiedLocation = join(plugins, "marketplaces", "semctx-stable");
      mkdirSync(fullyQualifiedLocation, { recursive: true });
      const writeMarketplace = (source: Record<string, unknown>, installLocation: string): string => {
        const bytes = JSON.stringify({
          "semctx-stable": {
            source,
            installLocation,
            lastUpdated: "2026-09-27T00:00:00Z",
          },
        });
        writeFileSync(marketplace, bytes);
        return bytes;
      };
      for (const installLocation of [
        "\0",
        "relative-marketplace",
        `${profile}\nmarketplace`,
        ...(process.platform === "win32" ? ["\\other", "/other", "C:other"] : []),
      ]) {
        const bytes = writeMarketplace(canonicalGithub, installLocation);
        for (const dryRun of [true, false]) {
          const { child, report } = run(dryRun);
          expect(child.exitCode).toBe(1);
          expect(report.hosts.claude.status).toBe("failed");
          expect(report.hosts.claude.error).toContain("declarative plugin metadata safely");
          expect(existsSync(unexpected)).toBe(false);
          expect(readFileSync(marketplace, "utf8")).toBe(bytes);
          expect(readdirSync(project)).toEqual([]);
        }
      }

      const traversalTarget = join(root, "traversal-target", "nested");
      const traversalLink = join(root, "traversal-link");
      const traversalFile = join(root, "traversal-file");
      mkdirSync(traversalTarget, { recursive: true });
      symlinkSync(
        traversalTarget,
        traversalLink,
        process.platform === "win32" ? "junction" : "dir",
      );
      writeFileSync(traversalFile, "not a directory");
      for (const installLocation of [
        `${traversalLink}${sep}..${sep}marketplace`,
        `${traversalFile}${sep}..${sep}marketplace`,
      ]) {
        const bytes = writeMarketplace(canonicalGithub, installLocation);
        for (const dryRun of [true, false]) {
          const { child, report } = run(dryRun);
          expect(child.exitCode).toBe(1);
          expect(report.hosts.claude.status).toBe("failed");
          expect(report.hosts.claude.error).toContain("declarative plugin metadata safely");
          expect(existsSync(unexpected)).toBe(false);
          expect(readFileSync(marketplace, "utf8")).toBe(bytes);
        }
      }

      const relativeGitBytes = writeMarketplace(
        { source: "git", url: "hoklims/semctx", ref: "stable" },
        fullyQualifiedLocation,
      );
      for (const dryRun of [true, false]) {
        const { child, report } = run(dryRun);
        expect(child.exitCode).toBe(1);
        expect(report.hosts.claude.status).toBe("conflict");
        expect(report.hosts.claude.error).toContain("already points to another source");
        expect(existsSync(unexpected)).toBe(false);
        expect(readFileSync(marketplace, "utf8")).toBe(relativeGitBytes);
      }

      for (const source of [
        { source: "github", repo: "hoklims/semctx\0", ref: "stable" },
        { source: "git", url: "https://github.com/hoklims/sem\nctx.git", ref: "stable" },
      ]) {
        const bytes = writeMarketplace(source, fullyQualifiedLocation);
        for (const dryRun of [true, false]) {
          const { child, report } = run(dryRun);
          expect(child.exitCode).toBe(1);
          expect(report.hosts.claude.status).toBe("failed");
          expect(report.hosts.claude.error).toContain("declarative plugin metadata safely");
          expect(existsSync(unexpected)).toBe(false);
          expect(readFileSync(marketplace, "utf8")).toBe(bytes);
        }
      }

      const safeTraversal = join(root, "safe-traversal");
      mkdirSync(safeTraversal);
      const safeLocation = `${safeTraversal}${sep}..${sep}profile${sep}plugins${sep}marketplaces${sep}semctx-stable`;
      for (const [source, location] of [
        [canonicalGithub, fullyQualifiedLocation],
        [canonicalGit, fullyQualifiedLocation],
        [canonicalGithub, safeLocation],
      ] as const) {
        writeMarketplace(source, location);
        const { child, report } = run(true);
        expect(child.exitCode).toBe(0);
        expect(report.hosts.claude.status).toBe("planned");
        expect(existsSync(unexpected)).toBe(false);
      }

      for (const dryRun of [true, false]) {
        const invalidHome = process.platform === "win32" ? "\\other-profile" : "relative-profile";
        const { child, report } = run(dryRun, { ...environment, CLAUDE_CONFIG_DIR: invalidHome });
        expect(child.exitCode).toBe(1);
        expect(report.hosts.claude.status).toBe("failed");
        expect(report.hosts.claude.error).toContain("declarative plugin metadata safely");
        expect(existsSync(unexpected)).toBe(false);
        expect(readdirSync(project)).toEqual([]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("Claude dry-run treats absolute and cwd-relative repository roots identically", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "semctx-install-relative-claude-")));
    const project = join(root, "project");
    const profile = join(root, "profile");
    const bin = join(root, "bin");
    const subdir = join(project, "subdir");
    mkdirSync(subdir, { recursive: true });
    mkdirSync(profile);
    mkdirSync(bin);
    writeFileSync(join(profile, "settings.json"), "{}");
    const script = join(bin, "claude-shim.js");
    writeFileSync(
      script,
      `if (process.argv.slice(2).join(" ") === "--version") { console.log("2.1.229"); process.exit(0); }\n`
        + `process.exit(9);\n`,
    );
    if (process.platform === "win32") {
      const compiled = Bun.spawnSync(
        [process.execPath, "build", "--compile", script, "--outfile", join(bin, "claude.exe")],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(compiled.exitCode).toBe(0);
    } else {
      writeFileSync(join(bin, "claude"), `#!/bin/sh\n"${process.execPath}" "${script}" "$@"\n`);
      chmodSync(join(bin, "claude"), 0o755);
    }
    const environment = fixtureEnvironmentWithPath(bin);
    environment["CLAUDE_CONFIG_DIR"] = profile;
    const entrypoint = resolve(import.meta.dir, "../src/index.ts");
    try {
      const reports = [project, ".", join("subdir", "..")].map((repositoryRoot) => {
        const child = Bun.spawnSync([
          process.execPath,
          entrypoint,
          "install",
          "--root",
          repositoryRoot,
          "--host",
          "claude",
          "--dry-run",
          "--skip-setup",
          "--json",
        ], { cwd: project, env: environment, stdout: "pipe", stderr: "pipe" });
        expect(child.exitCode).toBe(0);
        return JSON.parse(new TextDecoder().decode(child.stdout)) as InstallReport;
      });
      for (const report of reports) expect(report.hosts.claude.status).toBe("planned");
      expect(reports[1]?.hosts.claude.steps).toEqual(reports[0]?.hosts.claude.steps);
      expect(reports[2]?.hosts.claude.steps).toEqual(reports[0]?.hosts.claude.steps);

      const unsafe = Bun.spawnSync([
        process.execPath,
        entrypoint,
        "install",
        "--root",
        ".",
        "--host",
        "claude",
        "--dry-run",
        "--skip-setup",
        "--json",
      ], {
        cwd: project,
        env: { ...environment, CLAUDE_CONFIG_DIR: "relative-profile" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const unsafeReport = JSON.parse(new TextDecoder().decode(unsafe.stdout)) as InstallReport;
      expect(unsafe.exitCode).toBe(1);
      expect(unsafeReport.hosts.claude.status).toBe("failed");
      expect(unsafeReport.hosts.claude.error).toContain("declarative plugin metadata safely");
      expect(readdirSync(profile)).toEqual(["settings.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("malformed Claude settings block dry-run and apply before every plugin mutation", () => {
    for (const dryRun of [true, false]) {
      for (const plugins of [[], [{
        id: "semctx@semctx-stable",
        scope: "user",
        version: packageJson.version,
        installPath: "C:\\fixture\\semctx",
      }]]) {
        const runtime = fakeRuntime({
          codex: false,
          claude: true,
          claudeMetadata: {
            marketplaces: [],
            plugins,
            settingsValid: false,
            effectiveEnablement: {},
          },
        });
        const report = executeInstall(
          "C:\\work\\project",
          parseArgs([
            "install",
            "--host",
            "claude",
            ...(dryRun ? ["--dry-run"] : []),
            "--skip-setup",
          ]),
          runtime,
        );

        expect(report.ok).toBe(false);
        expect(report.hosts.claude.status).toBe("failed");
        expect(report.hosts.claude.error).toContain("settings layer is malformed");
        expect(runtime.commands.filter((command) => command[0] === "claude")).toEqual([
          ["claude", "--version"],
        ]);
      }
    }
  });

  test("project and local disable overrides conflict before writes, while a user disable plans enablement", () => {
    const metadataFor = (
      enabled: boolean | undefined,
      enablementScope: "user" | "project" | "local" | undefined,
      registrationScope: "user" | "project" | "local" | null = "user",
    ): ClaudePluginMetadataInventory => ({
      marketplaces: [{ name: "semctx-stable", repo: SEMCTX_SOURCE }],
      plugins: registrationScope === null ? [] : [{
        id: "semctx@semctx-stable",
        scope: registrationScope,
        ...(enabled === undefined ? {} : { enabled }),
        ...(enablementScope === undefined ? {} : { enablementScope }),
        version: packageJson.version,
      }],
      settingsValid: true,
      effectiveEnablement: enabled === undefined || enablementScope === undefined
        ? {}
        : { "semctx@semctx-stable": { enabled, scope: enablementScope } },
    });
    for (const enablementScope of ["project", "local"] as const) {
      for (const registrationScope of [null, "user", "project", "local"] as const) {
        for (const dryRun of [true, false]) {
          const runtime = fakeRuntime({
            codex: false,
            claude: true,
            claudeMetadata: metadataFor(false, enablementScope, registrationScope),
          });
          const report = executeInstall(
            "C:\\work\\project",
            parseArgs([
              "install",
              "--host",
              "claude",
              ...(dryRun ? ["--dry-run"] : []),
              "--skip-setup",
            ]),
            runtime,
          );
          expect(report.ok).toBe(false);
          expect(report.hosts.claude.status).toBe("conflict");
          expect(report.hosts.claude.error).toContain(`${enablementScope} settings override`);
          expect(runtime.commands.filter((command) => command[0] === "claude")).toEqual([
            ["claude", "--version"],
          ]);
        }
      }
    }

    for (const registrationScope of ["project", "local"] as const) {
      for (const dryRun of [true, false]) {
        const runtime = fakeRuntime({
          codex: false,
          claude: true,
          claudeMetadata: metadataFor(undefined, undefined, registrationScope),
        });
        const report = executeInstall(
          "C:\\work\\project",
          parseArgs([
            "install",
            "--host",
            "claude",
            ...(dryRun ? ["--dry-run"] : []),
            "--skip-setup",
          ]),
          runtime,
        );
        expect(report.ok).toBe(false);
        expect(report.hosts.claude.status).toBe("failed");
        expect(report.hosts.claude.error).toContain("cannot determine effective Claude plugin enablement");
        expect(runtime.commands.filter((command) => command[0] === "claude")).toEqual([
          ["claude", "--version"],
        ]);
      }
    }

    const userRuntime = fakeRuntime({
      codex: false,
      claude: true,
      claudeMetadata: metadataFor(false, "user"),
    });
    const userReport = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--host", "claude", "--dry-run", "--skip-setup"]),
      userRuntime,
    );
    expect(userReport.ok).toBe(true);
    expect(userReport.hosts.claude.steps).toContainEqual(expect.objectContaining({
      action: "enable Semctx Claude plugin",
      status: "planned",
    }));
    const unregisteredUserRuntime = fakeRuntime({
      codex: false,
      claude: true,
      claudeMetadata: metadataFor(false, "user", null),
    });
    const unregisteredUserReport = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--host", "claude", "--dry-run", "--skip-setup"]),
      unregisteredUserRuntime,
    );
    expect(unregisteredUserReport.ok).toBe(true);
    expect(unregisteredUserReport.hosts.claude.steps).toContainEqual(expect.objectContaining({
      action: "enable Semctx Claude plugin",
      status: "planned",
    }));
  });

  test("legacy Claude inventory refuses project and local registrations with false or unknown enablement", () => {
    for (const scope of ["project", "local"] as const) {
      for (const state of ["unknown", "false"] as const) {
        for (const dryRun of [true, false]) {
          const runtime = fakeRuntime({
            codex: false,
            claude: true,
            claudeMarketplaces: [],
            claudePlugins: [{
              id: "semctx@semctx-stable",
              scope,
              version: packageJson.version,
              ...(state === "false" ? { enabled: false, enablementScope: scope } : {}),
            }],
          });
          const report = executeInstall(
            "C:\\work\\project",
            parseArgs([
              "install",
              "--host",
              "claude",
              ...(dryRun ? ["--dry-run"] : []),
              "--skip-setup",
            ]),
            runtime,
          );
          expect(report.ok).toBe(false);
          expect(report.hosts.claude.status).toBe(state === "false" ? "conflict" : "failed");
          expect(runtime.commands.filter((command) =>
            command[0] === "claude"
            && command.some((token) => ["add", "install", "update", "enable", "remove"].includes(token))
          )).toEqual([]);
        }
      }
    }
  });

  test("legacy Claude marketplace shapes use the shared raw source matcher before mutations", () => {
    for (const marketplace of [
      { name: "semctx-stable", source: "git", repo: "hoklims/semctx" },
      { name: "semctx-stable", source: "future", repo: "hoklims/semctx" },
      { name: "semctx-stable", repo: "hoklims/semctx " },
      { name: "semctx-stable", source: null, repo: "hoklims/semctx" },
      { name: "semctx-stable", source: "", repo: "hoklims/semctx" },
      { name: "semctx-stable", source: 7, repo: "hoklims/semctx" },
      { name: "semctx-stable", source: "github\n", repo: "hoklims/semctx" },
      { name: "semctx-stable", sourceKind: "github", source: "git", repo: "hoklims/semctx" },
    ]) {
      for (const dryRun of [true, false]) {
        const runtime = fakeRuntime({
          codex: false,
          claude: true,
          claudeMarketplaces: [marketplace],
          claudePlugins: [],
        });
        const report = executeInstall(
          "C:\\work\\project",
          parseArgs([
            "install",
            "--host",
            "claude",
            ...(dryRun ? ["--dry-run"] : []),
            "--skip-setup",
          ]),
          runtime,
        );
        expect(report.ok).toBe(false);
        expect(report.hosts.claude.status).toBe("conflict");
        expect(runtime.commands.filter((command) =>
          command[0] === "claude"
          && command.some((token) => ["add", "install", "update", "enable", "remove"].includes(token))
        )).toEqual([]);
      }
    }

    for (const repo of ["hoklims/semctx", SEMCTX_SOURCE]) {
      const control = fakeRuntime({
        codex: false,
        claude: true,
        claudeMarketplaces: [{ name: "semctx-stable", repo }],
        claudePlugins: [],
      });
      const controlReport = executeInstall(
        "C:\\work\\project",
        parseArgs(["install", "--host", "claude", "--dry-run", "--skip-setup"]),
        control,
      );
      expect(controlReport.ok).toBe(true);
      expect(controlReport.hosts.claude.status).toBe("planned");
    }
  });

  test("apply revalidates declared traversal observations before Claude mutations", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "semctx-install-traversal-drift-")));
    const project = join(root, "project");
    const profile = join(root, "profile");
    const plugins = join(profile, "plugins");
    const erased = join(root, "erased");
    const target = join(root, "target", "nested");
    mkdirSync(project);
    mkdirSync(plugins, { recursive: true });
    mkdirSync(erased);
    mkdirSync(target, { recursive: true });
    const rawLocation = join(erased, "marketplace");
    writeFileSync(join(plugins, "known_marketplaces.json"), JSON.stringify({
      "semctx-stable": {
        source: { source: "github", repo: "hoklims/semctx", ref: "stable" },
        installLocation: rawLocation,
        lastUpdated: "2026-09-27T00:00:00Z",
      },
    }));
    writeFileSync(join(plugins, "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: {
        "semctx@semctx-stable": [{
          scope: "user",
          installPath: join(erased, "cache"),
          version: packageJson.version,
        }],
      },
    }));
    writeFileSync(join(profile, "settings.json"), JSON.stringify({
      enabledPlugins: { "semctx@semctx-stable": true },
    }));

    try {
      const positive = fakeRuntime({ codex: false, claude: true });
      positive.readClaudePluginMetadata = () => readClaudePluginMetadataInventory(project, profile);
      const positiveReport = executeInstall(
        project,
        parseArgs(["install", "--host", "claude", "--dry-run", "--skip-setup"]),
        positive,
      );
      expect(positiveReport.ok).toBe(true);
      expect(positiveReport.hosts.claude.status).toBe("planned");

      let reads = 0;
      const drifting = fakeRuntime({ codex: false, claude: true });
      drifting.readClaudePluginMetadata = () => {
        reads += 1;
        return readClaudePluginMetadataInventory(project, profile, reads === 2 ? () => {
          rmSync(erased, { recursive: true });
          symlinkSync(target, erased, process.platform === "win32" ? "junction" : "dir");
        } : undefined);
      };
      const report = executeInstall(
        project,
        parseArgs(["install", "--host", "claude", "--skip-setup"]),
        drifting,
      );
      expect(reads).toBe(2);
      expect(report.ok).toBe(false);
      expect(report.hosts.claude.status).toBe("failed");
      expect(drifting.commands.filter((command) =>
        command[0] === "claude"
        && command.some((token) => ["add", "install", "update", "enable", "remove"].includes(token))
      )).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("two-host aggregate preflight blocks Codex and workspace writes on Claude source conflict", () => {
    const runtime = fakeRuntime({
      codex: true,
      claude: true,
      claudeMarketplaces: [{ name: "semctx-stable", repo: "attacker/semctx" }],
    });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--host", "all"]),
      runtime,
    );

    expect(report.ok).toBe(false);
    expect(report.hosts.codex.status).toBe("planned");
    expect(report.hosts.claude.status).toBe("conflict");
    expect(report.workspace.status).toBe("planned");
    expect(runtime.setupRoots).toEqual([]);
    expect(runtime.commands.some((command) => command.includes("add") || command.includes("install")
      || command.includes("update") || command.includes("upgrade") || command.includes("remove")
      || command.includes("enable"))).toBe(false);
  });

  test("all-host apply revalidates every host before the first native mutation", () => {
    const runtime = fakeRuntime({ codex: true, claude: true });
    const validClaudeMetadata: ClaudePluginMetadataInventory = {
      marketplaces: [],
      plugins: [],
      settingsValid: true,
      effectiveEnablement: {},
    };
    let reads = 0;
    runtime.readClaudePluginMetadata = () => {
      reads += 1;
      return reads === 1 ? validClaudeMetadata : null;
    };

    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--host", "all", "--skip-setup"]),
      runtime,
    );

    const mutations = runtime.commands.filter((command) =>
      command.some((token) => ["add", "install", "update", "upgrade", "remove", "enable"].includes(token))
    );
    expect(reads).toBe(2);
    expect(report.ok).toBe(false);
    expect(report.hosts.codex.status).toBe("planned");
    expect(report.hosts.claude.status).toBe("failed");
    expect(mutations).toEqual([]);
    expect(runtime.setupRoots).toEqual([]);
    expect(runtime.deferredCodexCleanups).toEqual([]);
    expect(runtime.deferredCacheCleanups).toEqual([]);
  });

  for (const first of ["stable", "absent"] as const) {
    test(`Codex ${first} identity remains the operation plan across aggregate preflight`, () => {
      const marketplace = (ref: string): CodexPluginMetadataInventory => ({
        marketplaces: [{
          name: "semctx-stable",
          marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE },
          ref,
          sparsePaths: ["plugins/semctx-control"],
        }],
        plugins: [],
      });
      const initial: CodexPluginMetadataInventory = first === "absent"
        ? { marketplaces: [], plugins: [] }
        : marketplace("stable");
      const runtime = fakeRuntime({
        codex: true,
        claude: true,
        codexMetadata: initial,
        claudeMetadata: { marketplaces: [], plugins: [], settingsValid: true, effectiveEnablement: {} },
      });
      let reads = 0;
      runtime.readCodexPluginMetadata = () => {
        reads += 1;
        return reads === 1 ? initial : marketplace("changed-ref");
      };

      const report = executeInstall(
        "C:\\work\\project",
        parseArgs(["install", "--host", "all", "--skip-setup"]),
        runtime,
      );

      expect(reads).toBe(2);
      expect(report.ok).toBe(false);
      expect(report.hosts.codex.error).toContain("changed after the installation plan was admitted");
      expect(runtime.commands.some((command) => command.some((token) =>
        ["add", "install", "update", "upgrade", "remove", "enable"].includes(token)))).toBe(false);
      expect(runtime.setupRoots).toEqual([]);
    });
  }

  const finalCodexMetadata = (
    plugin: Record<string, unknown> | null = {
      pluginId: "semctx-control@semctx-stable",
      installed: true,
      enabled: true,
      version: packageJson.version,
      cacheDirectory: packageJson.version,
    },
  ): CodexPluginMetadataInventory => ({
    marketplaces: [{
      name: "semctx-stable",
      marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE },
      ref: "stable",
      sparsePaths: [],
    }],
    plugins: plugin === null ? [] : [plugin],
  });

  for (const [name, final] of [
    ["disabled plugin", finalCodexMetadata({
      pluginId: "semctx-control@semctx-stable", installed: true, enabled: false,
      version: packageJson.version, cacheDirectory: packageJson.version,
    })],
    ["higher selected cache", finalCodexMetadata({
      pluginId: "semctx-control@semctx-stable", installed: true, enabled: true,
      version: newerFixtureVersion, cacheDirectory: newerFixtureVersion,
    })],
    ["missing registration", finalCodexMetadata(null)],
  ] as const) {
    test(`final declarative inventory refuses ${name} before repository setup`, () => {
      const initial = finalCodexMetadata();
      const runtime = fakeRuntime({
        codex: true,
        claude: false,
        codexMetadata: initial,
        codexPluginsAfter: codexPluginsAfter({}),
      });
      let reads = 0;
      runtime.readCodexPluginMetadata = () => {
        reads += 1;
        return reads < 4 ? initial : final;
      };

      const report = executeInstall("C:\\work\\project", parseArgs(["install"]), runtime);

      expect(reads).toBeGreaterThanOrEqual(4);
      expect(report.ok).toBe(false);
      expect(report.hosts.codex.status).toBe("failed");
      expect(report.hosts.codex.steps.find((step) => step.action === "verify Semctx Codex plugin")?.status)
        .toBe("failed");
      expect(runtime.setupRoots).toEqual([]);
      expect(runtime.deferredCacheCleanups).toEqual([]);
    });
  }

  test("a coherent final declarative inventory permits repository setup", () => {
    const metadata = finalCodexMetadata();
    const runtime = fakeRuntime({ codex: true, claude: false, codexMetadata: metadata,
      codexPluginsAfter: codexPluginsAfter({}) });
    const report = executeInstall("C:\\work\\project", parseArgs(["install"]), runtime);
    expect(report.ok).toBe(true);
    expect(runtime.setupRoots).toEqual(["C:\\work\\project"]);
  });

  for (const [name, final] of [
    ["disabled plugin", finalCodexMetadata({
      pluginId: "semctx-control@semctx-stable", installed: true, enabled: false,
      version: packageJson.version, cacheDirectory: packageJson.version,
    })],
    ["higher selected cache", finalCodexMetadata({
      pluginId: "semctx-control@semctx-stable", installed: true, enabled: true,
      version: newerFixtureVersion, cacheDirectory: newerFixtureVersion,
    })],
  ] as const) {
    test(`cache-lock recovery refuses final declarative ${name} before cleanup`, () => {
      const initial = finalCodexMetadata({
        pluginId: "semctx-control@semctx-stable", installed: true, enabled: true,
        version: "0.1.17", cacheDirectory: "0.1.17",
      });
      const runtime = installWithLockedAdd({
        codexMetadata: initial,
        codexPluginsAfter: codexPluginsAfter({}),
      });
      let reads = 0;
      runtime.readCodexPluginMetadata = () => {
        reads += 1;
        return reads < 4 ? initial : final;
      };

      const report = executeInstall("C:\\work\\project", parseArgs(["install"]), runtime);

      expect(reads).toBeGreaterThanOrEqual(4);
      expect(report.ok).toBe(false);
      expect(report.hosts.codex.status).toBe("failed");
      expect(runtime.deferredCacheCleanups).toEqual([]);
      expect(runtime.setupRoots).toEqual([]);
    });
  }

  test("an ordinary inventory query failure keeps the generic remedy, not the host-CLI upgrade message", () => {
    const runtime = fakeRuntime({
      codex: true,
      claude: false,
      queryOutcomes: {
        "codex plugin marketplace list --json": { code: 1, err: "permission denied" },
      },
    });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.hosts.codex.status).toBe("failed");
    expect(report.hosts.codex.interfaceUnsupported).toBe(false);
    expect(report.next).toContain("resolve the Codex command error above, then re-run");
  });

  test("a failed dry run names the specific remedy instead of recommending a blind re-run", () => {
    const runtime = fakeRuntime({
      codex: true,
      claude: false,
      queryOutcomes: {
        "codex plugin marketplace list --json": {
          code: 2,
          err: "error: unexpected argument 'marketplace' found",
        },
      },
    });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup", "--dry-run"]),
      runtime,
    );

    expect(report.dryRun).toBe(true);
    expect(report.hosts.codex.status).toBe("failed");
    expect(report.next).not.toContain("re-run without --dry-run to apply this plan");
    expect(report.next.some((step) => step.includes("does not support the plugin commands"))).toBe(true);
  });

  test("a successful dry run still recommends applying the plan", () => {
    const runtime = fakeRuntime({ codex: true, claude: false });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup", "--dry-run"]),
      runtime,
    );

    expect(report.dryRun).toBe(true);
    expect(report.hosts.codex.status).toBe("planned");
    expect(report.workspace.status).toBe("skipped");
    expect(runtime.setupRoots).toEqual([]);
    expect(report.next).toContain("re-run without --dry-run to apply this plan");
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
      version: "0.1.17",
      keepVersion: packageJson.version,
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
    // A host that claims the pre-update version is already current must not get its live cache wiped.
    const runtime = installWithLockedAdd({
      ...stableCodexOptions(packageJson.version),
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
            version: "0.1.17",
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
      version: "0.1.17",
      keepVersion: packageJson.version,
    }]);
  });

  test("locked-cache convergence refuses a foreign plugin manifest with matching version and bytes", () => {
    const metadata: CodexPluginMetadataInventory = {
      marketplaces: [{
        name: "semctx-stable",
        marketplaceSource: { sourceType: "git", source: SEMCTX_SOURCE },
        ref: "stable",
        sparsePaths: [],
      }],
      plugins: [{
        pluginId: "semctx-control@semctx-stable",
        installed: true,
        enabled: true,
        version: "0.1.17",
      }],
    };
    const runtime = installWithLockedAdd({
      codexMetadata: metadata,
      codexPluginsAfter: codexPluginsAfter({}),
      codexPayloads: {
        [CODEX_SNAPSHOT_PATH]: probe(),
        [CODEX_CACHE_PATH]: {
          ...probe(),
          identity: { name: "foreign-plugin", version: packageJson.version },
        },
      },
    });

    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--skip-setup"]),
      runtime,
    );

    expect(report.ok).toBe(false);
    expect(report.hosts.codex.error).toContain("does not declare the expected plugin identity");
    expect(runtime.deferredCacheCleanups).toEqual([]);
    expect(runtime.setupRoots).toEqual([]);
  });

  test("survives a malformed plugin list with a structured failure", () => {
    const runtime = installWithLockedAdd({
      codexPlugins: { installed: [null, { pluginId: "semctx-control@semctx-stable", installed: true, enabled: true, version: "0.1.17" }] },
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
      options: { codexPluginsAfter: codexPluginsAfter({ version: "0.1.17" }) },
      reason: `expected plugin v${packageJson.version}, found v0.1.17`,
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
          [CODEX_CACHE_PATH]: probe(packageJson.version, { "semctx-shared.js": { status: "missing" } }),
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
          [CODEX_CACHE_PATH]: probe(packageJson.version, { "semctx.js": { status: "empty" } }),
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
          [CODEX_CACHE_PATH]: probe(packageJson.version, { "semctx-mcp.js": { status: "not-a-file" } }),
        },
      },
      reason: "semctx-mcp.js is not-a-file",
    },
    {
      name: "the cache manifest declares another version",
      options: {
        codexPluginsAfter: codexPluginsAfter({}),
        codexPayloads: { [CODEX_SNAPSHOT_PATH]: probe(), [CODEX_CACHE_PATH]: probe("0.1.17") },
      },
      reason: `declares v0.1.17, expected v${packageJson.version}`,
    },
    {
      name: "the marketplace snapshot manifest declares another version",
      options: {
        codexPluginsAfter: codexPluginsAfter({}),
        codexPayloads: { [CODEX_SNAPSHOT_PATH]: probe("0.1.17"), [CODEX_CACHE_PATH]: probe() },
      },
      reason: "snapshot at",
    },
    {
      name: "a cached bundle digest diverges from the approved snapshot",
      options: {
        codexPluginsAfter: codexPluginsAfter({}),
        codexPayloads: {
          [CODEX_SNAPSHOT_PATH]: probe(),
          [CODEX_CACHE_PATH]: probe(packageJson.version, {
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
      parseArgs(["install"]),
      runtime,
    );

    expect(report.ok).toBe(false);
    expect(report.hosts.codex.status).toBe("failed");
    expect(report.hosts.codex.error).toContain(`expected plugin v${packageJson.version}`);
    expect(report.workspace.status).toBe("skipped");
    expect(runtime.setupRoots).toEqual([]);
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
        version: packageJson.version,
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

  test("dry-run probes workspace conflicts but performs no mutation or repository setup", () => {
    const runtime = fakeRuntime({ codex: true, claude: true });
    const report = executeInstall(
      "C:\\work\\project",
      parseArgs(["install", "--dry-run"]),
      runtime,
    );

    expect(report.ok).toBe(true);
    expect(report.dryRun).toBe(true);
    expect(report.workspace.status).toBe("planned");
    expect(report.workspace.report?.kind).toBe("setup_plan");
    expect(runtime.commands.some((command) => command.includes("add"))).toBe(false);
    expect(runtime.commands.some((command) => command.includes("install"))).toBe(false);
    expect(runtime.commands.some((command) => command.includes("update"))).toBe(false);
    expect(runtime.commands.some((command) => command.includes("upgrade"))).toBe(false);
    expect(runtime.commands.some((command) => command.includes("remove"))).toBe(false);
  });

  test("workspace preflight conflict blocks host mutation before real installation", () => {
    const conflictReport = {
      schemaVersion: 1,
      kind: "setup_conflict",
      repositoryRoot: "C:\\work\\project",
      conflict: {
        code: "CONFIG_INVALID",
        message: "repository store files must be regular files",
        details: { path: "C:\\work\\project\\.semctx\\semctx.db" },
      },
      plannedChanges: [],
      index: { status: "not-run", reason: "workspace-conflict" },
      analysisReady: "unknown",
      setupReady: false,
      verdict: "SETUP_REFUSED",
      preset: null,
    };
    const runtime = fakeRuntime({
      codex: true,
      claude: true,
      preflight: { code: 1, report: conflictReport, err: "" },
    });
    const report = executeInstall("C:\\work\\project", parseArgs(["install", "--host", "all"]), runtime);

    expect(report.ok).toBe(false);
    expect(report.workspace.status).toBe("failed");
    expect(report.workspace.error).toBe("repository store files must be regular files");
    expect(report.workspace.report).toEqual(conflictReport);
    expect(runtime.commands).toEqual([["git", "rev-parse", "--show-toplevel"]]);
    expect(runtime.setupRoots).toEqual([]);
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
      version: packageJson.version,
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
      version: packageJson.version,
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
    expect(resolveCodexCacheEntry(CODEX_HOME, packageJson.version)).toBe(CODEX_CACHE_PATH);
    expect(resolveCodexCacheEntry(CODEX_HOME, "0.1.17")).toBe(CODEX_OBSOLETE_CACHE_PATH);
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
    const script = process.platform === "win32"
      ? join(directory, "node_modules", "@openai", "codex", "bin", "codex.js")
      : join(directory, "codex-shim.js");
    const counter = join(directory, "counter.txt");
    mkdirSync(resolve(script, ".."), { recursive: true });
    writeFileSync(
      script,
      `const { readFileSync, writeFileSync } = require("node:fs");
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
        "@echo off\r\nnode \"%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n",
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
          ...fixtureEnvironmentWithPath(shim.directory),
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
