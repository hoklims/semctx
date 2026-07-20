import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { cpSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareTaskTool, inspectTool, verifyChangeTool } from "../src/index";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import { analyzeAndBuildClaims } from "@semantic-context/app-services";
import { dbPath, initWorkspace, openStore } from "@semantic-context/repository-store";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "semctx-mcp-"));
  cpSync(SAMPLE_REPO, root, {
    recursive: true,
    filter: (src) => !src.includes(".semctx") && !src.includes("node_modules"),
  });
  const config = initWorkspace(root);
  const store = openStore(root);
  try {
    const { analysis, claims } = analyzeAndBuildClaims(config);
    store.saveGraph(analysis.graph, analysis.evidence);
    store.replaceClaims(claims);
  } finally {
    store.close();
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readiness policy", () => {
  it("fails closed without creating .semctx for an uninitialized repository", async () => {
    const uninitialized = mkdtempSync(join(tmpdir(), "semctx-mcp-uninitialized-"));
    try {
      cpSync(SAMPLE_REPO, uninitialized, {
        recursive: true,
        filter: (src) => !src.includes(".semctx") && !src.includes("node_modules"),
      });

      expect(() => inspectTool(uninitialized, { query: "reservation" })).toThrow("run 'semctx setup' first");
      expect(() => verifyChangeTool(uninitialized, { gitDiff: "diff --git a/a.ts b/a.ts" })).toThrow(
        "run 'semctx setup' first",
      );
      await expect(prepareTaskTool(uninitialized, { task: "reservation" })).rejects.toThrow(
        "run 'semctx setup' first",
      );
      expect(existsSync(join(uninitialized, ".semctx"))).toBe(false);
    } finally {
      rmSync(uninitialized, { recursive: true, force: true });
    }
  });

  it("does not create SQLite files when an initialized repository is still unindexed", async () => {
    const calls: Array<(target: string) => unknown | Promise<unknown>> = [
      (target: string) => inspectTool(target, { query: "reservation" }),
      (target: string) => verifyChangeTool(target, { gitDiff: "diff --git a/a.ts b/a.ts" }),
      (target: string) => prepareTaskTool(target, { task: "reservation" }),
    ];

    for (const call of calls) {
      const unindexed = mkdtempSync(join(tmpdir(), "semctx-mcp-unindexed-"));
      try {
        initWorkspace(unindexed);
        const database = dbPath(unindexed);
        expect(existsSync(database)).toBe(false);
        await expect((async () => { await call(unindexed); })()).rejects.toThrow("run 'semctx setup' first");
        expect(existsSync(database)).toBe(false);
        expect(existsSync(`${database}-wal`)).toBe(false);
        expect(existsSync(`${database}-shm`)).toBe(false);
      } finally {
        rmSync(unindexed, { recursive: true, force: true });
      }
    }
  });
});

describe("semctx_prepare_task", () => {
  it("returns a justified pack from an explicitly prepared repo", async () => {
    const { taskFrame, contextPack } = await prepareTaskTool(root, {
      task: "Fix overbooking on concurrent reservation confirmation",
      mode: "bugfix",
    });
    expect(taskFrame.mode).toBe("bugfix");
    expect(taskFrame.hardInvariants).toContain("confirmed-never-exceeds-capacity");
    expect(contextPack.hardConstraints.length).toBeGreaterThan(0);
    expect(contextPack.meta.deterministic).toBe(true);
    expect(contextPack.recommendedReads.some((r) => r.path.includes("confirmation"))).toBe(true);
  });

  it("keeps the deprecated lexical neighbour non-normative", async () => {
    const { contextPack } = await prepareTaskTool(root, { task: "reservation confirmation capacity" });
    expect(contextPack.recommendedReads.some((r) => r.path.includes("legacy"))).toBe(false);
    for (const claim of contextPack.authoritativeClaims) {
      expect(claim.verificationStatus).not.toBe("deprecated");
    }
  });
});

describe("semctx_inspect", () => {
  it("inspects a capability and lists files to read", () => {
    const result = inspectTool(root, { query: "reservation-confirmation", kind: "capability" });
    expect(result.matchedNodes.length).toBeGreaterThan(0);
    expect(result.matchedNodes[0]?.kind).toBe("capability");
    expect(result.relatedClaims.length).toBeGreaterThan(0);
  });
});

describe("semctx_verify_change", () => {
  it("verifies a supplied unified diff", () => {
    const diff = "--- a/src/domain/capacity.ts\n+++ b/src/domain/capacity.ts\n@@ -12 +12,2 @@\n-old\n+new\n";
    const result = verifyChangeTool(root, { gitDiff: diff });
    expect(result.schemaVersion).toBe(1);
    expect(["PASS", "WARN", "BLOCK"]).toContain(result.verdict);
    expect(result.head).toBe("(provided)");
    expect(result.summary.blockCount + result.summary.warnCount).toBe(result.findings.length);
    expect(result.changedFiles).toContain("src/domain/capacity.ts");
    expect(result.recommendedTests.length).toBeGreaterThan(0);
  });
});
