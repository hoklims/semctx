import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace, openStore } from "@semantic-context/repository-store";
import { initSemanticScaffold } from "@semantic-context/semantic-engine";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import { indexRepository, loadControlState, planControlMigration, planVerify, runVerify } from "../src";

let root: string;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "semctx-test",
  GIT_AUTHOR_EMAIL: "semctx-test@example.com",
  GIT_COMMITTER_NAME: "semctx-test",
  GIT_COMMITTER_EMAIL: "semctx-test@example.com",
};

function git(args: string[]): string {
  return gitAt(root, args);
}

function gitAt(cwd: string, args: string[]): string {
  const process = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: GIT_ENV });
  if (process.exitCode !== 0) throw new Error(new TextDecoder().decode(process.stderr));
  return new TextDecoder().decode(process.stdout).trim();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "semctx-app-services-"));
  cpSync(SAMPLE_REPO, root, { recursive: true, filter: (src) => !src.includes(".semctx") && !src.includes("node_modules") });
  writeFileSync(join(root, ".gitignore"), "ignored-input.ts\n", "utf8");
  writeFileSync(join(root, "ignored-input.ts"), "export const ignoredInput = 1;\n", "utf8");
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  initWorkspace(root);
  initSemanticScaffold(root);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("application services", () => {
  it("owns indexing, ADR-0008 verification, and read-only control loading", () => {
    const indexed = indexRepository(root, "2026-07-20T00:00:00.000Z");
    expect(indexed.analysis.graph.nodes.length).toBeGreaterThan(0);

    const verified = runVerify(root, {
      kind: "provided",
      diffText: "--- a/src/domain/capacity.ts\n+++ b/src/domain/capacity.ts\n@@ -12 +12,2 @@\n-old\n+new\n",
    });
    expect(verified.report.schemaVersion).toBe(1);
    expect(verified.report.head).toBe("(provided)");

    const control = loadControlState(root);
    expect(control.freshnessSeal).toEqual(indexed.freshnessSeal);
    expect(control.snapshot.commit).toContain("git:");
    expect(control.freshnessSeal.headAtCapture).toBe(git(["rev-parse", "HEAD"]));
    expect(control.freshnessSeal.indexedHeadCommit).toBe(control.freshnessSeal.headAtCapture);
    expect(control.freshnessSeal.indexedRepositoryRoot).toBe(control.freshnessSeal.repositoryRoot);
    expect(control.freshnessSeal.indexedRepositoryGraphHash).toBe(control.freshnessSeal.repositoryGraphHash);
    expect(control.freshnessSeal.indexedSemanticModelHash).toBe(control.freshnessSeal.semanticModelHash);
    expect(control.freshnessSeal.indexedAnalysisInputHash).toBe(control.freshnessSeal.analysisInputHash);
    expect(control.freshnessSeal.indexedWorkingDiffHash).toBe(control.freshnessSeal.workingDiffHash);
    expect(control.freshnessSeal.storeSchemaVersion).toBe(1);
    expect(control.freshnessSeal.indexedStoreSchemaVersion).toBe(1);
    expect(control.freshnessSeal.toolVersion).toBe("@semantic-context/app-services@0.1.9");
    expect(control.freshnessSeal.indexedToolVersion).toBe(control.freshnessSeal.toolVersion);

    const tracked = join(root, "src", "domain", "capacity.ts");
    const before = readFileSync(tracked, "utf8");
    try {
      writeFileSync(tracked, `${before}\n// freshness test\n`, "utf8");
      const dirty = loadControlState(root);
      expect(dirty.freshnessSeal.headAtCapture).toBe(control.freshnessSeal.headAtCapture);
      expect(dirty.freshnessSeal.repositoryGraphHash).toBe(control.freshnessSeal.repositoryGraphHash);
      expect(dirty.freshnessSeal.workingDiffHash).not.toBe(control.freshnessSeal.workingDiffHash);
      expect(dirty.freshnessSeal.sealHash).not.toBe(control.freshnessSeal.sealHash);
    } finally {
      writeFileSync(tracked, before, "utf8");
    }

    const untracked = join(root, "freshness-untracked.tmp");
    try {
      writeFileSync(untracked, "untracked bytes", "utf8");
      const dirty = loadControlState(root);
      expect(dirty.freshnessSeal.workingDiffHash).not.toBe(control.freshnessSeal.workingDiffHash);
      expect(dirty.freshnessSeal.sealHash).not.toBe(control.freshnessSeal.sealHash);
    } finally {
      unlinkSync(untracked);
    }

    const ignored = join(root, "ignored-input.ts");
    const ignoredBefore = readFileSync(ignored, "utf8");
    try {
      writeFileSync(ignored, `${ignoredBefore}// ignored but analyzed\n`, "utf8");
      const changedInput = loadControlState(root);
      expect(changedInput.freshnessSeal.workingDiffHash).toBe(control.freshnessSeal.workingDiffHash);
      expect(changedInput.freshnessSeal.analysisInputHash).not.toBe(control.freshnessSeal.analysisInputHash);
      expect(changedInput.freshnessSeal.sealHash).not.toBe(control.freshnessSeal.sealHash);
    } finally {
      writeFileSync(ignored, ignoredBefore, "utf8");
    }
  });

  it("rejects an architecture delta without an explicit target at the shared boundary", () => {
    const delta = {
      currentSnapshotId: "current",
      targetSnapshotId: "target",
      added: [],
      removed: [],
      changed: [],
      addedRelations: [],
      removedRelations: [],
      changedRelations: [],
      changedInvariantIds: [],
    };
    expect(() => planControlMigration(root, { changeId: "change.missing", delta })).toThrow(
      "delta requires an explicit target architecture",
    );
  });

  it("rejects option-like git refs before invoking git", () => {
    expect(() => planVerify(root, { kind: "range", base: "--help" })).toThrow(
      'invalid base ref "--help": refs must not start with "-"',
    );
    expect(() => planVerify(root, { kind: "working-tree", head: "--no-merges" })).toThrow(
      'invalid head ref "--no-merges": refs must not start with "-"',
    );
  });

  it("keeps legacy unignored store outputs outside the working-diff seal", () => {
    const legacyRoot = mkdtempSync(join(tmpdir(), "semctx-app-services-legacy-"));
    try {
      writeFileSync(join(legacyRoot, "input.ts"), "export const value = 1;\n", "utf8");
      gitAt(legacyRoot, ["init", "-q"]);
      gitAt(legacyRoot, ["add", "-A"]);
      gitAt(legacyRoot, ["commit", "-q", "-m", "fixture"]);
      initWorkspace(legacyRoot);
      openStore(legacyRoot).close();

      const indexed = indexRepository(legacyRoot, "2026-07-21T00:00:00.000Z");
      const loaded = loadControlState(legacyRoot);

      expect(loaded.freshnessSeal).toEqual(indexed.freshnessSeal);
    } finally {
      rmSync(legacyRoot, { recursive: true, force: true });
    }
  });
});
