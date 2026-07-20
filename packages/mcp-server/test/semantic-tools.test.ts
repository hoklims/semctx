import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { cpSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import { analyzeAndBuildClaims } from "@semantic-context/app-services";
import { initWorkspace, openStore } from "@semantic-context/repository-store";
import { initSemanticScaffold } from "@semantic-context/semantic-engine";
import {
  semanticSliceTool,
  changeOpenTool,
  changeUpdateTool,
  changeVerifyTool,
  changeCloseTool,
  semanticInspectTool,
  handoffTool,
  resumeTool,
} from "../src/semantic-tools";

let root: string;
const CHANGE = "change.payment-webhook-retry";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "semctx-sem-mcp-"));
  cpSync(SAMPLE_REPO, root, { recursive: true, filter: (src) => !src.includes(".semctx") && !src.includes("node_modules") });
  const config = initWorkspace(root);
  const store = openStore(root);
  try {
    const { analysis, claims } = analyzeAndBuildClaims(config);
    store.saveGraph(analysis.graph, analysis.evidence);
    store.replaceClaims(claims);
  } finally {
    store.close();
  }
  // Scaffold the authored example nodes (as a human's `semctx semantic init` would).
  initSemanticScaffold(root);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("semantic-layer MCP tools", () => {
  it("rejects a prefixed traversal id before writing outside changes", () => {
    const escaped = join(root, ".semctx", "evil-payload.sem");
    expect(() =>
      changeOpenTool(root, {
        id: "change.x/../../../evil-payload",
        statement: "must stay contained",
      }),
    ).toThrow();
    expect(Bun.file(escaped).size).toBe(0);
  });

  it("opens an agent-authored change contract", () => {
    const contract = changeOpenTool(root, {
      id: CHANGE,
      statement: "make the webhook retry-safe",
      preserves: ["invariant.example.idempotent-write"],
      unknowns: ["unknown.example.concurrency-race"],
    });
    expect(contract.id).toBe(CHANGE);
    expect(contract.provenance).toBe("agent");
    expect(contract.lifecycle).toBe("active");
  });

  it("slices deterministically from the change scope", () => {
    const { slice, capsule } = semanticSliceTool(root, { changeId: CHANGE });
    expect(slice.changes.map((c) => c.id)).toContain(CHANGE);
    expect(slice.openUnknowns.map((u) => u.id)).toContain("unknown.example.concurrency-race");
    expect(capsule).toContain("# Semantic slice");
  });

  it("composes verify diff into a PARTIAL verdict while an unknown is open", () => {
    const report = changeVerifyTool(root, { changeId: CHANGE, gitDiff: "" });
    expect(report.verdict).toBe("PARTIAL");
    expect(report.underlying.schemaVersion).toBe(1);
    expect(report.openUnknowns.map((u) => u.id)).toContain("unknown.example.concurrency-race");
  });

  it("cannot claim verified through update or close before composed verification passes", () => {
    expect(() => changeUpdateTool(root, { id: CHANGE, status: "verified" })).toThrow(
      "use semctx_change_close",
    );
    expect(() => changeCloseTool(root, { id: CHANGE, gitDiff: "" })).toThrow(
      "composed verification is PARTIAL",
    );
  });

  it("resolves the unknown and reaches VERIFIED", () => {
    expect(() => changeUpdateTool(root, { id: CHANGE, resolveUnknowns: ["unknown.example.concurrency-race"] })).toThrow(
      "proved evidence",
    );
    writeFileSync(
      join(root, ".semctx", "semantic", "unknowns.sem"),
      "unknown unknown.example.concurrency-race\n  statement: Concurrent writers may race.\n  status: declared\n  proved_by: evidence.example.race-test\n",
      "utf8",
    );
    writeFileSync(
      join(root, ".semctx", "semantic", "evidence.sem"),
      "evidence evidence.example.race-test\n  statement: Concurrency regression passes.\n  status: tested\n",
      "utf8",
    );
    changeUpdateTool(root, { id: CHANGE, resolveUnknowns: ["unknown.example.concurrency-race"] });
    const report = changeVerifyTool(root, { changeId: CHANGE, gitDiff: "" });
    expect(report.verdict).toBe("VERIFIED");
  });

  it("inspects a semantic id with incoming references", () => {
    const inspection = semanticInspectTool(root, { id: "invariant.example.idempotent-write" });
    expect(inspection.found).toBe(true);
    expect(inspection.incoming.some((r) => r.from === CHANGE && r.field === "preserves")).toBe(true);
  });

  it("captures and resumes a handoff capsule", () => {
    const capsule = handoffTool(root, { note: "mid-task" });
    expect(capsule.activeChangeId).toBe(CHANGE);
    const resumed = resumeTool(root);
    expect("activeChangeId" in resumed ? resumed.activeChangeId : undefined).toBe(CHANGE);
  });

  it("closes verified only after composed verification passes", () => {
    const closed = changeCloseTool(root, { id: CHANGE, gitDiff: "" });
    expect(closed.lifecycle).toBe("verified");
  });

  it("does not disturb the first-class verify tool (import still works)", async () => {
    const { verifyChangeTool } = await import("../src/tools");
    const result = verifyChangeTool(root, { gitDiff: "--- a/src/domain/capacity.ts\n+++ b/src/domain/capacity.ts\n@@ -12 +12,2 @@\n-old\n+new\n" });
    expect(["PASS", "WARN", "BLOCK"]).toContain(result.verdict);
  });
});
