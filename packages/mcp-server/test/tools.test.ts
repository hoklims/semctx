import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, existsSync, realpathSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareTaskTool, inspectTool, verifyChangeTool } from "../src/index";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import { SemctxError } from "@semantic-context/core";
import type { ErrorWithSuppressed } from "@semantic-context/core";
import { analyzeAndBuildClaims, openReadyRepositoryWriter } from "@semantic-context/app-services";
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

async function expectFailure(
  action: () => unknown,
  expectedMessage: string,
): Promise<void> {
  let failure: unknown;
  try {
    await Promise.resolve().then(action);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(expectedMessage);
}

describe("readiness policy", () => {
  it("fails closed without creating .semctx for an uninitialized repository", async () => {
    const uninitialized = mkdtempSync(join(tmpdir(), "semctx-mcp-uninitialized-"));
    try {
      cpSync(SAMPLE_REPO, uninitialized, {
        recursive: true,
        filter: (src) => !src.includes(".semctx") && !src.includes("node_modules"),
      });

      expect(() => inspectTool(uninitialized, { query: "reservation" })).toThrow("run MCP semctx_setup (confirm:true) or 'semctx setup' first");
      expect(() => verifyChangeTool(uninitialized, { gitDiff: "diff --git a/a.ts b/a.ts" })).toThrow(
        "run MCP semctx_setup (confirm:true) or 'semctx setup' first",
      );
      await expectFailure(
        () => prepareTaskTool(uninitialized, { task: "reservation" }),
        "run MCP semctx_setup (confirm:true) or 'semctx setup' first",
      );
      expect(existsSync(join(uninitialized, ".semctx"))).toBe(false);
    } finally {
      rmSync(uninitialized, { recursive: true, force: true });
    }
  });

  it("does not create SQLite files when an initialized repository is still unindexed", async () => {
    const calls: Array<(target: string) => unknown> = [
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
        await expectFailure(
          () => call(unindexed),
          "run MCP semctx_setup (confirm:true) or 'semctx setup' first",
        );
        expect(existsSync(database)).toBe(false);
        expect(existsSync(`${database}-wal`)).toBe(false);
        expect(existsSync(`${database}-shm`)).toBe(false);
      } finally {
        rmSync(unindexed, { recursive: true, force: true });
      }
    }
  });

  it("preserves the unindexed readiness error when WAL cleanup is also blocked", () => {
    const unindexed = mkdtempSync(join(tmpdir(), "semctx-mcp-unindexed-wal-"));
    try {
      initWorkspace(unindexed);
      const store = openStore(unindexed);
      store.close();
      const database = dbPath(unindexed);
      const writer = new Database(database);
      writer.exec("PRAGMA journal_mode=WAL;");
      writer.query("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run("readiness_probe", "before");
      const blocker = new Database(database, { readonly: true });
      blocker.exec("BEGIN;");
      blocker.query("SELECT value FROM meta WHERE key = 'readiness_probe'").get();
      writer.query("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run("readiness_probe", "after");
      writer.close();
      try {
        let failure: unknown;
        try {
          openReadyRepositoryWriter(unindexed);
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(SemctxError);
        const readinessFailure = failure as SemctxError & ErrorWithSuppressed;
        expect(readinessFailure.code).toBe("REPO_NOT_INDEXED");
        expect(readinessFailure.suppressed[0]).toBeInstanceOf(SemctxError);
        expect((readinessFailure.suppressed[0] as SemctxError).code).toBe("STORE_ERROR");
        expect(readinessFailure.details.suppressed).toEqual([expect.objectContaining({
          code: "STORE_ERROR",
          message: "repository store checkpoint is busy",
        })]);
      } finally {
        blocker.exec("ROLLBACK;");
        blocker.close();
      }
    } finally {
      rmSync(unindexed, { recursive: true, force: true });
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

  it("recovers through a mutable writer after a busy WAL cleanup", async () => {
    const recoveryRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "semctx-mcp-wal-recovery-")));
    try {
      cpSync(SAMPLE_REPO, recoveryRoot, {
        recursive: true,
        filter: (src) => !src.includes(".semctx") && !src.includes("node_modules"),
      });
      const config = initWorkspace(recoveryRoot);
      const store = openStore(recoveryRoot);
      try {
        const { analysis, claims } = analyzeAndBuildClaims(config);
        store.saveGraph(analysis.graph, analysis.evidence);
        store.replaceClaims(claims);
      } finally {
        store.close();
      }

      const database = dbPath(recoveryRoot);
      const walSetup = new Database(database);
      walSetup.exec("PRAGMA journal_mode=WAL;");
      const blocker = new Database(database, { readonly: true });
      blocker.exec("BEGIN;");
      blocker.query("SELECT value FROM meta WHERE key = 'schema_version'").get();
      walSetup.query("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(
        "wal_recovery_probe",
        "pending",
      );
      walSetup.close();
      try {
        await expectFailure(
          () => prepareTaskTool(recoveryRoot, { task: "first WAL recovery attempt" }),
          "repository store checkpoint is busy",
        );
        expect(existsSync(`${database}-wal`)).toBe(true);
      } finally {
        blocker.exec("ROLLBACK;");
        blocker.close();
      }

      const result = await prepareTaskTool(recoveryRoot, { task: "retry WAL recovery" });
      expect(result.taskFrame.rawTask).toBe("retry WAL recovery");
      expect(existsSync(`${database}-wal`)).toBe(false);
      expect(existsSync(`${database}-shm`)).toBe(false);
    } finally {
      rmSync(recoveryRoot, { recursive: true, force: true });
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
