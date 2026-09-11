import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
function read(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8").replaceAll("\r\n", "\n");
}
function json<T>(path: string): T {
  return JSON.parse(read(path)) as T;
}

describe("Oh My Pi Agent-Plugins package", () => {
  test("catalog pins the Claude plugin tree to its immutable release tag with matching version", () => {
    const catalog = json<{
      name: string;
      plugins: Array<{
        name: string;
        source: { source: string; url: string; path: string; ref: string };
        version: string;
      }>;
    }>(".omp-plugin/marketplace.json");
    const claude = json<{ version: string }>(
      "plugins/claude-code/.claude-plugin/plugin.json",
    );
    expect(catalog.name).toBe("semctx-stable");
    expect(catalog.plugins).toHaveLength(1);
    expect(catalog.plugins[0]).toMatchObject({
      name: "semctx",
      source: {
        source: "git-subdir",
        url: "https://github.com/hoklims/semctx.git",
        path: "plugins/claude-code",
        ref: `v${claude.version}`,
      },
      version: claude.version,
    });
  });

  // The marketplace name ("semctx-stable") is a catalog label, not a Git pin. Only the plugin
  // source.ref field binds the installed bytes, and a release tag is immutable evidence while the
  // distribution branch can move after a later release.
  test("the marketplace name alone is not a git pin — only source.ref binds the install", () => {
    const catalog = json<{
      plugins: Array<{ source: { ref: string } }>;
    }>(".omp-plugin/marketplace.json");
    const ref = catalog.plugins[0]?.source.ref;
    expect(ref).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(ref).not.toBe("main");
    expect(ref).not.toBe("stable");
  });

  test("standard manifests launch the bundled MCP through PLUGIN_ROOT without project binding", () => {
    const manifest = json<{ $schema: string; name: string }>("plugins/claude-code/plugin.json");
    expect(manifest.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    expect(manifest.name).toBe("semctx");
    const mcp = json<{
      mcpServers: { semctx: { type: string; command: string; args: string[] } };
    }>("plugins/claude-code/mcp.json");
    expect(mcp.mcpServers.semctx).toEqual({
      type: "stdio",
      command: "bun",
      args: ["--cwd", "${PLUGIN_ROOT}", "${PLUGIN_ROOT}/dist/semctx-mcp.js"],
    });
    expect(read("plugins/claude-code/mcp.json")).not.toMatch(/CLAUDE_|SEMCTX_ROOT|"cwd"/);
    expect(existsSync(resolve(repoRoot, "plugins/claude-code/.omp-plugin/plugin.json"))).toBe(false);
    expect(existsSync(resolve(repoRoot, "plugins/claude-code/mcp-omp.json"))).toBe(false);
    expect(existsSync(resolve(repoRoot, "plugins/claude-code/dist/semctx-mcp.js"))).toBe(true);
  });
});
