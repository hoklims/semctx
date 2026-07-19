import { describe, it, expect } from "bun:test";
import type { RepositoryGraph, VerifyReport, VerifyReportFinding, SemanticPolicyConfig } from "@semantic-context/core";
import type { SemanticModel, ChangeContract } from "@semantic-context/semantic-model";
import {
  resolveRepositoryLinks,
  findDanglingReferences,
  sliceSemanticModel,
  newChangeContract,
  applyChangePatch,
  verifyChangeContract,
  buildHandoffCapsule,
  computeGitignore,
  DEFAULT_SEMANTIC_POLICY,
  type RepositoryFacts,
} from "../src/index";

const POLICY: SemanticPolicyConfig = DEFAULT_SEMANTIC_POLICY;

/** A small graph: sym:danger is constrained_by inv:x; both live in x.ts. */
function facts(): RepositoryFacts {
  const graph: RepositoryGraph = {
    nodes: [
      { id: "sym:function:x.ts:danger:5", kind: "function", name: "danger", filePath: "x.ts", exported: true, evidence: [{ filePath: "x.ts", startLine: 5, endLine: 10, sourceKind: "code" }], tags: [], metadata: {} },
      { id: "inv:x", kind: "invariant", name: "x", evidence: [], tags: [], metadata: {} },
      { id: "test:test/x.test.ts", kind: "test", name: "x.test.ts", filePath: "test/x.test.ts", evidence: [], tags: [], metadata: {} },
    ],
    edges: [{ id: "e1", kind: "constrained_by", from: "sym:function:x.ts:danger:5", to: "inv:x", evidence: [], metadata: {} }],
  };
  return { graph, claims: [], evidence: [] };
}

function report(verdict: VerifyReport["verdict"], findings: VerifyReportFinding[] = [], changedSymbols: VerifyReport["changedSymbols"] = []): VerifyReport {
  return {
    schemaVersion: 1,
    verdict,
    base: null,
    head: "HEAD",
    mergeBase: null,
    range: null,
    changedFiles: [],
    changedSymbols,
    impactedContracts: [],
    impactedInvariants: [],
    recommendedTests: [],
    contradictions: [],
    unknowns: [],
    findings,
    summary: { blockCount: findings.filter((f) => f.severity === "block").length, warnCount: findings.filter((f) => f.severity === "warn").length },
  };
}

function model(overrides: { invTags?: string[]; evidenceStatus?: "declared" | "tested"; withUnknown?: boolean; changeLinks?: string[] } = {}): SemanticModel {
  const nodes: SemanticModel["nodes"] = [
    { id: "goal.g", kind: "goal", statement: "G", status: "declared", provenance: "author", sourceRefs: [], repositoryLinks: [], relations: [], tags: [] },
    { id: "invariant.idem", kind: "invariant", statement: "idempotent", status: "declared", provenance: "author", sourceRefs: [], repositoryLinks: [{ kind: "invariant", ref: "inv:x" }], relations: [{ kind: "serves", to: "goal.g" }], tags: overrides.invTags ?? [] },
    { id: "proof.p", kind: "evidence", statement: "the test", status: overrides.evidenceStatus ?? "declared", provenance: "author", sourceRefs: [], repositoryLinks: [{ kind: "test", ref: "test:test/x.test.ts" }], relations: [], tags: [] },
  ];
  if (overrides.withUnknown === true) nodes.push({ id: "unknown.race", kind: "unknown", statement: "a race", status: "declared", provenance: "author", sourceRefs: [], repositoryLinks: [], relations: [], tags: [] });
  const change: ChangeContract = {
    id: "change.c",
    statement: "make it retry-safe",
    lifecycle: "active",
    provenance: "agent",
    sourceRefs: [],
    serves: ["goal.g"],
    preserves: ["invariant.idem"],
    requiresEvidence: ["proof.p"],
    openUnknowns: overrides.withUnknown === true ? ["unknown.race"] : [],
    repositoryLinks: (overrides.changeLinks ?? ["sym:function:x.ts:danger:5"]).map((ref) => ({ kind: ref.startsWith("sym:") ? "symbol" : "file", ref })),
    tags: [],
  };
  return { nodes, changes: [change] };
}

describe("link resolution & stale detection", () => {
  it("resolves valid links and flags a stale one", () => {
    const m = model({ changeLinks: ["sym:gone:0"] });
    const report2 = resolveRepositoryLinks(m, facts());
    expect(report2.staleLinks.map((s) => s.ownerId)).toContain("change.c");
    expect(report2.staleLinks[0]?.link.ref).toBe("sym:gone:0");
  });

  it("finds a dangling internal reference", () => {
    const m = model();
    m.changes[0]!.preserves.push("invariant.does-not-exist");
    const dangling = findDanglingReferences(m);
    expect(dangling.some((d) => d.ref === "invariant.does-not-exist" && d.field === "preserves")).toBe(true);
  });
});

