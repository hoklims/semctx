import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generatedAnalyzerIdentity } from "./analyzer-identity";

test("built analyzer identity binds exact implementation and compiler bytes", () => {
  const root = resolve(import.meta.dir, "..");
  expect(readFileSync(resolve(root, "packages/app-services/src/analyzer-identity.generated.ts"), "utf8")).toBe(generatedAnalyzerIdentity(root));
});
