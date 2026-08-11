import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig } from "@semantic-context/core";
import {
  analyzeRepository,
  TYPESCRIPT_DIALECT_VERSION,
} from "@semantic-context/ts-analyzer";
import { sampleConfig } from "@semantic-context/test-fixtures";
import ts from "typescript";

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

    expect(Object.keys(analysis).sort()).toEqual(["evidence", "graph", "unresolvedReferences"]);
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
    expect(TYPESCRIPT_DIALECT_VERSION).toBe(ts.version);
    expect(sidecar?.factBatches
      .filter((batch) => batch.scope.language === "typescript")
      .every((batch) => batch.scope.dialectVersion === ts.version)).toBe(true);
  });

  it("keeps source bindings stable across LF and CRLF checkout materialization", () => {
    expect(internal).not.toBeNull();
    if (internal === null) return;

    const root = mkdtempSync(join(tmpdir(), "semctx-plane-a-eol-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      const path = join(root, "src", "value.ts");
      const lf = "export const value = 1;\nexport const next = value + 1;\n";
      writeFileSync(path, lf, "utf8");
      const config = createDefaultConfig(root);
      const lfAnalysis = analyzeRepository(config);
      const lfSidecar = internal.getPlaneASidecar(lfAnalysis);

      writeFileSync(path, lf.replaceAll("\n", "\r\n"), "utf8");
      const crlfAnalysis = analyzeRepository(config);
      const crlfSidecar = internal.getPlaneASidecar(crlfAnalysis);

      expect(crlfAnalysis.graph).toEqual(lfAnalysis.graph);
      expect(crlfAnalysis.evidence).toEqual(lfAnalysis.evidence);
      expect(crlfSidecar).toEqual(lfSidecar);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
