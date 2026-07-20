import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { cpSync, rmSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import { loadActiveChange, loadSemanticModel } from "@semantic-context/semantic-engine";
import { parseArgs } from "../src/args";
import { runInit } from "../src/commands/init";
import { runIndex } from "../src/commands/index-cmd";
import { runSemantic } from "../src/commands/semantic";
import { runChange } from "../src/commands/change";

let root: string;
let emptyDiff: string;

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
  it("init scaffolds a versioned model and check passes on a fresh repo", () => {
    const init = run(runSemantic, ["semantic", "init"]);
    expect(init.code).toBe(0);
    expect(existsSync(join(root, ".semctx", "semantic", "goals.sem"))).toBe(true);
    expect(existsSync(join(root, ".gitignore"))).toBe(true);

    const check = run(runSemantic, ["semantic", "check", "--json"]);
    expect(check.code).toBe(0);
    const report = JSON.parse(check.out);
    expect(report.ok).toBe(true);
    expect(report.graphIndexed).toBe(true);
  });

  it("format is dry by default and skips comment-only files", () => {
    const dry = run(runSemantic, ["semantic", "format", "--json"]);
    expect(dry.code).toBe(0);
    const outcomes = JSON.parse(dry.out).outcomes as { file: string; skipped: boolean }[];
    expect(outcomes.some((o) => o.file.endsWith("assumptions.sem") && o.skipped)).toBe(true);
  });

  it("renders a node without unicode glyphs in ascii notation", () => {
    const r = run(runSemantic, ["semantic", "render", "invariant.example.idempotent-write", "--notation", "ascii"]);
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
    const opened = run(runChange, ["change", "open", CHANGE, "--statement", "retry-safe", "--preserves", "invariant.example.idempotent-write", "--unknown", "unknown.example.concurrency-race"]);
    expect(opened.code).toBe(0);
    expect(existsSync(join(root, ".semctx", "semantic", "changes", `${CHANGE}.sem`))).toBe(true);
    expect(loadActiveChange(root)?.id).toBe(CHANGE);
  });

  it("slice seeds from the change and reaches its goal and unknown", () => {
    const slice = run(runSemantic, ["semantic", "slice", "--change", CHANGE, "--format", "json"]);
    const payload = JSON.parse(slice.out);
    expect(payload.intentions.map((n: { id: string }) => n.id)).toContain("goal.example.reliable-writes");
    expect(payload.openUnknowns.map((n: { id: string }) => n.id)).toContain("unknown.example.concurrency-race");
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
      run(runChange, ["change", "update", CHANGE, "--resolve-unknown", "unknown.example.concurrency-race"]),
    ).toThrow("proved evidence");
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
    const upd = run(runChange, ["change", "update", CHANGE, "--resolve-unknown", "unknown.example.concurrency-race"]);
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
