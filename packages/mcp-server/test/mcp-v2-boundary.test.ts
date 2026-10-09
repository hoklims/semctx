import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");

function collectFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? collectFiles(path) : [path];
  });
}

describe("MCP 2026 SDK boundary", () => {
  test("uses the split v2 SDK without leaking it into the rest of the monorepo", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, "packages/mcp-server/package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(manifest.dependencies?.["@modelcontextprotocol/server"]).toBe("2.2.0");
    expect(manifest.devDependencies?.["@modelcontextprotocol/client"]).toBe("2.2.0");
    expect(manifest.dependencies?.["@modelcontextprotocol/sdk"]).toBeUndefined();
    expect(manifest.dependencies?.["zod"]).toBe("^3.23.8");
    expect(manifest.dependencies?.["zod-v4"]).toBe("npm:zod@4.2.0");
  });

  test("serves stdio through the dual-era factory entrypoint", () => {
    const source = readFileSync(
      resolve(root, "packages/mcp-server/src/index.ts"),
      "utf8",
    );

    expect(source).toContain(
      'import { serveStdio } from "@modelcontextprotocol/server/stdio";',
    );
    expect(source).toContain("serveStdio(() => createSemctxServer(root)");
    expect(source).not.toContain("new StdioServerTransport()");
  });

  test("keeps legacy SDK imports out of production and test sources", () => {
    const legacyPackage = ["@modelcontextprotocol", "sdk"].join("/");
    const legacyImport = new RegExp(`from\\s+["']${legacyPackage}`);
    const matches: string[] = [];

    for (const relative of [
      "packages/mcp-server/src",
      "packages/mcp-server/test",
    ]) {
      for (const file of collectFiles(resolve(root, relative))) {
        if (legacyImport.test(readFileSync(file, "utf8"))) {
          matches.push(file);
        }
      }
    }

    expect(matches).toEqual([]);
  });
});
