import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { cpSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareTaskTool, inspectTool, verifyChangeTool } from "../src/index";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "semctx-mcp-"));
  cpSync(SAMPLE_REPO, root, {
    recursive: true,
    filter: (src) => !src.includes(".semctx") && !src.includes("node_modules"),
  });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("semctx_prepare_task", () => {
  it("auto-indexes an un-initialised repo and returns a justified pack", async () => {
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
    expect(["PASS", "WARN", "BLOCK"]).toContain(result.verdict);
    expect(result.changedFiles).toContain("src/domain/capacity.ts");
    expect(result.recommendedTests.length).toBeGreaterThan(0);
  });
});
