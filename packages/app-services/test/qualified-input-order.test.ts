import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { captureQualifiedAnalysisInputs } from "../src/freshness";
test("qualified retained traversal orders source bytes independently of filesystem enumeration", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "semctx-input-order-"));
  expect(Bun.spawnSync(["git", "init", "-q"], { cwd: root }).exitCode).toBe(0);
  fs.writeFileSync(join(root, "a.ts"), "export {}; "); fs.writeFileSync(join(root, "z.ts"), "export {}; ");
  const original = fs.readdirSync;
  const enumeration = spyOn(fs, "readdirSync").mockImplementation(((...args: Parameters<typeof fs.readdirSync>) => {
    const result = original(...args);
    return [...result].reverse();
  }) as typeof fs.readdirSync);
  try { expect(captureQualifiedAnalysisInputs(createGlobSelectionConfig(root)).files.map(file => file.path)).toEqual(["a.ts", "z.ts"]); }
  finally { enumeration.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
});
