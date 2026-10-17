import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Claim, EvidenceRecord, RepositoryGraph, SemctxConfig } from "@semantic-context/core";
import { ControlFreshnessStatusReportSchema } from "@semantic-context/control-model";
import type { ControlFreshnessSeal, ControlFreshnessStatusReport, Sha256Hash } from "@semantic-context/control-model";
import type { SemanticModel } from "@semantic-context/semantic-model";
import { discoverFiles, inspectModuleConfiguration, type DiscoveredFile } from "@semantic-context/ts-analyzer";
import { resolveTypeScriptModule } from "../../ts-analyzer/src/ts-symbols";
import {
  canonicalSourceText,
  digestCanonical,
} from "@semantic-context/plane-a-internal";
import { initWorkspace } from "@semantic-context/repository-store";
import { newChangeContract, writeActiveChange, writeChangeFile } from "@semantic-context/semantic-engine";
import { sampleConfig } from "@semantic-context/test-fixtures";
import { parseIndexedControlSnapshot } from "../src/freshness";
import { analyzePlaneARuntime } from "../src/plane-a-runtime";
import * as appServices from "../src";
import { buildControlFreshnessSeal, captureGitState, controlStatus, fingerprintAnalysisInputs, indexRepository, type IndexedControlSnapshot } from "../src";

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
      appliesAtLevel: 6,
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
  refinementRelations: [],
};

