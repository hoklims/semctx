import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectJavaScriptSource } from "../src/javascript-diagnostics";

test("declared semver third-party dependency retains its external boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-external-snapshot-"));
  try {
    const path = join(root, "test.mjs"); const content = "import { test } from 'vitest';";
    const snapshot = new Map([[path, content], [join(root, "package.json"), JSON.stringify({ devDependencies: { vitest: "4.0.0" } })]]);
    const inspected = inspectJavaScriptSource(path, content, root, snapshot);
    expect(inspected.staticModuleLinks).toContainEqual({ specifier: "vitest", resolution: "external" });
    expect(inspected.reasons).not.toContain("JAVASCRIPT_IMPORT_UNRESOLVED:vitest");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
