import { describe, expect, it } from "bun:test";
import { analyzeRepository } from "@semantic-context/ts-analyzer";
import { sampleConfig } from "@semantic-context/test-fixtures";

const internal = await import("../../plane-a-internal/src/index").catch(() => null);

describe("TypeScript Plane A internal sidecar", () => {
  it("fails closed when a captured binding coordinate changes", () => {
    expect(internal).not.toBeNull();
    if (internal === null) return;
    expect(() => internal.assertStableCapture(
      { sourceDigest: "sha256:before", producerVersion: "0.1.0" },
      { sourceDigest: "sha256:after", producerVersion: "0.1.0" },
    )).toThrow(expect.objectContaining({
      code: "CAPTURE_CHANGED_DURING_ANALYSIS",
      coordinate: "sourceDigest",
    }));
  });

  it("captures versioned source, producer, configuration, and schema bindings off the public result", () => {
    expect(internal).not.toBeNull();
    if (internal === null) return;

    const analysis = analyzeRepository(sampleConfig());
    const sidecar = internal.getPlaneASidecar(analysis);

    expect(Object.keys(analysis).sort()).toEqual(["evidence", "graph"]);
    expect(sidecar?.schemaVersion).toBe(1);
    expect(sidecar?.producerResults).toHaveLength(sidecar?.factBatches.length ?? 0);
    expect(sidecar?.producerResults).toEqual(
      sidecar?.factBatches.map((batch) => expect.objectContaining({
        producer: {
          identity: "@semantic-context/ts-analyzer",
          version: "0.1.0",
        },
        status: "completed",
        scope: batch.scope,
        factBatchId: batch.batchId,
      })) ?? [],
    );
    expect(sidecar?.producerConfigurationDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sidecar?.factSchemaDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sidecar?.sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sidecar?.scope.selectedPaths).toEqual(
      [...(sidecar?.scope.selectedPaths ?? [])].sort(),
    );
  });
});
