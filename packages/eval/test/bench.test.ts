import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeAndBuildClaims } from "@semantic-context/context-engine";
import { runBench } from "@semantic-context/eval";
import type { BenchCase } from "@semantic-context/eval";
import { sampleConfig, SAMPLE_REPO, must } from "@semantic-context/test-fixtures";

const { analysis, claims } = analyzeAndBuildClaims(sampleConfig());
const suite = JSON.parse(readFileSync(join(SAMPLE_REPO, "semctx-bench.json"), "utf8")) as { cases: BenchCase[] };

describe("benchmark harness", () => {
  it("passes the fixture golden suite with a perfect score", () => {
    const report = runBench({ graph: analysis.graph, evidence: analysis.evidence, claims, cases: suite.cases });
    expect(report.passed).toBe(true);
    expect(report.score).toBe(1);
    for (const caseResult of report.cases) {
      expect(caseResult.passed).toBe(true);
      for (const metric of caseResult.metrics) expect(metric.score).toBe(1);
    }
  });

  it("measures a real regression: an impossible expectation fails the gate", () => {
    const report = runBench({
      graph: analysis.graph,
      evidence: analysis.evidence,
      claims,
      cases: [
        {
          id: "impossible",
          task: "Fix the overbooking on confirmation.",
          expect: { requiredReads: ["src/does-not-exist.ts"], forbiddenReads: ["src/domain/confirmation.ts"] },
        },
      ],
    });
    expect(report.passed).toBe(false);
    const first = must(report.cases[0]);
    expect(first.passed).toBe(false);
    expect(must(first.metrics.find((m) => m.name === "required-reads")).score).toBe(0);
    expect(must(first.metrics.find((m) => m.name === "forbidden-reads")).score).toBe(0);
  });

  it("is deterministic across runs (the determinism metric holds)", () => {
    const report = runBench({ graph: analysis.graph, evidence: analysis.evidence, claims, cases: suite.cases });
    for (const caseResult of report.cases) {
      const determinism = caseResult.metrics.find((m) => m.name === "determinism");
      expect(determinism?.score).toBe(1);
    }
  });
});
