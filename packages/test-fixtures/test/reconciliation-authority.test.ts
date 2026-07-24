import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findForbiddenReconciliationAuthorityExposures,
  inspectReconciliationAuthorityClosure,
} from "../src/reconciliation-authority";

describe("reconciliation authority test rail", () => {
  for (const [family, source, expected] of [
    ["authorize-star", "export function authorizeTransition() {}", "authorizeTransition"],
    ["authorization-star", "export const authorizationQuery = {};", "authorizationQuery"],
    ["Authorization-star", "export class AuthorizationDecision {}", "AuthorizationDecision"],
    ["ALLOW-token", "export const decision = \"ALLOW\";", "ALLOW"],
  ] as const) {
    it(`rejects ${family} source exposure`, () => {
      expect(
        findForbiddenReconciliationAuthorityExposures("safe-module.ts", source),
      ).toContainEqual({
        kind: "source_symbol",
        path: "safe-module.ts",
        match: expected,
      });
    });
  }

  for (const path of [
    "packages/control-engine/src/authorize-transition.ts",
    "packages/control-engine/src/authorization-query.ts",
  ]) {
    it(`rejects forbidden module path ${path}`, () => {
      expect(
        findForbiddenReconciliationAuthorityExposures(path, "export const safe = true;"),
      ).toContainEqual({
        kind: "module_path",
        path,
        match: expect.any(String),
      });
    });
  }

  it("ignores forbidden words that exist only in comments", () => {
    expect(findForbiddenReconciliationAuthorityExposures(
      "safe-module.ts",
      "// authorizeTransition AuthorizationDecision ALLOW\nexport const safe = true;",
    )).toEqual([]);
  });

  it("follows runtime imports and exports without traversing type-only declarations", () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-authority-rail-"));
    const entry = join(root, "entry.ts");
    const runtime = join(root, "runtime.ts");
    writeFileSync(
      entry,
      [
        "import type { SafeImportType } from \"./type-import\";",
        "export {",
        "  safeRuntime,",
        "} from \"./runtime\";",
        "export type {",
        "  SafeExportType,",
        "} from \"./type-export\";",
      ].join("\n"),
    );
    writeFileSync(runtime, "export const safeRuntime = true;\n");
    writeFileSync(
      join(root, "type-import.ts"),
      "export type SafeImportType = typeof authorizeTransition;\n",
    );
    writeFileSync(
      join(root, "type-export.ts"),
      "export type SafeExportType = AuthorizationDecision;\n",
    );

    try {
      const closure = inspectReconciliationAuthorityClosure(root, entry);
      expect(closure.visitedPaths).toEqual([entry, runtime].sort());
      expect(closure.violations).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
