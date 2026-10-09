import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, SemctxError, type SemctxErrorCode } from "@semantic-context/core";
import { initWorkspace, openStore } from "@semantic-context/repository-store";
import type { IndexHealthReportV1 } from "../src/index-health";
import {
  INDEX_HEALTH_SECTIONS, INDEX_HEALTH_VIEW_MAX_BYTES, indexHealthView, projectIndexHealth,
  type IndexHealthSection, type IndexHealthViewRequest,
} from "../src/index-health-view";

function report(): IndexHealthReportV1 {
  return {
    schemaVersion: 1,
    kind: "index_health",
    capturedAt: "2026-10-08T00:00:00.000Z",
    binding: { status: "valid", sidecarDigest: null, workspaceDigest: null },
    freshness: { verdict: "FRESH", canRunHighRiskControl: true, reasons: [] },
    coverage: {
      status: "complete", candidates: 1, selected: 1, excluded: 0, analyzed: 1,
      disabled: 0, unsupported: 0, failed: 0,
    },
    candidates: [{
      candidateIdentity: "src/a.ts", path: "src/a.ts", language: "typescript",
      workspaceUnitId: null, selectionDecision: "selected", analysisOutcome: "analyzed",
      selectionReasons: [], analysisReasons: [], producer: null, negativeEvidenceEligible: true,
    }],
    capabilities: [],
    workspace: null,
    evaluations: { schemaVersion: 1, decisions: [], reasonSummary: [] },
    reasonSummary: [],
  };
}

function populatedReport(): IndexHealthReportV1 {
  const base = report();
  const candidate = base.candidates[0]!;
  const outcomes = ["PASS", "UNKNOWN", "INSUFFICIENT_ANALYSIS", "POLICY_DENIED"] as const;
  return {
    ...base,
    candidates: ["a", "b", "c"].map((name) => ({ ...candidate, path: `src/${name}.ts`, candidateIdentity: name })),
    capabilities: ["a", "b", "c"].map((profileId) => ({
      profileId, factKind: "calls", language: "typescript", producer: { identity: "typescript", version: "1" },
      completenessClaim: "complete", negativeEvidenceEligible: true, label: null,
    })),
    workspace: {
      schemaVersion: 1, repositoryId: "repo",
      nodes: ["a", "b", "c"].map((id) => ({ id, kind: "package", root: id, identity: id, evidence: [] })),
      edges: ["a", "b", "c"].map((id) => ({ id, kind: "workspace_member_of", from: id, to: "repo", evidence: [] })),
      candidates: ["a", "b", "c"].map((root) => ({ root, reason: "conventional-directory" })),
      diagnostics: ["a", "b", "c"].map((message) => ({ code: "AMBIGUOUS_LAYOUT", message, roots: [message], evidence: [] })),
    },
    reasonSummary: ["LANGUAGE_UNSUPPORTED"],
    evaluations: {
      schemaVersion: 1, reasonSummary: ["CAPABILITY_MISSING"], primaryReason: "CAPABILITY_MISSING",
      decisions: outcomes.map((outcome) => ({
        decisionKind: "exact_subject", task: "test", operation: "positive", factKind: "calls",
        requestedScopeDescriptor: {}, candidateIdentity: outcome,
        scope: {
          repositoryIdentity: "repo", sourceStateDigest: "digest", selectedPathSetDigest: "digest",
          selectedPaths: ["src/a.ts"], language: "typescript",
        },
        outcome, admissible: outcome === "PASS", normalizedAnalysisOutcome: "analyzed", reasons: [],
        gates: {
          discoveryAndScope: "passed", bindingAndIntegrity: "passed", currentFreshness: "passed",
          capabilityMatch: "passed", negativeCompleteness: "passed", taskRelativeAuthority: "passed",
        },
      })),
    },
  };
}

function sectionItems(original: IndexHealthReportV1, section: IndexHealthSection): readonly unknown[] {
  switch (section) {
    case "candidates": return original.candidates;
    case "capabilities": return original.capabilities;
    case "evaluations": return original.evaluations.decisions;
    case "workspace_nodes": return original.workspace?.nodes ?? [];
    case "workspace_edges": return original.workspace?.edges ?? [];
    case "workspace_candidates": return original.workspace?.candidates ?? [];
    case "workspace_diagnostics": return original.workspace?.diagnostics ?? [];
  }
}

