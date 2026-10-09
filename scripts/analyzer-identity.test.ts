import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzerIdentity, generatedAnalyzerIdentity } from "./analyzer-identity";

test("built analyzer identity binds exact implementation and compiler bytes", () => {
  const root = resolve(import.meta.dir, "..");
  expect(readFileSync(resolve(root, "packages/app-services/src/analyzer-identity.generated.ts"), "utf8")).toBe(generatedAnalyzerIdentity(root));
});

test("analyzer identity covers the independent Git runtime inventory", () => {
  const root = resolve(import.meta.dir, "..");
  const inventory = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(inventory.exitCode).toBe(0);
  const fixed = new Set(["bun.lock", "tsconfig.json", "tsconfig.base.json", "scripts/analyzer-identity.ts", "scripts/build-plugin-runtime.ts", "scripts/build-cli-package.ts"]);
  const expected = new TextDecoder().decode(inventory.stdout).split("\0").filter((path) =>
    fixed.has(path) || (/^(?:packages\/[^/]+|apps\/cli)\/(?:package\.json|src\/.*\.(?:ts|js|mjs))$/.test(path)
      && path !== "packages/app-services/src/analyzer-identity.generated.ts"));
  expect(analyzerIdentity(root).files.map((file) => file.path)).toEqual(expected.sort());
});
