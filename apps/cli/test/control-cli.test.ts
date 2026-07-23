import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { SAMPLE_REPO } from "@semantic-context/test-fixtures";
import { initSemanticScaffold, newChangeContract, writeChangeFile } from "@semantic-context/semantic-engine";
import { queryControlDeletionAuthorization, queryControlGraph } from "@semantic-context/app-services";
import { parseArgs } from "../src/args";
import { runControl, loadCurrentControlState } from "../src/commands/control";
import { runIndex } from "../src/commands/index-cmd";
import { runInit } from "../src/commands/init";

let root: string;
const CHANGE = "change.control-plane-transport";
const BLOCKED_CHANGE = "change.control-plane-open-unknown";
const CLI = join(import.meta.dir, "..", "src", "index.ts");

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

function withoutStdout<T>(action: () => T): T {
  const originalWrite = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown) = (): boolean => true;
  try {
    return action();
  } finally {
    process.stdout.write = originalWrite;
  }
}

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

function runCli(repositoryRoot: string, argv: string[]): { code: number; out: string; err: string } {
  const process = Bun.spawnSync(["bun", "run", CLI, ...argv, "--root", repositoryRoot], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: process.exitCode ?? 1,
    out: new TextDecoder().decode(process.stdout),
    err: new TextDecoder().decode(process.stderr),
  };
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
  git(root, "init");
  runInit(root, parseArgs(["init", "--root", root]));
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
  git(root, "add", ".");
  git(root, "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "commit", "-m", "fixture");
  runIndex(root, parseArgs(["index", "--root", root]));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("semctx control CLI", () => {
  it("reports a fresh indexed repository through the top-level status command", () => {
    const result = runCli(root, ["status", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      kind: "control_freshness_status",
      basis: "control_index_snapshot_v1",
      verdict: "FRESH",
      canRunHighRiskControl: true,
      reasons: [],
    });
  });

  it("reports a captured non-empty working diff as DIRTY_KNOWN", () => {
    const dirty = mkdtempSync(join(tmpdir(), "semctx-status-dirty-known-"));
    try {
      cpSync(SAMPLE_REPO, dirty, { recursive: true, filter: (src) => !src.includes(".semctx") && !src.includes("node_modules") });
      git(dirty, "init");
      withoutStdout(() => runInit(dirty, parseArgs(["init", "--root", dirty])));
      git(dirty, "add", ".");
      git(dirty, "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "commit", "-m", "fixture");
      const source = join(dirty, "src", "domain", "capacity.ts");
      writeFileSync(source, `${readFileSync(source, "utf8")}\n// indexed working change\n`);
      withoutStdout(() => runIndex(dirty, parseArgs(["index", "--root", dirty])));

      const result = runCli(dirty, ["status", "--json"]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out)).toMatchObject({
        verdict: "DIRTY_KNOWN",
        canRunHighRiskControl: true,
        reasons: ["WORKING_TREE_DIRTY"],
      });
    } finally {
      rmSync(dirty, { recursive: true, force: true });
    }
  });

  it("reports an uninitialised repository as UNSEALED without creating state", () => {
    const empty = mkdtempSync(join(tmpdir(), "semctx-status-empty-"));
    try {
      const result = runCli(empty, ["status", "--json"]);
      expect(result.code).toBe(3);
      expect(JSON.parse(result.out)).toMatchObject({
        verdict: "UNSEALED",
        canRunHighRiskControl: false,
        reasons: ["REPOSITORY_NOT_INITIALIZED"],
        freshnessSeal: null,
      });
      expect(existsSync(join(empty, ".semctx"))).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("fails explicitly on an uninitialised repository without creating .semctx", () => {
    const empty = mkdtempSync(join(tmpdir(), "semctx-control-empty-"));
    try {
      expect(() => runControl(empty, parseArgs(["control", "trace", "repo:any", "--json"]))).toThrow("not initialized");
      const graph = (() => {
        const originalRoot = root;
        root = empty;
        try {
          return JSON.parse(run(["control", "graph", "--json"]).out);
        } finally {
          root = originalRoot;
        }
      })();
      expect(graph).toMatchObject({
        freshness: { verdict: "UNSEALED", reasons: ["REPOSITORY_NOT_INITIALIZED"], seal: null },
        terminalStatus: "refused",
        reasonCodes: ["INDEX_STALE"],
        payload: null,
      });
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
    expect(report.freshnessSeal.kind).toBe("control_freshness_seal");
    expect(report.freshnessSeal.sealHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("serializes the exact shared coordinate-graph envelope", () => {
    const cli = JSON.parse(run(["control", "graph", "--json"]).out);
    expect(cli).toEqual(queryControlGraph(root));
    expect(cli).toMatchObject({ schemaVersion: 1, kind: "coordinate_graph", terminalStatus: "success" });
  });

  it("uses the shared planning-commit refusal for read-only deletion authorization", () => {
    const dir = mkdtempSync(join(tmpdir(), "semctx-control-auth-query-"));
    const file = join(dir, "deletion.json");
    const query = {
      subject: "change.demo",
      planningCommit: "git:not-current",
      evaluatedAt: "2026-07-23T12:00:00.000Z",
      attestationRequests: [],
    };
    try {
      writeFileSync(file, JSON.stringify(query), "utf8");
      const cli = JSON.parse(run(["control", "authorize-deletion", "--input", file, "--json"]).out);
      expect(cli).toEqual(queryControlDeletionAuthorization(root, query));
      expect(cli).toMatchObject({
        terminalStatus: "refused",
        reasonCodes: ["PLANNING_COMMIT_MISMATCH"],
        payload: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns READY with a valid target and leaves every repository byte unchanged", () => {
    const current = loadCurrentControlState(root).snapshot;
    const target = { ...current, id: "target:control-plane", capturedAt: "2026-07-19T00:00:00.000Z" };
    const targetDir = mkdtempSync(join(tmpdir(), "semctx-control-target-"));
    const targetFile = join(targetDir, "target-architecture.json");
    try {
      writeFileSync(targetFile, `${JSON.stringify(target)}\n`, "utf8");
      const before = treeSnapshot(root);

      const result = run(["control", "plan", CHANGE, "--target", targetFile, "--json"]);

      expect(result.code).toBe(0);
      expect(JSON.parse(result.out).plan.status).toBe("READY");
      expect(treeSnapshot(root)).toBe(before);
      expect(statSync(targetFile).size).toBeGreaterThan(0);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("keeps an explicit target BLOCKED while the Plane B contract has an open unknown", () => {
    const current = loadCurrentControlState(root).snapshot;
    const targetDir = mkdtempSync(join(tmpdir(), "semctx-control-blocked-target-"));
    const targetFile = join(targetDir, "blocked-target-architecture.json");
    try {
      writeFileSync(targetFile, `${JSON.stringify({ ...current, id: "target:blocked", capturedAt: "2026-07-19T00:00:00.000Z" })}\n`, "utf8");

      const report = JSON.parse(run(["control", "plan", BLOCKED_CHANGE, "--target", targetFile, "--json"]).out);

      expect(report.plan.status).toBe("BLOCKED");
      expect(report.plan.blockedReason).toBe("open_unknowns");
      expect(report.plan.blockedDetails[0].subjectIds).toEqual(["unknown.runtime-consumer"]);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("blocks planning and traversal before using stale indexed inputs", () => {
    const sourceFile = join(root, "src", "domain", "capacity.ts");
    const original = readFileSync(sourceFile, "utf8");
    try {
      writeFileSync(sourceFile, `${original}\nexport const freshnessProbe = 1;\n`, "utf8");

      const status = runCli(root, ["status", "--json"]);
      expect(status.code).toBe(3);
      expect(JSON.parse(status.out)).toMatchObject({
        verdict: "STALE",
        canRunHighRiskControl: false,
        reasons: ["ANALYSIS_INPUT_MISMATCH", "WORKING_DIFF_MISMATCH"],
      });

      const plan = JSON.parse(run(["control", "plan", CHANGE, "--json"]).out);
      expect(plan.plan.status).toBe("BLOCKED");
      expect(plan.plan.blockedReason).toBe("control_inputs_stale");
      expect(plan.plan.steps).toEqual([]);

      expect(JSON.parse(run(["control", "graph", "--json"]).out)).toMatchObject({
        freshness: {
          verdict: "STALE",
          reasons: ["ANALYSIS_INPUT_MISMATCH", "WORKING_DIFF_MISMATCH"],
        },
        terminalStatus: "refused",
        reasonCodes: ["INDEX_STALE"],
        payload: null,
      });

      const sourceId = loadCurrentControlState(root).graph.nodes[0]?.id;
      expect(sourceId).toBeDefined();
      expect(() => run(["control", "trace", sourceId!, "--json"])).toThrow("control inputs are STALE");
    } finally {
      writeFileSync(sourceFile, original, "utf8");
    }
  });

  it("traces a qualified coordinate with explicit bounds", () => {
    const sourceId = loadCurrentControlState(root).graph.nodes[0]?.id;
    expect(sourceId).toBeDefined();
    const result = run(["control", "trace", sourceId!, "--to", "6", "--max-depth", "3", "--max-results", "5", "--json"]);
    const report = JSON.parse(result.out);
    expect(result.code).toBe(0);
    expect(report.schemaVersion).toBe(2);
    expect(report.sourceId).toBe(sourceId);
    expect(report.budget.limit).toBeGreaterThan(0);
    expect(report.freshnessSeal.kind).toBe("control_freshness_seal");
  });

  it("rejects an empty qualified id at the CLI boundary", () => {
    expect(() => run(["control", "trace", "repo:", "--json"])).toThrow("trace id must be qualified");
    expect(() => run(["control", "trace", "semantic:", "--json"])).toThrow("trace id must be qualified");
  });

  it("keeps the init-to-index freshness seal stable in a Git repository", () => {
    const repo = mkdtempSync(join(tmpdir(), "semctx-init-index-freshness-"));
    try {
      writeFileSync(join(repo, "input.ts"), "export const value = 1;\n", "utf8");
      git(repo, "init");
      git(repo, "add", ".");
      git(repo, "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "commit", "-m", "fixture");

      withoutStdout(() => runInit(repo, parseArgs(["init", "--root", repo])));
      withoutStdout(() => runIndex(`${repo}${sep}.`, parseArgs(["index", "--root", `${repo}${sep}.`])));
      const seal = loadCurrentControlState(repo).freshnessSeal;

      expect(readFileSync(join(repo, ".gitignore"), "utf8")).toContain(".semctx/*");
      const currentState = {
        repositoryRoot: seal.repositoryRoot,
        headCommit: seal.headAtCapture,
        repositoryGraphHash: seal.repositoryGraphHash,
        semanticModelHash: seal.semanticModelHash,
        analysisInputHash: seal.analysisInputHash,
        workingDiffHash: seal.workingDiffHash,
        storeSchemaVersion: seal.storeSchemaVersion,
        toolVersion: seal.toolVersion,
      };
      const indexedState = {
        repositoryRoot: seal.indexedRepositoryRoot,
        headCommit: seal.indexedHeadCommit,
        repositoryGraphHash: seal.indexedRepositoryGraphHash,
        semanticModelHash: seal.indexedSemanticModelHash,
        analysisInputHash: seal.indexedAnalysisInputHash,
        workingDiffHash: seal.indexedWorkingDiffHash,
        storeSchemaVersion: seal.indexedStoreSchemaVersion,
        toolVersion: seal.indexedToolVersion,
      };
      expect(JSON.stringify(currentState)).toBe(JSON.stringify(indexedState));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
