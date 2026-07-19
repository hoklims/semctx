import { describe, it, expect } from "bun:test";
import {
  analyzeAndBuildClaims,
  prepareContextPack,
  parseTaskDocument,
  defaultTaskExtractor,
  extractionContext,
} from "@semantic-context/context-engine";
import type { ContextPack } from "@semantic-context/core";
import { sampleConfig, sampleTaskMarkdown, EXPECTED } from "@semantic-context/test-fixtures";

const { analysis, claims } = analyzeAndBuildClaims(sampleConfig());
const NOW = "2026-01-01T00:00:00.000Z";
const taskFrame = defaultTaskExtractor.extract(parseTaskDocument(sampleTaskMarkdown()), extractionContext(analysis.graph, NOW));

function build(): ContextPack {
  return prepareContextPack({ graph: analysis.graph, evidence: analysis.evidence, claims, taskFrame, now: NOW, candidateProviders: [] });
}

const pack = build();
const readPaths = pack.recommendedReads.map((r) => r.path);

describe("ContextPack — meets the objective", () => {
  it("1. surfaces the capability contract (confirmation code)", () => {
    expect(readPaths).toContain("src/domain/confirmation.ts");
    expect(readPaths).toContain("src/app/confirm-reservation-handler.ts");
  });

  it("2. identifies the confirmation call path", () => {
    const hasPath = pack.impactPaths.some(
      (p) =>
        p.description.includes("handleConfirmReservation") &&
        p.description.includes("confirmReservation") &&
        p.description.includes("remainingCapacity"),
    );
    expect(hasPath).toBe(true);
  });

  it("3. surfaces the relevant migration", () => {
    expect(readPaths).toContain(EXPECTED.migration);
  });

  it("4. surfaces the relevant tests", () => {
    const testPaths = pack.relevantTests.map((t) => t.filePath);
    expect(testPaths).toContain("test/confirmation.test.ts");
    expect(testPaths).toContain("test/capacity.test.ts");
  });

  it("5. carries the invariant as a hard constraint (tested)", () => {
    expect(pack.hardConstraints.length).toBeGreaterThan(0);
    const inv = pack.hardConstraints[0];
    expect(inv?.kind).toBe("invariant");
    expect(inv?.verificationStatus).toBe("tested");
  });

  it("6. every recommendation has a reason AND provenance", () => {
    for (const read of pack.recommendedReads) {
      expect(read.reason.length).toBeGreaterThan(0);
      expect(read.evidenceIds.length).toBeGreaterThan(0);
    }
  });

  it("7. is fully deterministic and LLM/CocoIndex-free", () => {
    expect(pack.meta.deterministic).toBe(true);
    expect(pack.meta.candidateProviders).toEqual([]);
    const strip = (p: ContextPack): string => JSON.stringify({ ...p, generatedAt: "" });
    expect(strip(build())).toBe(strip(pack));
  });
});

describe("NON-REGRESSION — deprecated lexical neighbour is never authoritative", () => {
  it("no authoritative claim is deprecated or contradicted", () => {
    for (const claim of [...pack.authoritativeClaims, ...pack.hardConstraints]) {
      expect(claim.verificationStatus).not.toBe("deprecated");
      expect(claim.verificationStatus).not.toBe("contradicted");
    }
  });

  it("the deprecated legacy doc is NOT a recommended read", () => {
    expect(readPaths).not.toContain(EXPECTED.deprecatedDoc);
  });

  it("the deprecated legacy doc IS surfaced as a (non-normative) contradiction", () => {
    expect(pack.contradictions.length).toBeGreaterThanOrEqual(1);
    const mentionsLegacy = pack.contradictions.some((c) => c.statement.toLowerCase().includes("legacy"));
    expect(mentionsLegacy).toBe(true);
  });

  it("the lexical decoy (notification templates) is not a primary node or recommended read", () => {
    expect(readPaths).not.toContain(EXPECTED.decoyModule);
    const primaryPaths = pack.primaryNodes.map((n) => n.filePath);
    expect(primaryPaths).not.toContain(EXPECTED.decoyModule);
  });
});

describe("semantic-provider candidates (optional, ADR 0004)", () => {
  it("folds a candidate into secondary + records the provider, never authoritative", () => {
    const withCandidate = prepareContextPack({
      graph: analysis.graph,
      evidence: analysis.evidence,
      claims,
      taskFrame,
      now: NOW,
      providerCandidates: [{ filePath: EXPECTED.decoyModule, score: 0.9, provider: "cocoindex" }],
    });
    expect(withCandidate.meta.candidateProviders).toContain("cocoindex");
    // The provider surfaced the decoy -> it appears in secondary consideration...
    expect(withCandidate.secondaryNodes.map((n) => n.filePath)).toContain(EXPECTED.decoyModule);
    // ...but a candidate NEVER becomes an authoritative read or a hard constraint.
    expect(withCandidate.recommendedReads.map((r) => r.path)).not.toContain(EXPECTED.decoyModule);
    for (const claim of withCandidate.authoritativeClaims) expect(claim.verificationStatus).not.toBe("deprecated");
  });
});

