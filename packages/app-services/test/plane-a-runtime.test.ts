import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  createDefaultConfig,
  createGlobSelectionConfig,
  type SemctxConfigV2,
  type TaskFrame,
} from "@semantic-context/core";
import {
  analyzeRepository,
  discoverRepository,
  type DiscoveryResult,
} from "@semantic-context/ts-analyzer";
import {
  buildClaims,
  GraphIndex,
  prepareContextPack,
} from "@semantic-context/context-engine";
import { analyzePlaneARuntime, mergeUnresolvedReferences } from "../src/plane-a-runtime";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "semctx-plane-a-runtime-")));
  roots.push(root);
  return root;
}

function write(root: string, relPath: string, content: string): void {
  const absPath = join(root, ...relPath.split("/"));
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, "utf8");
}

function v2(root: string): SemctxConfigV2 {
  return {
    ...createGlobSelectionConfig(root),
    include: ["**/*"],
    exclude: [],
  };
}

describe("private integrated Plane-A runtime", () => {
  it("preserves legacy v1 graph and evidence bytes", () => {
    const root = repository();
    write(root, "src/value.ts", "export function value(): number { return 1; }\n");
    write(root, "docs/guide.md", "# Guide\n");
    const config = createDefaultConfig(root);
    const discovery = discoverRepository(config);

    const legacy = analyzeRepository(config, discovery.files);
    const integrated = analyzePlaneARuntime(config, discovery);

    expect(JSON.stringify(integrated.analysis.graph)).toBe(JSON.stringify(legacy.graph));
    expect(JSON.stringify(integrated.analysis.evidence)).toBe(JSON.stringify(legacy.evidence));
  });

  it("preserves TypeScript bytes in v2 while no second-language facts are present", () => {
    const root = repository();
    write(root, "src/a.ts", [
      "// @boundedContext payments",
      "export function a(): number { return 1; }",
      "",
    ].join("\n"));
    write(root, "src/b.ts", [
      "// @boundedContext payments",
      "export function b(): number { return 2; }",
      "",
    ].join("\n"));
    const config = v2(root);
    const discovery = discoverRepository(config);

    const legacy = analyzeRepository(config, discovery.files);
    const integrated = analyzePlaneARuntime(config, discovery);

    expect(JSON.stringify(integrated.analysis.graph)).toBe(JSON.stringify(legacy.graph));
    expect(JSON.stringify(integrated.analysis.evidence)).toBe(JSON.stringify(legacy.evidence));
  });

  it("merges TypeScript import specifiers that resolve to the same module", () => {
    const root = repository();
    write(
      root,
      "src/consumer.ts",
      [
        'import { first } from "./target";',
        'import { second } from "./target.js";',
        "export const value = first + second;",
        "",
      ].join("\n"),
    );
    write(
      root,
      "src/target.ts",
      [
        "export const first = 1;",
        "export const second = 2;",
        "",
      ].join("\n"),
    );
    const config = v2(root);
    const result = analyzePlaneARuntime(config, discoverRepository(config));
    const importEdges = result.analysis.graph.edges.filter((edge) =>
      edge.kind === "imports"
      && edge.from === "mod:src/consumer.ts"
      && edge.to === "mod:src/target.ts");

    expect(importEdges).toHaveLength(1);
    expect(importEdges[0]?.evidence.map((ref) => ref.startLine)).toEqual([1, 2]);
    expect(importEdges[0]?.metadata).toEqual({
      specifiers: '["./target","./target.js"]',
    });
  });

  // The legacy pass removes an unresolved authored edge from the graph it hands over, so the
  // polyglot assembler cannot re-derive that diagnostic. Adding a second language must not be the
  // thing that erases the first language's gaps.
  it("keeps an unresolved authored reference visible once Python facts extend the graph", () => {
    const root = repository();
    write(root, "docs/notes.md", "---\ntype: doc\ncontradicts: [docs/absent.md]\n---\n\n# Notes\n");
    write(root, "src/value.py", "def value():\n    return 1\n");
    const config = v2(root);
    const discovery = discoverRepository(config);

    const legacy = analyzeRepository(config, discovery.files);
    const integrated = analyzePlaneARuntime(config, discovery);

    expect(legacy.unresolvedReferences).toHaveLength(1);
    expect(integrated.analysis.unresolvedReferences).toEqual(legacy.unresolvedReferences);
    expect(integrated.analysis.graph.nodes.map((node) => node.id)).toContain("mod:src/value.py");
  });

  // Both passes describe the same repository, so the same authored reference reported by each is
  // one gap. Composition must not multiply a diagnostic by the number of languages analysed.
  it("reports a reference seen by both passes once, in edge order", () => {
    const reference = (edgeId: string, to: string) => ({
      edgeId,
      kind: "contradicts" as const,
      from: "doc:docs/notes.md",
      to,
      missing: to,
    });

    const merged = mergeUnresolvedReferences(
      [reference("edge:contradicts:b", "doc:docs/b.md"), reference("edge:contradicts:a", "doc:docs/a.md")],
      [reference("edge:contradicts:b", "doc:docs/b.md")],
    );

    expect(merged.map((item) => item.edgeId)).toEqual(["edge:contradicts:a", "edge:contradicts:b"]);
  });

  it("keeps mixed-language source bindings stable across LF and CRLF checkout materialization", () => {
    const root = repository();
    const typescript = "export const value = 1;\nexport const next = value + 1;\n";
    const python = "def value():\n    return 1\n\ndef next_value():\n    return value() + 1\n";
    write(root, "src/value.ts", typescript);
    write(root, "src/value.py", python);
    const config = v2(root);

    const lf = analyzePlaneARuntime(config, discoverRepository(config));
    write(root, "src/value.ts", typescript.replaceAll("\n", "\r\n"));
    write(root, "src/value.py", python.replaceAll("\n", "\r\n"));
    const crlf = analyzePlaneARuntime(config, discoverRepository(config));

    expect(crlf.analysis.graph).toEqual(lf.analysis.graph);
    expect(crlf.analysis.evidence).toEqual(lf.analysis.evidence);
    expect(crlf.sidecar).toEqual(lf.sidecar);
  });

  it("composes TypeScript and Python facts with explicit markers and local imports", () => {
    const root = repository();
    write(root, "src/value.ts", "export const value = 1;\n");
    write(root, "src/python/helper.py", "def assist():\n    return 1\n");
    write(
      root,
      "src/python/service.py",
      [
        "from .helper import assist",
        "",
        "# @invariant positive-balance: balance cannot be negative",
        "def debit():",
        "    return assist()",
        "",
      ].join("\n"),
    );
    const config = v2(root);
    const result = analyzePlaneARuntime(config, discoverRepository(config));

    expect(result.analysis.graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "mod:src/value.ts", kind: "module" }),
      expect.objectContaining({ id: "mod:src/python/service.py", kind: "module" }),
      expect.objectContaining({
        id: "sym:function:src/python/service.py:debit",
        kind: "function",
      }),
      expect.objectContaining({ id: "inv:positive-balance", kind: "invariant" }),
    ]));
    expect(result.analysis.graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "imports",
        from: "mod:src/python/service.py",
        to: "mod:src/python/helper.py",
      }),
      expect.objectContaining({
        kind: "constrained_by",
        from: "sym:function:src/python/service.py:debit",
        to: "inv:positive-balance",
      }),
    ]));
    expect(result.discoveryLedger.find((entry) =>
      entry.candidateIdentity === "python:src/python/service.py")?.scope.dialectVersion)
      .toBe("<=3.12");
    expect(result.analysis.graph.edges.some((edge) =>
      edge.kind === "calls" && edge.from.includes("service.py"))).toBe(false);
    const repositoryBatch = result.sidecar.factBatches.find((batch) =>
      batch.facts.some((fact) =>
        fact.factType === "node" && fact.kind === "repository"));
    expect(repositoryBatch).toMatchObject({
      producer: { identity: "@semantic-context/ts-analyzer", version: "0.1.0" },
      scope: { language: "repository", selectedPaths: [] },
    });
    expect(result.sidecar.factBatches
      .filter((batch) => batch.producer.identity === "@semantic-context/python-analyzer")
      .every((batch) => batch.facts.every((fact) =>
        fact.factType !== "node" || fact.kind !== "repository"))).toBe(true);
  });

  it("merges repeated Python imports between the same two modules", () => {
    const root = repository();
    write(
      root,
      "src/pkg/__init__.py",
      [
        "from ._result import HookCallError",
        "from ._result import Result",
        "",
      ].join("\n"),
    );
    write(
      root,
      "src/pkg/_result.py",
      [
        "class HookCallError(Exception):",
        "    pass",
        "",
        "class Result:",
        "    pass",
        "",
      ].join("\n"),
    );
    const config = v2(root);
    const result = analyzePlaneARuntime(config, discoverRepository(config));
    const importEdges = result.analysis.graph.edges.filter((edge) =>
      edge.kind === "imports"
      && edge.from === "mod:src/pkg/__init__.py"
      && edge.to === "mod:src/pkg/_result.py");

    expect(importEdges).toHaveLength(1);
    expect(importEdges[0]?.evidence.map((ref) => ref.startLine)).toEqual([1, 2]);
    expect(importEdges[0]?.metadata).toEqual({
      specifiers: '["._result:HookCallError","._result:Result"]',
    });
  });

  it("does not resolve an absolute import by arbitrary repository-path suffix", () => {
    const root = repository();
    write(root, "src/vendor/pkg/helper.py", "value = 1\n");
    write(root, "src/service.py", "import pkg.helper\n");
    const config = v2(root);
    const result = analyzePlaneARuntime(config, discoverRepository(config));

    expect(result.analysis.graph.edges.some((edge) =>
      edge.kind === "imports"
      && edge.from === "mod:src/service.py"
      && edge.to === "mod:src/vendor/pkg/helper.py")).toBe(false);
    expect(result.discoveryLedger.find((entry) =>
      entry.candidateIdentity === "python:src/service.py")?.analysisReasons)
      .toEqual(expect.arrayContaining([
        expect.stringContaining("unresolved-import:1:pkg.helper"),
      ]));
  });

  it("retains the repository endpoint for a pure-Python v2 repository", () => {
    const root = repository();
    write(root, "src/service.py", "def service():\n    return 1\n");
    const config = v2(root);
    const result = analyzePlaneARuntime(config, discoverRepository(config));

    expect(result.analysis.graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: expect.stringMatching(/^repo:/), kind: "repository" }),
      expect.objectContaining({ id: "mod:src/service.py", kind: "module" }),
    ]));
    expect(result.analysis.graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "belongs_to",
        from: "mod:src/service.py",
        to: expect.stringMatching(/^repo:/),
      }),
    ]));
    const repositoryBatch = result.sidecar.factBatches.find((batch) =>
      batch.facts.some((fact) =>
        fact.factType === "node" && fact.kind === "repository"));
    expect(repositoryBatch).toMatchObject({
      producer: { identity: "@semantic-context/ts-analyzer", version: "0.1.0" },
      scope: { language: "repository", selectedPaths: [] },
    });
    expect(result.sidecar.factBatches
      .filter((batch) => batch.producer.identity === "@semantic-context/python-analyzer")
      .every((batch) => batch.facts.every((fact) =>
        fact.factType !== "node" || fact.kind !== "repository"))).toBe(true);
  });

  it("finalizes every candidate with exact per-path terminal cardinality", () => {
    const root = repository();
    write(root, "src/a.ts", "export const a = 1;\n");
    write(root, "src/b.py", "def b():\n    return 1\n");
    write(root, "notes.txt", "unsupported\n");
    const config = v2(root);
    const discovery = discoverRepository(config);
    const result = analyzePlaneARuntime(config, discovery);

    expect(result.discoveryLedger).toHaveLength(discovery.candidates.length);
    for (const entry of result.discoveryLedger) {
      expect(entry.scope.selectedPaths).toEqual([
        entry.candidateIdentity.slice(entry.candidateIdentity.indexOf(":") + 1),
      ]);
      const matchingResults = result.sidecar.producerResults.filter((item) =>
        item.scope.selectedPaths[0] === entry.scope.selectedPaths[0]);
      const matchingBatches = result.sidecar.factBatches.filter((item) =>
        item.scope.selectedPaths[0] === entry.scope.selectedPaths[0]);
      if (entry.selectionDecision === "selected" && entry.analysisOutcome === "analyzed") {
        expect(matchingResults).toHaveLength(1);
        expect(matchingBatches).toHaveLength(1);
      } else {
        expect(matchingResults).toHaveLength(0);
        expect(matchingBatches).toHaveLength(0);
      }
    }
  });

  it("retains Python limitations as partial, negative-ineligible capability evidence", () => {
    const root = repository();
    write(
      root,
      "src/dynamic.py",
      [
        "from missing import *",
        "importlib.import_module(name)",
        "sys.path.append('/tmp')",
        "def useful():",
        "    return 1",
        "",
      ].join("\n"),
    );
    write(root, "selected.bin", "unsupported\n");
    const config = v2(root);
    const result = analyzePlaneARuntime(config, discoverRepository(config));
    const pythonEntry = result.discoveryLedger.find((entry) =>
      entry.candidateIdentity === "python:src/dynamic.py");
    const unsupported = result.discoveryLedger.find((entry) =>
      entry.candidateIdentity === "unknown:selected.bin");
    const pythonProfiles = result.sidecar.capabilityProfiles.filter((profile) =>
      profile.scope.selectedPaths[0] === "src/dynamic.py");

    expect(pythonEntry).toMatchObject({
      analysisOutcome: "analyzed",
      analysisReasons: expect.arrayContaining([
        expect.stringContaining("star-import:"),
        expect.stringContaining("dynamic-import:"),
        expect.stringContaining("sys-path-mutation:"),
        expect.stringContaining("unresolved-import:"),
      ]),
    });
    expect(unsupported).toMatchObject({
      selectionDecision: "selected",
      analysisOutcome: "unsupported",
    });
    expect(pythonProfiles.length).toBeGreaterThan(0);
    expect(pythonProfiles.every((profile) =>
      profile.completenessClaim === "partial"
      && profile.negativeEvidenceEligible === false)).toBe(true);
  });

  it("isolates invalid Python scopes without failing unaffected candidates", () => {
    const root = repository();
    const config = v2(root);
    const malformed: DiscoveryResult = {
      candidates: [
        {
          relPath: "../escape.py",
          language: "python",
          selectionDecision: "selected",
          reason: "SELECTED",
        },
        {
          relPath: "src/ok.py",
          language: "python",
          selectionDecision: "selected",
          reason: "SELECTED",
        },
      ],
      files: [
        {
          absPath: join(root, "escape.py"),
          relPath: "../escape.py",
          role: "source",
          content: "def escape():\n    return 1\n",
          language: "python",
        },
        {
          absPath: join(root, "src", "ok.py"),
          relPath: "src/ok.py",
          role: "source",
          content: "def ok():\n    return 1\n",
          language: "python",
        },
      ],
    };

    const result = analyzePlaneARuntime(config, malformed);
    const entry = result.discoveryLedger.find((candidate) =>
      candidate.candidateIdentity === "python:../escape.py");

    expect(entry).toMatchObject({
      selectionDecision: "selected",
      analysisOutcome: "failed",
      analysisReasons: [
        "PRODUCER_FAILED",
        "invalid-repository-relative-path",
      ],
    });
    expect(result.sidecar.factBatches.some((batch) =>
      batch.scope.selectedPaths[0] === "../escape.py")).toBe(false);
    expect(result.sidecar.producerResults.some((producerResult) =>
      producerResult.scope.selectedPaths[0] === "../escape.py")).toBe(false);
    expect(result.discoveryLedger.find((candidate) =>
      candidate.candidateIdentity === "python:src/ok.py")).toMatchObject({
        selectionDecision: "selected",
        analysisOutcome: "analyzed",
      });
    expect(result.sidecar.factBatches.some((batch) =>
      batch.scope.selectedPaths[0] === "src/ok.py")).toBe(true);
  });

  it("projects manifest-backed workspaces without changing repository graph relations", () => {
    const root = repository();
    write(root, "package.json", JSON.stringify({
      name: "root",
      private: true,
      workspaces: ["packages/*"],
    }));
    write(root, "packages/api/package.json", JSON.stringify({ name: "@fixture/api" }));
    write(root, "packages/api/src/index.ts", "export const api = true;\n");
    const config = v2(root);
    const result = analyzePlaneARuntime(config, discoverRepository(config));

    expect(result.workspaceProjection.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "workspace:packages/api",
        identity: "@fixture/api",
      }),
    ]));
    expect(result.workspaceProjection.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "contained_in_workspace",
        from: "mod:packages/api/src/index.ts",
        to: "workspace:packages/api",
      }),
    ]));
    expect(result.analysis.graph.nodes.some((node) => node.kind === "package")).toBe(false);
    expect(result.analysis.graph.edges.every((edge) =>
      edge.kind !== ("contained_in_workspace" as typeof edge.kind)
      && edge.kind !== ("workspace_member_of" as typeof edge.kind))).toBe(true);
    const entry = result.discoveryLedger.find((candidate) =>
      candidate.candidateIdentity === "typescript:packages/api/src/index.ts");
    const batch = result.sidecar.factBatches.find((candidate) =>
      candidate.scope.selectedPaths[0] === "packages/api/src/index.ts");
    const producerResult = result.sidecar.producerResults.find((candidate) =>
      candidate.scope.selectedPaths[0] === "packages/api/src/index.ts");
    expect(entry?.scope.workspaceUnitId).toBe("workspace:packages/api");
    expect(batch?.scope.workspaceUnitId).toBe("workspace:packages/api");
    expect(producerResult?.scope.workspaceUnitId).toBe("workspace:packages/api");
    expect(result.sidecar.capabilityProfiles
      .filter((profile) => profile.scope.selectedPaths[0] === "packages/api/src/index.ts")
      .every((profile) => profile.scope.workspaceUnitId === "workspace:packages/api")).toBe(true);
  });

  // HOK-79: divergence must be judged after every producer's facts are composed, not just within
  // one producer's own pass — Python's own markers, and TypeScript's markers against Python's.
  it("degrades a slug declared with different statements across two Python files", () => {
    const root = repository();
    write(root, "src/a.py", "# @invariant must-hold: A must never exceed B\ndef a():\n    return 1\n");
    write(root, "src/b.py", "# @invariant must-hold: A must equal B\ndef b():\n    return 2\n");
    const config = v2(root);
    const result = analyzePlaneARuntime(config, discoverRepository(config));

    const inv = result.analysis.graph.nodes.find((node) => node.id === "inv:must-hold");
    expect(inv).toBeDefined();
    expect(inv!.tags).toContain("statement-divergent");
    expect(inv!.metadata["statement"]).toBeUndefined();
  });

  it("degrades a slug TypeScript and Python each declared consistently but differently from each other", () => {
    const root = repository();
    write(
      root,
      "src/a.ts",
      [
        "/**",
        " * @invariant must-hold: A must never exceed B",
        " */",
        "export function a(): number { return 1; }",
        "",
      ].join("\n"),
    );
    write(root, "src/b.py", "# @invariant must-hold: A must equal B\ndef b():\n    return 2\n");
    const config = v2(root);
    const result = analyzePlaneARuntime(config, discoverRepository(config));

    const inv = result.analysis.graph.nodes.find((node) => node.id === "inv:must-hold");
    expect(inv).toBeDefined();
    expect(inv!.tags).toContain("statement-divergent");
    expect(inv!.metadata["statement"]).toBeUndefined();
  });

  it("keeps cross-language @capability statement divergence non-authorizing end to end", () => {
    const root = repository();
    write(
      root,
      "src/checkout.ts",
      [
        "/**",
        " * @capability checkout: Charges a saved payment method",
        " */",
        "export function checkout(): number { return 1; }",
        "",
      ].join("\n"),
    );
    write(
      root,
      "src/checkout.py",
      "# @capability checkout: Reserves inventory without charging\ndef checkout():\n    return 2\n",
    );
    const config = v2(root);
    const result = analyzePlaneARuntime(config, discoverRepository(config));

    const capability = result.analysis.graph.nodes.find((node) => node.id === "cap:checkout");
    expect(capability).toBeDefined();
    expect(capability!.tags).toContain("statement-divergent");
    expect(capability!.metadata["statement"]).toBeUndefined();

    const claims = buildClaims(new GraphIndex(result.analysis.graph));
    const capabilityClaim = claims.find((claim) => claim.kind === "capability");
    expect(capabilityClaim).toBeDefined();
    expect(capabilityClaim!.verificationStatus).toBe("contradicted");

    const now = "2026-01-01T00:00:00.000Z";
    const taskFrame: TaskFrame = {
      id: "task:checkout",
      rawTask: "Change checkout behavior",
      mode: "feature",
      capabilities: ["checkout"],
      observedBehavior: [],
      expectedBehavior: [],
      boundedContexts: [],
      hardInvariants: [],
      softConstraints: [],
      acceptanceEvidence: [],
      nonGoals: [],
      riskSurfaces: [],
      hypotheses: [],
      createdAt: now,
    };
    const pack = prepareContextPack({
      graph: result.analysis.graph,
      evidence: result.analysis.evidence,
      claims,
      taskFrame,
      now,
      candidateProviders: [],
    });

    expect(pack.authoritativeClaims).not.toContainEqual(expect.objectContaining({ id: capabilityClaim!.id }));
    expect(pack.hardConstraints).not.toContainEqual(expect.objectContaining({ id: capabilityClaim!.id }));
    expect(pack.contradictions).toContainEqual(expect.objectContaining({ id: capabilityClaim!.id }));
  });

  it("does not flag a slug TypeScript and Python declare with the identical statement", () => {
    const root = repository();
    write(
      root,
      "src/a.ts",
      [
        "/**",
        " * @invariant must-hold: A must never exceed B",
        " */",
        "export function a(): number { return 1; }",
        "",
      ].join("\n"),
    );
    write(root, "src/b.py", "# @invariant must-hold: A must never exceed B\ndef b():\n    return 2\n");
    const config = v2(root);
    const result = analyzePlaneARuntime(config, discoverRepository(config));

    const inv = result.analysis.graph.nodes.find((node) => node.id === "inv:must-hold");
    expect(inv).toBeDefined();
    expect(inv!.tags).not.toContain("statement-divergent");
    expect(inv!.metadata["statement"]).toBe("A must never exceed B");
  });

  // Same doctrine as `ts-analyzer/symbol-grouping.ts` (overload sets fold, homonym collisions
  // split): Python has no signature-only overload form in this analyzer, so any redefinition
  // under one (kind, relPath, scope, name) key is a genuine, non-mergeable structural collision.
  it("splits a Python redefinition into ordinal-suffixed ids, neither owning the bare coordinate", () => {
    const root = repository();
    write(
      root,
      "src/twins.py",
      [
        "def twin():",
        "    return 1",
        "",
        "def twin():",
        "    return 2",
        "",
      ].join("\n"),
    );
    const config = v2(root);
    const result = analyzePlaneARuntime(config, discoverRepository(config));

    const bare = "sym:function:src/twins.py:twin";
    const twins = result.analysis.graph.nodes.filter((node) => node.id.startsWith(`${bare}#`));
    expect(twins).toHaveLength(2);
    expect(result.analysis.graph.nodes.some((node) => node.id === bare)).toBe(false);
  });

  it("is deterministic under discovery permutation", () => {
    const root = repository();
    write(root, "src/a.ts", "export const a = 1;\n");
    write(root, "src/b.py", "def b():\n    return 1\n");
    const config = v2(root);
    const discovery = discoverRepository(config);
    const reversed: DiscoveryResult = {
      files: [...discovery.files].reverse(),
      candidates: [...discovery.candidates].reverse(),
    };

    const forward = analyzePlaneARuntime(config, discovery);
    const backward = analyzePlaneARuntime(config, reversed);

    expect(JSON.stringify(backward.analysis)).toBe(JSON.stringify(forward.analysis));
    expect(JSON.stringify(backward.sidecar)).toBe(JSON.stringify(forward.sidecar));
    expect(JSON.stringify(backward.workspaceProjection)).toBe(
      JSON.stringify(forward.workspaceProjection),
    );
  });
});