describe("semantic slice — bounded & deterministic", () => {
  it("seeds from a change id and includes its intentions, invariants, evidence and unknowns", () => {
    const slice = sliceSemanticModel(model({ withUnknown: true }), { changeId: "change.c" });
    expect(slice.intentions.map((n) => n.id)).toEqual(["goal.g"]);
    expect(slice.invariants.map((n) => n.id)).toEqual(["invariant.idem"]);
    expect(slice.evidence.map((n) => n.id)).toEqual(["proof.p"]);
    expect(slice.openUnknowns.map((n) => n.id)).toEqual(["unknown.race"]);
    expect(slice.nextProofs).toEqual(["proof.p"]); // declared, not proven
  });

  it("respects maxNodes and reports truncation", () => {
    const slice = sliceSemanticModel(model(), { changeId: "change.c", maxNodes: 1 });
    expect(slice.truncated).toBe(true);
  });

  it("seeds from a repository symbol ref", () => {
    const slice = sliceSemanticModel(model(), { symbolRef: "inv:x" });
    expect(slice.invariants.map((n) => n.id)).toContain("invariant.idem");
  });
});

describe("change contract lifecycle", () => {
  it("creates and patches a change deterministically", () => {
    const c = newChangeContract({ id: "change.c", statement: "s", serves: ["goal.g"], links: ["sym:a:0", "sym:a:0"] });
    expect(c.lifecycle).toBe("draft");
    expect(c.repositoryLinks).toHaveLength(1); // deduped
    const patched = applyChangePatch(c, { lifecycle: "active", addPreserves: ["invariant.idem"], addUnknowns: ["unknown.race"], resolveUnknowns: ["unknown.race"] });
    expect(patched.lifecycle).toBe("active");
    expect(patched.preserves).toEqual(["invariant.idem"]);
    expect(patched.openUnknowns).toEqual([]); // added then resolved
  });
});

describe("composed change verification — the four verdicts", () => {
  it("PARTIAL: preserved invariant safe, but evidence pending and an open unknown", () => {
    const r = verifyChangeContract({ contract: model({ withUnknown: true }).changes[0]!, model: model({ withUnknown: true }), facts: facts(), verifyReport: report("PASS"), policy: POLICY });
    expect(r.verdict).toBe("PARTIAL");
    expect(r.pendingEvidence.map((e) => e.id)).toEqual(["proof.p"]);
    expect(r.openUnknowns.map((u) => u.id)).toEqual(["unknown.race"]);
  });

  it("VERIFIED: evidence proven, no open unknowns, underlying PASS", () => {
    const m = model({ evidenceStatus: "tested" });
    const r = verifyChangeContract({ contract: m.changes[0]!, model: m, facts: facts(), verifyReport: report("PASS"), policy: POLICY });
    expect(r.verdict).toBe("VERIFIED");
    expect(r.provedEvidence.map((e) => e.id)).toEqual(["proof.p"]);
  });

  it("BLOCKED: a critical preserved invariant is touched without a test (underlying BLOCK)", () => {
    const m = model({ invTags: ["critical"], evidenceStatus: "tested" });
    const finding: VerifyReportFinding = { rule: "invariant_touched_without_test", tier: "strict", severity: "block", message: "x", nodeIds: ["sym:function:x.ts:danger:5"], locations: [] };
    const r = verifyChangeContract({ contract: m.changes[0]!, model: m, facts: facts(), verifyReport: report("BLOCK", [finding]), policy: POLICY });
    expect(r.verdict).toBe("BLOCKED");
    expect(r.preserved.find((p) => p.id === "invariant.idem")?.state).toBe("unproven");
    expect(r.findings.some((f) => f.kind === "critical_invariant_unproven")).toBe(true);
  });

  it("STALE: a repository link on the change no longer resolves", () => {
    const m = model({ evidenceStatus: "tested", changeLinks: ["sym:gone:0"] });
    const r = verifyChangeContract({ contract: m.changes[0]!, model: m, facts: facts(), verifyReport: report("PASS"), policy: POLICY });
    expect(r.verdict).toBe("STALE");
    expect(r.stale.some((s) => s.kind === "stale_link")).toBe(true);
  });
});

describe("handoff capsule", () => {
  it("captures the active change, pending proofs and next validations", () => {
    const m = model({ withUnknown: true });
    const capsule = buildHandoffCapsule({ root: "/repo", now: "2026-07-05T00:00:00.000Z", model: m, activeChange: m.changes[0] });
    expect(capsule.activeChangeId).toBe("change.c");
    expect(capsule.touchedInvariants).toEqual(["invariant.idem"]);
    expect(capsule.pendingProofs).toEqual(["proof.p"]);
    expect(capsule.openUnknowns).toEqual(["unknown.race"]);
    expect(capsule.nextValidations.length).toBeGreaterThan(0);
  });
});

describe("gitignore policy", () => {
  it("migrates a blanket .semctx/ to track .semctx/semantic/", () => {
    const { content } = computeGitignore("node_modules\n.semctx/\n");
    expect(content).toContain(".semctx/*");
    expect(content).toContain("!.semctx/semantic/");
    expect(content).not.toMatch(/^\.semctx\/$/m);
  });

  it("is idempotent", () => {
    const once = computeGitignore("node_modules\n.semctx/\n").content;
    const twice = computeGitignore(once).content;
    expect(twice).toBe(once);
    expect(computeGitignore(once).changed).toBe(false);
  });

  it("preserves an explicit project-only semantic policy without widening it", () => {
    const projectOnly = [
      "node_modules/",
      ".semctx/*",
      "!.semctx/semantic/",
      ".semctx/semantic/*",
      "!.semctx/semantic/project/",
      "!.semctx/semantic/project/**",
      "",
    ].join("\n");

    const result = computeGitignore(projectOnly);

    expect(result.changed).toBe(false);
    expect(result.content).toBe(projectOnly);
  });
});
