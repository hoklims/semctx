import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inspectReconciliationAuthorityClosure } from "@semantic-context/test-fixtures";

describe("reconciliation runtime authority graph", () => {
  it("resolves recursively through real workspace exports and reaches no authority or writer module", () => {
    const root = resolve(import.meta.dir, "..", "..", "..");
    const entry = resolve(root, "packages", "app-services", "src", "reconciliation-index.ts");
    const closure = inspectReconciliationAuthorityClosure(root, entry);
    expect(closure.violations).toEqual([]);

    const entrySource = readFileSync(entry, "utf8");
    expect(entrySource).toContain("@semantic-context/control-engine/planning");
    expect(entrySource).toContain("@semantic-context/control-engine/reconciliation");
    expect(entrySource).toContain("@semantic-context/control-model/reconciliation");
    expect(entrySource).toContain("@semantic-context/semantic-engine/reconciliation-read");
    expect(entrySource).not.toContain('from "@semantic-context/control-engine"');
    expect(entrySource).not.toContain('from "@semantic-context/semantic-engine"');
  });
});
