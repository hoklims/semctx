import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepositoryGraph } from "@semantic-context/core";
import type { ControlFreshnessSeal, ControlFreshnessStatusReport, Sha256Hash } from "@semantic-context/control-model";
import type { SemanticModel } from "@semantic-context/semantic-model";
import * as appServices from "../src";
import { buildControlFreshnessSeal, captureGitState, type IndexedControlSnapshot } from "../src";

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

const graph: RepositoryGraph = {
  nodes: [
    {
      id: "sym:function:src/b.ts:b:1",
      kind: "function",
      name: "b",
      filePath: "src/b.ts",
      tags: ["z", "a"],
      evidence: [
        { filePath: "src/b.ts", startLine: 2, sourceKind: "code" },
        { filePath: "src/b.ts", startLine: 1, sourceKind: "code" },
      ],
      metadata: { z: "2", a: "1" },
    },
    {
      id: "sym:function:src/a.ts:a:1",
      kind: "function",
      name: "a",
      filePath: "src/a.ts",
      tags: [],
      evidence: [],
      metadata: {},
    },
  ],
  edges: [
    {
      id: "edge:z",
      kind: "calls",
      from: "sym:function:src/b.ts:b:1",
      to: "sym:function:src/a.ts:a:1",
      evidence: [
        { filePath: "src/b.ts", startLine: 2, sourceKind: "code" },
        { filePath: "src/b.ts", startLine: 1, sourceKind: "code" },
      ],
      metadata: { z: "2", a: "1" },
    },
  ],
};

const semanticModel: SemanticModel = {
  nodes: [
    {
      id: "goal.demo",
      kind: "goal",
      statement: "Keep the demo deterministic.",
      status: "declared",
      provenance: "author",
      sourceRefs: [{ file: ".semctx/semantic/goals.sem", line: 2 }],
      relations: [
        { kind: "depends_on", to: "invariant.demo" },
        { kind: "serves", to: "invariant.demo" },
      ],
      repositoryLinks: [{ kind: "file", ref: "src/a.ts" }],
      tags: ["z", "a"],
      metadata: { z: "2", a: "1" },
    },
  ],
  changes: [],
};

const base = {
  repositoryRoot: "C:/repo",
  headAtCapture: "a".repeat(40),
  repositoryGraph: graph,
  semanticModel,
  analysisInputHash: `sha256:${"a".repeat(64)}` as const,
  workingDiffHash: `sha256:${"b".repeat(64)}` as const,
  indexedSnapshot: null,
  storeSchemaVersion: 1,
  toolVersion: "@semantic-context/app-services@0.1.8",
};

function evaluate(seal: ControlFreshnessSeal): ControlFreshnessStatusReport {
  const candidate = (appServices as unknown as {
    evaluateControlFreshness?: (value: ControlFreshnessSeal) => ControlFreshnessStatusReport;
  }).evaluateControlFreshness;
  expect(candidate).toBeFunction();
  if (candidate === undefined) throw new Error("evaluateControlFreshness is not exported");
  return candidate(seal);
}

function indexedSnapshot(seal: ControlFreshnessSeal): IndexedControlSnapshot {
  return {
    schemaVersion: 1,
    capturedAt: "2026-07-21T10:00:00.000Z",
    repositoryRoot: seal.repositoryRoot,
    headCommit: seal.headAtCapture,
    repositoryGraphHash: seal.repositoryGraphHash,
    semanticModelHash: seal.semanticModelHash,
    analysisInputHash: seal.analysisInputHash,
    workingDiffHash: seal.workingDiffHash,
    storeSchemaVersion: seal.storeSchemaVersion!,
    toolVersion: seal.toolVersion,
  };
}

function sealed(workingDiffHash: Sha256Hash): ControlFreshnessSeal {
  const input = { ...base, workingDiffHash };
  const initial = buildControlFreshnessSeal(input);
  return buildControlFreshnessSeal({ ...input, indexedSnapshot: indexedSnapshot(initial) });
}

