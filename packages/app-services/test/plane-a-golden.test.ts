import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { GraphIndex, analyzeDiff, buildVerifyReport } from "@semantic-context/context-engine";
import { discoverFiles } from "@semantic-context/ts-analyzer";
import { SAMPLE_REPO, sampleConfig } from "@semantic-context/test-fixtures";
import { analyzeAndBuildClaims, fingerprintAnalysisInputs } from "@semantic-context/app-services";

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function portableRepositoryFacts(): unknown {
  const config = sampleConfig();
  const { analysis, claims } = analyzeAndBuildClaims(config);
  const graph = structuredClone(analysis.graph);
  for (const node of graph.nodes) {
    if (node.kind === "repository" && node.metadata["root"] === SAMPLE_REPO) {
      node.metadata["root"] = "<REPOSITORY_ROOT>";
    }
  }
  const result = analyzeDiff({
    index: new GraphIndex(graph),
    claims,
    config,
    diffText: [
      "diff --git a/src/booking/confirmation.ts b/src/booking/confirmation.ts",
      "--- a/src/booking/confirmation.ts",
      "+++ b/src/booking/confirmation.ts",
      "@@ -8,1 +8,1 @@",
      "-export function confirmReservation() {",
      "+export function confirmReservation() {",
      "",
    ].join("\n"),
  });
  const report = buildVerifyReport(
    result,
    { base: "base", head: "head", mergeBase: "merge-base", range: "merge-base..head" },
    config.blockingRules,
  );
  return { graph, evidence: analysis.evidence, claims, result, report };
}

describe("Plane A TypeScript compatibility golden", () => {
  // Re-pinned twice, both times deliberately.
  //
  // First: authored-edge provenance moved out of the open `metadata` bag into a typed
  // `EdgeFact.provenance` field the assembler owns, so the single `contradicts` edge in the
  // sample repository lost its `{ declared: true }` entry.
  //
  // Second (HOK-79): symbol identity dropped the start-line field (`sym:function:path:name:12`
  // -> `sym:function:path:name`) so a harmless insertion above a declaration no longer changes
  // its id, and the sample repository's `confirmed-never-exceeds-capacity` invariant — declared
  // with two different statements in `capacity.ts` and `confirmation.ts` — is now correctly
  // reported as contested: it gains the `statement-divergent` tag and loses `metadata.statement`
  // instead of silently keeping whichever declaration the graph builder saw first.
  //
  // Third (HOK-79 marker authority): that contested invariant's *claim* stopped reading `tested`
  // (0.85 authority) and reads `contradicted` (0.15) instead — `constrained_by` + a passing test
  // proved the symbol was exercised, never which of the two disagreeing statements it proved.
  // Verified as the only delta: node/evidence/result/report shape and every other claim are
  // otherwise unchanged (checked directly against the live claim list before re-pinning).
  it("keeps graph, evidence, claims, and verification bytes stable", () => {
    expect(sha256(portableRepositoryFacts())).toBe(
      "28c4c0ae8f6561c7c73673a0e173245d7bcfe922ac4524ebedba72978708837e",
    );
  });

  it("keeps the legacy analysis-input fingerprint stable", () => {
    const config = { ...sampleConfig(), repositoryRoot: "/portable/repository" };
    const files = discoverFiles(sampleConfig()).map((file) => ({
      ...file,
      absPath: `/portable/repository/${file.relPath}`,
    }));
    expect(fingerprintAnalysisInputs(config, files)).toBe(
      "sha256:f8076e48996fc0435e1053283063a3e40a6c2fbc9033df0f0632fe19132b0c7e",
    );
  });
});
