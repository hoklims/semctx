import { describe, expect, it } from "bun:test";
import { outlineModuleLinks, outlineTopLevel } from "@semantic-context/ts-analyzer";

const SOURCE = [
  'import { a } from "./a";', // 1
  'import "./side-effect";', // 2
  "", // 3
  "/** Keys. */", // 4
  "const KEYS = [a, 1] as const;", // 5
  "", // 6
  "export function f(value: string): boolean {", // 7
  "  return (KEYS as readonly unknown[]).includes(value) && value.length > 0;", // 8
  "}", // 9
  "", // 10
  "export { KEYS as keys };", // 11
  "register(f);", // 12
].join("\n");

describe("outlineTopLevel", () => {
  const outline = outlineTopLevel(SOURCE, "src/x.ts");

  it("records statement ranges with their leading comments", () => {
    expect(outline.statements.map((statement) => [statement.kind, statement.startLine, statement.endLine, statement.leadingStartLine])).toEqual([
      ["import", 1, 1, 1],
      ["import", 2, 2, 2],
      ["variable", 5, 5, 4],
      ["function", 7, 9, 7],
      ["export", 11, 11, 11],
      ["statement", 12, 12, 12],
    ]);
    expect(outline.statements[1]!.sideEffectImport).toBe(true);
    expect(outline.hasSyntaxErrors).toBe(false);
  });

  it("collects referenced bindings, not member names", () => {
    const fn = outline.statements[3]!;
    expect(fn.declaredNames).toEqual(["f"]);
    expect(fn.referencedNames).toContain("KEYS");
    expect(fn.referencedNames).not.toContain("includes");
    expect(fn.referencedNames).not.toContain("length");
    expect(outline.statements[2]!.referencedNames).toContain("a");
  });

  it("reports local names visible to importers, including local export clauses", () => {
    expect(outline.exportedNames).toEqual(["KEYS", "f"]);
  });

  it("flags syntax errors so callers can refuse to classify", () => {
    expect(outlineTopLevel("export const = ;", "src/broken.ts").hasSyntaxErrors).toBe(true);
  });
});

describe("statement digest", () => {
  const digest = (source: string): string => outlineTopLevel(source, "src/d.ts").statements.map((statement) => statement.digest).join(",");

  it("changes with operators, keywords and flags that are not child nodes", () => {
    const edits: [string, string][] = [
      ["export const D = -1;", "export const D = +1;"],
      ["function f(x: number) { return -x; }", "function f(x: number) { return ~x; }"],
      ["function f() { count++; }", "function f() { count--; }"],
      ["function f() { const lock = acquire(); }", "function f() { using lock = acquire(); }"],
      ["let x = 1;", "var x = 1;"],
      ["class C extends B {}", "class C implements B {}"],
      ["namespace N {}", "module N {}"],
      ["const p = String.raw`a\\d`;", "const p = String.raw`a\\x64`;"],
      ["export { foo };", "export type { foo };"],
      ['import type { S } from "./s";', 'import { S } from "./s";'],
      ["export = foo;", "export default foo;"],
      ["for (x; y;) {}", "for (; x; y) {}"],
    ];
    for (const [before, after] of edits) expect([before, digest(before)]).not.toEqual([before, digest(after)]);
  });

  it("ignores comments, whitespace, list commas and a final semicolon", () => {
    const edits: [string, string][] = [
      ["const a = [1, 2];", "const a = [1, 2,];"],
      ["const a = 1;", "const a = 1"],
      ["const a = f(1, 2);", "const a = f(\n  1,\n  2,\n);"],
      ["interface I { a: string; b: number }", "interface I { a: string, b: number, }"],
      ["/** doc */\nconst a = 1;", "/** other */\nconst a = 1; // trailing"],
    ];
    for (const [before, after] of edits) expect([before, digest(before)]).toEqual([before, digest(after)]);
  });
});

describe("load-time evaluation", () => {
  const outline = outlineTopLevel([
    "class Ctl { constructor(@Inject(T) svc: unknown) {} }", // 1
    "class Handler { handle(@Inject(T) svc: unknown) {} }", // 2
    "using conn = pool;", // 3
    'import type { A } from "./a";', // 4
    'import { type B } from "./a";', // 5
    'import { v } from "./a";', // 6
    'import "./side";', // 7
    'export type { T } from "./t";', // 8
    'export * from "./r";', // 9
    'import cjs = require("./cjs");', // 10
    "/** @jsxImportSource preact */", // 11
    "const z = 1;", // 12
  ].join("\n"), "src/load.ts");
  const at = (line: number) => outline.statements.find((statement) => statement.startLine === line)!;

  it("counts parameter decorators and top-level `using` as running on load", () => {
    expect([at(1).executesOnLoad, at(2).executesOnLoad, at(3).executesOnLoad, at(12).executesOnLoad]).toEqual([true, true, true, false]);
  });

  it("tells a type-only import from one whose load depends on the compiler configuration", () => {
    expect([4, 5, 6, 7, 8, 9, 10].map((line) => at(line).loadsModule)).toEqual(["never", "maybe", "yes", "yes", "never", "yes", "yes"]);
    expect(at(10)).toMatchObject({ moduleSpecifier: "./cjs", importBindings: [{ local: "cjs", imported: "=", typeOnly: false }] });
  });

  it("treats JSX pragmas as directives", () => {
    expect(outline.directiveLines).toEqual([11]);
  });
});

describe("outlineModuleLinks", () => {
  it("reads re-exports, dynamic imports and requires, literal or not", () => {
    const text = [
      'import { a } from "./a";',
      'export { b } from "./b";',
      'export * from "@demo/pkg";',
      "export { local };",
      'const lazy = () => import("./lazy");',
      "const any = (name: string) => import(name);",
      'const legacy = require("./legacy");',
      'import cjs = require("./cjs");',
    ].join("\n");
    expect(outlineModuleLinks(text, "src/index.ts")).toEqual([
      { kind: "import", specifier: "./a", line: 1 },
      { kind: "reexport", specifier: "./b", line: 2 },
      { kind: "reexport", specifier: "@demo/pkg", line: 3 },
      { kind: "dynamic_import", specifier: "./lazy", line: 5 },
      { kind: "dynamic_import", specifier: null, line: 6 },
      { kind: "require", specifier: "./legacy", line: 7 },
      { kind: "require", specifier: "./cjs", line: 8 },
    ]);
  });
});
