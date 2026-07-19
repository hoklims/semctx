import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import { initSemanticScaffold, newChangeContract, writeChangeFile } from "@semantic-context/semantic-engine";
import { parseArgs } from "../src/args";
import { runControl, loadCurrentControlState } from "../src/commands/control";
import { runIndex } from "../src/commands/index-cmd";
import { runInit } from "../src/commands/init";

let root: string;
const CHANGE = "change.control-plane-transport";
const BLOCKED_CHANGE = "change.control-plane-open-unknown";

function run(argv: string[]): { code: number; out: string } {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let out = "";
  (process.stdout.write as unknown) = (chunk: string): boolean => { out += chunk; return true; };
  try {
    return { code: runControl(root, parseArgs([...argv, "--root", root])), out };
  } finally {
    process.stdout.write = originalWrite;
  }
}

function treeSnapshot(dir: string): string {
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
  root = mkdtempSync(join(tmpdir(), "semctx-control-cli-"));
  cpSync(SAMPLE_REPO, root, { recursive: true, filter: (src) => !src.includes(".semctx") && !src.includes("node_modules") });
  runInit(root, parseArgs(["init", "--root", root]));
  runIndex(root, parseArgs(["index", "--root", root]));
  initSemanticScaffold(root);
  writeChangeFile(root, newChangeContract({
    id: CHANGE,
    statement: "expose Plane C through read-only transports",
    lifecycle: "active",
    provenance: "author",
  }));
  writeChangeFile(root, newChangeContract({
    id: BLOCKED_CHANGE,
    statement: "migration with unresolved runtime dependency",
    lifecycle: "active",
    provenance: "author",
    openUnknowns: ["unknown.runtime-consumer"],
  }));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("semctx control CLI", () => {
  it("fails explicitly on an uninitialised repository without creating .semctx", () => {
    const empty = mkdtempSync(join(tmpdir(), "semctx-control-empty-"));
    try {
      expect(() => runControl(empty, parseArgs(["control", "trace", "repo:any", "--json"]))).toThrow("not initialized");
      expect(existsSync(join(empty, ".semctx"))).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("fails explicitly when the repository has not been indexed", () => {
    const unindexed = mkdtempSync(join(tmpdir(), "semctx-control-unindexed-"));
    try {
      runInit(unindexed, parseArgs(["init", "--root", unindexed]));
      const before = treeSnapshot(unindexed);
      expect(() => runControl(unindexed, parseArgs(["control", "trace", "repo:any", "--json"]))).toThrow("index is absent");
      expect(treeSnapshot(unindexed)).toBe(before);
    } finally {
      rmSync(unindexed, { recursive: true, force: true });
    }
  });

  it("returns a stable BLOCKED report when the target architecture is missing", () => {
    const result = run(["control", "plan", CHANGE, "--json"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    expect(report.schemaVersion).toBe(1);
    expect(report.plan.status).toBe("BLOCKED");
    expect(report.plan.blockedReason).toBe("target_architecture_missing");
  });

  it("returns READY with a valid target and leaves every repository byte unchanged", () => {
    const current = loadCurrentControlState(root).snapshot;
    const target = { ...current, id: "target:control-plane", capturedAt: "2026-07-19T00:00:00.000Z" };
    const targetFile = join(root, "target-architecture.json");
    writeFileSync(targetFile, `${JSON.stringify(target)}\n`, "utf8");
    const before = treeSnapshot(root);

    const result = run(["control", "plan", CHANGE, "--target", targetFile, "--json"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).plan.status).toBe("READY");
    expect(treeSnapshot(root)).toBe(before);
    expect(statSync(targetFile).size).toBeGreaterThan(0);
  });

  it("keeps an explicit target BLOCKED while the Plane B contract has an open unknown", () => {
    const current = loadCurrentControlState(root).snapshot;
    const targetFile = join(root, "blocked-target-architecture.json");
    writeFileSync(targetFile, `${JSON.stringify({ ...current, id: "target:blocked", capturedAt: "2026-07-19T00:00:00.000Z" })}\n`, "utf8");

    const report = JSON.parse(run(["control", "plan", BLOCKED_CHANGE, "--target", targetFile, "--json"]).out);

    expect(report.plan.status).toBe("BLOCKED");
    expect(report.plan.blockedReason).toBe("open_unknowns");
    expect(report.plan.blockedDetails[0].subjectIds).toEqual(["unknown.runtime-consumer"]);
  });

  it("traces a qualified coordinate with explicit bounds", () => {
    const sourceId = loadCurrentControlState(root).graph.nodes[0]?.id;
    expect(sourceId).toBeDefined();
    const result = run(["control", "trace", sourceId!, "--to", "6", "--max-depth", "3", "--max-results", "5", "--json"]);
    const report = JSON.parse(result.out);
    expect(result.code).toBe(0);
    expect(report.schemaVersion).toBe(1);
    expect(report.sourceId).toBe(sourceId);
    expect(report.maxDepth).toBe(3);
    expect(report.maxResults).toBe(5);
  });

  it("rejects an empty qualified id at the CLI boundary", () => {
    expect(() => run(["control", "trace", "repo:", "--json"])).toThrow("trace id must be qualified");
    expect(() => run(["control", "trace", "semantic:", "--json"])).toThrow("trace id must be qualified");
  });
});