function expectError(original: IndexHealthReportV1, request: IndexHealthViewRequest, code: SemctxErrorCode): void {
  let caught: unknown;
  try { projectIndexHealth(original, request); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(SemctxError);
  expect((caught as SemctxError).code).toBe(code);
  expect(Buffer.byteLength(canonicalJson((caught as SemctxError).toJSON()), "utf8")).toBeLessThan(1024);
}

describe("bounded index health view", () => {
  it("rejects invalid options before reading malformed repository configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-index-health-view-"));
    try {
      expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
      expect(Bun.spawnSync([
        "git", "-C", root, "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test",
        "commit", "-q", "--allow-empty", "-m", "fixture",
      ]).exitCode).toBe(0);
      initWorkspace(root);
      const store = openStore(root);
      try {
        store.saveGraph({
          nodes: [{ id: "repo", kind: "repository", name: "repo", evidence: [], tags: [], metadata: {} }],
          edges: [],
        }, []);
      } finally {
        store.close();
      }
      writeFileSync(join(root, ".semctx", "config.json"), "{");
      let caught: unknown;
      try { indexHealthView(root, { cursor: "invalid" }); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(SemctxError);
      expect((caught as SemctxError).code).toBe("INVALID_TASK_INPUT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a versioned summary preserving verdict and complete coverage without candidate details", () => {
    const original = report();
    const view = projectIndexHealth(original);
    expect(view.schemaVersion).toBe(2);
    expect(view.status).toBe("healthy");
    expect(view.freshness).toEqual(original.freshness);
    expect(view.coverage).toEqual(original.coverage);
    expect(view.binding).toEqual(original.binding);
    expect(view.details).toEqual({ candidates: 1, capabilities: 0, evaluations: 0, workspace: null });
    expect(view.page).toBeNull();
    expect("candidates" in view).toBe(false);
    expect(view.evaluations).toEqual({
      reasonSummary: [], outcomeCounts: { PASS: 0, UNKNOWN: 0, INSUFFICIENT_ANALYSIS: 0, POLICY_DENIED: 0 },
    });
  });

  it("preserves blocking and degraded dimensions plus all evaluation outcomes and primary reasons", () => {
    const original = populatedReport();
    const partial = { ...original, coverage: { ...original.coverage, status: "partial" as const } };
    expect(projectIndexHealth(partial).status).toBe("degraded");
    const stale = {
      ...original,
      freshness: { verdict: "STALE" as const, canRunHighRiskControl: false, reasons: ["HEAD_MISMATCH" as const] },
    };
    const view = projectIndexHealth(stale);
    expect(view.status).toBe("blocked");
    expect(view.freshness).toEqual(stale.freshness);
    expect(view.reasonSummary).toEqual(["LANGUAGE_UNSUPPORTED"]);
    expect(view.evaluations).toEqual({
      reasonSummary: ["CAPABILITY_MISSING"], primaryReason: "CAPABILITY_MISSING",
      outcomeCounts: { PASS: 1, UNKNOWN: 1, INSUFFICIENT_ANALYSIS: 1, POLICY_DENIED: 1 },
    });
    expect(view.details.workspace).toEqual({ repositoryId: "repo", nodes: 3, edges: 3, candidates: 3, diagnostics: 3 });
    expect(projectIndexHealth({ ...original, binding: { ...original.binding, status: "invalid" } }).status).toBe("blocked");
    expect(projectIndexHealth({ ...original, coverage: { ...original.coverage, status: "insufficient" } }).status).toBe("blocked");
  });

  it.each([...INDEX_HEALTH_SECTIONS])("paginates %s in source order without omitting or repeating items", (section) => {
    const original = populatedReport();
    const collected: unknown[] = [];
    let cursor: string | undefined;
    do {
      const view = projectIndexHealth(original, { section, limit: 2, ...(cursor === undefined ? {} : { cursor }) });
      const page = view.page!;
      expect(page.section).toBe(section);
      expect(page.total).toBe(section === "evaluations" ? 4 : 3);
      expect(page.offset).toBe(collected.length);
      expect(page.returned).toBe(page.items.length);
      expect(page.returned).toBeGreaterThan(0);
      expect(page.returned).toBeLessThanOrEqual(2);
      collected.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(collected).toEqual([...sectionItems(original, section)]);
  });

  it("uses the default page limit and returns a deterministic opaque continuation", () => {
    const original = populatedReport();
    const candidate = original.candidates[0]!;
    original.candidates = Array.from({ length: 21 }, (_, i) => ({ ...candidate, path: `src/${i}.ts` }));
    const first = projectIndexHealth(original, { section: "candidates" });
    expect(first.page?.returned).toBe(20);
    expect(first.page?.nextCursor).toBeString();
    expect(projectIndexHealth(original, { section: "candidates" })).toEqual(first);
    const last = projectIndexHealth(original, { section: "candidates", cursor: first.page!.nextCursor! });
    expect(last.page?.offset).toBe(20);
    expect(last.page?.returned).toBe(1);
    expect(last.page?.nextCursor).toBeNull();
  });

  it.each(INDEX_HEALTH_SECTIONS.slice(3))("returns a terminal empty %s page for absent workspace", (section) => {
    expect(projectIndexHealth(report(), { section }).page).toEqual({
      section, total: 0, offset: 0, returned: 0, nextCursor: null, items: [],
    });
  });

  it.each([
    { limit: 1 }, { cursor: "token" }, { section: "candidates", limit: 0 },
    { section: "candidates", limit: 101 }, { section: "candidates", limit: 1.5 },
    { section: "candidates", limit: Number.NaN }, { section: "candidates", limit: Number.POSITIVE_INFINITY },
    { section: "unknown" }, { section: "candidates", cursor: 3 },
  ] as IndexHealthViewRequest[])("rejects invalid request %p with a stable bounded input error", (request) => {
    expectError(report(), request, "INVALID_TASK_INPUT");
  });

  it.each([
    { label: "empty", cursor: "" }, { label: "invalid alphabet", cursor: "not a cursor" },
    { label: "incomplete body", cursor: "eyJvZmZzZXQiOi0xfQ" }, { label: "oversized", cursor: "a".repeat(2048) },
  ])("rejects malformed cursor $label", ({ cursor }) => {
    expectError(populatedReport(), { section: "candidates", cursor }, "INDEX_HEALTH_CURSOR_INVALID");
  });

  it("rejects a continuation reused for another section or a changed full report", () => {
    const original = populatedReport();
    const cursor = projectIndexHealth(original, { section: "candidates", limit: 1 }).page!.nextCursor!;
    expectError(original, { section: "evaluations", cursor }, "INDEX_HEALTH_CURSOR_INVALID");
    expectError({ ...original, capturedAt: "2026-10-09T00:00:00.000Z" }, { section: "candidates", cursor }, "INDEX_HEALTH_CURSOR_STALE");
    const changedDetails = { ...original, capabilities: original.capabilities.slice(1) };
    expectError(changedDetails, { section: "candidates", cursor }, "INDEX_HEALTH_CURSOR_STALE");
  });

  it("rejects a cursor whose offset is outside the requested section", () => {
    const original = populatedReport();
    const cursor = projectIndexHealth(original, { section: "candidates", limit: 1 }).page!.nextCursor!;
    const body = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    for (const offset of [-1, 0, 3, 100, 1.5]) {
      const invalid = Buffer.from(canonicalJson({ ...body, offset })).toString("base64url");
      expectError(original, { section: "candidates", cursor: invalid }, "INDEX_HEALTH_CURSOR_INVALID");
    }
  });

  it("rejects an oversized summary without returning unbounded input data in the error", () => {
    const original = report();
    original.capturedAt = "large".repeat(INDEX_HEALTH_VIEW_MAX_BYTES);
    expectError(original, {}, "INDEX_HEALTH_RESPONSE_TOO_LARGE");
  });

  it("rejects malformed cursor fields and noncanonical encodings with a bounded error", () => {
    const original = populatedReport();
    const cursor = projectIndexHealth(original, { section: "candidates", limit: 1 }).page!.nextCursor!;
    const body = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    for (const change of [{ schemaVersion: 2 }, { reportDigest: "wrong" }, { extra: true }, { offset: "1" }]) {
      const invalid = Buffer.from(canonicalJson({ ...body, ...change })).toString("base64url");
      expectError(original, { section: "candidates", cursor: invalid }, "INDEX_HEALTH_CURSOR_INVALID");
    }
    for (const invalid of [`${cursor}=`, Buffer.from(JSON.stringify(body, null, 2)).toString("base64url")]) {
      expectError(original, { section: "candidates", cursor: invalid }, "INDEX_HEALTH_CURSOR_INVALID");
    }
  });

  it("deduplicates closed reason vocabularies without removing any reason or primary reason", () => {
    const original = populatedReport();
    original.reasonSummary = Array(100_000).fill("LANGUAGE_UNSUPPORTED") as IndexHealthReportV1["reasonSummary"];
    original.evaluations.reasonSummary = ["CAPABILITY_MISSING", "CAPABILITY_MISSING"];
    original.freshness.reasons = ["WORKING_TREE_DIRTY", "WORKING_TREE_DIRTY"];
    const view = projectIndexHealth(original);
    expect(view.reasonSummary).toEqual(["LANGUAGE_UNSUPPORTED"]);
    expect(view.evaluations.reasonSummary).toEqual(["CAPABILITY_MISSING"]);
    expect(view.evaluations.primaryReason).toBe("CAPABILITY_MISSING");
    expect(view.freshness.reasons).toEqual(["WORKING_TREE_DIRTY"]);
  });

  it("uses escaped UTF-8 bytes to stop a page before the hard bound and reassembles every item", () => {
    const original = report();
    const candidate = original.candidates[0]!;
    const text = '🎵"\\\n\u0000'.repeat(5000);
    original.candidates = Array.from({ length: 8 }, (_, i) => ({ ...candidate, candidateIdentity: String(i), path: text }));
    expect(Buffer.byteLength(JSON.stringify(text), "utf8")).toBe(80_002);
    const collected: unknown[] = [];
    const pageCounts: number[] = [];
    let cursor: string | undefined;
    do {
      const view = projectIndexHealth(original, { section: "candidates", limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      const page = view.page!;
      expect(Buffer.byteLength(canonicalJson(view), "utf8")).toBeLessThanOrEqual(INDEX_HEALTH_VIEW_MAX_BYTES);
      pageCounts.push(page.returned);
      collected.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(pageCounts).toEqual([3, 3, 2]);
    expect(collected).toEqual(original.candidates);
  });

  it("rejects one indivisible oversized item without truncation and keeps the summary available", () => {
    const original = report();
    original.candidates[0]!.path = "x".repeat(INDEX_HEALTH_VIEW_MAX_BYTES);
    expect(projectIndexHealth(original).details.candidates).toBe(1);
    expectError(original, { section: "candidates" }, "INDEX_HEALTH_RESPONSE_TOO_LARGE");
  });

  it("returns a continuation before an oversized subsequent item instead of silently dropping it", () => {
    const original = report();
    const candidate = original.candidates[0]!;
    original.candidates = [candidate, { ...candidate, path: "x".repeat(INDEX_HEALTH_VIEW_MAX_BYTES) }];
    const view = projectIndexHealth(original, { section: "candidates", limit: 100 });
    expect(view.page?.items).toEqual([candidate]);
    expect(view.page?.total).toBe(2);
    expect(view.page?.nextCursor).toBeString();
    expectError(original, { section: "candidates", cursor: view.page!.nextCursor! }, "INDEX_HEALTH_RESPONSE_TOO_LARGE");
  });

  it("accepts a detail response exactly at the byte limit and rejects one byte above it", () => {
    const original = report();
    original.candidates[0]!.path = "";
    const empty = projectIndexHealth(original, { section: "candidates" });
    const available = INDEX_HEALTH_VIEW_MAX_BYTES - Buffer.byteLength(canonicalJson(empty), "utf8");
    original.candidates[0]!.path = "x".repeat(available);
    expect(Buffer.byteLength(canonicalJson(projectIndexHealth(original, { section: "candidates" })), "utf8"))
      .toBe(INDEX_HEALTH_VIEW_MAX_BYTES);
    original.candidates[0]!.path += "x";
    expectError(original, { section: "candidates" }, "INDEX_HEALTH_RESPONSE_TOO_LARGE");
  });

  it("enforces the final response bound when an empty page adds metadata to a large summary", () => {
    const original = report();
    original.capturedAt = "";
    const available = INDEX_HEALTH_VIEW_MAX_BYTES - Buffer.byteLength(canonicalJson(projectIndexHealth(original)), "utf8");
    original.capturedAt = "x".repeat(available);
    expect(Buffer.byteLength(canonicalJson(projectIndexHealth(original)), "utf8")).toBe(INDEX_HEALTH_VIEW_MAX_BYTES);
    expectError(original, { section: "workspace_nodes" }, "INDEX_HEALTH_RESPONSE_TOO_LARGE");
  });
});
