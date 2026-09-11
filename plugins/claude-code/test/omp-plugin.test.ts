import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  OMP_CLI_SHIM_PATH,
  ompStandardContractErrors,
  renderOmpCliShim,
} from "../../../scripts/build-plugin-runtime.ts";
import { evaluateGuard } from "../hooks/semctx-guard.mjs";
import semctxGuardExtension, {
  evaluateOmpToolCall,
  explicitGuardOff,
  mergeOmpEnvironment,
  resolveOmpFilesystemCwd,
} from "../omp/semctx-guard.ts";

const pluginRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(import.meta.dir, "../../..");

function json<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(repoRoot, relativePath), "utf8")) as T;
}

describe("OMP standard plugin manifests (ADR 0020)", () => {
  test("plugin.json is a closed Agent Plugins 1.0.0 manifest matching the Claude package identity", () => {
    const manifest = json<Record<string, unknown>>("plugins/claude-code/plugin.json");
    const claudeManifest = json<{ version: string }>("plugins/claude-code/.claude-plugin/plugin.json");
    expect(manifest.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    expect(manifest.name).toBe("semctx");
    expect(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(manifest.name as string)).toBe(true);
    expect((manifest.name as string).includes("--")).toBe(false);
    expect(manifest.version).toBe(claudeManifest.version);
    const allowed = new Set([
      "$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions",
    ]);
    for (const key of Object.keys(manifest)) expect(allowed.has(key)).toBe(true);
    // The manifest's own "extensions" field is opaque namespaced client data (spec §8.1) — an
    // unrelated mechanism from package.json#omp.extensions. Left unset: nothing implements it.
    expect(manifest.extensions).toBeUndefined();
  });

  test("mcp.json is a closed Agent Plugins 1.0.0 stdio config: PLUGIN_ROOT-pinned Bun cwd and bundle arg, no cwd field, no SEMCTX_ROOT", () => {
    const mcp = json<{ $schema: string; mcpServers: Record<string, Record<string, unknown>> }>(
      "plugins/claude-code/mcp.json",
    );
    expect(mcp.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
    expect(Object.keys(mcp).sort()).toEqual(["$schema", "mcpServers"]);
    expect(Object.keys(mcp.mcpServers)).toEqual(["semctx"]);
    const server = mcp.mcpServers.semctx!;
    expect(Object.keys(server).sort()).toEqual(["args", "command", "type"]);
    expect(server.type).toBe("stdio");
    expect(server.command).toBe("bun");
    // Bun's own `--cwd` (not a manifest `cwd` field) keeps the analysed checkout's `bunfig.toml`
    // preload scripts and `.env` out of the server process (plugins/launch-isolation.test.ts).
    expect(server.args).toEqual(["--cwd", "${PLUGIN_ROOT}", "${PLUGIN_ROOT}/dist/semctx-mcp.js"]);
    expect(server.cwd).toBeUndefined();
    expect(server.env).toBeUndefined();
  });

  test("package.json declares the OMP guard adapter exactly once, outside hooks/pre and hooks/post", () => {
    const pkg = json<{ version: string; omp: { extensions: string[] } }>("plugins/claude-code/package.json");
    const claudeManifest = json<{ version: string }>("plugins/claude-code/.claude-plugin/plugin.json");
    expect(pkg.version).toBe(claudeManifest.version);
    expect(pkg.omp.extensions).toEqual(["./omp/semctx-guard.ts"]);
    for (const entry of pkg.omp.extensions) {
      expect(entry.includes("hooks/pre")).toBe(false);
      expect(entry.includes("hooks/post")).toBe(false);
      expect(existsSync(resolve(pluginRoot, entry))).toBe(true);
    }
  });

  test("retires the legacy OMP provider manifest and replacement MCP launch", () => {
    expect(existsSync(resolve(pluginRoot, ".omp-plugin", "plugin.json"))).toBe(false);
    expect(existsSync(resolve(pluginRoot, "mcp-omp.json"))).toBe(false);
  });

  test("the catalogue pins an immutable release tag, not the mutable stable branch", () => {
    const marketplace = json<{ plugins: Array<{ name: string; source: { ref: string; path: string } }> }>(
      ".omp-plugin/marketplace.json",
    );
    const claudeManifest = json<{ version: string }>("plugins/claude-code/.claude-plugin/plugin.json");
    const plugin = marketplace.plugins.find((candidate) => candidate.name === "semctx");
    expect(plugin?.source.ref).toBe(`v${claudeManifest.version}`);
    expect(plugin?.source.ref).not.toBe("stable");
    expect(plugin?.source.path).toBe("plugins/claude-code");
  });

  test("the build contract rejects schema, launch, version and pin mutants", () => {
    const releaseVersion = json<{ version: string }>("plugins/claude-code/.claude-plugin/plugin.json").version;
    const base = {
      plugin: json<Record<string, unknown>>("plugins/claude-code/plugin.json"),
      mcp: json<Record<string, unknown>>("plugins/claude-code/mcp.json"),
      pkg: json<Record<string, unknown>>("plugins/claude-code/package.json"),
      marketplace: json<Record<string, unknown>>(".omp-plugin/marketplace.json"),
      releaseVersion,
    };
    expect(ompStandardContractErrors(base)).toEqual([]);

    const mutated = (mutate: (copy: typeof base) => void): string[] => {
      const copy = structuredClone(base);
      mutate(copy);
      return ompStandardContractErrors(copy);
    };
    expect(mutated((copy) => { copy.plugin.extra = true; })).toContain("plugin.json fields are not closed");
    expect(mutated((copy) => { copy.mcp.$schema = "https://example.invalid/schema.json"; })).toContain("mcp.json schema mismatch");
    expect(mutated((copy) => {
      const server = (copy.mcp.mcpServers as Record<string, Record<string, unknown>>).semctx!;
      server.cwd = ".";
    })).toContain("mcp.json server fields are not closed");
    expect(mutated((copy) => { copy.pkg.version = "0.0.0"; })).toContain("package.json OMP extension contract mismatch");
    expect(mutated((copy) => {
      const plugins = copy.marketplace.plugins as Array<Record<string, unknown>>;
      (plugins[0]!.source as Record<string, unknown>).ref = "stable";
    })).toContain("OMP catalogue version or immutable git-subdir source mismatch");
    expect(mutated((copy) => {
      const plugins = copy.marketplace.plugins as Array<Record<string, unknown>>;
      (plugins[0]!.source as Record<string, unknown>).sha = "0".repeat(40);
    })).toContain("OMP catalogue git-subdir source fields are not closed");
  });
});

describe("OMP embedded CLI shim (ADR 0020)", () => {
  const shimPath = resolve(repoRoot, OMP_CLI_SHIM_PATH);

  test("generated parity: committed shim matches the generator", () => {
    expect(readFileSync(shimPath, "utf8").replaceAll("\r\n", "\n")).toBe(renderOmpCliShim());
  });

  test("real child process: preserves argv and exit code from a path containing spaces, without bash", () => {
    const stagingParent = mkdtempSync(join(tmpdir(), "semctx omp cli "));
    try {
      const stagedRoot = join(stagingParent, "plugin root");
      cpSync(resolve(pluginRoot, "dist"), join(stagedRoot, "dist"), { recursive: true });
      mkdirSync(join(stagedRoot, "skills", "semctx-control", "scripts"), { recursive: true });
      cpSync(shimPath, join(stagedRoot, "skills", "semctx-control", "scripts", "omp-cli.mjs"));

      const cliVersion = json<{ version: string }>("apps/cli/package.json").version;
      const result = execFileSync(
        "bun",
        [join(stagedRoot, "skills", "semctx-control", "scripts", "omp-cli.mjs"), "--version"],
        { encoding: "utf8" },
      );
      expect(result.trim()).toBe(cliVersion);
    } finally {
      rmSync(stagingParent, { recursive: true, force: true });
    }
  });
});

function createGuardedRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "tracked.ts"), "export const value = 1;\n");
  execFileSync("git", ["add", "tracked.ts"], { cwd: repo, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.invalid", "commit", "-m", "baseline"],
    { cwd: repo, stdio: "ignore" },
  );
  mkdirSync(join(repo, ".semctx"));
  writeFileSync(join(repo, ".semctx", "guard.json"), JSON.stringify({ enabled: true }));
  return repo;
}

