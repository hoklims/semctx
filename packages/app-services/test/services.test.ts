import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace } from "@semantic-context/repository-store";
import { initSemanticScaffold } from "@semantic-context/semantic-engine";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import { indexRepository, loadControlState, planControlMigration, planVerify, runVerify } from "../src";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "semctx-app-services-"));
  cpSync(SAMPLE_REPO, root, { recursive: true, filter: (src) => !src.includes(".semctx") && !src.includes("node_modules") });
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
    expect(control.snapshot.commit).toContain("graph:");
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
});
