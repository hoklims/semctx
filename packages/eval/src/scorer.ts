import type { ContextPack } from "@semantic-context/core";
import type { BenchExpectations, BenchMetric, BenchCaseResult } from "./spec";

function fractionPresent(required: readonly string[], actual: readonly string[]): number {
  if (required.length === 0) return 1;
  const set = new Set(actual);
  return required.filter((r) => set.has(r)).length / required.length;
}

function fractionAbsent(forbidden: readonly string[], actual: readonly string[]): number {
  if (forbidden.length === 0) return 1;
  const set = new Set(actual);
  return forbidden.filter((f) => !set.has(f)).length / forbidden.length;
}

function allSubstrings(subs: readonly string[], haystack: string): number {
  if (subs.length === 0) return 1;
  return subs.filter((s) => haystack.includes(s)).length / subs.length;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 1;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Canonical form ignoring the two intentional timestamp fields (determinism check). */
function canonical(pack: ContextPack): string {
  return JSON.stringify({ ...pack, generatedAt: "", taskFrame: { ...pack.taskFrame, createdAt: "" } });
}

/**
 * Score one ContextPack against golden expectations. `packRepeat` is a second build of
 * the same pack (different injected clock) used solely for the determinism metric.
 *
 * A metric only participates when its expectation is declared, so each case asserts only
 * what it specifies. A metric passes when its score is 1 (strict regression gate).
 */
export function scoreCase(
  id: string,
  pack: ContextPack,
  packRepeat: ContextPack,
  expect: BenchExpectations,
): BenchCaseResult {
  const metrics: BenchMetric[] = [];
  const add = (name: string, score: number, detail: string): void => {
    metrics.push({ name, score, passed: score >= 1, detail });
  };

  const readPaths = pack.recommendedReads.map((r) => r.path);
  const testPaths = pack.relevantTests.map((t) => t.filePath ?? t.name);
  const pathText = pack.impactPaths.map((p) => p.description).join(" | ");
  const contradictionText = pack.contradictions.map((c) => c.statement.toLowerCase()).join(" | ");
  const authoritative = [...pack.authoritativeClaims, ...pack.hardConstraints];

  if (expect.requiredReads !== undefined) {
    add("required-reads", fractionPresent(expect.requiredReads, readPaths), expect.requiredReads.join(", "));
  }
  if (expect.forbiddenReads !== undefined) {
    add("forbidden-reads", fractionAbsent(expect.forbiddenReads, readPaths), expect.forbiddenReads.join(", "));
  }
  if (expect.requiredTests !== undefined) {
    add("required-tests", fractionPresent(expect.requiredTests, testPaths), expect.requiredTests.join(", "));
  }
  if (expect.requiredHardConstraintKinds !== undefined) {
    const kinds = pack.hardConstraints.map((c) => c.kind);
    add("hard-constraint-kinds", fractionPresent(expect.requiredHardConstraintKinds, kinds), expect.requiredHardConstraintKinds.join(", "));
  }
  if (expect.requiredImpactPathContains !== undefined) {
    add("impact-path", allSubstrings(expect.requiredImpactPathContains, pathText), expect.requiredImpactPathContains.join(" -> "));
  }
  if (expect.requiredContradictions !== undefined) {
    const subs = expect.requiredContradictions.map((s) => s.toLowerCase());
    add("contradictions", allSubstrings(subs, contradictionText), expect.requiredContradictions.join(", "));
  }
  if (expect.forbiddenAuthoritativeStatuses !== undefined) {
    const forbidden = expect.forbiddenAuthoritativeStatuses;
    const violators = authoritative.filter((c) => forbidden.includes(c.verificationStatus));
    add(
      "authoritative-purity",
      violators.length === 0 ? 1 : 0,
      violators.length === 0 ? "no forbidden status among authoritative claims" : `violators: ${violators.map((c) => c.verificationStatus).join(", ")}`,
    );
  }
  if (expect.mustBeDeterministic !== false) {
    const deterministic = canonical(pack) === canonical(packRepeat);
    add("determinism", deterministic ? 1 : 0, deterministic ? "identical across runs (modulo timestamp)" : "NON-DETERMINISTIC");
  }

  return {
    id,
    score: mean(metrics.map((m) => m.score)),
    passed: metrics.every((m) => m.passed),
    metrics,
  };
}
