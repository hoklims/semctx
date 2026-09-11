import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Bun reads `$cwd/bunfig.toml` (running its `preload` scripts before the entrypoint) and
// auto-loads `$cwd/.env`. A host that starts the plugin MCP server inside the analysed checkout
// therefore hands that checkout arbitrary code execution the moment the plugin auto-starts
// (SEC-PPLUG-01). Every shipped launch pins Bun's working directory to the installed plugin root,
// and this file proves both that the vector is real and that the pinned launch closes it.

const repoRoot = resolve(import.meta.dir, "..");
const claudePluginRoot = resolve(repoRoot, "plugins/claude-code");
const codexPluginRoot = resolve(repoRoot, "plugins/semctx-control");

const fixtures: string[] = [];

/** A checkout that would run code on every Bun start from its directory. */
function hostileCheckout(): { root: string; marker: string } {
  const root = mkdtempSync(join(tmpdir(), "semctx-hostile-checkout-"));
  fixtures.push(root);
  const marker = join(root, "PRELOAD-RAN");
  writeFileSync(join(root, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
  writeFileSync(
    join(root, "preload.ts"),
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
  );
  writeFileSync(join(root, ".env"), "SEMCTX_LAUNCH_PROBE=leaked\n");
  return { root, marker };
}

/** Prints what a launched process actually observes; stands in for the bundle entrypoint. */
function probeEntry(): string {
  const dir = mkdtempSync(join(tmpdir(), "semctx-launch-probe-"));
  fixtures.push(dir);
  const entry = join(dir, "probe.js");
  writeFileSync(
    entry,
    'process.stdout.write(JSON.stringify({ cwd: process.cwd(), probe: process.env.SEMCTX_LAUNCH_PROBE ?? null }));\n',
  );
  return entry;
}

function json<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(repoRoot, path), "utf8")) as T;
}

interface StdioLaunch {
  command: string;
  args: string[];
}

/** The argv a host builds from a manifest, with the host's plugin-root placeholder substituted. */
function launchArgv(launch: StdioLaunch, placeholder: string, pluginRoot: string): string[] {
  return launch.args.map((arg) => arg.replaceAll(placeholder, pluginRoot));
}

function runBun(args: string[], cwd: string): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync([process.execPath, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode };
}

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("plugin MCP launches never run the analysed checkout's Bun configuration", () => {
  test("witness: an unpinned launch from a hostile checkout runs its preload and loads its .env", () => {
    const checkout = hostileCheckout();
    const result = runBun([probeEntry()], checkout.root);
    expect(result.exitCode).toBe(0);
    expect(existsSync(checkout.marker)).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual({ cwd: checkout.root, probe: "leaked" });
  });

  const hosts: Array<{ host: string; manifest: string; placeholder: string; pluginRoot: string }> = [
    {
      host: "Claude Code",
      manifest: "plugins/claude-code/.mcp.json",
      placeholder: "${CLAUDE_PLUGIN_ROOT}",
      pluginRoot: claudePluginRoot,
    },
    {
      host: "Oh My Pi",
      manifest: "plugins/claude-code/mcp.json",
      placeholder: "${PLUGIN_ROOT}",
      pluginRoot: claudePluginRoot,
    },
  ];

  for (const { host, manifest, placeholder, pluginRoot } of hosts) {
    test(`${host} manifest pins Bun's working directory to the plugin root`, () => {
      const launch = json<{ mcpServers: { semctx: StdioLaunch } }>(manifest).mcpServers.semctx;
      expect(launch.command).toBe("bun");
      expect(launch.args.slice(0, 2)).toEqual(["--cwd", placeholder]);
      expect(launch.args.at(-1)).toBe(`${placeholder}/dist/semctx-mcp.js`);
      expect(existsSync(resolve(pluginRoot, "dist/semctx-mcp.js"))).toBe(true);
    });

    test(`${host} launch started inside a hostile checkout ignores its bunfig.toml and .env`, () => {
      const checkout = hostileCheckout();
      const launch = json<{ mcpServers: { semctx: StdioLaunch } }>(manifest).mcpServers.semctx;
      const argv = launchArgv(launch, placeholder, pluginRoot);
      const result = runBun([...argv.slice(0, -1), probeEntry()], checkout.root);
      expect(result.exitCode).toBe(0);
      expect(existsSync(checkout.marker)).toBe(false);
      expect(JSON.parse(result.stdout)).toEqual({ cwd: pluginRoot, probe: null });
    });
  }

  test("the pinned launch still starts the committed MCP bundle", async () => {
    const checkout = hostileCheckout();
    const launch = json<{ mcpServers: { semctx: StdioLaunch } }>("plugins/claude-code/.mcp.json").mcpServers.semctx;
    const argv = launchArgv(launch, "${CLAUDE_PLUGIN_ROOT}", claudePluginRoot);
    const child = Bun.spawn([process.execPath, ...argv], {
      cwd: checkout.root,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const ready = await Promise.race([
        (async () => {
          let text = "";
          for await (const chunk of child.stderr) {
            text += new TextDecoder().decode(chunk);
            if (text.includes("semctx MCP server ready")) return text;
          }
          return text;
        })(),
        Bun.sleep(20_000).then(() => "TIMEOUT"),
      ]);
      expect(ready).toContain("semctx MCP server ready");
      expect(existsSync(checkout.marker)).toBe(false);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test("Codex manifest resolves the bundle relative to a cwd that must be the plugin root", () => {
    // Codex substitutes no plugin-root placeholder into `.mcp.json`. Its launch names the bundle
    // relative to `cwd: "."`, so the server can only start when that cwd is the installed plugin
    // directory; a launch from the analysed checkout would fail before Bun read anything there.
    const launch = json<{ mcpServers: { semctx: StdioLaunch & { cwd: string } } }>(
      "plugins/semctx-control/.mcp.json",
    ).mcpServers.semctx;
    expect(launch.command).toBe("bun");
    expect(launch.cwd).toBe(".");
    expect(launch.args).toEqual(["./dist/semctx-mcp.js"]);
    expect(existsSync(resolve(codexPluginRoot, launch.cwd, launch.args[0]!))).toBe(true);
    expect(existsSync(resolve(codexPluginRoot, "bunfig.toml"))).toBe(false);
    expect(existsSync(resolve(codexPluginRoot, ".env"))).toBe(false);
  });
});
