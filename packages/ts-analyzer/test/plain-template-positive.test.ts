import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTypeScript, inspectModuleConfiguration } from "../src";

test("retained TS and MJS plain templates retain their actual helper call", () => {
  for (const extension of ["ts", "mjs"]) {
    const root = mkdtempSync(join(tmpdir(), "semctx-tagged-template-"));
    try {
      const path = join(root, `main.${extension}`);
      const content = "export function helper() { return 1; } export function main() { return `value ${helper()}`; }";
      const inputs = new Map([[path, content]]);
      expect(inspectModuleConfiguration(path, root, inputs)).not.toContain("SOURCE_TAGGED_TEMPLATE_UNSUPPORTED");
      expect(extractTypeScript([path], root, inputs).calls).toContainEqual(expect.objectContaining({ callerSymbolPath: "main", calleeSymbolPath: "helper" }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
