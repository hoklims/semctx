import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTypeScript, inspectModuleConfiguration } from "../src";
import { retainedCompilerSystem } from "../src/ts-symbols";

for (const alias of [false, true]) test(`retained nonexistent sources resolve through ${alias ? "directory alias" : "real directory"}`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-directory-origin-"));
  const link = `${root}-alias`;
  try {
    if (alias) symlinkSync(root, link, process.platform === "win32" ? "junction" : "dir");
    const directory = alias ? link : root;
    const leaf = join(directory, "leaf.ts"); const caller = join(directory, "caller.ts");
    const inputs = new Map([[leaf, "export default function namedFn() { return 1; } export class Base {}"], [caller, "import value, { Base } from './leaf'; export class Derived extends Base {} export function main() { return value(); }"]]);
    expect(retainedCompilerSystem(inputs).directoryExists?.(directory)).toBe(true);
    expect(extractTypeScript([leaf, caller], directory, inputs).calls).toContainEqual(expect.objectContaining({ calleeRelPath: "leaf.ts", calleeSymbolPath: "namedFn" }));
    expect(inspectModuleConfiguration(caller, directory, inputs)).toContain("SOURCE_INTERNAL_HERITAGE_UNSUPPORTED");
  } finally {
    if (alias) rmSync(link);
    rmSync(root, { recursive: true, force: true });
  }
});
