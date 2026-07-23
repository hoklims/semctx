import { describe, it, expect } from "bun:test";
import {
  GraphIndex,
  classifyQuestion,
  policyFor,
  evaluateClaim,
  detectContradictions,
  parseTaskDocument,
  defaultTaskExtractor,
  extractionContext,
  fetchCandidatesFromProvider,
  validateProviderCandidate,
  type PriorityContext,
} from "@semantic-context/context-engine";
import type { SemanticCandidateProvider } from "@semantic-context/cocoindex-adapter";
import { analyzeAndBuildClaims } from "@semantic-context/app-services";
import type { Claim, RepositoryGraph, TaskFrame, VerificationStatus } from "@semantic-context/core";
import { sampleConfig, sampleTaskMarkdown, EXPECTED, must } from "@semantic-context/test-fixtures";

const { analysis, claims } = analyzeAndBuildClaims(sampleConfig());
const index = new GraphIndex(analysis.graph);
const NOW = "2026-01-01T00:00:00.000Z";

function frame(): TaskFrame {
  return defaultTaskExtractor.extract(parseTaskDocument(sampleTaskMarkdown()), extractionContext(analysis.graph, NOW));
}

describe("task frame extractor (heuristic, no LLM)", () => {
  const tf = frame();
  it("detects bugfix mode from the task text", () => {
    expect(tf.mode).toBe("bugfix");
  });
  it("matches known capabilities and the invariant", () => {
    expect(tf.capabilities).toContain("reservation-confirmation");
    expect(tf.hardInvariants).toContain(EXPECTED.invariant);
    expect(tf.boundedContexts).toContain("booking");
  });
  it("produces at least one hypothesis", () => {
    expect(tf.hypotheses.length).toBeGreaterThan(0);
    expect(must(tf.hypotheses[0]).status).toBe("unverified");
  });
  it("is deterministic: same raw task -> same id", () => {
    expect(frame().id).toBe(tf.id);
  });
});

describe("claim building", () => {
  it("derives a tested invariant claim", () => {
    const inv = must(claims.find((c) => c.kind === "invariant"));
    expect(inv.verificationStatus).toBe("tested");
    expect(inv.authority).toBeGreaterThan(0.8);
  });
  it("marks exported interfaces/types as statically-verified contracts", () => {
    const contracts = claims.filter((c) => c.kind === "contract" && c.verificationStatus === "statically_verified");
    expect(contracts.length).toBeGreaterThan(0);
  });
  it("emits a deprecation claim for the legacy doc", () => {
    const dep = claims.find((c) => c.kind === "deprecation" && c.verificationStatus === "deprecated");
    expect(dep).toBeDefined();
  });
  it("emits a contradicted assumption for the legacy-vs-current contradiction", () => {
    const contra = claims.find((c) => c.verificationStatus === "contradicted");
    expect(contra).toBeDefined();
  });
});

describe("authority policies", () => {
  it("classifies the overbooking bugfix as a business_rule question", () => {
    expect(classifyQuestion(frame())).toBe("business_rule");
  });
  it("requires strong verification for security questions (gate, not bonus)", () => {
    expect(policyFor("security").requiredVerificationStatuses).toBeDefined();
    expect(policyFor("business_rule").requiredVerificationStatuses).toBeUndefined();
  });
});

function contextFor(taskFrame: TaskFrame): PriorityContext {
  const { contradictedClaimIds } = detectContradictions(claims);
  return {
    index,
    taskFrame,
    policy: policyFor(classifyQuestion(taskFrame)),
    entrypoints: new Set<string>(),
    reachable: new Map<string, number>(),
    contradictedClaimIds,
  };
}

describe("priority gates", () => {
  const tf = frame();
  const ctx = contextFor(tf);

  it("keeps a tested invariant claim eligible", () => {
    const inv = must(claims.find((c) => c.kind === "invariant"));
    const explanation = evaluateClaim(inv, ctx);
    expect(explanation.eligible).toBe(true);
    expect(explanation.score).toBeGreaterThan(0);
  });

  it("eliminates deprecated/contradicted claims by gate (not by low score)", () => {
    const dep = must(claims.find((c) => c.verificationStatus === "deprecated"));
    const explanation = evaluateClaim(dep, ctx);
    expect(explanation.eligible).toBe(false);
    expect(explanation.gates.find((g) => g.name === "status-allowed")?.passed).toBe(false);
  });

  it("eliminates a claim outside the selected bounded context", () => {
    const graph: RepositoryGraph = {
      nodes: [{ id: "sym:function:notif.ts:sendEmail:1", kind: "function", name: "sendEmail", boundedContext: "notifications", evidence: [], tags: [], metadata: {} }],
      edges: [],
    };
    const localIndex = new GraphIndex(graph);
    const outsideClaim: Claim = {
      id: "claim:capability:notify-1",
      kind: "capability",
      statement: "sends notifications",
      subjectNodeIds: ["sym:function:notif.ts:sendEmail:1"],
      evidenceIds: [],
      authority: 0.6,
      freshness: 0.7,
      confidence: 0.6,
      verificationStatus: "documented",
      tags: [],
    };
    const bookingTask = { ...tf, boundedContexts: ["booking"] };
    const explanation = evaluateClaim(outsideClaim, {
      index: localIndex,
      taskFrame: bookingTask,
      policy: policyFor("business_rule"),
      entrypoints: new Set<string>(),
      reachable: new Map<string, number>(),
      contradictedClaimIds: new Set<string>(),
    });
    expect(explanation.eligible).toBe(false);
    expect(explanation.gates.find((g) => g.name === "within-bounded-context")?.passed).toBe(false);
  });
});

