import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import { initSemanticScaffold, newChangeContract, writeChangeFile } from "@semantic-context/semantic-engine";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, queryControlDeletionAuthorization, queryControlGraph } from "@semantic-context/app-services";
import { controlAuthorizeDeletionTool, controlGraphTool, controlPlanTool, controlStatusTool, controlTraceTool } from "../src/control-tools";

let root: string;
const CHANGE = "change.control-plane-mcp";
const BLOCKED_CHANGE = "change.control-plane-mcp-open-unknown";

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

function snapshot(dir: string): string {
  const records: Array<{ path: string; bytes: string }> = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) records.push({ path: relative(dir, full).replace(/\\/g, "/"), bytes: readFileSync(full).toString("base64") });
    }
  };
  visit(dir);
  return JSON.stringify(records);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "semctx-control-mcp-"));
  cpSync(SAMPLE_REPO, root, { recursive: true, filter: (src) => !src.includes(".semctx") && !src.includes("node_modules") });
  git(root, "init");
  initWorkspace(root);
  initSemanticScaffold(root);
  writeChangeFile(root, newChangeContract({
    id: CHANGE,
    statement: "expose Plane C MCP tools",
    lifecycle: "active",
    provenance: "author",
  }));
  writeChangeFile(root, newChangeContract({
    id: BLOCKED_CHANGE,
    statement: "MCP migration with unresolved runtime dependency",
    lifecycle: "active",
    provenance: "author",
    openUnknowns: ["unknown.runtime-consumer"],
  }));
  git(root, "add", ".");
  git(root, "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "commit", "-m", "fixture");
  indexRepository(root, "2026-07-19T00:00:00.000Z");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("Plane C MCP handlers", () => {
  it("reports the explicit freshness verdict without mutating the repository", () => {
    const before = snapshot(root);
    expect(controlStatusTool(root)).toMatchObject({
      kind: "control_freshness_status",
      basis: "control_index_snapshot_v1",
      verdict: "FRESH",
      canRunHighRiskControl: true,
      reasons: [],
    });
    expect(snapshot(root)).toBe(before);
  });

  it("returns BLOCKED without a target and READY with an explicit target", () => {
    const blocked = controlPlanTool(root, { changeId: CHANGE });
    expect(blocked.plan.status).toBe("BLOCKED");
    expect(blocked.plan.blockedReason).toBe("target_architecture_missing");
    expect(blocked.freshnessSeal?.sealHash).toMatch(/^sha256:[a-f0-9]{64}$/);

    const current = blocked.plan.current;
    const ready = controlPlanTool(root, {
      changeId: CHANGE,
      target: { ...current, id: "target:mcp", capturedAt: "2026-07-19T01:00:00.000Z" },
    });
    expect(ready.plan.status).toBe("READY");
    expect(ready.plan.steps.map((step) => step.kind)).toContain("deletion_check");
  });

  it("returns the exact shared graph and authorization envelopes", () => {
    expect(controlGraphTool(root)).toEqual(queryControlGraph(root));
    const query = {
      subject: "change.demo",
      planningCommit: "git:not-current",
      evaluatedAt: "2026-07-23T12:00:00.000Z",
      attestationRequests: [],
    };
    expect(controlAuthorizeDeletionTool(root, query)).toEqual(queryControlDeletionAuthorization(root, query));
    expect(controlAuthorizeDeletionTool(root, query)).toMatchObject({
      terminalStatus: "refused",
      reasonCodes: ["PLANNING_COMMIT_MISMATCH"],
      payload: null,
    });
  });

  it("traces without mutating the repository", () => {
    const sourceId = controlGraphTool(root).payload?.nodes.find((node) => !node.id.startsWith("sha256:"))?.id;
    if (sourceId === undefined) throw new Error("expected at least one architecture element");
    const before = snapshot(root);
    const report = controlTraceTool(root, { sourceId: sourceId as `repo:${string}` | `semantic:${string}`, direction: "lift", maxDepth: 4, maxResults: 10 });
    expect(report.schemaVersion).toBe(2);
    expect(report.sourceId).toBe(sourceId);
    expect(report.freshnessSeal?.sealHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(snapshot(root)).toBe(before);
  });

  it("projects Plane B unknowns into a fail-closed plan", () => {
    const current = controlPlanTool(root, { changeId: CHANGE }).plan.current;
    const report = controlPlanTool(root, {
      changeId: BLOCKED_CHANGE,
      target: { ...current, id: "target:mcp-blocked", capturedAt: "2026-07-19T01:00:00.000Z" },
    });

    expect(report.plan.status).toBe("BLOCKED");
    expect(report.plan.blockedReason).toBe("open_unknowns");
    expect(report.plan.blockedDetails[0]?.subjectIds).toEqual(["unknown.runtime-consumer"]);
  });
});
