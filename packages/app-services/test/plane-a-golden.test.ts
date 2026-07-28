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
  it("keeps graph, evidence, claims, and verification bytes stable", () => {
    expect(sha256(portableRepositoryFacts())).toBe(
      "9d5175da1f04185594b72f8bef99543bf964dcb48313992b16bc156a1c7ab9a9",
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
