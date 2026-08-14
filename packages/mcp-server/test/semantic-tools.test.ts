import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { cpSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import { indexRepository } from "@semantic-context/app-services";
import { initWorkspace } from "@semantic-context/repository-store";
import { activeChangePath, initSemanticScaffold } from "@semantic-context/semantic-engine";
import {
  semanticSliceTool,
  changeOpenTool,
  changeUpdateTool,
  changeVerifyTool,
  changeCloseTool,
  semanticInspectTool,
  semanticCheckTool,
  handoffTool,
  resumeTool,
} from "../src/semantic-tools";

let root: string;
const CHANGE = "change.payment-webhook-retry";
const INVARIANT = "invariant.semctx-test.idempotent-write";
const UNKNOWN = "unknown.semctx-test.concurrency-race";
const EVIDENCE = "evidence.semctx-test.race-test";
const SUPPLIED_DIFF =
  "--- a/src/domain/capacity.ts\n+++ b/src/domain/capacity.ts\n@@ -12 +12,2 @@\n-old\n+new\n";

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "semctx-sem-mcp-"));
  cpSync(SAMPLE_REPO, root, { recursive: true, filter: (src) => !src.includes(".semctx") && !src.includes("node_modules") });
  // A real commit, not a bare directory: impact conclusions are bound to a commit, so a fixture
  // with no Git history could only ever be refused.
  writeFileSync(join(root, ".gitignore"), ".semctx/\n", "utf8");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "fixture");
  initWorkspace(root);
  // Scaffold only inert guidance, then explicitly author the truths used by this fixture.
  initSemanticScaffold(root);
  writeFileSync(
    join(root, ".semctx", "semantic", "invariants.sem"),
    `invariant ${INVARIANT}\n  statement: Retrying a write is equivalent to applying it once.\n  status: declared\n`,
    "utf8",
  );
  writeFileSync(
    join(root, ".semctx", "semantic", "unknowns.sem"),
    `unknown ${UNKNOWN}\n  statement: Concurrent writers may race.\n  status: declared\n`,
    "utf8",
  );
  // Index through the product path rather than writing the graph into the store by hand: a store
  // populated directly carries no index binding, and an unbound index authorizes no impact
  // conclusion. Indexing last so the seal covers the authored truths above.
  indexRepository(root, "2026-08-12T09:00:00.000Z");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("semantic-layer MCP tools", () => {
  it("exposes the same versioned semantic-check contract as the CLI", () => {
    const report = semanticCheckTool(root);
    expect(report.schemaVersion).toBe(1);
    expect(report.kind).toBe("semantic_check");
    expect(report.reasonCodes).toEqual([]);
  });

  it("returns the same canonical lifecycle reason order as the CLI", () => {
    const pointer = activeChangePath(root);
    writeFileSync(pointer, "not a semantic block\n", "utf8");
    try {
      expect(semanticCheckTool(root).reasonCodes).toEqual(["ACTIVE_CHANGE_POINTER_INVALID"]);
    } finally {
      rmSync(pointer, { force: true });
    }
  });

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
      preserves: [INVARIANT],
      unknowns: [UNKNOWN],
    });
    expect(contract.id).toBe(CHANGE);
    expect(contract.provenance).toBe("agent");
    expect(contract.lifecycle).toBe("active");
  });

  it("slices deterministically from the change scope", () => {
    const { slice, capsule } = semanticSliceTool(root, { changeId: CHANGE });
    expect(slice.changes.map((c) => c.id)).toContain(CHANGE);
    expect(slice.openUnknowns.map((u) => u.id)).toContain(UNKNOWN);
    expect(capsule).toContain("# Semantic slice");
  });

  it("composes verify diff into a PARTIAL verdict while an unknown is open", () => {
    const report = changeVerifyTool(root, { changeId: CHANGE });
    expect(report.verdict).toBe("PARTIAL");
    expect(report.underlying.schemaVersion).toBe(1);
    expect(report.openUnknowns.map((u) => u.id)).toContain(UNKNOWN);
  });

  it("cannot claim verified through update or close before composed verification passes", () => {
    expect(() => changeUpdateTool(root, { id: CHANGE, status: "verified" })).toThrow(
      "use semctx_change_close",
    );
    expect(() => changeCloseTool(root, { id: CHANGE })).toThrow(
      "composed verification is PARTIAL",
    );
  });

  it("resolves the unknown and reaches VERIFIED", () => {
    expect(() => changeUpdateTool(root, { id: CHANGE, resolveUnknowns: [UNKNOWN] })).toThrow(
      "proved evidence",
    );
    writeFileSync(
      join(root, ".semctx", "semantic", "unknowns.sem"),
      `unknown ${UNKNOWN}\n  statement: Concurrent writers may race.\n  status: declared\n  proved_by: ${EVIDENCE}\n`,
      "utf8",
    );
    writeFileSync(
      join(root, ".semctx", "semantic", "evidence.sem"),
      `evidence ${EVIDENCE}\n  statement: Concurrency regression passes.\n  status: tested\n`,
      "utf8",
    );
    changeUpdateTool(root, { id: CHANGE, resolveUnknowns: [UNKNOWN] });
    const report = changeVerifyTool(root, { changeId: CHANGE });
    expect(report.verdict).toBe("VERIFIED");
  });

  it("inspects a semantic id with incoming references", () => {
    const inspection = semanticInspectTool(root, { id: INVARIANT });
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
    const closed = changeCloseTool(root, { id: CHANGE });
    expect(closed.lifecycle).toBe("verified");
  });

  it("does not disturb the first-class verify tool (import still works)", async () => {
    const { verifyChangeTool } = await import("../src/tools");
    const result = verifyChangeTool(root, { gitDiff: SUPPLIED_DIFF });
    expect(["PASS", "WARN", "BLOCK"]).toContain(result.verdict);
  });
});

// The MCP surface accepts diff text but offers no way to say which commit it belongs to, so every
// conclusion drawn from it is unanchored. It must stay diagnostic rather than certifying.
describe("MCP-supplied diff text carries no provenance", () => {
  it("refuses an impact verdict for a diff handed to semctx_verify_change", async () => {
    const { verifyChangeTool } = await import("../src/tools");

    const report = verifyChangeTool(root, { gitDiff: SUPPLIED_DIFF });

    expect(report.verdict).toBe("BLOCK");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "index_binding_stale",
          message: expect.stringContaining("SOURCE_IDENTITY_ABSENT"),
        }),
      ]),
    );
  });

  it("never composes a supplied diff into VERIFIED", () => {
    const composed = changeVerifyTool(root, { changeId: CHANGE, gitDiff: SUPPLIED_DIFF });

    expect(composed.verdict).not.toBe("VERIFIED");
    expect(composed.verdict).toBe("BLOCKED");
  });

  it("refuses to close a change on a supplied diff", () => {
    expect(() => changeCloseTool(root, { id: CHANGE, gitDiff: SUPPLIED_DIFF })).toThrow(
      "composed verification is BLOCKED",
    );
  });
});