const base = {
  repositoryRoot: "C:/repo",
  headAtCapture: "a".repeat(40),
  repositoryFacts: { graph, claims: [], evidence: [] },
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
  it("changes when an authored level or typed refinement relation changes", () => {
    const baseHash = appServices.fingerprintSemanticModel(semanticModel);
    expect(appServices.fingerprintSemanticModel({
      ...semanticModel,
      nodes: semanticModel.nodes.map((node) => ({ ...node, appliesAtLevel: 5 })),
    })).not.toBe(baseHash);
    expect(appServices.fingerprintSemanticModel({
      ...semanticModel,
      refinementRelations: [{
        schemaVersion: 1,
        id: "relation.demo",
        kind: "decomposes_to",
        source: { plane: "B", kind: "semantic_node", nodeId: "goal.demo" },
        target: { plane: "B", kind: "semantic_node", nodeId: "goal.child" },
        epistemicStatus: "human_declared",
        provenance: "author",
        evidenceRefs: [{
          schemaVersion: 1,
          kind: "semantic_node",
          locator: "goal.demo",
          digest: { algorithm: "sha256", value: "a".repeat(64) },
        }],
      }],
    })).not.toBe(baseHash);
  });

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
    const right = buildControlFreshnessSeal({ ...base, repositoryFacts: { ...base.repositoryFacts, graph: reorderedGraph }, semanticModel: reorderedSemantic });

    expect(right).toEqual(left);
    expect(left.repositoryGraphHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(left.semanticModelHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(left.sealHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("binds analysis inputs to source state rather than to the checkout's line endings", () => {
    const config = sampleConfig();
    const discovered = (eol: string): DiscoveredFile[] => [
      {
        absPath: join(config.repositoryRoot, "src", "a.ts"),
        relPath: "src/a.ts",
        role: "source",
        content: `export const a = 1;${eol}export const b = 2;${eol}`,
      },
      {
        absPath: join(config.repositoryRoot, "docs", "a.md"),
        relPath: "docs/a.md",
        role: "document",
        content: `# Title${eol}${eol}body${eol}`,
      },
    ];

    const crlf = discovered("\r\n");
    const lf = discovered("\n");
    expect(fingerprintAnalysisInputs(config, crlf))
      .toBe(fingerprintAnalysisInputs(config, lf));

    const sourceManifest = (files: readonly DiscoveredFile[]) => files.map((file) => ({
      relPath: file.relPath,
      role: file.role,
      language: file.language ?? null,
      content: canonicalSourceText(file.content),
    }));
    expect(digestCanonical(sourceManifest(crlf)))
      .toBe(digestCanonical(sourceManifest(lf)));
  });

  it("still separates analysis inputs that differ beyond line endings", () => {
    const config = sampleConfig();
    const discovered = (content: string): DiscoveredFile[] => [
      { absPath: join(config.repositoryRoot, "src", "a.ts"), relPath: "src/a.ts", role: "source", content },
    ];

    expect(fingerprintAnalysisInputs(config, discovered("export const a = 1;\n")))
      .not.toBe(fingerprintAnalysisInputs(config, discovered("export const a = 2;\n")));
  });

  it("invalidates ordinary v2 freshness when a workspace configuration link changes", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "semctx-workspace-freshness-"))).replaceAll("\\", "/");
    const write = (path: string, content: string) => {
      const target = join(root, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, content);
    };
    try {
      mkdirSync(join(root, ".git"));
      write("pnpm-workspace.yaml", 'packages:\n  - "tooling/*"\n  - "domains/*/*"\n');
      write("package.json", JSON.stringify({ name: "root", private: true }));
      write("tooling/config/package.json", JSON.stringify({ name: "@fixture/config", version: "1.0.0" }));
      const inherited = JSON.stringify({ compilerOptions: { allowJs: true, module: "ESNext", moduleResolution: "Bundler", paths: { "#shared": ["./shared.ts"] } } }, null, 2) + "\n";
      write("tooling/config/base.json", inherited);
      write("tooling/config/shared.ts", "export const shared = 1;\n");
      write("domains/catalog/api/tsconfig.json", JSON.stringify({ extends: "@fixture/config/base.json" }));
      const dependency = (range: string) => JSON.stringify({ name: "api", devDependencies: { "@fixture/config": range } }, null, 2) + "\n";
      write("domains/catalog/api/package.json", dependency("workspace:*"));
      write("domains/catalog/api/src/items.js", 'import { shared } from "#shared"; export const items = shared;\n');
      write("domains/catalog/api/src/items.ts", 'export const items = 1;\n');
      const config = { ...sampleConfig(), repositoryRoot: root, version: 2 as const, selectionMode: "globs-v1" as const,
        include: ["**/*.js", "**/*.ts"], exclude: [], languages: { typescript: "on" as const, javascript: "on" as const, python: "off" as const, markdown: "off" as const, sql: "off" as const } };
      const source = `${root}/domains/catalog/api/src/items.js`;
      const files = discoverFiles(config);
      const before = fingerprintAnalysisInputs(config, files);
      const legacyConfig = { ...sampleConfig(), repositoryRoot: root };
      const legacyFiles = discoverFiles(legacyConfig);
      const legacyBefore = fingerprintAnalysisInputs(legacyConfig, legacyFiles);
      const typescriptFiles = files.filter(file => file.relPath.endsWith(".ts"));
      const typescriptBefore = fingerprintAnalysisInputs(config, typescriptFiles);
      const typescriptOutcome = (runtimeConfig: SemctxConfig = config, runtimeFiles = typescriptFiles) => analyzePlaneARuntime(runtimeConfig, {
        files: runtimeFiles,
        candidates: runtimeFiles.map(file => ({ relPath: file.relPath, language: "typescript" as const, selectionDecision: "selected" as const, reason: "SELECTED" })),
      }).discoveryLedger.find(entry => entry.candidateIdentity === "typescript:domains/catalog/api/src/items.ts")?.analysisOutcome;
      expect(typescriptOutcome()).toBe("analyzed");
      expect(typescriptOutcome(legacyConfig, legacyFiles)).toBe("analyzed");
      expect(resolveTypeScriptModule("#shared", source)).toBe(`${root}/tooling/config/shared.ts`);
      expect(inspectModuleConfiguration(source, root)).toEqual([]);
      write("domains/catalog/api/package.json", dependency("workspace:*").replaceAll("\n", "\r\n"));
      write("tooling/config/base.json", inherited.replaceAll("\n", "\r\n"));
      expect(fingerprintAnalysisInputs(config, files)).toBe(before);
      write("tooling/config/base.json", inherited.replace("shared.ts", "other.ts"));
      expect(fingerprintAnalysisInputs(config, files)).not.toBe(before);
      write("tooling/config/base.json", inherited);
      write("pnpm-workspace.yaml", 'packages:\n  - "domains/*/*"\n');
      expect(fingerprintAnalysisInputs(config, files)).not.toBe(before);
      write("pnpm-workspace.yaml", 'packages:\n  - "tooling/*"\n  - "domains/*/*"\n');
      write("tooling/config/package.json", JSON.stringify({ name: "@fixture/renamed", version: "1.0.0" }));
      expect(fingerprintAnalysisInputs(config, files)).not.toBe(before);
      write("tooling/config/package.json", JSON.stringify({ name: "@fixture/config", version: "1.0.0" }));
      write("domains/catalog/api/package.json", dependency("^1.0.0"));
      expect(resolveTypeScriptModule("#shared", source)).toBeUndefined();
      expect(inspectModuleConfiguration(source, root).some(reason => reason.startsWith("SOURCE_CONFIGURATION_INVALID:"))).toBe(true);
      expect(fingerprintAnalysisInputs(config, files)).not.toBe(before);
      // Version 1 maps imports through the same inherited `paths`, so it binds that chain as well.
      expect(fingerprintAnalysisInputs(legacyConfig, legacyFiles)).not.toBe(legacyBefore);
      expect(typescriptOutcome()).toBe("failed");
      expect(typescriptOutcome(legacyConfig, legacyFiles)).toBe("analyzed");
      expect(fingerprintAnalysisInputs(config, typescriptFiles)).not.toBe(typescriptBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("invalidates indexed v2 freshness when an installed configuration changes or disappears", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "semctx-installed-freshness-"))).replaceAll("\\", "/");
    const write = (path: string, content: string) => {
      const target = join(root, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, content);
    };
    try {
      write(".gitignore", ".semctx/\nnode_modules/\n");
      write("package.json", JSON.stringify({ name: "fixture", devDependencies: { "@fixture/config": "1.0.0" } }));
      write("tsconfig.json", JSON.stringify({ extends: "./node_modules/@fixture/config/base.json" }));
      write("node_modules/@fixture/config/package.json", JSON.stringify({ name: "@fixture/config", version: "1.0.0" }));
      const inherited = JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", paths: { "#shared": ["../../../src/shared.ts"] } } }, null, 2) + "\n";
      write("node_modules/@fixture/config/base.json", inherited);
      write("src/shared.ts", "export const shared = 1;\n");
      write("src/other.ts", "export const shared = 2;\n");
      write("src/main.ts", 'import { shared } from "#shared"; export const main = shared;\n');
      git(root, "init", "-q");
      git(root, "add", ".");
      git(root, "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "commit", "-q", "-m", "fixture");
      const config = initWorkspace(root, { version: 2, selectionMode: "globs-v1", include: ["src/**/*.ts"], exclude: [],
        languages: { typescript: "on", javascript: "off", python: "off", markdown: "off", sql: "off" } });
      const files = discoverFiles(config);
      const legacyConfig = { ...sampleConfig(), repositoryRoot: root };
      const legacyBefore = fingerprintAnalysisInputs(legacyConfig, files);
      const source = `${root}/src/main.ts`;
      expect(resolveTypeScriptModule("#shared", source, undefined, true)).toBe(`${root}/src/shared.ts`);
      expect(inspectModuleConfiguration(source, root)).toEqual([]);
      indexRepository(root, "2026-10-13T00:00:00.000Z");
      expect(controlStatus(root).verdict).toBe("FRESH");
      const before = fingerprintAnalysisInputs(config, files);
      write("node_modules/@fixture/config/base.json", inherited.replaceAll("\n", "\r\n"));
      expect(controlStatus(root).verdict).toBe("FRESH");
      write("node_modules/@fixture/config/base.json", inherited.replace("shared.ts", "other.ts"));
      expect(resolveTypeScriptModule("#shared", source, undefined, true)).toBe(`${root}/src/other.ts`);
      expect(controlStatus(root)).toMatchObject({ verdict: "STALE", reasons: ["ANALYSIS_INPUT_MISMATCH"] });
      expect(fingerprintAnalysisInputs(config, files)).not.toBe(before);
      // Version 1 maps imports through the same inherited `paths`, so it binds that chain as well.
      expect(fingerprintAnalysisInputs(legacyConfig, files)).not.toBe(legacyBefore);
      write("node_modules/@fixture/config/base.json", inherited);
      expect(fingerprintAnalysisInputs(legacyConfig, files)).toBe(legacyBefore);
      expect(controlStatus(root).verdict).toBe("FRESH");
      rmSync(join(root, "node_modules/@fixture/config/base.json"));
      expect(inspectModuleConfiguration(source, root).some(reason => reason.startsWith("SOURCE_CONFIGURATION_INVALID:"))).toBe(true);
      expect(controlStatus(root)).toMatchObject({ verdict: "STALE", reasons: ["ANALYSIS_INPUT_MISMATCH"] });
      write("node_modules/@fixture/config/base.json", inherited);
      expect(controlStatus(root).verdict).toBe("FRESH");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("invalidates indexed v2 freshness when parent configuration starts rejecting unchanged sources", () => {
    const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "semctx-parent-config-freshness-"))).replaceAll("\\", "/");
    const root = join(parent, "repository");
    const parentConfig = join(parent, "tsconfig.json");
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, ".gitignore"), ".semctx/\n");
      writeFileSync(join(root, "src/main.ts"), "export const main = 1;\n");
      writeFileSync(join(root, "src/other.js"), "export const other = 2;\n");
      git(root, "init", "-q");
      git(root, "add", ".");
      git(root, "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "commit", "-q", "-m", "fixture");
      const config = initWorkspace(root, { version: 2, selectionMode: "globs-v1", include: ["src/**/*.ts", "src/**/*.js"], exclude: [],
        languages: { typescript: "on", javascript: "on", python: "off", markdown: "off", sql: "off" } });
      const files = discoverFiles(config);
      const legacyConfig = { ...sampleConfig(), repositoryRoot: root };
      const legacyBefore = fingerprintAnalysisInputs(legacyConfig, files);
      const source = join(root, "src/main.ts");
      const outcome = () => analyzePlaneARuntime(config, {
        files,
        candidates: files.map(file => ({ relPath: file.relPath, language: file.relPath.endsWith(".ts") ? "typescript" as const : "javascript" as const,
          selectionDecision: "selected" as const, reason: "SELECTED" })),
      }).discoveryLedger;
      expect(inspectModuleConfiguration(source, root)).toEqual([]);
      expect(outcome().every(entry => entry.analysisOutcome === "analyzed")).toBe(true);
      indexRepository(root, "2026-10-13T00:00:00.000Z");
      expect(controlStatus(root).verdict).toBe("FRESH");
      const before = fingerprintAnalysisInputs(config, files);
      const gitBefore = captureGitState(root);

      writeFileSync(parentConfig, JSON.stringify({ compilerOptions: { strict: true } }));
      expect(inspectModuleConfiguration(source, root)).toEqual(["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY"]);
      expect(outcome().find(entry => entry.candidateIdentity === "typescript:src/main.ts")?.analysisOutcome).toBe("failed");
      expect(inspectModuleConfiguration(join(root, "src/other.js"), root)).toEqual(["SOURCE_CONFIGURATION_OUTSIDE_REPOSITORY"]);
      expect(captureGitState(root)).toEqual(gitBefore);
      expect(controlStatus(root)).toMatchObject({ verdict: "STALE", reasons: ["ANALYSIS_INPUT_MISMATCH"] });
      const rejected = fingerprintAnalysisInputs(config, files);
      expect(rejected).not.toBe(before);
      expect(fingerprintAnalysisInputs(config, [...files].reverse())).toBe(rejected);
      expect(fingerprintAnalysisInputs(legacyConfig, files)).toBe(legacyBefore);

      // Outside bytes are never consumed: only the rejection state affects freshness.
      writeFileSync(parentConfig, "not valid JSON");
      expect(fingerprintAnalysisInputs(config, files)).toBe(rejected);
      rmSync(parentConfig);
      expect(inspectModuleConfiguration(source, root)).toEqual([]);
      expect(fingerprintAnalysisInputs(config, files)).toBe(before);
      expect(controlStatus(root).verdict).toBe("FRESH");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("changes for graph, semantic, and working-diff inputs", () => {
    const original = buildControlFreshnessSeal(base);
    const graphChanged = buildControlFreshnessSeal({
      ...base,
      repositoryFacts: { ...base.repositoryFacts, graph: { ...graph, nodes: graph.nodes.map((node, index) => index === 0 ? { ...node, name: "changed" } : node) } },
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

  it("changes when persisted claims or evidence consumed by Plane C drift", () => {
    const claim: Claim = {
      id: "claim.a",
      kind: "behavior",
      statement: "Claim A",
      subjectNodeIds: [graph.nodes[0]!.id],
      evidenceIds: ["evidence.a"],
      authority: 1,
      freshness: 1,
      confidence: 1,
      verificationStatus: "tested",
      tags: ["z", "a"],
    };
    const evidence: EvidenceRecord = {
      id: "evidence.a",
      filePath: "src/a.ts",
      startLine: 1,
      sourceKind: "test",
    };
    const original = buildControlFreshnessSeal({
      ...base,
      repositoryFacts: { graph, claims: [claim], evidence: [evidence] },
    });
    const claimChanged = buildControlFreshnessSeal({
      ...base,
      repositoryFacts: { graph, claims: [{ ...claim, statement: "Claim A changed" }], evidence: [evidence] },
    });
    const evidenceChanged = buildControlFreshnessSeal({
      ...base,
      repositoryFacts: { graph, claims: [claim], evidence: [{ ...evidence, startLine: 2 }] },
    });
    const reordered = buildControlFreshnessSeal({
      ...base,
      repositoryFacts: {
        graph,
        claims: [{ ...claim, subjectNodeIds: [...claim.subjectNodeIds].reverse(), evidenceIds: [...claim.evidenceIds].reverse(), tags: [...claim.tags].reverse() }],
        evidence: [{ ...evidence, filePath: "src\\a.ts" }],
      },
    });

    expect(claimChanged.repositoryGraphHash).not.toBe(original.repositoryGraphHash);
    expect(evidenceChanged.repositoryGraphHash).not.toBe(original.repositoryGraphHash);
    expect(reordered.repositoryGraphHash).toBe(original.repositoryGraphHash);
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

describe("authored target binding freshness", () => {
  it("participates in the Plane B semantic model hash while absence stays compatible", () => {
    const legacyChange = {
      id: "change.checkout",
      statement: "Adopt target",
      lifecycle: "active" as const,
      provenance: "author" as const,
      sourceRefs: [],
      serves: [],
      preserves: [],
      requiresEvidence: [],
      openUnknowns: [],
      repositoryLinks: [],
      tags: [],
    };
    const modelWithLegacyChange: SemanticModel = { ...semanticModel, changes: [legacyChange] };
    const legacyHash = appServices.fingerprintSemanticModel(modelWithLegacyChange);
    const sameLegacyHash = appServices.fingerprintSemanticModel({
      ...modelWithLegacyChange,
      changes: modelWithLegacyChange.changes.map((change) => ({ ...change })),
    });
    const targetBoundHash = appServices.fingerprintSemanticModel({
      ...modelWithLegacyChange,
      changes: modelWithLegacyChange.changes.map((change) => ({
            ...change,
            targetBinding: {
              schemaVersion: 1 as const,
              targetId: "checkout-v2",
              revision: 1,
              artifactHash: `sha256:${"e".repeat(64)}` as const,
            },
          })),
    });

    expect(sameLegacyHash).toBe(legacyHash);
    expect(targetBoundHash).not.toBe(legacyHash);
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

describe("preflight verdict on an unprojectable semantic model", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** An indexed repository whose authored model was still projectable at capture time. */
  function indexedRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "semctx-preflight-"));
    roots.push(dir);
    writeFileSync(join(dir, "README.md"), "fixture\n", "utf8");
    writeFileSync(join(dir, ".gitignore"), ".semctx/\n", "utf8");
    git(dir, "init", "-q");
    git(dir, "add", "README.md", ".gitignore");
    git(dir, "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", "commit", "-q", "-m", "fixture");
    initWorkspace(dir);
    indexRepository(dir, "2026-07-25T00:00:00.000Z");
    return dir;
  }

  it("reports a bounded verdict when authored lifecycle drifts after indexing", () => {
    const dir = indexedRoot();
    expect(controlStatus(dir).verdict).not.toBe("UNSEALED");

    // Two non-terminal contracts with a pointer on one: ACTIVE_CHANGE_OBSOLETE, severity error.
    const selected = newChangeContract({ id: "change.selected", statement: "Selected", lifecycle: "active", provenance: "author" });
    writeChangeFile(dir, selected);
    writeChangeFile(dir, newChangeContract({ id: "change.orphan", statement: "Orphan", lifecycle: "active", provenance: "author" }));
    writeActiveChange(dir, selected);

    const status = controlStatus(dir);

    expect(status.verdict).toBe("UNSEALED");
    expect(status.reasons).toEqual(["SEMANTIC_LIFECYCLE_INVALID"]);
    expect(status.canRunHighRiskControl).toBe(false);
    expect(status.freshnessSeal).toBeNull();
    expect(ControlFreshnessStatusReportSchema.safeParse(status).success).toBe(true);
  });

  it("reports a bounded verdict when the authored model stops parsing", () => {
    const dir = indexedRoot();
    mkdirSync(join(dir, ".semctx", "semantic"), { recursive: true });
    writeFileSync(
      join(dir, ".semctx", "semantic", "goals.sem"),
      [
        "goal goal.duplicated",
        "  statement: First declaration.",
        "  status: declared",
        "",
        "goal goal.duplicated",
        "  statement: Second declaration of the same id.",
        "  status: declared",
        "",
      ].join("\n"),
      "utf8",
    );

    const status = controlStatus(dir);

    expect(status.verdict).toBe("UNSEALED");
    expect(status.reasons).toEqual(["SEMANTIC_MODEL_INVALID"]);
    expect(status.canRunHighRiskControl).toBe(false);
    expect(ControlFreshnessStatusReportSchema.safeParse(status).success).toBe(true);
  });

  it("reports both causes in canonical order when the model and its lifecycle are invalid", () => {
    const dir = indexedRoot();
    mkdirSync(join(dir, ".semctx", "semantic"), { recursive: true });
    writeFileSync(
      join(dir, ".semctx", "semantic", "goals.sem"),
      [
        "goal goal.duplicated",
        "  statement: First declaration.",
        "  status: declared",
        "",
        "goal goal.duplicated",
        "  statement: Second declaration of the same id.",
        "  status: declared",
        "",
      ].join("\n"),
      "utf8",
    );
    const selected = newChangeContract({ id: "change.selected", statement: "Selected", lifecycle: "active", provenance: "author" });
    writeChangeFile(dir, selected);
    writeChangeFile(dir, newChangeContract({ id: "change.orphan", statement: "Orphan", lifecycle: "active", provenance: "author" }));
    writeActiveChange(dir, selected);

    const status = controlStatus(dir);

    expect(status.verdict).toBe("UNSEALED");
    expect(status.reasons).toEqual(["SEMANTIC_MODEL_INVALID", "SEMANTIC_LIFECYCLE_INVALID"]);
    expect(status.canRunHighRiskControl).toBe(false);
    expect(ControlFreshnessStatusReportSchema.safeParse(status).success).toBe(true);
  });
});

describe("persisted control snapshot boundary", () => {
  for (const raw of ["", "{", "null", "[]", JSON.stringify({ ...indexedSnapshot(buildControlFreshnessSeal(base)), repositoryGraphHash: 1 })]) {
    it(`rejects malformed snapshot ${raw}`, () => {
      expect(() => parseIndexedControlSnapshot(raw)).toThrow("invalid persisted control index snapshot");
      try {
        parseIndexedControlSnapshot(raw);
      } catch (error) {
        expect(error).toMatchObject({ code: "STORE_ERROR", details: { table: "meta", id: "control_index_snapshot_v1" } });
      }
    });
  }
  it("reads valid v1 and v2 snapshots without coercion", () => {
    const v1 = indexedSnapshot(buildControlFreshnessSeal(base));
    const v2 = { ...v1, schemaVersion: 2 as const, observedHunkIndexHash: base.analysisInputHash, attestationSetHash: null };
    expect(parseIndexedControlSnapshot(undefined)).toBeNull();
    expect(parseIndexedControlSnapshot(JSON.stringify(v1))).toEqual(v1);
    expect(parseIndexedControlSnapshot(JSON.stringify(v2))).toEqual(v2);
    expect(() => parseIndexedControlSnapshot(JSON.stringify({ ...v2, attestationSetHash: "invalid" }))).toThrow();
  });
});