describe("control freshness seal", () => {
  it("is deterministic across semantically irrelevant ordering", () => {
    const reorderedGraph: RepositoryGraph = {
      nodes: [...graph.nodes].reverse().map((node) => ({
        ...node,
        tags: [...node.tags].reverse(),
        evidence: [...node.evidence].reverse(),
        metadata: Object.fromEntries(Object.entries(node.metadata).reverse()),
      })),
      edges: [...graph.edges].reverse().map((edge) => ({
        ...edge,
        evidence: [...edge.evidence].reverse(),
        metadata: Object.fromEntries(Object.entries(edge.metadata).reverse()),
      })),
    };
    const reorderedSemantic: SemanticModel = {
      nodes: semanticModel.nodes.map((node) => ({
        ...node,
        relations: [...node.relations].reverse(),
        repositoryLinks: [...node.repositoryLinks].reverse(),
        tags: [...node.tags].reverse(),
        metadata: Object.fromEntries(Object.entries(node.metadata ?? {}).reverse()),
      })),
      changes: [],
    };

    const left = buildControlFreshnessSeal(base);
    const right = buildControlFreshnessSeal({ ...base, repositoryGraph: reorderedGraph, semanticModel: reorderedSemantic });

    expect(right).toEqual(left);
    expect(left.repositoryGraphHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(left.semanticModelHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(left.sealHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("changes for graph, semantic, and working-diff inputs", () => {
    const original = buildControlFreshnessSeal(base);
    const graphChanged = buildControlFreshnessSeal({
      ...base,
      repositoryGraph: { ...graph, nodes: graph.nodes.map((node, index) => index === 0 ? { ...node, name: "changed" } : node) },
    });
    const semanticChanged = buildControlFreshnessSeal({
      ...base,
      semanticModel: { ...semanticModel, nodes: semanticModel.nodes.map((node) => ({ ...node, statement: `${node.statement} changed` })) },
    });
    const sourceRefChanged = buildControlFreshnessSeal({
      ...base,
      semanticModel: { ...semanticModel, nodes: semanticModel.nodes.map((node) => ({ ...node, sourceRefs: [{ ...node.sourceRefs[0]!, line: 3 }] })) },
    });
    const diffChanged = buildControlFreshnessSeal({ ...base, workingDiffHash: `sha256:${"c".repeat(64)}` });

    expect(graphChanged.repositoryGraphHash).not.toBe(original.repositoryGraphHash);
    expect(semanticChanged.semanticModelHash).not.toBe(original.semanticModelHash);
    expect(new Set([original.sealHash, graphChanged.sealHash, semanticChanged.sealHash, sourceRefChanged.sealHash, diffChanged.sealHash]).size).toBe(5);
  });

  it("records unavailable or mismatched Git state without inventing a verdict", () => {
    const indexedSnapshot = {
      schemaVersion: 1 as const,
      capturedAt: "2026-07-21T10:00:00.000Z",
      repositoryRoot: "C:/indexed-repo",
      headCommit: "d".repeat(40),
      repositoryGraphHash: `sha256:${"d".repeat(64)}` as const,
      semanticModelHash: `sha256:${"e".repeat(64)}` as const,
      analysisInputHash: `sha256:${"a".repeat(64)}` as const,
      workingDiffHash: `sha256:${"f".repeat(64)}` as const,
      storeSchemaVersion: 1,
      toolVersion: "@semantic-context/app-services@0.1.8",
    };
    const seal = buildControlFreshnessSeal({ ...base, headAtCapture: null, indexedSnapshot, workingDiffHash: null });

    expect(seal.headAtCapture).toBeNull();
    expect(seal.indexedHeadCommit).toBe("d".repeat(40));
    expect(seal.indexedRepositoryRoot).toBe("C:/indexed-repo");
    expect(seal.workingDiffHash).toBeNull();
    expect("status" in seal).toBe(false);
    expect("verdict" in seal).toBe(false);
  });

  it("distinguishes a non-Git directory from a broken Git repository", () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-freshness-git-"));
    try {
      expect(captureGitState(root)).toEqual({ headCommit: null, workingDiffHash: null });
      writeFileSync(join(root, ".git"), "gitdir: missing-git-dir\n", "utf8");
      expect(() => captureGitState(root)).toThrow("cannot capture control freshness: read Git status");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scopes nested project captures away from dirty parent siblings", () => {
    const parent = mkdtempSync(join(tmpdir(), "semctx-freshness-nested-"));
    const root = join(parent, "project");
    try {
      mkdirSync(root);
      writeFileSync(join(root, "input.ts"), "export const value = 1;\n", "utf8");
      writeFileSync(join(parent, "sibling.txt"), "clean\n", "utf8");
      git(parent, "init");
      git(parent, "add", ".");
      git(parent, "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "commit", "-m", "fixture");

      const clean = captureGitState(root);
      writeFileSync(join(parent, "sibling.txt"), "dirty sibling\n", "utf8");
      expect(captureGitState(root)).toEqual(clean);

      writeFileSync(join(root, "input.ts"), "export const value = 2;\n", "utf8");
      expect(captureGitState(root).workingDiffHash).not.toBe(clean.workingDiffHash);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("explicit control freshness verdict", () => {
  it("distinguishes fresh, sealed dirty, stale, and unsealed inputs", () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-freshness-verdict-"));
    try {
      git(root, "init");
      git(root, "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "commit", "--allow-empty", "-m", "fixture");
      const cleanDiffHash = captureGitState(root).workingDiffHash;
      if (cleanDiffHash === null) throw new Error("expected Git working diff hash");

      const fresh = sealed(cleanDiffHash);
      expect(evaluate(fresh)).toMatchObject({
        verdict: "FRESH",
        canRunHighRiskControl: true,
        reasons: [],
      });

      const dirty = sealed(`sha256:${"b".repeat(64)}`);
      expect(evaluate(dirty)).toMatchObject({
        verdict: "DIRTY_KNOWN",
        canRunHighRiskControl: true,
        reasons: ["WORKING_TREE_DIRTY"],
      });

      const stale = { ...fresh, headAtCapture: "c".repeat(40) };
      expect(evaluate(stale)).toMatchObject({
        verdict: "STALE",
        canRunHighRiskControl: false,
        reasons: ["HEAD_MISMATCH"],
      });

      const unsealed = buildControlFreshnessSeal(base);
      expect(evaluate(unsealed)).toMatchObject({
        verdict: "UNSEALED",
        canRunHighRiskControl: false,
        reasons: ["INDEX_SNAPSHOT_MISSING"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
