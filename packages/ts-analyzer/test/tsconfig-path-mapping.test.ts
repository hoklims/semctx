import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import { createDefaultConfig, createGlobSelectionConfig } from "@semantic-context/core";
import type { RepositoryGraph, SemctxConfig } from "@semantic-context/core";
import { analyzeRepository, analyzeRepositoryAsync, discoverRepository, extractTypeScript, extractTypeScriptParallel } from "../src";
import { __partitionTypeScriptRootsForTesting, __setExtractionWorkerFactoryForTesting } from "../src/ts-symbols";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A canonical temporary directory: macOS reaches tmpdir through a `/var` link. */
function temporaryRoot(prefix: string): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix))).replaceAll("\\", "/");
  temporary.push(root);
  return root;
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

const PATHS_TSCONFIG = JSON.stringify({
  compilerOptions: {
    module: "NodeNext", moduleResolution: "NodeNext", strict: true, rootDir: ".", noEmit: true,
    paths: { "@r/pkg/*": ["./src/*", "./src/*.ts"] },
  },
  include: ["src"],
});

/** The reproduction of issue #354: three importers of one handler, and a test importing by alias. */
const ISSUE_FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "repro-root", private: true, packageManager: "pnpm@10.0.0" }),
  "pnpm-workspace.yaml": 'packages:\n  - "pkg"\n',
  "pkg/package.json": JSON.stringify({ name: "@r/pkg", version: "1.0.0" }),
  "pkg/tsconfig.json": PATHS_TSCONFIG,
  "pkg/src/feat/handler.ts": "export function handle(n: number): number { return n + 1; }\n",
  "pkg/src/feat/alias-js-user.ts": 'import { handle } from "@r/pkg/feat/handler.js";\nexport function viaAliasJs(): number { return handle(1); }\n',
  "pkg/src/feat/alias-noext-user.ts": 'import { handle } from "@r/pkg/feat/handler";\nexport function viaAliasNoExt(): number { return handle(1); }\n',
  "pkg/src/feat/relative-user.ts": 'import { handle } from "./handler.js";\nexport function viaRelative(): number { return handle(2); }\n',
  "pkg/src/feat/handler.spec.ts": 'import { handle } from "@r/pkg/feat/handler.js";\nexport const result = handle(3);\n',
};

function v2Config(root: string, include: string[] = ["pkg/**/*.ts"]): SemctxConfig {
  return { ...createGlobSelectionConfig(root), include, exclude: [] };
}

function edges(graph: RepositoryGraph, kind: string): string[] {
  return graph.edges.filter(edge => edge.kind === kind).map(edge => `${edge.from} -> ${edge.to}`).sort();
}

const HANDLER = "sym:function:pkg/src/feat/handler.ts:handle";
const EXPECTED_IMPORTS = [
  "mod:pkg/src/feat/alias-js-user.ts -> mod:pkg/src/feat/handler.ts",
  "mod:pkg/src/feat/alias-noext-user.ts -> mod:pkg/src/feat/handler.ts",
  "mod:pkg/src/feat/relative-user.ts -> mod:pkg/src/feat/handler.ts",
  "test:pkg/src/feat/handler.spec.ts -> mod:pkg/src/feat/handler.ts",
];

