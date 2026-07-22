import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

function read(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8").replaceAll("\r\n", "\n");
}

function json<T>(path: string): T {
  return JSON.parse(read(path)) as T;
}

function typescriptLibs(plugin: "claude-code" | "semctx-control"): string[] {
  return readdirSync(resolve(repoRoot, `plugins/${plugin}/dist/typescript-lib`))
    .filter((name) => name.startsWith("lib") && name.endsWith(".d.ts"))
    .sort();
}

describe("Codex and Claude Code plugin parity", () => {
  test("ships one byte-identical semctx-control workflow contract", () => {
    const codex = read("plugins/semctx-control/skills/semctx-control/SKILL.md");
    const claude = read("plugins/claude-code/skills/semctx-control/SKILL.md");

    expect(claude).toBe(codex);
    for (const required of [
      "semctx_control_status",
      "semctx_control_trace",
      "semctx_control_plan",
      "semctx_verify_change",
      "semctx_change_verify",
      "READY",
      "BLOCKED",
      "PARTIAL",
      "runtime tests",
    ]) {
      expect(codex).toContain(required);
    }
  });

  test("registers the same MCP server identity and compatible plugin versions", () => {
    const codexMcp = json<{
      mcpServers: Record<string, { command: string; args: string[]; cwd?: string; default_tools_approval_mode?: string }>;
    }>(
      "plugins/semctx-control/.mcp.json",
    );
    const claudeMcp = json<{
      mcpServers: Record<
        string,
        { command: string; args: string[]; env: Record<string, string> }
      >;
    }>(
      "plugins/claude-code/.mcp.json",
    );
    const codexManifest = json<{ version: string }>(
      "plugins/semctx-control/.codex-plugin/plugin.json",
    );
    const claudeManifest = json<{
      version: string;
      skills?: string;
      hooks?: string;
      mcpServers?: string;
    }>(
      "plugins/claude-code/.claude-plugin/plugin.json",
    );
    const marketplace = json<{ plugins: Array<{ name: string; version: string }> }>(
      ".claude-plugin/marketplace.json",
    );

    expect(Object.keys(codexMcp.mcpServers)).toEqual(["semctx"]);
    expect(Object.keys(claudeMcp.mcpServers)).toEqual(["semctx"]);
    expect(codexMcp.mcpServers.semctx).toEqual({
      command: "bun",
      args: ["./dist/semctx-mcp.js"],
      cwd: ".",
      default_tools_approval_mode: "writes",
    });
    expect(claudeMcp.mcpServers.semctx.command).toBe("bun");
    expect(claudeMcp.mcpServers.semctx.args).toEqual([
      "${CLAUDE_PLUGIN_ROOT}/dist/semctx-mcp.js",
    ]);
    expect(claudeMcp.mcpServers.semctx.env).toEqual({
      SEMCTX_ROOT: "${CLAUDE_PROJECT_DIR}",
    });
    expect(existsSync(resolve(repoRoot, "plugins/claude-code/bin/semctx-mcp-launcher.ts"))).toBe(false);
    expect(read("plugins/claude-code/dist/semctx-mcp.js")).toBe(read("plugins/semctx-control/dist/semctx-mcp.js"));
    const codexLibs = typescriptLibs("semctx-control");
    const claudeLibs = typescriptLibs("claude-code");
    expect(codexLibs.length).toBeGreaterThan(90);
    expect(codexLibs).toContain("lib.d.ts");
    expect(claudeLibs).toEqual(codexLibs);
    for (const lib of codexLibs) {
      expect(read(`plugins/claude-code/dist/typescript-lib/${lib}`)).toBe(
        read(`plugins/semctx-control/dist/typescript-lib/${lib}`),
      );
    }
    expect(codexManifest.version.split("+")[0]).toBe(claudeManifest.version.split("+")[0]);
    expect(claudeManifest.skills).toBeUndefined();
    expect(claudeManifest.hooks).toBeUndefined();
    expect(claudeManifest.mcpServers).toBeUndefined();
    expect(marketplace.plugins.find((plugin) => plugin.name === "semctx")?.version).toBe(
      claudeManifest.version,
    );
    expect(json<{ version: string }>("packages/mcp-server/package.json").version).toBe(claudeManifest.version);
    expect(json<{ version: string }>("packages/app-services/package.json").version).toBe(claudeManifest.version);
    const serverSource = read("packages/mcp-server/src/server.ts");
    expect(serverSource).toContain('import packageJson from "../package.json"');
    expect(serverSource).toContain("version: packageJson.version");
  });

  test("documents the shared Plane A, B, and C workflow for both hosts", () => {
    const rootReadme = read("README.md");
    const claudeReadme = read("plugins/claude-code/README.md");
    const claudeGuide = read("docs/integrations/claude-code.md");
    const codexGuide = read("docs/integrations/codex-control-plane.md");

    for (const document of [rootReadme, claudeReadme, claudeGuide, codexGuide]) {
      expect(document).toContain("semctx_control_status");
      expect(document).toContain("semctx_control_trace");
      expect(document).toContain("semctx_control_plan");
      expect(document).toContain("READY");
      expect(document).toContain("execution authority");
    }
  });
});
