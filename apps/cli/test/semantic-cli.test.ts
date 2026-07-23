import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { cpSync, rmSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import { activeChangePath, loadActiveChange, loadSemanticModel } from "@semantic-context/semantic-engine";
import { parseArgs } from "../src/args";
import { runInit } from "../src/commands/init";
import { runIndex } from "../src/commands/index-cmd";
import { runSemantic } from "../src/commands/semantic";
import { runChange } from "../src/commands/change";

let root: string;
let emptyDiff: string;

const GOAL = "goal.semctx-test.reliable-writes";
const INVARIANT = "invariant.semctx-test.idempotent-write";
const UNKNOWN = "unknown.semctx-test.concurrency-race";
const EVIDENCE = "evidence.semctx-test.race-test";

function writeAuthoredFixture(): void {
  writeFileSync(
    join(root, ".semctx", "semantic", "goals.sem"),
    `goal ${GOAL}\n  statement: Every write is applied at most once.\n  status: declared\n`,
    "utf8",
  );
  writeFileSync(
    join(root, ".semctx", "semantic", "invariants.sem"),
    `invariant ${INVARIANT}\n  statement: Retrying a write is equivalent to applying it once.\n  status: declared\n  serves: ${GOAL}\n`,
    "utf8",
  );
  writeFileSync(
    join(root, ".semctx", "semantic", "unknowns.sem"),
    `unknown ${UNKNOWN}\n  statement: Concurrent writers may race.\n  status: declared\n`,
    "utf8",
  );
}

/** Run a CLI command, capturing stdout so we can assert on JSON payloads and verdicts. */
function run(fn: (root: string, args: ReturnType<typeof parseArgs>) => number, argv: string[]): { code: number; out: string } {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let out = "";
  (process.stdout.write as unknown) = (chunk: string): boolean => {
    out += chunk;
    return true;
  };
  try {
    const code = fn(root, parseArgs([...argv, "--root", root]));
    return { code, out };
  } finally {
    process.stdout.write = originalWrite;
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "semctx-semantic-cli-"));
  cpSync(SAMPLE_REPO, root, { recursive: true, filter: (src) => !src.includes(".semctx") && !src.includes("node_modules") });
  emptyDiff = join(root, "empty.diff");
  writeFileSync(emptyDiff, "", "utf8");
  runInit(root, parseArgs(["init", "--root", root]));
  runIndex(root, parseArgs(["index", "--root", root]));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("semctx semantic — CLI", () => {
  it("init scaffolds inert placeholders and check passes on a fresh repo", () => {
    const init = run(runSemantic, ["semantic", "init"]);
    expect(init.code).toBe(0);
    expect(existsSync(join(root, ".semctx", "semantic", "goals.sem"))).toBe(true);
    expect(existsSync(join(root, ".gitignore"))).toBe(true);

    const check = run(runSemantic, ["semantic", "check", "--json"]);
    expect(check.code).toBe(0);
    const report = JSON.parse(check.out);
    expect(report.ok).toBe(true);
    expect(report.schemaVersion).toBe(1);
    expect(report.kind).toBe("semantic_check");
    expect(report.reasonCodes).toEqual([]);
    expect(report.graphIndexed).toBe(true);
    expect(report.counts.nodes).toBe(0);
    expect(loadSemanticModel(root).model).toEqual({ nodes: [], changes: [], refinementRelations: [] });
    expect(readFileSync(join(root, ".semctx", "semantic", "goals.sem"), "utf8")).toContain("#   goal goal.<project>.<slug>");
  });

  it("format is dry by default and skips comment-only files", () => {
    const dry = run(runSemantic, ["semantic", "format", "--json"]);
    expect(dry.code).toBe(0);
    const outcomes = JSON.parse(dry.out).outcomes as { file: string; skipped: boolean }[];
    expect(outcomes.some((o) => o.file.endsWith("assumptions.sem") && o.skipped)).toBe(true);
  });

  it("returns the canonical lifecycle reason order on a negative path", () => {
    const pointer = activeChangePath(root);
    writeFileSync(pointer, "not a semantic block\n", "utf8");
    try {
      const check = run(runSemantic, ["semantic", "check", "--json"]);
      expect(check.code).toBe(1);
      expect(JSON.parse(check.out).reasonCodes).toEqual(["ACTIVE_CHANGE_POINTER_INVALID"]);
    } finally {
      rmSync(pointer, { force: true });
    }
  });

  it("renders a node without unicode glyphs in ascii notation", () => {
    writeAuthoredFixture();
    const r = run(runSemantic, ["semantic", "render", INVARIANT, "--notation", "ascii"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("[invariant]");
    expect(r.out).not.toContain("□");
  });
});

describe("semctx change — CLI end-to-end (PARTIAL → VERIFIED)", () => {
  const CHANGE = "change.payment-webhook-retry";

  it("rejects a prefixed traversal id before writing outside changes", () => {
    const escaped = join(root, ".semctx", "evil-payload.sem");
    expect(() =>
      run(runChange, ["change", "open", "change.x/../../../evil-payload", "--statement", "must stay contained"]),
    ).toThrow();
    expect(existsSync(escaped)).toBe(false);
  });

  it("opens a change contract, tracked and set active", () => {
    writeAuthoredFixture();
    const opened = run(runChange, ["change", "open", CHANGE, "--statement", "retry-safe", "--preserves", INVARIANT, "--unknown", UNKNOWN]);
    expect(opened.code).toBe(0);
    expect(existsSync(join(root, ".semctx", "semantic", "changes", `${CHANGE}.sem`))).toBe(true);
    expect(loadActiveChange(root)?.id).toBe(CHANGE);
  });

  it("slice seeds from the change and reaches its goal and unknown", () => {
    const slice = run(runSemantic, ["semantic", "slice", "--change", CHANGE, "--format", "json"]);
    const payload = JSON.parse(slice.out);
    expect(payload.intentions.map((n: { id: string }) => n.id)).toContain(GOAL);
    expect(payload.openUnknowns.map((n: { id: string }) => n.id)).toContain(UNKNOWN);
  });

  it("verify returns PARTIAL while an unknown is open (exit 0, not a failure)", () => {
    const v = run(runChange, ["change", "verify", CHANGE, "--from-file", emptyDiff, "--format", "json"]);
    expect(v.code).toBe(0);
    const report = JSON.parse(v.out);
    expect(report.verdict).toBe("PARTIAL");
    expect(report.underlying.verdict).toBe("PASS");
  });

  it("cannot claim verified through update or close before composed verification passes", () => {
    expect(() => run(runChange, ["change", "update", CHANGE, "--status", "verified"])).toThrow(
      "use 'semctx change close'",
    );
    expect(() => run(runChange, ["change", "close", CHANGE, "--from-file", emptyDiff])).toThrow(
      "composed verification is PARTIAL",
    );
    expect(loadActiveChange(root)?.lifecycle).toBe("active");
  });

  it("verify returns VERIFIED once the unknown is resolved", () => {
    expect(() =>
      run(runChange, ["change", "update", CHANGE, "--resolve-unknown", UNKNOWN]),
    ).toThrow("proved evidence");
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
    const upd = run(runChange, ["change", "update", CHANGE, "--resolve-unknown", UNKNOWN]);
    expect(upd.code).toBe(0);
    const v = run(runChange, ["change", "verify", CHANGE, "--from-file", emptyDiff, "--format", "json"]);
    expect(v.code).toBe(0);
    expect(JSON.parse(v.out).verdict).toBe("VERIFIED");
  });

  it("handoff captures the active change and re-reads via resume", () => {
    const h = run(runSemantic, ["semantic", "handoff", "--json"]);
    expect(h.code).toBe(0);
    expect(JSON.parse(h.out).activeChangeId).toBe(CHANGE);
    const resume = run(runSemantic, ["semantic", "resume", "--json"]);
    expect(JSON.parse(resume.out).activeChangeId).toBe(CHANGE);
  });

  it("close marks the change verified only after composed verification passes", () => {
    const c = run(runChange, ["change", "close", CHANGE, "--from-file", emptyDiff]);
    expect(c.code).toBe(0);
    expect(loadActiveChange(root)).toBeUndefined();
    const model = loadSemanticModel(root);
    expect(model.model.changes.find((x) => x.id === CHANGE)?.lifecycle).toBe("verified");
  });
});