describe("tsconfig path mapping in a TypeScript-only graph (issue #354)", () => {
  test("an aliased import yields the same edges as a relative import, and links its test", () => {
    const root = temporaryRoot("semctx-paths-alias-");
    write(root, ISSUE_FILES);
    const { graph } = analyzeRepository(v2Config(root));
    expect(edges(graph, "imports").sort()).toEqual(EXPECTED_IMPORTS);
    expect(edges(graph, "calls")).toEqual([
      `sym:function:pkg/src/feat/alias-js-user.ts:viaAliasJs -> ${HANDLER}`,
      `sym:function:pkg/src/feat/alias-noext-user.ts:viaAliasNoExt -> ${HANDLER}`,
      `sym:function:pkg/src/feat/relative-user.ts:viaRelative -> ${HANDLER}`,
      // A call at module scope belongs to the module, which here is the test.
      `test:pkg/src/feat/handler.spec.ts -> ${HANDLER}`,
    ]);
    expect(edges(graph, "tested_by")).toEqual([`${HANDLER} -> test:pkg/src/feat/handler.spec.ts`]);
    expect(edges(graph, "covers")).toEqual([`test:pkg/src/feat/handler.spec.ts -> ${HANDLER}`]);
  });

  test("worker extraction partitions by alias and equals the single Program", async () => {
    const root = temporaryRoot("semctx-paths-parallel-");
    write(root, {
      ...ISSUE_FILES,
      "pkg/src/other/leaf.ts": "export function leaf(): number { return 1; }\n",
      "pkg/src/other/leaf-user.ts": 'import { leaf } from "@r/pkg/other/leaf";\nexport function useLeaf(): number { return leaf(); }\n',
    });
    const config = v2Config(root);
    const files = discoverRepository(config).files;
    const paths = files.map(file => file.absPath);
    const single = analyzeRepository(config, files);
    const asynchronous = await analyzeRepositoryAsync(config, files, 2);
    expect(asynchronous.parallelism).toMatchObject({ mode: "parallel", used: 2 });
    expect(JSON.stringify(asynchronous.analysis.graph)).toBe(JSON.stringify(single.graph));
    expect(edges(asynchronous.analysis.graph, "imports")).toContain("mod:pkg/src/other/leaf-user.ts -> mod:pkg/src/other/leaf.ts");
    const direct = await extractTypeScriptParallel(paths, root, 2, undefined, { tsconfigPathMapping: true });
    expect(JSON.stringify(direct.extraction)).toBe(JSON.stringify(extractTypeScript(paths, root, undefined, { tsconfigPathMapping: true })));
    expect(direct.extraction.imports.filter(link => link.resolvedRelPath !== undefined)).toHaveLength(5);
  });

  test("the nearest configuration of each package decides, with baseUrl and an inherited member configuration", () => {
    const root = temporaryRoot("semctx-paths-nearest-");
    write(root, {
      "pnpm-workspace.yaml": 'packages:\n  - "tooling/*"\n  - "packages/*"\n',
      "package.json": JSON.stringify({ name: "root", private: true }),
      "tooling/config/package.json": JSON.stringify({ name: "@r/config", version: "1.0.0" }),
      "tooling/config/tsconfig/node.json": JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", paths: { "#shared": ["./shared.ts"] } } }),
      "tooling/config/tsconfig/shared.ts": "export function shared(): number { return 1; }\n",
      "packages/a/package.json": JSON.stringify({ name: "@r/a", devDependencies: { "@r/config": "workspace:*" } }),
      "packages/a/tsconfig.json": JSON.stringify({ extends: "@r/config/tsconfig/node.json", compilerOptions: { paths: { "@x/*": ["./a-impl/*"] } } }),
      "packages/a/a-impl/thing.ts": "export function thing(): number { return 1; }\n",
      "packages/a/src/use.ts": 'import { thing } from "@x/thing";\nexport function useA(): number { return thing(); }\n',
      "packages/b/package.json": JSON.stringify({ name: "@r/b" }),
      "packages/b/tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "." } }),
      "packages/b/b-impl/thing.ts": "export function thing(): number { return 2; }\n",
      "packages/b/src/use.ts": 'import { thing } from "b-impl/thing";\nexport function useB(): number { return thing(); }\n',
      "packages/c/package.json": JSON.stringify({ name: "@r/c", devDependencies: { "@r/config": "workspace:*" } }),
      "packages/c/tsconfig.json": JSON.stringify({ extends: "@r/config/tsconfig/node.json" }),
      "packages/c/src/use.ts": 'import { shared } from "#shared";\nexport function useC(): number { return shared(); }\n',
    });
    const roots = ["packages/a/a-impl/thing.ts", "packages/a/src/use.ts", "packages/b/b-impl/thing.ts", "packages/b/src/use.ts",
      "packages/c/src/use.ts", "tooling/config/tsconfig/shared.ts"].map(path => join(root, path));
    const extraction = extractTypeScript(roots, root, undefined, { tsconfigPathMapping: true });
    const resolved = Object.fromEntries(extraction.imports.map(link => [link.fromRelPath, link.resolvedRelPath]));
    expect(resolved).toEqual({
      "packages/a/src/use.ts": "packages/a/a-impl/thing.ts",
      "packages/b/src/use.ts": "packages/b/b-impl/thing.ts",
      "packages/c/src/use.ts": "tooling/config/tsconfig/shared.ts",
    });
    expect(extraction.calls.filter(call => call.calleeRelPath !== undefined).map(call => `${call.callerSymbolPath}:${call.calleeRelPath}`).sort()).toEqual([
      "useA:packages/a/a-impl/thing.ts", "useB:packages/b/b-impl/thing.ts", "useC:tooling/config/tsconfig/shared.ts",
    ]);
  });

  test("a node_modules lookup behind a mapping is not shared between directories", () => {
    const root = temporaryRoot("semctx-paths-fallback-");
    write(root, {
      "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@x/*": ["./missing/*"] } } }),
      "a/node_modules/@x/pkg/package.json": JSON.stringify({ name: "@x/pkg", types: "index.d.ts" }),
      "a/node_modules/@x/pkg/index.d.ts": "export declare const pkg: number;\n",
      "a/use.ts": 'import { pkg } from "@x/pkg";\nexport const fromA = pkg;\n',
      "b/use.ts": 'import { pkg } from "@x/pkg";\nexport const fromB = pkg;\n',
    });
    // The importer that finds the package comes first: a shared result would reach `b`.
    const paths = ["a/use.ts", "b/use.ts"].map(path => join(root, path));
    const resolved = (options: { tsconfigPathMapping?: boolean }) => Object.fromEntries(
      extractTypeScript(paths, root, undefined, options).imports.map(link => [link.fromRelPath, link.resolvedRelPath]));
    const mapped = resolved({ tsconfigPathMapping: true });
    expect(mapped).toEqual(resolved({}));
    expect(mapped["a/use.ts"]).toBe("a/node_modules/@x/pkg/index.d.ts");
    expect(mapped["b/use.ts"]).toBeUndefined();
  });

  test("baseUrl resolves what it holds and leaves an installed package to the historical resolution", () => {
    const root = temporaryRoot("semctx-paths-baseurl-");
    write(root, {
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "." } }),
      "node_modules/dep/package.json": JSON.stringify({ name: "dep", types: "index.d.ts" }),
      "node_modules/dep/index.d.ts": "export declare const dep: number;\n",
      "src/held.ts": "export const held = 1;\n",
      "src/use.ts": 'import { held } from "src/held";\nimport { dep } from "dep";\nexport const both = held + dep;\n',
    });
    const paths = ["src/held.ts", "src/use.ts"].map(path => join(root, path));
    const mapped = extractTypeScript(paths, root, undefined, { tsconfigPathMapping: true }).imports;
    const legacy = extractTypeScript(paths, root).imports;
    expect(mapped.map(link => link.resolvedRelPath)).toEqual(["src/held.ts", "node_modules/dep/index.d.ts"]);
    expect(legacy.map(link => link.resolvedRelPath)).toEqual([undefined, "node_modules/dep/index.d.ts"]);
  });

  test("an unresolved alias invents no edge", () => {
    const root = temporaryRoot("semctx-paths-unresolved-");
    write(root, {
      ...ISSUE_FILES,
      "pkg/src/feat/missing-user.ts": 'import { nothing } from "@r/pkg/feat/missing.js";\nexport function viaMissing(): number { return nothing(1); }\n',
    });
    const result = analyzeRepository(v2Config(root));
    expect(edges(result.graph, "imports")).toEqual(EXPECTED_IMPORTS);
    expect(edges(result.graph, "calls").some(edge => edge.includes("viaMissing"))).toBe(false);
    expect(result.unresolvedReferences).toEqual([]);
    const extraction = extractTypeScript([join(root, "pkg/src/feat/missing-user.ts")], root, undefined, { tsconfigPathMapping: true });
    expect(extraction.imports).toMatchObject([{ moduleSpecifier: "@r/pkg/feat/missing.js" }]);
    expect(extraction.imports[0]!.resolvedRelPath).toBeUndefined();
  });

  test("an alias leaving the repository reads nothing and produces nothing", () => {
    const parent = temporaryRoot("semctx-paths-outside-");
    const root = `${parent}/repo`;
    write(parent, { "outside/leak.ts": "export function leak(): number { return 42; }\n" });
    write(root, {
      "pkg/tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", paths: { "@out/*": ["../../outside/*"] } } }),
      "pkg/src/use.ts": 'import { leak } from "@out/leak";\nexport function viaOutside(): number { return leak(); }\n',
    });
    const original = ts.sys.readFile.bind(ts.sys);
    const reads: string[] = [];
    const probe = spyOn(ts.sys, "readFile").mockImplementation(((path: string, encoding?: string) => {
      reads.push(path.replaceAll("\\", "/"));
      return original(path, encoding);
    }) as typeof ts.sys.readFile);
    try {
      const extraction = extractTypeScript([join(root, "pkg/src/use.ts")], root, undefined, { tsconfigPathMapping: true });
      expect(extraction.imports).toMatchObject([{ moduleSpecifier: "@out/leak" }]);
      expect(extraction.imports[0]!.resolvedRelPath).toBeUndefined();
      expect(extraction.calls.every(call => call.calleeRelPath === undefined)).toBe(true);
      expect(extraction.symbols.map(symbol => symbol.name)).toEqual(["viaOutside"]);
    } finally {
      probe.mockRestore();
    }
    expect(reads.some(path => path.includes("/outside/"))).toBe(false);
    // The same alias aimed inside the repository resolves: the refusal above is confinement.
    write(root, {
      "pkg/tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", paths: { "@out/*": ["./inner/*"] } } }),
      "pkg/inner/leak.ts": "export function leak(): number { return 42; }\n",
    });
    const inside = extractTypeScript([join(root, "pkg/src/use.ts"), join(root, "pkg/inner/leak.ts")], root, undefined, { tsconfigPathMapping: true });
    expect(inside.imports[0]!.resolvedRelPath).toBe("pkg/inner/leak.ts");
  });

  test("a configuration without paths or baseUrl leaves the extraction byte-identical", () => {
    for (const tsconfig of [undefined, JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true } }),
      JSON.stringify({ compilerOptions: { outDir: "dist", rootDir: "." }, include: ["src"] })]) {
      const root = temporaryRoot("semctx-paths-none-");
      const { "pkg/tsconfig.json": _removed, ...files } = ISSUE_FILES;
      write(root, { ...files, ...(tsconfig === undefined ? {} : { "pkg/tsconfig.json": tsconfig }) });
      const paths = Object.keys(files).filter(path => path.endsWith(".ts")).map(path => join(root, path));
      const legacy = extractTypeScript(paths, root);
      const mapped = extractTypeScript(paths, root, undefined, { tsconfigPathMapping: true });
      expect(JSON.stringify(mapped)).toBe(JSON.stringify(legacy));
      // Without a mapping the aliases stay unresolved, exactly as before.
      expect(legacy.imports.filter(link => link.resolvedRelPath !== undefined).map(link => link.fromRelPath)).toEqual(["pkg/src/feat/relative-user.ts"]);
    }
  });

  test("package.json imports that target a source file resolve with and without the mapping", () => {
    const root = temporaryRoot("semctx-paths-imports-");
    write(root, {
      ...ISSUE_FILES,
      "pkg/package.json": JSON.stringify({ name: "@r/pkg", version: "1.0.0", imports: { "#feat/*": "./src/feat/*.ts" } }),
      "pkg/src/feat/hash-user.ts": 'import { handle } from "#feat/handler";\nexport function viaHash(): number { return handle(4); }\n',
    });
    const paths = [join(root, "pkg/src/feat/handler.ts"), join(root, "pkg/src/feat/hash-user.ts")];
    for (const options of [{}, { tsconfigPathMapping: true }]) {
      const extraction = extractTypeScript(paths, root, undefined, options);
      expect(extraction.imports).toMatchObject([{ moduleSpecifier: "#feat/handler", resolvedRelPath: "pkg/src/feat/handler.ts" }]);
      expect(extraction.calls).toContainEqual(expect.objectContaining({ callerSymbolPath: "viaHash", calleeRelPath: "pkg/src/feat/handler.ts" }));
    }
  });

  test("a v1 configuration resolves aliases and links the test, as a relative import does", () => {
    const root = temporaryRoot("semctx-paths-v1-");
    write(root, ISSUE_FILES);
    const config: SemctxConfig = { ...createDefaultConfig(root), include: ["pkg/**/*.ts"], exclude: [] };
    const { graph } = analyzeRepository(config);
    expect(edges(graph, "imports")).toEqual(EXPECTED_IMPORTS);
    expect(edges(graph, "tested_by")).toContain(`${HANDLER} -> test:pkg/src/feat/handler.spec.ts`);
    expect(edges(graph, "covers")).toContain(`test:pkg/src/feat/handler.spec.ts -> ${HANDLER}`);
    expect(edges(graph, "calls")).toContain(`sym:function:pkg/src/feat/alias-js-user.ts:viaAliasJs -> ${HANDLER}`);
  });

  test("a v1 configuration governed by neither paths nor baseUrl keeps its historical resolution", () => {
    const root = temporaryRoot("semctx-paths-v1-none-");
    const { "pkg/tsconfig.json": _removed, ...files } = ISSUE_FILES;
    write(root, { ...files, "pkg/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }) });
    const config: SemctxConfig = { ...createDefaultConfig(root), include: ["pkg/**/*.ts"], exclude: [] };
    expect(edges(analyzeRepository(config).graph, "imports")).toEqual(["mod:pkg/src/feat/relative-user.ts -> mod:pkg/src/feat/handler.ts"]);
  });

  test("the governing configuration is read once per pass, not once per import", () => {
    const readsOfConfiguration = (importers: number): number => {
      const root = temporaryRoot("semctx-paths-reads-");
      const users: Record<string, string> = {};
      for (let index = 0; index < importers; index += 1) {
        users[`pkg/src/feat/user-${index}.ts`] = `import { handle } from "@r/pkg/feat/handler.js";\nexport function user${index}(): number { return handle(${index}); }\n`;
      }
      write(root, { ...ISSUE_FILES, ...users });
      const original = ts.sys.readFile.bind(ts.sys);
      let count = 0;
      const probe = spyOn(ts.sys, "readFile").mockImplementation(((path: string, encoding?: string) => {
        if (path.replaceAll("\\", "/").endsWith("pkg/tsconfig.json")) count += 1;
        return original(path, encoding);
      }) as typeof ts.sys.readFile);
      try {
        const paths = Object.keys({ ...ISSUE_FILES, ...users }).filter(path => path.endsWith(".ts")).map(path => join(root, path));
        extractTypeScript(paths, root, undefined, { tsconfigPathMapping: true });
      } finally {
        probe.mockRestore();
      }
      return count;
    };
    const few = readsOfConfiguration(2);
    expect(few).toBeGreaterThan(0);
    expect(readsOfConfiguration(30)).toBe(few);
  });

  test("what depends on the importing directory is resolved per directory behind a catch-all mapping", () => {
    // `imports` and a self-name reference resolve from the importer's package, so one directory's answer
    // must never be served to another, whichever importer is analyzed first.
    for (const pattern of ["*", "#*"]) {
      const root = temporaryRoot("semctx-paths-directory-");
      write(root, {
        "tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", paths: { [pattern]: ["./types/*"] } } }),
        "packages/a/package.json": JSON.stringify({ name: "@r/a", imports: { "#util": "./src/util.ts" }, exports: { "./util": "./src/util.ts" } }),
        "packages/a/src/util.ts": "export function util(): number { return 1; }\n",
        "packages/a/src/use.ts": 'import { util } from "#util";\nimport { util as self } from "@r/a/util";\nexport function useA(): number { return util() + self(); }\n',
        "packages/b/package.json": JSON.stringify({ name: "@r/b", imports: { "#util": "./src/util.ts" } }),
        "packages/b/src/util.ts": "export function util(): number { return 2; }\n",
        "packages/b/src/use.ts": 'import { util } from "#util";\nimport { util as other } from "@r/a/util";\nexport function useB(): number { return util() + other(); }\n',
      });
      const order = ["packages/a/src/util.ts", "packages/a/src/use.ts", "packages/b/src/util.ts", "packages/b/src/use.ts"];
      const summary = (extraction: ReturnType<typeof extractTypeScript>) => ({
        imports: extraction.imports.map(link => `${link.fromRelPath}|${link.moduleSpecifier}=>${link.resolvedRelPath}`).sort(),
        calls: extraction.calls.filter(call => call.calleeRelPath !== undefined)
          .map(call => `${call.callerSymbolPath}=>${call.calleeRelPath}`).sort(),
      });
      for (const roots of [order, [...order].reverse()]) {
        const paths = roots.map(path => join(root, path));
        const legacy = summary(extractTypeScript(paths, root));
        const mapped = summary(extractTypeScript(paths, root, undefined, { tsconfigPathMapping: true }));
        expect(mapped).toEqual(legacy);
        expect(mapped.imports).toContain("packages/b/src/use.ts|#util=>packages/b/src/util.ts");
        expect(mapped.imports).toContain("packages/a/src/use.ts|#util=>packages/a/src/util.ts");
        expect(mapped.imports).toContain("packages/a/src/use.ts|@r/a/util=>packages/a/src/util.ts");
        // `b` has no link to `@r/a`: only `a` may reach it by its own name.
        expect(mapped.imports).toContain("packages/b/src/use.ts|@r/a/util=>undefined");
      }
    }
  });

  test("a mapping the importer does not use leaves usage-mode resolution to the compiler", () => {
    // A `.cts` file and an `import x = require()` resolve the `require` condition; the import form resolves `import`.
    for (const [typedCjs, typedEsm] of [["Foo", "any"], ["any", "Foo"]] as const) {
      for (const tsconfig of [{ compilerOptions: { strict: true } }, { compilerOptions: { paths: { "@app/*": ["./src/*"] } } }]) {
        const root = temporaryRoot("semctx-paths-mode-");
        write(root, {
          "tsconfig.json": JSON.stringify(tsconfig),
          "src/foo.ts": "export class Foo { bar(): void {} }\n",
          "node_modules/dual/package.json": JSON.stringify({ name: "dual", exports: { ".": { import: "./esm.d.ts", require: "./cjs.d.ts" } } }),
          "node_modules/dual/cjs.d.ts": `import { Foo } from "../../src/foo";\nexport declare function make(): ${typedCjs};\n`,
          "node_modules/dual/esm.d.ts": `import { Foo } from "../../src/foo";\nexport declare function make(): ${typedEsm};\n`,
          "src/use.cts": 'import dual = require("dual");\nexport function run(): void { dual.make().bar(); }\n',
          "src/eq.ts": 'import dual = require("dual");\nexport function viaEq(): void { dual.make().bar(); }\n',
          "src/plain.ts": 'import { make } from "dual";\nexport function viaPlain(): void { make().bar(); }\n',
        });
        const paths = ["src/foo.ts", "src/use.cts", "src/eq.ts", "src/plain.ts"].map(path => join(root, path));
        const legacy = extractTypeScript(paths, root);
        const mapped = extractTypeScript(paths, root, undefined, { tsconfigPathMapping: true });
        expect(JSON.stringify(mapped)).toBe(JSON.stringify(legacy));
        const reached = (extraction: typeof legacy) => extraction.calls
          .filter(call => call.calleeName === "bar" && call.calleeRelPath === "src/foo.ts").map(call => call.callerSymbolPath).sort();
        // Non-vacuous: the mode really decides which declaration the call reaches.
        expect(reached(mapped)).toEqual(typedCjs === "Foo" ? ["run", "viaEq"] : ["viaPlain"]);
      }
    }
  });

  for (const [name, file, source, used] of [
    ["package ESM import", "use.ts", 'import { value } from "#dual"; export const result = value;', "esm"],
    ["ESM import", "use.mts", 'import { value } from "#dual"; export const result = value;', "esm"],
    ["CommonJS import equals", "use.cts", 'import dual = require("#dual"); export const result = dual.value;', "cjs"],
    ["import equals in ESM", "use.mts", 'import dual = require("#dual"); export const result = dual.value;', "cjs"],
    ["require call", "use.ts", 'const dual = require("#dual"); export const result = dual.value;', "cjs"],
    ["ESM dynamic import", "use.mts", 'export const result = import("#dual");', "esm"],
    ["CommonJS dynamic import", "use.cts", 'export const result = import("#dual");', "cjs"],
    ["type import attribute", "use.mts", 'import type { Value } from "#dual" with { "resolution-mode": "require" }; export type Result = Value;', "cjs"],
  ] as const) test(`confinement follows only the used conditional branch for ${name}`, async () => {
    const parent = temporaryRoot("semctx-paths-used-mode-");
    const root = `${parent}/repo`;
    const unused = used === "esm" ? "cjs" : "esm";
    write(parent, { "outside.ts": "export const secret = 42;\n" });
    write(root, {
      "package.json": JSON.stringify({ type: "module", imports: { "#dual": { import: "./esm.ts", require: "./cjs.ts" } } }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "*": ["./missing/*"] } } }),
      [file]: source,
      "leaf.ts": "export const leaf = 1;\n",
      [`${used}.ts`]: "export const value = 1; export type Value = number;\n",
      [`${unused}.ts`]: 'export { secret } from "../outside";\n',
    });
    const paths = [join(root, file), join(root, "leaf.ts")];
    const options = { tsconfigPathMapping: true };
    const single = extractTypeScript(paths, root, undefined, options);
    const parallel = await extractTypeScriptParallel(paths, root, 2, undefined, options);
    expect(parallel.parallelism).toMatchObject({ mode: "parallel", used: 2 });
    expect(parallel.extraction).toEqual(single);
    // Moving the escape into the used branch must still refuse the actual dependency.
    write(root, {
      [`${unused}.ts`]: "export const value = 1; export type Value = number;\n",
      [`${used}.ts`]: 'export { secret } from "../outside";\n',
    });
    expect(() => extractTypeScript(paths, root, undefined, options)).toThrow(/IMPORT_OUTSIDE_REPOSITORY/);
    const refusal = await extractTypeScriptParallel(paths, root, 2, undefined, options)
      .then(() => "extracted", (error: Error) => error.message);
    expect(refusal).toMatch(/IMPORT_OUTSIDE_REPOSITORY/);
  });

  test("an alias to a repository file does not let the Program read what the relative import may not", () => {
    const parent = temporaryRoot("semctx-paths-bridge-");
    const root = `${parent}/repo`;
    write(parent, {
      "outside/secret.ts": "export function secret(): number { return 42; }\n",
      "outside/ref.d.ts": "declare const referenced: number;\n",
    });
    write(root, {
      "pkg/tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", paths: { "@r/*": ["./lib/*"] } } }),
      "pkg/lib/bridge.ts": 'export { secret } from "../../../outside/secret";\n',
      "pkg/lib/refbridge.ts": '/// <reference path="../../../outside/ref.d.ts" />\nexport const x = 1;\n',
      "pkg/lib/inner.ts": 'export { helper } from "./helper";\n',
      "pkg/lib/helper.ts": "export function helper(): number { return 1; }\n",
      "pkg/src/use.ts": 'import { secret } from "@r/bridge";\nexport function viaBridge(): number { return secret(); }\n',
      "pkg/src/ref.ts": 'import { x } from "@r/refbridge";\nexport const y = x;\n',
      "pkg/src/rel.ts": 'import { secret } from "../lib/bridge";\nexport function viaRelative(): number { return secret(); }\n',
      "pkg/src/ok.ts": 'import { helper } from "@r/inner";\nexport function viaInner(): number { return helper(); }\n',
    });
    const original = ts.sys.readFile.bind(ts.sys);
    const reads: string[] = [];
    const probe = spyOn(ts.sys, "readFile").mockImplementation(((path: string, encoding?: string) => {
      reads.push(path.replaceAll("\\", "/"));
      return original(path, encoding);
    }) as typeof ts.sys.readFile);
    const outcome = (file: string, options: { tsconfigPathMapping?: boolean }): string => {
      try {
        extractTypeScript([join(root, file)], root, undefined, options);
        return "extracted";
      } catch (error) {
        return (error as Error).message.split(":")[0]!;
      }
    };
    try {
      const mapping = { tsconfigPathMapping: true };
      // The relative spelling of the same chain is refused; the alias is held to the same confinement.
      expect(outcome("pkg/src/rel.ts", {})).toBe("IMPORT_OUTSIDE_REPOSITORY");
      expect(outcome("pkg/src/use.ts", mapping)).toBe("IMPORT_OUTSIDE_REPOSITORY");
      expect(outcome("pkg/src/ref.ts", mapping)).toBe("REFERENCE_OUTSIDE_REPOSITORY");
      // Without the mapping the alias does not resolve, so nothing outside is reachable and indexing is unchanged.
      expect(outcome("pkg/src/use.ts", {})).toBe("extracted");
      expect(outcome("pkg/src/ref.ts", {})).toBe("extracted");
      // A bridge that stays inside the repository is not refused and its target resolves.
      expect(outcome("pkg/src/ok.ts", mapping)).toBe("extracted");
      expect(() => analyzeRepository({ ...createGlobSelectionConfig(root), include: ["pkg/src/use.ts"], exclude: [] }))
        .toThrow(/IMPORT_OUTSIDE_REPOSITORY/);
    } finally {
      probe.mockRestore();
    }
    expect(reads.filter(path => path.includes("/outside/"))).toEqual([]);
    const inner = extractTypeScript([join(root, "pkg/src/ok.ts"), join(root, "pkg/lib/inner.ts"), join(root, "pkg/lib/helper.ts")], root, undefined, { tsconfigPathMapping: true });
    expect(inner.imports.find(link => link.fromRelPath === "pkg/src/ok.ts")?.resolvedRelPath).toBe("pkg/lib/inner.ts");
  });

  test("a specifier TypeScript treats as bare is confined like the alias the Program resolves it to", () => {
    const parent = temporaryRoot("semctx-paths-dotname-");
    const root = `${parent}/repo`;
    write(parent, { "outside/secret.ts": "export function secret(): number { return 42; }\n" });
    write(root, {
      "pkg/tsconfig.json": JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "Bundler", baseUrl: ".", paths: { ".x/*": ["./lib/*"], "..y/*": ["./lib/*"] } },
      }),
      "pkg/lib/bridge.ts": 'export { secret } from "../../../outside/secret";\n',
      "pkg/lib/helper.ts": "export function helper(): number { return 1; }\n",
      "pkg/.lib/bridge.ts": 'export { secret } from "../../../outside/secret";\n',
      "pkg/src/dot.ts": 'import { secret } from ".x/bridge";\nexport const a = secret();\n',
      "pkg/src/dotdot.ts": 'import { secret } from "..y/bridge";\nexport const a = secret();\n',
      "pkg/src/baseurl.ts": 'import { secret } from ".lib/bridge";\nexport const a = secret();\n',
      "pkg/src/absolute.ts": `import { secret } from "${parent}/outside/secret";\nexport const a = secret();\n`,
      "pkg/src/inside.ts": 'import { helper } from ".x/helper";\nexport const a = helper();\n',
    });
    const original = ts.sys.readFile.bind(ts.sys);
    const reads: string[] = [];
    const probe = spyOn(ts.sys, "readFile").mockImplementation(((path: string, encoding?: string) => {
      reads.push(path.replaceAll("\\", "/"));
      return original(path, encoding);
    }) as typeof ts.sys.readFile);
    const outcome = (file: string, options: { tsconfigPathMapping?: boolean }): string => {
      try {
        extractTypeScript([join(root, file)], root, undefined, options);
        return "extracted";
      } catch (error) {
        return (error as Error).message.split(":")[0]!;
      }
    };
    const mapping = { tsconfigPathMapping: true };
    try {
      // The Program applies `paths`/`baseUrl` to a name TypeScript does not call relative, even when
      // it begins with a dot; the confinement walk must follow the same classification.
      for (const file of ["pkg/src/dot.ts", "pkg/src/dotdot.ts", "pkg/src/baseurl.ts"]) {
        expect(outcome(file, mapping)).toBe("IMPORT_OUTSIDE_REPOSITORY");
      }
      // An absolute specifier is repository-authored traversal as well, with or without the mapping.
      expect(outcome("pkg/src/absolute.ts", {})).toBe("IMPORT_OUTSIDE_REPOSITORY");
      expect(outcome("pkg/src/absolute.ts", mapping)).toBe("IMPORT_OUTSIDE_REPOSITORY");
      // A dot-named alias that stays inside the repository still resolves.
      expect(outcome("pkg/src/inside.ts", mapping)).toBe("extracted");
    } finally {
      probe.mockRestore();
    }
    expect(reads.filter(path => path.includes("/outside/"))).toEqual([]);
    const inside = extractTypeScript([join(root, "pkg/src/inside.ts"), join(root, "pkg/lib/helper.ts")], root, undefined, mapping);
    expect(inside.imports.find(link => link.fromRelPath === "pkg/src/inside.ts")?.resolvedRelPath).toBe("pkg/lib/helper.ts");
  });

  test("only the configuration of a selected file decides an alias, because only it is bound into freshness", () => {
    const root = temporaryRoot("semctx-paths-unselected-");
    const files: Record<string, string> = {
      "tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", paths: { "@b/*": ["./bridge/*"] } } }),
      "bridge/tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", paths: { "@impl/*": ["../impl1/*"] } } }),
      "bridge/entry.ts": 'export { f } from "@impl/f";\n',
      "impl1/f.ts": "export function f(): number { return 1; }\n",
      "impl2/f.ts": "export function f(): number { return 2; }\n",
      "src/use.ts": 'import { f } from "@b/entry";\nexport function useIt(): number { return f(); }\n',
    };
    write(root, files);
    const extract = (selected: string[]) => extractTypeScript(selected.map(path => join(root, path)), root, undefined, { tsconfigPathMapping: true });
    const retarget = (target: string): void => write(root, {
      "bridge/tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", paths: { "@impl/*": [`../${target}/*`] } } }),
    });
    const selected = ["src/use.ts", "impl1/f.ts", "impl2/f.ts"];
    const calleeOfUseIt = (extraction: ReturnType<typeof extract>) =>
      extraction.calls.find(call => call.callerSymbolPath === "useIt" && call.calleeName === "f")?.calleeRelPath;
    const before = extract(selected);
    // The import written in a selected file is mapped by that file's configuration.
    expect(before.imports.find(link => link.fromRelPath === "src/use.ts")?.resolvedRelPath).toBe("bridge/entry.ts");
    // `bridge/entry.ts` is loaded but not selected: its alias keeps the historical resolution.
    expect(calleeOfUseIt(before)).toBeUndefined();
    retarget("impl2");
    // Editing the configuration of a file freshness cannot see changes nothing.
    expect(JSON.stringify(extract(selected))).toBe(JSON.stringify(before));
    // Selected, the same file is bound by its own configuration, so the edit is an input of the analysis.
    const withBridge = [...selected, "bridge/entry.ts"];
    expect(calleeOfUseIt(extract(withBridge))).toBe("impl2/f.ts");
    retarget("impl1");
    expect(calleeOfUseIt(extract(withBridge))).toBe("impl1/f.ts");
  });

  test("a package hoisted above the root keeps the historical resolution under a mapping that governs its name", () => {
    for (const [tsconfig, extra] of [
      [{ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", paths: { "*": ["./types/*"] } } }, {}],
      [{ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", baseUrl: "." } }, { "deploy/keep.ts": "export const keep = 1;\n" }],
    ] as const) {
      const parent = temporaryRoot("semctx-paths-hoisted-");
      const root = `${parent}/repo`;
      write(parent, {
        "node_modules/dep/package.json": JSON.stringify({ name: "dep", types: "index.d.ts" }),
        "node_modules/dep/index.d.ts": 'import { Foo } from "../../repo/src/foo";\nexport declare function make(cb: () => Foo): Foo;\n',
      });
      write(root, {
        "tsconfig.json": JSON.stringify(tsconfig),
        "src/foo.ts": "export class Foo { bar(): void {} }\n",
        "src/use.ts": 'import { make } from "dep";\nimport { Foo } from "./foo";\nexport function run(): void { make(() => new Foo()).bar(); }\n',
        ...extra,
      });
      const paths = ["src/foo.ts", "src/use.ts"].map(path => join(root, path));
      const legacy = extractTypeScript(paths, root);
      const mapped = extractTypeScript(paths, root, undefined, { tsconfigPathMapping: true });
      expect(JSON.stringify(mapped)).toBe(JSON.stringify(legacy));
      // Non-vacuous: the call into the repository goes through the hoisted package's types.
      expect(mapped.calls.some(call => call.callerSymbolPath === "run" && call.calleeName === "bar" && call.calleeRelPath === "src/foo.ts")).toBe(true);
      expect(mapped.imports.find(link => link.moduleSpecifier === "dep")?.resolvedRelPath).toBe("../node_modules/dep/index.d.ts");
    }
  });

  test("the work a catch-all mapping adds does not grow with the directories that import", () => {
    const probesFor = (directories: number): number => {
      const root = temporaryRoot("semctx-paths-cost-");
      const files: Record<string, string> = {
        "tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", paths: { "*": ["./types/*"] } } }),
      };
      // The mapped directory exists, so every candidate beneath it is probed.
      files["types/unrelated.d.ts"] = "export declare const unrelated: number;\n";
      for (const name of ["one", "two", "three"]) {
        files[`node_modules/${name}/package.json`] = JSON.stringify({ name, types: "index.d.ts" });
        files[`node_modules/${name}/index.d.ts`] = `export declare const ${name}: number;\n`;
      }
      for (let index = 0; index < directories; index += 1) {
        files[`src/d${index}/user.ts`] = 'import { one } from "one";\nimport { two } from "two";\nimport { three } from "three";\nexport const total = one + two + three;\n';
      }
      write(root, files);
      const original = ts.sys.fileExists.bind(ts.sys);
      let probes = 0;
      const spy = spyOn(ts.sys, "fileExists").mockImplementation(((path: string) => {
        if (path.replaceAll("\\", "/").startsWith(`${root}/types/`)) probes += 1;
        return original(path);
      }) as typeof ts.sys.fileExists);
      try {
        const paths = Object.keys(files).filter(path => path.startsWith("src/")).map(path => join(root, path));
        extractTypeScript(paths, root, undefined, { tsconfigPathMapping: true });
      } finally {
        spy.mockRestore();
      }
      return probes;
    };
    const few = probesFor(2);
    expect(few).toBeGreaterThan(0);
    expect(probesFor(8)).toBe(few);
  });

  test("a bare package that no baseUrl entry can name is not probed under baseUrl", () => {
    const root = temporaryRoot("semctx-paths-baseurl-probe-");
    write(root, {
      "tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", baseUrl: "." } }),
      "node_modules/zeta/package.json": JSON.stringify({ name: "zeta", types: "index.d.ts" }),
      "node_modules/zeta/index.d.ts": "export declare const zeta: number;\n",
      "src/held.ts": "export const held = 1;\n",
      "src/use.ts": 'import { held } from "src/held";\nimport { zeta } from "zeta";\nexport const both = held + zeta;\n',
    });
    const original = ts.sys.fileExists.bind(ts.sys);
    const probed: string[] = [];
    const spy = spyOn(ts.sys, "fileExists").mockImplementation(((path: string) => {
      const normalized = path.replaceAll("\\", "/");
      if (normalized.startsWith(`${root}/zeta`)) probed.push(normalized);
      return original(path);
    }) as typeof ts.sys.fileExists);
    try {
      const extraction = extractTypeScript([join(root, "src/held.ts"), join(root, "src/use.ts")], root, undefined, { tsconfigPathMapping: true });
      // The mapping is in use for what baseUrl holds, and the package still resolves.
      expect(extraction.imports.map(link => link.resolvedRelPath)).toEqual(["src/held.ts", "node_modules/zeta/index.d.ts"]);
    } finally {
      spy.mockRestore();
    }
    expect(probed).toEqual([]);
  });

  test("a specifier no paths key matches is resolved by the compiler alone", () => {
    const root = temporaryRoot("semctx-paths-unmatched-");
    write(root, {
      "tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", paths: { "@app/*": ["./src/*"] } } }),
      "node_modules/zeta/package.json": JSON.stringify({ name: "zeta", types: "index.d.ts" }),
      "node_modules/zeta/index.d.ts": "export declare const zeta: number;\n",
      "src/held.ts": "export const held = 1;\n",
      "src/use.ts": 'import { held } from "@app/held";\nimport { zeta } from "zeta";\nexport const both = held + zeta;\n',
    });
    const probesOf = (options: { tsconfigPathMapping?: boolean }): number => {
      const original = ts.sys.fileExists.bind(ts.sys);
      let probes = 0;
      const spy = spyOn(ts.sys, "fileExists").mockImplementation(((path: string) => {
        if (path.replaceAll("\\", "/").startsWith(`${root}/node_modules/zeta`)) probes += 1;
        return original(path);
      }) as typeof ts.sys.fileExists);
      try {
        extractTypeScript([join(root, "src/held.ts"), join(root, "src/use.ts")], root, undefined, options);
      } finally {
        spy.mockRestore();
      }
      return probes;
    };
    const compiler = probesOf({});
    expect(compiler).toBeGreaterThan(0);
    // The mapping is in use (`@app/held` resolves), yet it does not resolve a second time a package its
    // keys cannot match: that would at least double the compiler's own probes.
    expect(probesOf({ tsconfigPathMapping: true })).toBeLessThan(compiler * 2);
  });

  test("the default single-Program path and every fallback of the async extraction keep the alias edges", async () => {
    const root = temporaryRoot("semctx-paths-fallbacks-");
    write(root, ISSUE_FILES);
    const config = v2Config(root);
    const files = discoverRepository(config).files;
    const expectAliasEdges = (graph: RepositoryGraph): void => {
      expect(edges(graph, "imports")).toEqual(EXPECTED_IMPORTS);
    };
    // `semctx index` runs with one worker by default, and "auto" stays single below 1000 files.
    for (const workers of [1, "auto"] as const) {
      const result = await analyzeRepositoryAsync(config, files, workers);
      expect(result.parallelism).toMatchObject({ mode: "single", used: 1 });
      expectAliasEdges(result.analysis.graph);
    }
    // One connected component, which only holds when the preflight resolves the aliases too.
    const connected = await analyzeRepositoryAsync(config, files, 2);
    expect(connected.parallelism).toMatchObject({ mode: "single", reason: "TypeScript root module graph has one connected component" });
    expectAliasEdges(connected.analysis.graph);
    // A global script is not safe to partition: the preflight falls back to the single Program.
    write(root, { "pkg/src/feat/global-script.ts": "declare const legacyGlobal: number;\nlegacyGlobal;\n" });
    const withScript = discoverRepository(config).files;
    const unsafe = await analyzeRepositoryAsync(config, withScript, 2);
    expect(unsafe.parallelism).toMatchObject({ mode: "preflight-fallback" });
    expect(edges(unsafe.analysis.graph, "imports")).toEqual(EXPECTED_IMPORTS);
    rmSync(join(root, "pkg/src/feat/global-script.ts"));
    // Two components and no worker to launch: the same single Program, with the same options.
    write(root, {
      "pkg/src/other/leaf.ts": "export function leaf(): number { return 1; }\n",
      "pkg/src/other/leaf-user.ts": 'import { leaf } from "@r/pkg/other/leaf";\nexport function useLeaf(): number { return leaf(); }\n',
    });
    const split = discoverRepository(config).files;
    __setExtractionWorkerFactoryForTesting(() => { throw new Error("no worker in this host"); });
    try {
      const unavailable = await analyzeRepositoryAsync(config, split, 2);
      expect(unavailable.parallelism).toMatchObject({ mode: "worker-unavailable-fallback" });
      expect(edges(unavailable.analysis.graph, "imports")).toEqual([
        ...EXPECTED_IMPORTS, "mod:pkg/src/other/leaf-user.ts -> mod:pkg/src/other/leaf.ts",
      ].sort());
    } finally {
      __setExtractionWorkerFactoryForTesting(undefined);
    }
  });

  test("the partition keeps an importer by alias and its target in one chunk", () => {
    const root = temporaryRoot("semctx-paths-partition-");
    write(root, {
      "pkg/package.json": JSON.stringify({ name: "@r/pkg", version: "1.0.0" }),
      "pkg/tsconfig.json": PATHS_TSCONFIG,
      "pkg/src/one/target.ts": "export function target(): number { return 1; }\n",
      "pkg/src/one/user.ts": 'import { target } from "@r/pkg/one/target";\nexport function useOne(): number { return target(); }\n',
      "pkg/src/two/leaf.ts": "export function leaf(): number { return 2; }\n",
      "pkg/src/two/user.ts": 'import { leaf } from "@r/pkg/two/leaf";\nexport function useTwo(): number { return leaf(); }\n',
    });
    const paths = ["one/target", "one/user", "two/leaf", "two/user"].map(name => join(root, `pkg/src/${name}.ts`));
    const chunkIndex = (chunks: string[][], name: string): number =>
      chunks.findIndex(chunk => chunk.includes(join(root, `pkg/src/${name}.ts`).replaceAll("\\", "/")) || chunk.includes(join(root, `pkg/src/${name}.ts`)));
    const mapped = __partitionTypeScriptRootsForTesting(paths, root, 2, { tsconfigPathMapping: true });
    expect(mapped).toHaveLength(2);
    expect(chunkIndex(mapped, "one/user")).toBe(chunkIndex(mapped, "one/target"));
    expect(chunkIndex(mapped, "two/user")).toBe(chunkIndex(mapped, "two/leaf"));
    expect(chunkIndex(mapped, "one/user")).not.toBe(chunkIndex(mapped, "two/user"));
    // Control: without the mapping the aliases join nothing, and the same partition splits an importer from its target.
    const legacy = __partitionTypeScriptRootsForTesting(paths, root, 2);
    expect([chunkIndex(legacy, "one/user") === chunkIndex(legacy, "one/target"), chunkIndex(legacy, "two/user") === chunkIndex(legacy, "two/leaf")])
      .toContain(false);
  });
});
