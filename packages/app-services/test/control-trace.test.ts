import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace, openStore } from "@semantic-context/repository-store";
import { initSemanticScaffold } from "@semantic-context/semantic-engine";
import { controlStatus, indexRepository, queryControlTraversal, traceControl } from "../src";
import { CONTROL_INDEX_SNAPSHOT_META_KEY } from "../src/freshness";

let fixture: string;
let main: string;
let linked: string;

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "semctx-test",
      GIT_AUTHOR_EMAIL: "semctx-test@example.com",
      GIT_COMMITTER_NAME: "semctx-test",
      GIT_COMMITTER_EMAIL: "semctx-test@example.com",
    },
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

beforeAll(() => {
  fixture = realpathSync.native(mkdtempSync(join(tmpdir(), "semctx-control-trace-")));
  main = join(fixture, "main");
  linked = join(fixture, "linked");
  mkdirSync(join(main, "src"), { recursive: true });
  writeFileSync(join(main, "src/count.ts"), "export function count(): number { return 1; }\n");
  git(main, "init", "-q");
  git(main, "add", "--", "src/count.ts");
  git(main, "commit", "-qm", "source fixture");
  initWorkspace(main);
  initSemanticScaffold(main);
  writeFileSync(join(main, ".semctx/semantic/trace.sem"),
    "goal goal.trace\n  statement: Synthetic mapped goal.\n  status: declared\n  provenance: author\n  appliesAtLevel: 2\n"
    + "goal goal.unmapped\n  statement: Synthetic unmapped goal.\n  status: declared\n  provenance: author\n");
  git(main, "add", "--", ".gitignore", ".semctx/config.json", ".semctx/semantic");
  git(main, "commit", "-qm", "semantic fixture");
  git(main, "worktree", "add", "-qb", "linked", linked);
  for (const root of [main, linked]) indexRepository(root, "2026-10-14T00:00:00.000Z");
}, 60_000);

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

describe("control trace integration", () => {
  it.each(["lift", "lower"] as const)("traces a fresh mapped coordinate in %s direction in both Git roots", (direction) => {
    for (const root of [main, linked]) {
      expect(controlStatus(root).verdict).toBe("FRESH");
      const query = { sourceId: "semantic:goal.trace" as const, targetLevel: 2 as const, direction };
      const traversal = queryControlTraversal(root, query);
      expect(traversal.terminalStatus).toBe("success");
      const trace = traceControl(root, query);
      expect(trace).toMatchObject({
        terminalStatus: "success",
        direction,
        targetLevel: 2,
        visitedCoordinateIds: ["semantic:goal.trace"],
        paths: [{ coordinates: ["semantic:goal.trace"], steps: [] }],
      });
      const { freshnessSeal, ...facts } = trace;
      expect(traversal.payload).toEqual(facts);
      expect(freshnessSeal ?? null).toEqual(traversal.freshness.seal);
    }
  });

  it.each([
    { sourceId: "semantic:missing" as const, reasonCode: "COORDINATE_UNKNOWN" },
    { sourceId: "semantic:goal.unmapped" as const, reasonCode: "MAPPING_MISSING" },
  ])("preserves $reasonCode on fresh inputs", ({ sourceId, reasonCode }) => {
    for (const direction of ["lift", "lower"] as const) {
      const trace = traceControl(main, { sourceId, direction });
      expect(trace).toMatchObject({ terminalStatus: "empty", direction, reasonCode, targetLevel: direction === "lift" ? 6 : 0 });
    }
  });

  it.each(["src/count.ts", ".semctx/semantic/trace.sem"])("refuses drift in %s without resealing", (path) => {
    const fullPath = join(main, path);
    const original = readFileSync(fullPath, "utf8");
    try {
      writeFileSync(fullPath, original.replace("Synthetic mapped goal.", "Altered mapped goal.").replace("return 1", "return 2"));
      expect(controlStatus(main).verdict).toBe("STALE");
      for (const direction of ["lift", "lower"] as const) {
        const query = { sourceId: "semantic:goal.trace" as const, targetLevel: 2 as const, direction };
        expect(() => traceControl(main, query)).toThrow("control inputs are STALE");
        expect(queryControlTraversal(main, query)).toMatchObject({ terminalStatus: "refused", reasonCodes: ["INDEX_STALE"], payload: null });
      }
    } finally {
      writeFileSync(fullPath, original);
    }
    expect(controlStatus(main).verdict).toBe("FRESH");
  });

  it("refuses an invalid persisted index snapshot", () => {
    const store = openStore(main);
    const original = store.getMeta(CONTROL_INDEX_SNAPSHOT_META_KEY)!;
    store.setMeta(CONTROL_INDEX_SNAPSHOT_META_KEY, "{}");
    store.close();
    try {
      expect(controlStatus(main)).toMatchObject({ verdict: "UNSEALED", reasons: ["INDEX_SNAPSHOT_INVALID"] });
      const query = { sourceId: "semantic:goal.trace" as const, targetLevel: 2 as const, direction: "lift" as const };
      expect(() => traceControl(main, query)).toThrow("invalid persisted control index snapshot");
      expect(queryControlTraversal(main, query)).toMatchObject({ terminalStatus: "refused", reasonCodes: ["INDEX_STALE"], payload: null });
    } finally {
      const restoringStore = openStore(main);
      try {
        restoringStore.setMeta(CONTROL_INDEX_SNAPSHOT_META_KEY, original);
      } finally {
        restoringStore.close();
      }
    }
    expect(controlStatus(main).verdict).toBe("FRESH");
  });
});