/** Non-booking task frames: assert verification-plan policy without domain-coupled wording. */
function packForTask(rawTask: string): ContextPack {
  const frame = defaultTaskExtractor.extract(parseTaskDocument(rawTask), extractionContext(analysis.graph, NOW));
  return prepareContextPack({
    graph: analysis.graph,
    evidence: analysis.evidence,
    claims,
    taskFrame: frame,
    now: NOW,
    candidateProviders: [],
  });
}

function reproduceSteps(p: ContextPack) {
  return p.verificationPlan.steps.filter((s) => s.kind === "reproduce");
}

function isConcurrentReproduce(description: string): boolean {
  return /concurrent execution/i.test(description);
}

function isObservedExpectedReproduce(description: string): boolean {
  return /observed behaviour/i.test(description) && /expected behaviour/i.test(description);
}

describe("verification plan — mode vs concurrency risk (non-booking)", () => {
  it("detects bugfix mode from generic keywords (no domain-specific terms)", () => {
    const frame = defaultTaskExtractor.extract(
      parseTaskDocument("Fix the null pointer when applying a payment refund"),
      extractionContext(analysis.graph, NOW),
    );
    expect(frame.mode).toBe("bugfix");
    expect(frame.riskSurfaces).toEqual([]);
  });

  it("bugfix without concurrency risk gets observed-vs-expected reproduce, not concurrent", () => {
    const p = packForTask(
      [
        "Fix the null pointer when applying a payment refund",
        "",
        "mode: bugfix",
        "capability: reservation-confirmation",
        "Observed: refund throws when the payment id is missing",
        "Expected: refund returns a not-found error without throwing",
      ].join("\n"),
    );
    expect(p.taskFrame.mode).toBe("bugfix");
    expect(p.unknowns.some((u) => /concurrency race/i.test(u))).toBe(false);

    const repro = reproduceSteps(p);
    expect(repro.length).toBe(1);
    expect(isObservedExpectedReproduce(repro[0]!.description)).toBe(true);
    expect(isConcurrentReproduce(repro[0]!.description)).toBe(false);
    // Generic wording — no leftover booking-domain phrases in the plan.
    for (const step of p.verificationPlan.steps) {
      expect(step.description.toLowerCase()).not.toMatch(/overbook|confirmation path|confirmations/);
    }
  });

  it("explicit concurrency risk alone yields concurrent reproduce (and matching unknown)", () => {
    const p = packForTask(
      [
        "Harden payment application against double-apply",
        "",
        "mode: feature",
        "capability: reservation-confirmation",
        "Risk: race on concurrent payment retries without a lock",
      ].join("\n"),
    );
    expect(p.taskFrame.mode).toBe("feature");
    expect(p.taskFrame.riskSurfaces.some((r) => /race|concurr|lock|atomic/i.test(r))).toBe(true);
    expect(p.unknowns.some((u) => /concurrency race/i.test(u))).toBe(true);

    const repro = reproduceSteps(p);
    expect(repro.length).toBe(1);
    expect(isConcurrentReproduce(repro[0]!.description)).toBe(true);
    expect(isObservedExpectedReproduce(repro[0]!.description)).toBe(false);
    expect(repro[0]!.targetNodeIds.length).toBeGreaterThan(0);
  });

  it("bugfix + explicit concurrency risk yields both reproduce steps", () => {
    const p = packForTask(
      [
        "Fix double-apply under concurrent retries",
        "",
        "mode: bugfix",
        "capability: reservation-confirmation",
        "Observed: two concurrent retries both charge the card",
        "Expected: at most one charge is applied",
        "Risk: race on concurrent retries without an atomic guard",
      ].join("\n"),
    );
    expect(p.taskFrame.mode).toBe("bugfix");

    const repro = reproduceSteps(p);
    expect(repro.length).toBe(2);
    expect(repro.some((s) => isObservedExpectedReproduce(s.description))).toBe(true);
    expect(repro.some((s) => isConcurrentReproduce(s.description))).toBe(true);
    expect(p.unknowns.some((u) => /concurrency race/i.test(u))).toBe(true);
  });

  it("feature without concurrency risk does not emit a reproduce step", () => {
    const p = packForTask(
      [
        "Add support for multi-currency refunds",
        "",
        "mode: feature",
        "capability: reservation-confirmation",
      ].join("\n"),
    );
    expect(p.taskFrame.mode).toBe("feature");
    expect(reproduceSteps(p)).toEqual([]);
    expect(p.unknowns.some((u) => /concurrency race/i.test(u))).toBe(false);
  });
});