describe("contradiction detection", () => {
  it("collects deprecated and contradicted claims as non-normative", () => {
    const report = detectContradictions(claims);
    expect(report.contradictions.length).toBeGreaterThanOrEqual(2);
    for (const c of report.contradictions) {
      expect(["deprecated", "contradicted"]).toContain(c.verificationStatus);
    }
  });
});

describe("verification-sufficient gate (ADR 0003)", () => {
  // public_api requires one of [statically_verified, tested, runtime_verified]. A merely
  // documented claim must NOT gain authority just by lexical resemblance — the gate runs
  // before scoring, so it is eliminated regardless of how high its other components are.
  const policy = policyFor("public_api");
  const baseCtx: PriorityContext = {
    index: new GraphIndex({ nodes: [], edges: [] }),
    taskFrame: frame(),
    policy,
    entrypoints: new Set<string>(),
    reachable: new Map<string, number>(),
    contradictedClaimIds: new Set<string>(),
  };

  const claimWith = (status: VerificationStatus): Claim => ({
    id: `claim:contract:public-${status}`,
    kind: "contract",
    statement: "A public, exported contract.",
    // Not present in the empty index → not code-anchored, so only the verification gate can fail.
    subjectNodeIds: ["sym:interface:x.ts:Foo:1"],
    evidenceIds: [],
    authority: 0.9,
    freshness: 0.9,
    confidence: 0.9,
    verificationStatus: status,
    tags: ["contract"],
  });

  it("bars a merely-documented claim from authority even with high authority/freshness", () => {
    const e = evaluateClaim(claimWith("documented"), baseCtx);
    const gate = must(e.gates.find((g) => g.name === "verification-sufficient"));
    expect(gate.passed).toBe(false);
    expect(e.eligible).toBe(false);
    expect(e.score).toBe(0);
  });

  it("admits a statically_verified claim through the same gate", () => {
    const e = evaluateClaim(claimWith("statically_verified"), baseCtx);
    const gate = must(e.gates.find((g) => g.name === "verification-sufficient"));
    expect(gate.passed).toBe(true);
    expect(e.eligible).toBe(true);
  });
});

describe("atomic provider attestation", () => {
  const sourceSeal = `sha256:${"a".repeat(64)}`;
  const input = { query: "find payment code", repositoryRoot: "C:/repo", limit: 5 };
  const raw = [{ filePath: "src/payment.ts", score: 0.9, provider: "attested" }];

  it("seals only candidates returned in one matching attested envelope", async () => {
    const provider: SemanticCandidateProvider = {
      name: "attested",
      version: async () => "attested@1",
      isAvailable: async () => true,
      search: async () => raw,
      attestedSearch: async () => ({
        candidates: raw,
        providerVersion: "attested@1",
        sourceRepositorySealHash: sourceSeal,
      }),
    };
    const [candidate] = await fetchCandidatesFromProvider(
      provider,
      input,
      { sourceRepositorySealHash: sourceSeal, capturedAt: NOW },
    );

    expect(candidate?.seal).toBeDefined();
    expect(validateProviderCandidate(candidate!, {
      expectedSourceRepositorySealHash: sourceSeal,
      expectedInput: input,
    })).toEqual({ accepted: true });
  });

  it("keeps legacy or source-mismatched provider results unsealed", async () => {
    const legacy: SemanticCandidateProvider = {
      name: "attested",
      version: async () => "attested@1",
      isAvailable: async () => true,
      search: async () => raw,
    };
    expect((await fetchCandidatesFromProvider(legacy, input, {
      sourceRepositorySealHash: sourceSeal,
      capturedAt: NOW,
    }))[0]?.seal).toBeUndefined();

    const mismatched: SemanticCandidateProvider = {
      ...legacy,
      attestedSearch: async () => ({
        candidates: raw,
        providerVersion: "attested@1",
        sourceRepositorySealHash: `sha256:${"b".repeat(64)}`,
      }),
    };
    expect((await fetchCandidatesFromProvider(mismatched, input, {
      sourceRepositorySealHash: sourceSeal,
      capturedAt: NOW,
    }))[0]?.seal).toBeUndefined();
  });
});
