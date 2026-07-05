import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { cpSync, rmSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import { parseArgs } from "../src/args";
import { runSetup } from "../src/commands/setup";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "semctx-setup-"));
  cpSync(SAMPLE_REPO, root, { recursive: true, filter: (src) => !src.includes(".semctx") && !src.includes("node_modules") });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("semctx setup — one-command bootstrap", () => {
  it("configures, indexes, scaffolds and validates in a single call", () => {
    const code = runSetup(root, parseArgs(["setup", "--root", root]));
    expect(code).toBe(0);
    expect(existsSync(join(root, ".semctx", "config.json"))).toBe(true);
    expect(existsSync(join(root, ".semctx", "semctx.db"))).toBe(true);
    expect(existsSync(join(root, ".semctx", "semantic", "goals.sem"))).toBe(true);
    expect(existsSync(join(root, ".gitignore"))).toBe(true);
  });

  it("is idempotent — a second run keeps everything and scaffolds nothing new", () => {
    const originalWrite = process.stdout.write.bind(process.stdout);
    let out = "";
    (process.stdout.write as unknown) = (chunk: string): boolean => ((out += chunk), true);
    let code: number;
    try {
      code = runSetup(root, parseArgs(["setup", "--json", "--root", root]));
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(code).toBe(0);
    const report = JSON.parse(out);
    expect(report.check.ok).toBe(true);
    expect(report.semanticFilesCreated).toBe(0);
    expect(report.nodes).toBeGreaterThan(0);
  });
});
