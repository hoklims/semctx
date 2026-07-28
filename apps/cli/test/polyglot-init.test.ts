import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/args";
import { runInit } from "../src/commands/init";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("polyglot configuration migration", () => {
  it("writes an explicit v2 glob-selection config only when requested", () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-polyglot-init-"));
    roots.push(root);
    const originalWrite = process.stdout.write.bind(process.stdout);
    let code: number;
    (process.stdout.write as unknown) = (): boolean => true;
    try {
      code = runInit(root, parseArgs(["init", "--root", root, "--polyglot", "--json"]));
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(code).toBe(0);
    const config = JSON.parse(readFileSync(join(root, ".semctx", "config.json"), "utf8"));
    expect(config).toMatchObject({
      version: 2,
      selectionMode: "globs-v1",
      languages: {
        typescript: "on",
        python: "on",
        markdown: "on",
        sql: "on",
      },
    });
    expect(config.include).toContain("src/**/*.{ts,tsx,mts,cts,py}");
  });
});