describe("guard evaluation parity — Claude hook vs OMP bash tool_call (ADR 0020)", () => {
  test("opt-in off: both host input shapes stay advisory (non-blocking)", () => {
    const repo = createGuardedRepo("semctx-omp-guard-off-");
    try {
      const claudeShaped = evaluateGuard({ command: "git commit -m x", cwd: repo, env: { SEMCTX_GUARD: "off" } });
      const ompShaped = evaluateGuard({
        command: "git commit -m x",
        cwd: repo,
        env: { ...process.env, SEMCTX_GUARD: "off" },
      });
      expect(claudeShaped).toEqual({ block: false });
      expect(ompShaped).toEqual({ block: false });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("missing verification blocks identically for both input shapes", () => {
    const repo = createGuardedRepo("semctx-omp-guard-missing-");
    try {
      const claudeShaped = evaluateGuard({ command: "git commit -m x", cwd: repo, env: process.env });
      const ompShaped = evaluateGuard({ command: "git commit -m x", cwd: repo, env: { ...process.env } });
      expect(claudeShaped.block).toBe(true);
      expect(ompShaped.block).toBe(true);
      expect("reason" in claudeShaped ? claudeShaped.reason : undefined)
        .toBe("reason" in ompShaped ? ompShaped.reason : undefined);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("real cwd: an explicit per-call cwd is honoured over the ambient process cwd on both hosts", () => {
    const repo = createGuardedRepo("semctx-omp-guard-cwd-");
    try {
      const decision = evaluateGuard({ command: "git commit -m x", cwd: repo, env: process.env });
      expect(decision.block).toBe(true);
      expect("reason" in decision ? decision.reason : undefined).toContain("no verification on record");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("non-terminal Bash commands never block on either host", () => {
    const repo = createGuardedRepo("semctx-omp-guard-nonterminal-");
    try {
      expect(evaluateGuard({ command: "git status", cwd: repo, env: process.env })).toEqual({ block: false });
      expect(evaluateGuard({ command: "ls -la", cwd: repo, env: process.env })).toEqual({ block: false });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("OMP extension adapter wiring (omp/semctx-guard.ts)", () => {
  test("matches OMP 18.1.11 filesystem cwd normalization, including host aliases", () => {
    const options = { platform: "win32" as const, env: {}, home: "C:\\Users\\OMP User" };
    const session = "C:\\work\\session";
    const resolved = (cwd: string) => resolveOmpFilesystemCwd(cwd, session, options);

    expect(resolved("child repo")).toEqual({ ok: true, cwd: "C:\\work\\session\\child repo" });
    expect(resolved("child\u202Frepo")).toEqual({ ok: true, cwd: "C:\\work\\session\\child repo" });
    expect(resolved("/")).toEqual({ ok: true, cwd: session });
    expect(resolved("@/repo")).toEqual({
      ok: false,
      reason: expect.stringContaining("not a fully qualified filesystem path"),
    });
    expect(resolved(":.\\repo")).toEqual({ ok: true, cwd: "C:\\work\\session\\repo" });
    expect(resolved("~/repo")).toEqual({ ok: true, cwd: "C:\\Users\\OMP User/repo" });
    expect(resolved("file:///C:/work/repo")).toEqual({ ok: true, cwd: "C:\\work\\repo" });
    expect(resolveOmpFilesystemCwd("file:///home/omp/repo", "/tmp/session", {
      platform: "linux",
      env: {},
      home: "/home/omp",
    })).toEqual({ ok: true, cwd: "/home/omp/repo" });
    expect(resolved("\\\\?\\C:\\work\\repo")).toEqual({ ok: true, cwd: "C:\\work\\repo" });
    expect(resolved("\\\\?\\UNC\\server\\share\\repo")).toEqual({
      ok: true,
      cwd: "\\\\server\\share\\repo",
    });
    expect(resolved("/c/work/repo")).toEqual({ ok: true, cwd: "C:\\work\\repo" });
    expect(resolved("/mnt/c/work/repo")).toEqual({ ok: true, cwd: "C:\\work\\repo" });
    expect(resolved("C:\\absolute\\repo")).toEqual({ ok: true, cwd: "C:\\absolute\\repo" });
    expect(resolved("\\\\server\\share\\repo")).toEqual({ ok: true, cwd: "\\\\server\\share\\repo" });
    expect(resolved("C:drive-relative")).toEqual({
      ok: false,
      reason: expect.stringContaining("drive-relative, not a fully qualified filesystem path"),
    });
    expect(resolveOmpFilesystemCwd("C:\\work\\repo", "/home/omp", {
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      home: "/home/omp",
    })).toEqual({ ok: true, cwd: "/mnt/c/work/repo" });
    expect(resolved("@skill://semctx-control/scripts/omp-cli.mjs")).toEqual({
      ok: false,
      reason: expect.stringContaining("did not expand internal URL cwd"),
    });
    expect(resolveOmpFilesystemCwd("child repo", "skill://session", {
      platform: "linux",
      env: {},
      home: "/home/omp",
    })).toEqual({
      ok: false,
      reason: expect.stringContaining("relative cwd cannot be resolved from internal URL session cwd"),
    });
    expect(resolveOmpFilesystemCwd("child repo", "relative/session", {
      platform: "linux",
      env: {},
      home: "/home/omp",
    })).toEqual({
      ok: false,
      reason: expect.stringContaining("relative cwd cannot be resolved from a non-fully-qualified session cwd"),
    });
    for (const rootRelativeSession of ["\\session", "/session"]) {
      expect(resolveOmpFilesystemCwd("child repo", rootRelativeSession, options)).toEqual({
        ok: false,
        reason: expect.stringContaining("relative cwd cannot be resolved from a non-fully-qualified session cwd"),
      });
    }
    expect(resolveOmpFilesystemCwd("child repo", "\\\\server\\share", options)).toEqual({
      ok: true,
      cwd: "\\\\server\\share\\child repo",
    });
    for (const deviceNamespace of [
      "\\\\.\\pipe\\semctx",
      "//./pipe/semctx",
      "//.\\pipe\\semctx",
      "\\\\./pipe/semctx",
      "\\\\.\\C:\\repo",
      "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\repo",
      "//?/GLOBALROOT/Device/HarddiskVolume1/repo",
      "//?\\GLOBALROOT\\Device\\HarddiskVolume1\\repo",
      "\\\\?/GLOBALROOT/Device/HarddiskVolume1/repo",
      "//?\\C:\\repo",
    ]) {
      expect(resolveOmpFilesystemCwd(deviceNamespace, session, options)).toEqual({
        ok: false,
        reason: expect.stringContaining("refuses Windows device namespace cwd"),
        unsafe: true,
      });
      expect(resolveOmpFilesystemCwd("child repo", deviceNamespace, options)).toEqual({
        ok: false,
        reason: expect.stringContaining("refuses Windows device namespace session cwd"),
        unsafe: true,
      });
    }
  });

  test("resolves a guarded relative target from the OMP session cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-omp-relative-"));
    const sessionRepo = join(root, "session");
    const targetRepo = join(root, "guarded target");
    mkdirSync(sessionRepo);
    mkdirSync(targetRepo);
    execFileSync("git", ["init"], { cwd: targetRepo, stdio: "ignore" });
    writeFileSync(join(targetRepo, "tracked.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "tracked.ts"], { cwd: targetRepo, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.invalid", "commit", "-m", "baseline"],
      { cwd: targetRepo, stdio: "ignore" },
    );
    mkdirSync(join(targetRepo, ".semctx"));
    writeFileSync(join(targetRepo, ".semctx", "guard.json"), JSON.stringify({ enabled: true }));
    try {
      const decision = evaluateOmpToolCall({
        type: "tool_call",
        toolCallId: "relative-target",
        toolName: "bash",
        input: { command: "git commit -m x", cwd: relative(sessionRepo, targetRepo) },
      }, { cwd: sessionRepo });
      expect(decision?.block).toBe(true);
      expect(decision?.reason).toContain("no verification on record");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps unresolved internal cwd advisory unless guard enablement is known", () => {
    const sessionRepo = mkdtempSync(join(tmpdir(), "semctx-omp-internal-cwd-"));
    execFileSync("git", ["init"], { cwd: sessionRepo, stdio: "ignore" });
    const internalCwd = {
      type: "tool_call" as const,
      toolCallId: "internal-cwd",
      toolName: "bash",
      input: { command: "git commit -m x", cwd: "skill://semctx-control" },
    };
    try {
      expect(evaluateOmpToolCall(internalCwd, { cwd: sessionRepo })).toBeUndefined();
      let observedEnv: Record<string, string | undefined> | undefined;
      expect(evaluateOmpToolCall({
        ...internalCwd,
        input: { ...internalCwd.input, env: { OMP_TEST_OVERLAY: "call" } },
      }, { cwd: sessionRepo }, evaluateGuard, (input) => {
        observedEnv = input.env;
        return false;
      })).toBeUndefined();
      expect(observedEnv?.OMP_TEST_OVERLAY).toBe("call");
      expect(observedEnv?.PATH ?? observedEnv?.Path).toBe(process.env.PATH ?? process.env.Path);
      expect(evaluateOmpToolCall({
        ...internalCwd,
        input: { ...internalCwd.input, env: { SEMCTX_GUARD: "off" } },
      }, { cwd: sessionRepo }, () => { throw new Error("must not evaluate"); }, () => { throw new Error("must not evaluate"); }))
        .toBeUndefined();

      const explicitlyEnabled = evaluateOmpToolCall({
        ...internalCwd,
        input: { ...internalCwd.input, env: { SEMCTX_GUARD: "on" } },
      }, { cwd: sessionRepo });
      expect(explicitlyEnabled).toEqual({
        block: true,
        reason: expect.stringContaining("did not expand internal URL cwd"),
      });

      mkdirSync(join(sessionRepo, ".semctx"));
      writeFileSync(join(sessionRepo, ".semctx", "guard.json"), JSON.stringify({ enabled: true }));
      expect(evaluateOmpToolCall(internalCwd, { cwd: sessionRepo })).toEqual({
        block: true,
        reason: expect.stringContaining("did not expand internal URL cwd"),
      });

      expect(evaluateOmpToolCall(internalCwd, { cwd: sessionRepo }, evaluateGuard, () => {
        throw new Error("probe failure");
      })).toEqual({
        block: true,
        reason: expect.stringContaining("guard enablement evaluation failed"),
      });
      expect(evaluateOmpToolCall(internalCwd, { cwd: sessionRepo }, evaluateGuard, (() => undefined) as never)).toEqual({
        block: true,
        reason: expect.stringContaining("guard enablement evaluation returned an unknown result"),
      });
      expect(evaluateOmpToolCall(internalCwd, { cwd: "skill://session" })).toEqual({
        block: true,
        reason: expect.stringContaining("guard enablement cannot be established"),
      });
      expect(evaluateOmpToolCall(internalCwd, { cwd: join(sessionRepo, "missing") })).toEqual({
        block: true,
        reason: expect.stringContaining("not an accessible filesystem directory"),
      });
    } finally {
      rmSync(sessionRepo, { recursive: true, force: true });
    }
  });

  test("never turns a relative cwd plus opaque session cwd into a filesystem target", () => {
    const event = {
      type: "tool_call" as const,
      toolCallId: "relative-opaque-session",
      toolName: "bash",
      input: { command: "git commit -m x", cwd: "child repo" },
    };
    let evaluated = false;
    const evaluator = () => {
      evaluated = true;
      return { block: false } as const;
    };

    expect(evaluateOmpToolCall(event, { cwd: "skill://session" }, evaluator)).toEqual({
      block: true,
      reason: expect.stringContaining("guard enablement cannot be established"),
    });
    expect(evaluated).toBe(false);

    expect(evaluateOmpToolCall({
      ...event,
      input: { ...event.input, env: { SEMCTX_GUARD: "on" } },
    }, { cwd: "skill://session" }, evaluator)).toEqual({
      block: true,
      reason: expect.stringContaining("guard enablement cannot be established"),
    });
    expect(evaluated).toBe(false);

    expect(evaluateOmpToolCall({
      ...event,
      input: { ...event.input, env: { SEMCTX_GUARD: "off" } },
    }, { cwd: "skill://session" }, () => {
      throw new Error("must not evaluate");
    }, () => {
      throw new Error("must not evaluate");
    })).toBeUndefined();

    expect(evaluateOmpToolCall(
      event,
      { cwd: "skill://session" },
      evaluator,
      (() => false) as never,
    )).toEqual({
      block: true,
      reason: expect.stringContaining("guard enablement cannot be established"),
    });
    expect(evaluated).toBe(false);
  });

  test("blocks relative cwd resolution from Windows root-relative session forms before evaluation", () => {
    if (process.platform !== "win32") return;
    const event = {
      type: "tool_call" as const,
      toolCallId: "relative-root-session",
      toolName: "bash",
      input: { command: "git commit -m x", cwd: "child repo" },
    };
    let evaluated = false;
    let enablementEvaluated = false;
    const evaluator = () => {
      evaluated = true;
      return { block: false } as const;
    };

    for (const sessionCwd of ["\\session", "/session"]) {
      expect(evaluateOmpToolCall(event, { cwd: sessionCwd }, evaluator, () => {
        enablementEvaluated = true;
        return false;
      })).toEqual({
        block: true,
        reason: expect.stringContaining("guard enablement cannot be established"),
      });
      expect(evaluated).toBe(false);
      expect(enablementEvaluated).toBe(false);
    }
  });

  test("blocks a Windows drive-relative event cwd before guard evaluation", () => {
    if (process.platform !== "win32") return;
    const sessionRepo = createGuardedRepo("semctx-omp-drive-relative-");
    let evaluated = false;
    try {
      expect(evaluateOmpToolCall({
        type: "tool_call",
        toolCallId: "drive-relative-event",
        toolName: "bash",
        input: { command: "git commit -m x", cwd: "C:child-repo" },
      }, { cwd: sessionRepo }, () => {
        evaluated = true;
        return { block: false };
      })).toEqual({
        block: true,
        reason: expect.stringContaining("drive-relative, not a fully qualified filesystem path"),
      });
      expect(evaluated).toBe(false);
    } finally {
      rmSync(sessionRepo, { recursive: true, force: true });
    }
  });

  test("blocks Windows device namespace event and session cwd before either evaluator", () => {
    if (process.platform !== "win32") return;
    const sessionRepo = createGuardedRepo("semctx-omp-device-namespace-");
    let primaryCalls = 0;
    let enablementCalls = 0;
    const primary = () => {
      primaryCalls += 1;
      return { block: false } as const;
    };
    const enablement = () => {
      enablementCalls += 1;
      return false;
    };
    const namespaces = [
      "\\\\.\\pipe\\semctx",
      "//./pipe/semctx",
      "//.\\pipe\\semctx",
      "\\\\./pipe/semctx",
      "\\\\.\\C:\\repo",
      "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\repo",
      "//?/GLOBALROOT/Device/HarddiskVolume1/repo",
      "//?\\GLOBALROOT\\Device\\HarddiskVolume1\\repo",
      "\\\\?/GLOBALROOT/Device/HarddiskVolume1/repo",
      "//?\\C:\\repo",
    ];
    try {
      for (const cwd of namespaces) {
        expect(evaluateOmpToolCall({
          type: "tool_call",
          toolCallId: "device-event",
          toolName: "bash",
          input: { command: "git commit -m x", cwd },
        }, { cwd: sessionRepo }, primary, enablement)).toEqual({
          block: true,
          reason: expect.stringContaining("refuses Windows device namespace cwd"),
        });
        expect(evaluateOmpToolCall({
          type: "tool_call",
          toolCallId: "device-session",
          toolName: "bash",
          input: { command: "git commit -m x", cwd: "child repo" },
        }, { cwd }, primary, enablement)).toEqual({
          block: true,
          reason: expect.stringContaining("refuses Windows device namespace session cwd"),
        });
      }
      expect(primaryCalls).toBe(0);
      expect(enablementCalls).toBe(0);
    } finally {
      rmSync(sessionRepo, { recursive: true, force: true });
    }
  });

  test("blocks opaque scopes when the real guard config cannot establish advisory mode", () => {
    const sessionRepo = mkdtempSync(join(tmpdir(), "semctx-omp-guard-config-unknown-"));
    execFileSync("git", ["init"], { cwd: sessionRepo, stdio: "ignore" });
    const guardDir = join(sessionRepo, ".semctx");
    const guardPath = join(guardDir, "guard.json");
    mkdirSync(guardDir);
    const event = {
      type: "tool_call" as const,
      toolCallId: "opaque-config-unknown",
      toolName: "bash",
      input: { command: "git commit -m x", cwd: "skill://semctx-control" },
    };
    try {
      writeFileSync(guardPath, "{not-json");
      expect(evaluateOmpToolCall(event, { cwd: sessionRepo })).toEqual({
        block: true,
        reason: expect.stringContaining("guard enablement evaluation returned an unknown result"),
      });

      writeFileSync(guardPath, JSON.stringify({ enabled: "sometimes" }));
      expect(evaluateOmpToolCall(event, { cwd: sessionRepo })).toEqual({
        block: true,
        reason: expect.stringContaining("guard enablement evaluation returned an unknown result"),
      });

      rmSync(guardPath);
      mkdirSync(guardPath);
      expect(evaluateOmpToolCall(event, { cwd: sessionRepo })).toEqual({
        block: true,
        reason: expect.stringContaining("guard enablement evaluation returned an unknown result"),
      });

      rmSync(guardPath, { recursive: true });
      symlinkSync(
        join(sessionRepo, "missing-guard-target"),
        guardPath,
        process.platform === "win32" ? "junction" : "file",
      );
      expect(evaluateOmpToolCall(event, { cwd: sessionRepo })).toEqual({
        block: true,
        reason: expect.stringContaining("guard enablement evaluation returned an unknown result"),
      });

      expect(evaluateOmpToolCall({
        ...event,
        input: { ...event.input, env: { SEMCTX_GUARD: "off" } },
      }, { cwd: sessionRepo })).toBeUndefined();

      rmSync(guardPath, { force: true });
      expect(evaluateOmpToolCall(event, { cwd: sessionRepo })).toBeUndefined();
    } finally {
      rmSync(sessionRepo, { recursive: true, force: true });
    }
  });

  test("keeps unresolved internal Git scope advisory unless guard enablement is known", () => {
    const advisoryRepo = mkdtempSync(join(tmpdir(), "semctx-omp-internal-scope-advisory-"));
    execFileSync("git", ["init"], { cwd: advisoryRepo, stdio: "ignore" });
    const guardedRepo = createGuardedRepo("semctx-omp-internal-scope-guarded-");
    const commands = [
      "cd skill://semctx-control && git commit -m x",
      "git -Cskill://semctx-control commit -m x",
      "  cd skill://semctx-control && git commit -m x",
    ];
    try {
      for (const command of commands) {
        const event = {
          type: "tool_call" as const,
          toolCallId: "internal-scope",
          toolName: "bash",
          input: { command },
        };
        expect(evaluateOmpToolCall(event, { cwd: advisoryRepo })).toBeUndefined();
        expect(evaluateOmpToolCall({
          ...event,
          input: { command, env: { SEMCTX_GUARD: "off" } },
        }, { cwd: guardedRepo })).toBeUndefined();
        expect(evaluateOmpToolCall({
          ...event,
          input: { command, env: { SEMCTX_GUARD: "on" } },
        }, { cwd: advisoryRepo })).toEqual({
          block: true,
          reason: expect.stringContaining("did not expand internal URL Git scope"),
        });
        expect(evaluateOmpToolCall(event, { cwd: guardedRepo })).toEqual({
          block: true,
          reason: expect.stringContaining("did not expand internal URL Git scope"),
        });
      }
      const throwing = () => { throw new Error("probe failure"); };
      expect(evaluateOmpToolCall({
        type: "tool_call",
        toolCallId: "internal-scope-failure",
        toolName: "bash",
        input: { command: commands[0]! },
      }, { cwd: advisoryRepo }, evaluateGuard, throwing)).toEqual({
        block: true,
        reason: expect.stringContaining("guard enablement evaluation failed"),
      });
    } finally {
      rmSync(advisoryRepo, { recursive: true, force: true });
      rmSync(guardedRepo, { recursive: true, force: true });
    }
  });

  test("preserves the guarded session root when structured cwd targets another repository", () => {
    const sessionRepo = createGuardedRepo("semctx-omp-session-");
    const targetRepo = createGuardedRepo("semctx-omp-target-");
    try {
      rmSync(join(targetRepo, ".semctx"), { recursive: true, force: true });
      const event = {
        type: "tool_call" as const,
        toolCallId: "cross-repo",
        toolName: "bash",
        input: { command: "git commit -m x", cwd: targetRepo },
      };
      const decision = evaluateOmpToolCall(event, { cwd: sessionRepo });
      expect(decision?.block).toBe(true);
      expect(decision?.reason).toContain("no verification on record");

      expect(evaluateOmpToolCall(
        { ...event, input: { ...event.input, env: { SEMCTX_GUARD: "off" } } },
        { cwd: sessionRepo },
      )).toBeUndefined();
      expect(evaluateOmpToolCall(
        { ...event, input: { command: "git status", cwd: targetRepo } },
        { cwd: sessionRepo },
      )).toBeUndefined();
    } finally {
      rmSync(sessionRepo, { recursive: true, force: true });
      rmSync(targetRepo, { recursive: true, force: true });
    }
  });

  test("normalizes Windows environment key casing so the structured override wins", () => {
    const merged = mergeOmpEnvironment(
      { PATH: "ambient", SEMCTX_GUARD: "on", Keep: "yes" },
      { Path: "call", semctx_guard: "off" },
      true,
    );
    expect(merged).toEqual({ Keep: "yes", Path: "call", semctx_guard: "off" });
    expect(explicitGuardOff({ SEMCTX_GUARD: "on", semctx_guard: "off" }, "linux")).toBe(false);
    expect(explicitGuardOff({ SEMCTX_GUARD: "on", semctx_guard: "off" }, "win32")).toBe(true);
  });

  test("blocks enabled evaluator exceptions but preserves explicit off and nonterminal calls", () => {
    const terminal = {
      type: "tool_call" as const,
      toolCallId: "throw",
      toolName: "bash",
      input: { command: "git commit -m x", env: { SEMCTX_GUARD: "on" } },
    };
    const throwing = () => { throw new Error("probe failure"); };
    const blocked = evaluateOmpToolCall(terminal, { cwd: repoRoot }, throwing, () => true);
    expect(blocked).toEqual({
      block: true,
      reason: "semctx guarded mode: guard evaluation failed; terminal Git operation is not authorized.",
    });
    expect(evaluateOmpToolCall(
      { ...terminal, input: { command: "git commit -m x", env: { SEMCTX_GUARD: "off" } } },
      { cwd: repoRoot },
      throwing,
      throwing,
    )).toBeUndefined();
    expect(evaluateOmpToolCall(
      { ...terminal, input: { command: "git status" } },
      { cwd: repoRoot },
      throwing,
      () => true,
    )).toBeUndefined();
  });

  test("blocks evaluator exceptions when real guard enablement is unknown but preserves advisory and off", () => {
    const sessionRepo = mkdtempSync(join(tmpdir(), "semctx-omp-evaluator-fallback-"));
    execFileSync("git", ["init"], { cwd: sessionRepo, stdio: "ignore" });
    const guardDir = join(sessionRepo, ".semctx");
    const guardPath = join(guardDir, "guard.json");
    mkdirSync(guardDir);
    const terminal = {
      type: "tool_call" as const,
      toolCallId: "fallback-unknown",
      toolName: "bash",
      input: { command: "git commit -m x" },
    };
    const throwing = () => { throw new Error("probe failure"); };
    try {
      writeFileSync(guardPath, "{not-json");
      expect(evaluateOmpToolCall(terminal, { cwd: sessionRepo }, throwing)).toEqual({
        block: true,
        reason: "semctx guarded mode: guard evaluation failed; terminal Git operation is not authorized.",
      });

      rmSync(guardPath);
      expect(evaluateOmpToolCall(terminal, { cwd: sessionRepo }, throwing)).toBeUndefined();

      writeFileSync(guardPath, "{not-json");
      expect(evaluateOmpToolCall({
        ...terminal,
        input: { ...terminal.input, env: { SEMCTX_GUARD: "off" } },
      }, { cwd: sessionRepo }, throwing)).toBeUndefined();
    } finally {
      rmSync(sessionRepo, { recursive: true, force: true });
    }
  });

  test("registers exactly one tool_call handler; ignores non-bash tools; never authorizes a blocked evaluation", () => {
    const repo = createGuardedRepo("semctx-omp-adapter-");
    try {
      type Event = { type: "tool_call"; toolCallId: string; toolName: string; input: Record<string, unknown> };
      type Context = { cwd: string };
      const handlers: Array<(event: Event, ctx: Context) => { block?: boolean; reason?: string } | undefined> = [];
      const api = {
        on: (event: "tool_call", handler: typeof handlers[number]) => {
          expect(event).toBe("tool_call");
          handlers.push(handler);
        },
      };
      semctxGuardExtension(api);
      expect(handlers).toHaveLength(1);
      const handler = handlers[0]!;
      const ctx = { cwd: repo };

      expect(handler({ type: "tool_call", toolCallId: "1", toolName: "read", input: {} }, ctx)).toBeUndefined();

      const blocked = handler(
        { type: "tool_call", toolCallId: "2", toolName: "bash", input: { command: "git commit -m x" } },
        ctx,
      );
      expect(blocked?.block).toBe(true);
      expect(typeof blocked?.reason).toBe("string");

      const retargeted = handler(
        {
          type: "tool_call",
          toolCallId: "2b",
          toolName: "bash",
          input: { command: "git commit -m x", env: { GIT_DIR: join(repo, ".git") } },
        },
        ctx,
      );
      expect(retargeted?.block).toBe(true);
      expect(retargeted?.reason).toContain("Git repository retargeting");

      const explicitlyDisabled = handler(
        {
          type: "tool_call",
          toolCallId: "2c",
          toolName: "bash",
          input: { command: "git commit -m x", env: { SEMCTX_GUARD: "off" } },
        },
        ctx,
      );
      expect(explicitlyDisabled).toBeUndefined();

      const passthrough = handler(
        { type: "tool_call", toolCallId: "3", toolName: "bash", input: { command: "git status" } },
        ctx,
      );
      expect(passthrough).toBeUndefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
