import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChangeImpactReportSchema, createDefaultConfig, type ChangeImpactReport } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runChangeImpact } from "../src";

/**
 * How single edits are classified, end to end. Each case is a way an edit could be misread as
 * inert (a false "nothing reached") or as broader than it is (a false requalification). One
 * repository is indexed once; every case edits the working tree, analyses it and restores it.
 */

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "classification", version: "0.0.0" }),
  "src/lib/registry.ts": [
    "export function register(): void {}",
    "",
    "export function subscribe(topic: string): () => void {",
    "  return () => void topic;",
    "}",
    "",
  ].join("\n"),
  "src/lib/boot.ts": [
    'import { register } from "./registry";',
    "// register();",
    "",
    "export function ping(): number {",
    "  return 1;",
    "}",
    "",
  ].join("\n"),
  "src/app/main.ts": [
    'import { ping } from "../lib/boot";',
    "",
    "export function main(): number {",
    "  return ping();",
    "}",
    "",
  ].join("\n"),
  "src/lib/service.ts": [
    "class Service {",
    "  run(): number {",
    "    return 1;",
    "  }",
    "}",
    "",
    "export default Service;",
    "",
  ].join("\n"),
  "src/app/use-service.ts": [
    'import Service from "../lib/service";',
    "",
    "export function useService(): number {",
    "  return new Service().run();",
    "}",
    "",
  ].join("\n"),
  "src/lib/limits.ts": [
    "export const limits = [3, 1, 2]",
    "",
    "export function first(): number {",
    "  return limits[0] ?? 0;",
    "}",
    "",
  ].join("\n"),
  "src/app/read-limits.ts": [
    'import { limits } from "../lib/limits";',
    "",
    "export const count = limits.length;",
    "",
  ].join("\n"),
  "src/lib/decorated.ts": [
    "function reg(target: unknown): void {",
    "  void target;",
    "}",
    "",
    "export class Widget {",
    "  size(): number {",
    "    return 1;",
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/app/use-widget.ts": [
    'import { Widget } from "../lib/decorated";',
    "",
    "export function widgetSize(): number {",
    "  return new Widget().size();",
    "}",
    "",
  ].join("\n"),
  "src/lib/wire.ts": [
    'import { subscribe } from "./registry";',
    "",
    'const unsubscribe = subscribe("orders");',
    "",
    "export function stop(): void {",
    "  unsubscribe();",
    "}",
    "",
  ].join("\n"),
  "src/app/boot-app.ts": ['import "../lib/wire";', ""].join("\n"),
  "src/lib/x.ts": ["export function price(): number {", "  return 2;", "}", ""].join("\n"),
  "src/lib/y.ts": ["export function price(): number {", "  return 1;", "}", ""].join("\n"),
  "src/lib/index.ts": ['export * from "./y";', ""].join("\n"),
  "src/app/pricing.ts": [
    'import { price } from "../lib/index";',
    "",
    "export function total(): number {",
    "  return price();",
    "}",
    "",
  ].join("\n"),
  "src/lib/polyfill.ts": "",
  "src/app/uses-polyfill.ts": ['import "../lib/polyfill";', ""].join("\n"),
  "src/lib/foo/index.ts": ["export function foo(): number {", "  return 1;", "}", ""].join("\n"),
  "src/app/use-foo.ts": [
    'import { foo } from "../lib/foo";',
    "",
    "export function useFoo(): number {",
    "  return foo();",
    "}",
    "",
  ].join("\n"),
  "src/lib/nested.ts": [
    "function normalise(name: string): string {",
    "  const strip = (value: string) => value.trim();",
    "  return strip(name);",
    "}",
    "",
    "export function greet(name: string): string {",
    "  return `hi ${normalise(name)}`;",
    "}",
    "",
  ].join("\n"),
  "src/app/use-greet.ts": [
    'import { greet } from "../lib/nested";',
    "",
    "export function welcome(): string {",
    '  return greet("you");',
    "}",
    "",
  ].join("\n"),
  "src/lib/direction.ts": [
    "export const DIRECTION = -1;",
    "",
    "export function step(x: number): number {",
    "  return x * DIRECTION;",
    "}",
    "",
  ].join("\n"),
  "src/lib/clause.ts": ["function helper(): number {", "  return 1;", "}", "", "export { helper };", ""].join("\n"),
  "src/app/use-clause.ts": ['import { helper } from "../lib/clause";', "", "export const one = helper();", ""].join("\n"),
  "src/lib/twice.ts": ['import { register } from "./registry";', "// register();", "register();", ""].join("\n"),
  "src/app/uses-twice.ts": ['import "../lib/twice";', ""].join("\n"),
  "src/lib/side.ts": ['console.log("side loaded");', 'export type Side = "a" | "b";', "export const sideValue = 1;", ""].join("\n"),
  "src/lib/uses-side.ts": [
    'import type { Side } from "./side";',
    "",
    "export function pick(side: Side): Side {",
    "  return side;",
    "}",
    "",
  ].join("\n"),
  "src/app/pick-app.ts": ['import { pick } from "../lib/uses-side";', "", 'export const chosen = pick("a");', ""].join("\n"),
  "src/lib/val.ts": ["// note", "export const value = 1;", ""].join("\n"),
  "src/lib/pure.ts": ["// @ts-ignore", "export const pure = 1;", ""].join("\n"),
  "src/app/use-val.ts": ['import { value } from "../lib/val";', "", "export const doubled = value * 2;", ""].join("\n"),
  "src/lib/marked.ts": [
    "/**",
    " * Runs once.",
    " * @invariant top-idempotent: top must be idempotent",
    " */",
    "export function top(): number {",
    "  return 1;",
    "}",
    "",
    "export function outer(): number {",
    "  /**",
    "   * @invariant inner-idempotent: inner must be idempotent",
    "   */",
    "  function inner(): number {",
    "    return 2;",
    "  }",
    "  return inner();",
    "}",
    "",
  ].join("\n"),
  "src/lib/a-effect.ts": ['console.log("a");', "export const a = 1;", ""].join("\n"),
  "src/lib/b-effect.ts": ['console.log("b");', "export const b = 2;", ""].join("\n"),
  "src/lib/order.ts": ['import { a } from "./a-effect";', 'import { b } from "./b-effect";', "", "export const sum = a + b;", ""].join("\n"),
  "src/app/use-order.ts": ['import { sum } from "../lib/order";', "", "export const total2 = sum;", ""].join("\n"),
  "src/lib/fetch-source.ts": [
    "export function other(): string {",
    '  return "";',
    "}",
    "",
    "export function fetch(url: string): Promise<unknown> {",
    "  return Promise.reject(new Error(url));",
    "}",
    "",
  ].join("\n"),
  "src/lib/net.ts": [
    'import { other } from "./fetch-source";',
    "",
    "export function load(url: string): Promise<unknown> {",
    "  return fetch(url + other());",
    "}",
    "",
  ].join("\n"),
  "src/app/start.ts": [
    'import { load } from "../lib/net";',
    "",
    "export function start(): Promise<unknown> {",
    '  return load("https://example.test");',
    "}",
    "",
  ].join("\n"),
  "src/lib/handlers.ts": [
    "export function greet(): string {",
    '  return "hi";',
    "}",
    "",
  ].join("\n"),
  "src/lib/commands.ts": [
    'import * as handlers from "./handlers";',
    "",
    "export function commandNames(): string[] {",
    "  return Object.keys(handlers);",
    "}",
    "",
  ].join("\n"),
  "src/lib/pa.ts": ["export const PA = 1;", ""].join("\n"),
  "src/lib/pb.ts": ["export const PB = 2;", ""].join("\n"),
  "src/lib/pbarrel.ts": ['export * from "./pa";', ""].join("\n"),
  "src/app/pmain.ts": ['import { PA } from "../lib/pbarrel";', 'import { PB } from "../lib/pb";', "", "export const both = PA + PB;", ""].join("\n"),
};

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.test",
  GIT_AUTHOR_DATE: "2026-09-01T10:00:00Z",
  GIT_COMMITTER_DATE: "2026-09-01T10:00:00Z",
};

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "core.autocrlf=false", ...args], { cwd: root, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

let parent: string;
let root: string;

beforeAll(() => {
  parent = mkdtempSync(join(tmpdir(), "semctx-classification-"));
  root = join(parent, "repo");
  mkdirSync(root);
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  initWorkspace(root, createDefaultConfig(root));
  indexRepository(root, "2026-09-01T10:00:00.000Z");
});

afterAll(() => {
  rmSync(parent, { recursive: true, force: true });
});

function edit(path: string, before: string, after: string): void {
  const file = join(root, path);
  const text = readFileSync(file, "utf8");
  if (!text.includes(before)) throw new Error(`fixture drifted: ${path}`);
  writeFileSync(file, text.replace(before, after));
}

/** Analyse the working tree, check the contract invariants every report must hold, then restore. */
function analyse(change: () => void): ChangeImpactReport {
  change();
  try {
    const report = ChangeImpactReportSchema.parse(runChangeImpact(root, { kind: "working-tree" })) as ChangeImpactReport;
    expect(report.analysis.binding.status).toBe("bound");
    // Every target's chain starts at the change and is as long as its distance.
    const origins = new Set([
      ...report.changes.units!.map((unit) => unit.id),
      ...report.changes.files.flatMap((file) => [`file:${file.path}`, ...(file.oldPath !== undefined ? [`file:${file.oldPath}`] : [])]),
    ]);
    for (const target of [...report.directlyAffected!, ...report.transitivelyAffected!, ...report.possiblyAffected!]) {
      expect(target.via.length).toBe(target.distance);
      expect(origins.has(target.via[0]!.from)).toBe(true);
    }
    return report;
  } finally {
    git(root, "checkout", "-q", "--", ".");
    git(root, "clean", "-fdq");
  }
}

const ids = (targets: ChangeImpactReport["possiblyAffected"]): string[] => (targets ?? []).map((target) => target.id).sort();
const gapCodes = (report: ChangeImpactReport): string[] => report.unresolved.map((gap) => gap.code);
const reached = (report: ChangeImpactReport): string[] => [
  ...ids(report.directlyAffected),
  ...ids(report.transitivelyAffected),
  ...ids(report.possiblyAffected),
];

describe("edits that must not read as inert", () => {
  it("uncommenting a top-level call runs code on load", () => {
    const report = analyse(() => edit("src/lib/boot.ts", "// register();", "register();"));
    expect(report.changes.units!.some((unit) => unit.kind === "module_statement" && unit.behavioral)).toBe(true);
    expect(ids(report.possiblyAffected)).toContain("mod:src/app/main.ts");
    expect(report.blastRadius.complete).toBe(false);
  });

  it("replacing a blank line with a call runs code on load", () => {
    const report = analyse(() => edit("src/lib/boot.ts", "// register();\n\n", "// register();\nregister();\n"));
    expect(report.changes.units!.some((unit) => unit.kind === "module_statement" && unit.behavioral)).toBe(true);
    expect(ids(report.possiblyAffected)).toContain("mod:src/app/main.ts");
  });

  it("a class exported by `export default Service` is visible to importers", () => {
    const report = analyse(() => edit("src/lib/service.ts", "    return 1;", "    return 2;"));
    const unit = report.changes.units!.find((entry) => entry.id === "sym:class:src/lib/service.ts:Service");
    expect(unit?.exported).toBe(true);
    expect(ids(report.possiblyAffected)).toContain("mod:src/app/use-service.ts");
    expect(gapCodes(report)).toContain("REVERSE_REACH_NOT_MODELED");
  });

  it("a continuation line appended to an exported constant changes it", () => {
    const report = analyse(() => edit("src/lib/limits.ts", "export const limits = [3, 1, 2]\n", "export const limits = [3, 1, 2]\n  .filter((n) => n > 1)\n"));
    const unit = report.changes.units!.find((entry) => entry.names.includes("limits"));
    expect(unit).toMatchObject({ kind: "declaration", behavioral: true, exported: true });
    expect(ids(report.directlyAffected)).toContain("sym:function:src/lib/limits.ts:first");
    expect(ids(report.possiblyAffected)).toContain("mod:src/app/read-limits.ts");
  });

  it("a decorator added to an existing class changes it and runs on load", () => {
    const report = analyse(() => edit("src/lib/decorated.ts", "export class Widget {", "@reg\nexport class Widget {"));
    const unit = report.changes.units!.find((entry) => entry.names.includes("Widget"));
    expect(unit).toMatchObject({ behavioral: true, runsOnLoad: true });
    expect(ids(report.possiblyAffected)).toContain("mod:src/app/use-widget.ts");
  });

  it("an added constant whose initializer calls code runs on load", () => {
    const report = analyse(() => edit("src/lib/wire.ts", 'const unsubscribe = subscribe("orders");\n', 'const unsubscribe = subscribe("orders");\nconst extra = subscribe("payments");\n'));
    const unit = report.changes.units!.find((entry) => entry.names.includes("extra"));
    expect(unit).toMatchObject({ kind: "added_declaration", behavioral: true, runsOnLoad: true });
    expect(ids(report.possiblyAffected)).toContain("mod:src/app/boot-app.ts");
    expect(gapCodes(report)).toContain("REVERSE_REACH_NOT_MODELED");
  });

  it("a private constant whose initializer calls code reaches every importer", () => {
    const report = analyse(() => edit("src/lib/wire.ts", 'subscribe("orders")', 'subscribe("payments")'));
    const unit = report.changes.units!.find((entry) => entry.names.includes("unsubscribe"));
    expect(unit).toMatchObject({ kind: "declaration", exported: false, runsOnLoad: true });
    expect(ids(report.directlyAffected)).toContain("sym:function:src/lib/wire.ts:stop");
    expect(ids(report.possiblyAffected)).toContain("mod:src/app/boot-app.ts");
    expect(report.blastRadius.complete).toBe(false);
  });

  it("an explicit re-export added next to `export *` can rebind an imported name", () => {
    const report = analyse(() => edit("src/lib/index.ts", 'export * from "./y";\n', 'export * from "./y";\nexport { price } from "./x";\n'));
    expect(report.changes.units!.some((unit) => unit.kind === "added_declaration" && unit.behavioral)).toBe(true);
    expect(ids(report.possiblyAffected)).toContain("mod:src/app/pricing.ts");
  });

  it("an added declaration that shadows a global existing code reads changes that code", () => {
    const report = analyse(() => edit("src/lib/net.ts", "  return fetch(url + other());\n}\n", "  return fetch(url + other());\n}\n\nfunction fetch(url: string): Promise<unknown> {\n  return Promise.resolve(url);\n}\n"));
    expect(report.changes.units!.find((unit) => unit.kind === "added_declaration")).toMatchObject({ names: ["fetch"], behavioral: true });
    expect(report.directlyAffected!.find((target) => target.id === "sym:function:src/lib/net.ts:load")?.reason).toBe("REFERENCES_CHANGED_DECLARATION");
    expect(ids(report.transitivelyAffected)).toContain("sym:function:src/app/start.ts:start");
  });

  it("a binding added to an already-loaded import can shadow a global existing code reads", () => {
    const report = analyse(() => edit("src/lib/net.ts", 'import { other } from "./fetch-source";', 'import { other, fetch } from "./fetch-source";'));
    expect(report.changes.units!.find((unit) => unit.kind === "added_declaration")).toMatchObject({ names: ["fetch"], behavioral: true });
    expect(report.directlyAffected!.find((target) => target.id === "sym:function:src/lib/net.ts:load")?.reason).toBe("REFERENCES_CHANGED_DECLARATION");
  });

  it("a whole import added for an already-loaded module can shadow a global existing code reads", () => {
    const report = analyse(() => edit("src/lib/net.ts", 'import { other } from "./fetch-source";\n', 'import { other } from "./fetch-source";\nimport { fetch } from "./fetch-source";\n'));
    // The module was already loaded: the rebinding alone makes the new import behavioural.
    expect(report.changes.units!.map((unit) => [unit.kind, unit.names, unit.behavioral, unit.runsOnLoad])).toEqual([["added_declaration", ["fetch"], true, undefined]]);
    expect(report.directlyAffected!.find((target) => target.id === "sym:function:src/lib/net.ts:load")?.reason).toBe("REFERENCES_CHANGED_DECLARATION");
  });

  it("an export added to a module read through `import * as` changes what its reader sees", () => {
    const report = analyse(() => edit("src/lib/handlers.ts", '  return "hi";\n}\n', '  return "hi";\n}\n\nexport function wipe(): string {\n  return "rm";\n}\n'));
    expect(report.changes.units!.find((unit) => unit.kind === "added_declaration")).toMatchObject({ names: ["wipe"], behavioral: true });
    expect(report.possiblyAffected!.find((target) => target.id === "mod:src/lib/commands.ts")?.reason).toBe("IMPORTS_FILE_OF_CHANGED_DECLARATION");
  });

  it("an export added to a module re-exported by `export *` reaches the barrel and its importers", () => {
    const report = analyse(() => edit("src/lib/pa.ts", "export const PA = 1;\n", "export const PA = 1;\nexport const PC = 3;\n"));
    expect(report.changes.units!.find((unit) => unit.kind === "added_declaration")).toMatchObject({ names: ["PC"], behavioral: true });
    expect(report.possiblyAffected!.find((target) => target.id === "mod:src/lib/pbarrel.ts")?.reason).toBe("REEXPORTS_CHANGED_FILE");
    expect(report.possiblyAffected!.find((target) => target.id === "mod:src/app/pmain.ts")?.reason).toBe("IMPORTS_REEXPORTER_OF_CHANGED_FILE");
  });

  it("deleting an empty imported module reaches its importers", () => {
    const report = analyse(() => unlinkSync(join(root, "src/lib/polyfill.ts")));
    expect(report.changes.files).toContainEqual({ path: "src/lib/polyfill.ts", status: "deleted", hunks: 0 });
    const importer = report.possiblyAffected!.find((target) => target.id === "mod:src/app/uses-polyfill.ts");
    expect(importer?.reason).toBe("IMPORTS_MOVED_OR_DELETED_FILE");
    expect(importer?.via[0]!.from).toBe("file:src/lib/polyfill.ts");
  });

  it("a new file that takes over an existing module's resolution reaches its importers", () => {
    const report = analyse(() => writeFileSync(join(root, "src/lib/foo.ts"), "export function foo(): number {\n  return 99;\n}\n"));
    expect(report.possiblyAffected!.find((target) => target.id === "mod:src/app/use-foo.ts")?.reason).toBe("IMPORTS_SHADOWED_MODULE");
    expect(gapCodes(report)).toContain("ADDED_PATH_MAY_SHADOW_MODULE");
  });
});

describe("edits whose syntax differs only in tokens, flags or position", () => {
  it("flipping an operator is a change, not formatting", () => {
    const report = analyse(() => edit("src/lib/direction.ts", "DIRECTION = -1;", "DIRECTION = +1;"));
    expect(report.changes.units!.some((unit) => unit.names.includes("DIRECTION") && unit.behavioral)).toBe(true);
    expect(ids(report.directlyAffected)).toContain("sym:function:src/lib/direction.ts:step");
  });

  it("turning an export into `export type` removes a runtime export", () => {
    const report = analyse(() => edit("src/lib/clause.ts", "export { helper };", "export type { helper };"));
    expect(report.changes.units!.some((unit) => unit.behavioral)).toBe(true);
    expect(ids(report.possiblyAffected)).toContain("mod:src/app/use-clause.ts");
  });

  it("uncommenting a statement that duplicates the next one runs it on load", () => {
    const report = analyse(() => edit("src/lib/twice.ts", "// register();", "register();"));
    expect(report.changes.units!.some((unit) => unit.kind === "module_statement" && unit.behavioral)).toBe(true);
    expect(ids(report.possiblyAffected)).toContain("mod:src/app/uses-twice.ts");
  });

  it("an `import type` that becomes a value import starts loading the module", () => {
    const report = analyse(() => edit("src/lib/uses-side.ts", 'import type { Side } from "./side";', 'import { type Side, sideValue } from "./side";'));
    expect(report.changes.units!.some((unit) => unit.kind === "module_statement" && unit.behavioral)).toBe(true);
    expect(ids(report.possiblyAffected)).toContain("mod:src/app/pick-app.ts");
  });

  it("an inline-type import added next to `import type` may load the module", () => {
    const report = analyse(() => edit("src/lib/uses-side.ts", 'import type { Side } from "./side";\n', 'import type { Side } from "./side";\nimport { type Side as S2 } from "./side";\n'));
    expect(report.changes.units!.find((unit) => unit.names.includes("S2"))).toMatchObject({ behavioral: true, runsOnLoad: true });
    expect(ids(report.possiblyAffected)).toContain("mod:src/app/pick-app.ts");
  });

  it("reordering value imports changes which module runs first", () => {
    const report = analyse(() => edit("src/lib/order.ts", 'import { a } from "./a-effect";\nimport { b } from "./b-effect";', 'import { b } from "./b-effect";\nimport { a } from "./a-effect";'));
    expect(report.changes.units!.some((unit) => unit.kind === "module_statement" && unit.behavioral)).toBe(true);
    expect(ids(report.possiblyAffected)).toContain("mod:src/app/use-order.ts");
  });

  it("a parameter decorator added to a private class runs on load", () => {
    const report = analyse(() => edit("src/lib/decorated.ts", "export class Widget {", "class Ctl {\n  handle(@reg svc: unknown): void {\n    void svc;\n  }\n}\n\nexport class Widget {"));
    expect(report.changes.units!.find((unit) => unit.names.includes("Ctl"))).toMatchObject({ behavioral: true, runsOnLoad: true });
    expect(ids(report.possiblyAffected)).toContain("mod:src/app/use-widget.ts");
  });
});

describe("directives and markers outside code", () => {
  it("a directive replacing a comment above a statement is not a comment edit", () => {
    const report = analyse(() => edit("src/lib/val.ts", "// note", "// @ts-ignore"));
    expect(report.changes.units!.some((unit) => unit.kind === "unclassified" && unit.behavioral)).toBe(true);
    expect(gapCodes(report)).toContain("CHANGE_NOT_CLASSIFIED");
  });

  it("removing a directive above a statement is not a comment edit", () => {
    const report = analyse(() => edit("src/lib/pure.ts", "// @ts-ignore", "// note"));
    expect(report.changes.units!.find((unit) => unit.kind === "unclassified")).toMatchObject({ behavioral: true, side: "old" });
    expect(gapCodes(report)).toContain("CHANGE_NOT_CLASSIFIED");
  });

  it("an inserted triple-slash directive is not trivia", () => {
    const report = analyse(() => edit("src/lib/val.ts", "// note\n", '/// <reference types="node" />\n// note\n'));
    expect(report.changes.units!.some((unit) => unit.kind === "unclassified" && unit.behavioral)).toBe(true);
    expect(report.blastRadius.complete).toBe(false);
  });

  const claim = (report: ChangeImpactReport, slug: string) => report.exposedClaims!.find((entry) => entry.id.includes(slug));

  it("a marker line inserted into a doc comment exposes the claims it documents as changed", () => {
    const report = analyse(() => edit("src/lib/marked.ts", " * Runs once.\n", " * Runs once.\n * @risk top-reentrancy: top may run twice\n"));
    expect(claim(report, "top-idempotent")?.exposure).toBe("changed");
  });

  it("prose inserted right after a marker line still exposes its claims as possible", () => {
    const marker = " * @invariant top-idempotent: top must be idempotent\n";
    const report = analyse(() => edit("src/lib/marked.ts", marker, `${marker} * Called at boot.\n`));
    expect(claim(report, "top-idempotent")?.exposure).toBe("possible");
  });

  it("a marker edited on a nested declaration exposes its claim as changed", () => {
    const report = analyse(() => edit("src/lib/marked.ts", "inner must be idempotent", "inner must stay idempotent"));
    expect(claim(report, "inner-idempotent")?.exposure).toBe("changed");
    expect(report.changes.units!.every((unit) => !unit.behavioral)).toBe(true);
  });
});

describe("chains", () => {
  it("a possible target keeps its shortest chain whatever the unit order", () => {
    const report = analyse(() => {
      edit("src/lib/pa.ts", "PA = 1", "PA = 10");
      edit("src/lib/pb.ts", "PB = 2", "PB = 20");
    });
    expect(report.possiblyAffected!.find((target) => target.id === "mod:src/app/pmain.ts")).toMatchObject({ distance: 1, reason: "IMPORTS_FILE_OF_CHANGED_DECLARATION" });
  });
});

describe("edits that must not read as broader than they are", () => {
  it("a comment added inside a function is not behavioural", () => {
    const report = analyse(() => edit("src/lib/registry.ts", "  return () => void topic;", "  // closes over the topic\n  return () => void topic;"));
    expect(report.changes.units!.every((unit) => !unit.behavioral)).toBe(true);
    expect(reached(report)).toEqual([]);
  });

  it("reformatting a line is not behavioural", () => {
    const report = analyse(() => edit("src/lib/registry.ts", "  return () => void topic;", "  return () =>   void   topic;"));
    expect(report.changes.units!.every((unit) => !unit.behavioral)).toBe(true);
    expect(reached(report)).toEqual([]);
  });

  it("a compiler directive comment stays behavioural", () => {
    const report = analyse(() => edit("src/lib/registry.ts", "  return () => void topic;", "  // @ts-ignore\n  return () => void topic;"));
    expect(report.changes.units!.some((unit) => unit.behavioral)).toBe(true);
  });

  it("adding a binding to an import does not change the existing ones", () => {
    const report = analyse(() => edit("src/app/main.ts", 'import { ping } from "../lib/boot";', 'import { ping, PING_ID } from "../lib/boot";'));
    expect(report.changes.units!.map((unit) => [unit.kind, unit.names, unit.behavioral])).toEqual([["added_declaration", ["PING_ID"], false]]);
    expect(reached(report)).toEqual([]);
  });

  it("an added declaration no existing code reads stays inert", () => {
    const report = analyse(() => edit("src/lib/net.ts", "  return fetch(url + other());\n}\n", "  return fetch(url + other());\n}\n\nfunction retry(url: string): Promise<unknown> {\n  return load(url);\n}\n"));
    expect(report.changes.units!.every((unit) => !unit.behavioral)).toBe(true);
    expect(reached(report)).toEqual([]);
  });

  it("an export added to a module imported only by name stays inert", () => {
    const report = analyse(() => edit("src/lib/registry.ts", "export function register(): void {}\n", "export function register(): void {}\n\nexport function unregister(): void {}\n"));
    expect(report.changes.units!.every((unit) => !unit.behavioral)).toBe(true);
    expect(reached(report)).toEqual([]);
  });

  it("a type exported from a module read whole stays inert", () => {
    const report = analyse(() => edit("src/lib/handlers.ts", '  return "hi";\n}\n', '  return "hi";\n}\n\nexport interface Handler {\n  name: string;\n}\n'));
    expect(report.changes.units!.every((unit) => !unit.behavioral)).toBe(true);
    expect(reached(report)).toEqual([]);
  });

  it("a symbol nested in a private function is invisible to importers", () => {
    const report = analyse(() => edit("src/lib/nested.ts", "value.trim()", "value.trim().toLowerCase()"));
    expect(report.changes.units!.every((unit) => unit.exported === false)).toBe(true);
    expect(ids(report.directlyAffected)).toContain("sym:function:src/lib/nested.ts:greet");
    expect(report.possiblyAffected).toEqual([]);
  });
});
