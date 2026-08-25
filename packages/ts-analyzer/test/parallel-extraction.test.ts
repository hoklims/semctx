import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { normalizePath } from "@semantic-context/core";
import {
  extractTypeScript,
  extractTypeScriptParallel,
  resolveWorkerCount,
  __partitionTypeScriptRootsForTesting,
  __setExtractionWorkerFactoryForTesting,
} from "../src/ts-symbols";

const temporary: string[] = [];

function fixture(files: Record<string, string>): { root: string; paths: string[] } {
  const root = mkdtempSync(join(tmpdir(), "semctx-parallel-ts-"));
  temporary.push(root);
  const paths = Object.entries(files).map(([name, content]) => {
    const path = resolve(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    return path;
  });
  return { root, paths };
}

afterEach(() => {
  __setExtractionWorkerFactoryForTesting(undefined);
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("parallel TypeScript extraction", () => {
  test("workers 1 and 2 return byte-identical structured extraction with shared declarations", async () => {
    const { root, paths } = fixture({
      "globals.d.ts": "declare interface SharedShape { value: string }\n",
      "packages/a/index.ts": "export function a(input: SharedShape) { return input.value }\n",
      "packages/b/index.ts": "export function b(input: SharedShape) { return input.value.length }\n",
    });
    const one = await extractTypeScriptParallel(paths, root, 1);
    const two = await extractTypeScriptParallel(paths, root, 2);

    expect(one.parallelism).toMatchObject({ used: 1, mode: "single" });
    expect(two.parallelism).toMatchObject({ used: 2, mode: "parallel" });
    expect(JSON.stringify(two.extraction)).toBe(JSON.stringify(one.extraction));
    expect(JSON.stringify(two.extraction)).toBe(JSON.stringify(extractTypeScript(paths, root)));
    expect(two.extraction.modules).toEqual(["packages/a/index.ts", "packages/b/index.ts"]);
  });

  test("keeps one monolithic import chain single-core with an explicit reason", async () => {
    const { root, paths } = fixture({
      "a.ts": "import { b } from './b'; export const a = b + 1\n",
      "b.ts": "import { c } from './c'; export const b = c + 1\n",
      "c.ts": "export const c = 1\n",
    });

    const result = await extractTypeScriptParallel(paths, root, 2);
    expect(result.parallelism).toMatchObject({
      requested: 2,
      used: 1,
      mode: "single",
      reason: "TypeScript root module graph has one connected component",
    });
    expect(JSON.stringify(result.extraction)).toBe(JSON.stringify(extractTypeScript(paths, root)));
  });

  test("partitions connected module components deterministically without splitting them", () => {
    const { root, paths } = fixture({
      "packages/a/a0.ts": "export const a0 = 1\n",
      "packages/a/a1.ts": "export { a0 } from './a0'\n",
      "packages/b/b0.ts": "export const b0 = 1\n",
      "packages/b/b1.ts": "import { b0 } from './b0'; export const b1 = b0 + 1\n",
    });
    const first = __partitionTypeScriptRootsForTesting(paths, root, 2);
    const second = __partitionTypeScriptRootsForTesting([...paths].reverse(), root, 2);

    expect(second).toEqual(first);
    expect(first).toHaveLength(2);
    expect(first.map((chunk) => [...chunk].sort()).sort()).toEqual([
      [normalizePath(paths[0]!), normalizePath(paths[1]!)].sort(),
      [normalizePath(paths[2]!), normalizePath(paths[3]!)].sort(),
    ].sort());
  });

  test.each([
    ["re-export", "export { value } from './target'\n"],
    ["export type", "export type { Shape } from './target'\n"],
    ["import type", "import type { Shape } from './target'; export function read(value: Shape) { return value.id }\n"],
    ["dynamic import", "export async function load() { return import('./target') }\n"],
    ["import type expression", "export type Loaded = typeof import('./target')\n"],
    ["require", "const target = require('./target'); export const loaded = target.value\n"],
    ["import equals require", "import target = require('./target'); export const loaded = target.value\n"],
  ])("keeps %s module edges together and separate from an independent root", (_label, source) => {
    const { root, paths } = fixture({
      "source.ts": source,
      "target.ts": "export interface Shape { id: string }\nexport const value = 1\n",
      "independent.ts": "export const independent = true\n",
    });

    const chunks = __partitionTypeScriptRootsForTesting(paths, root, 2);
    expect(chunks).toHaveLength(2);
    const sourcePath = normalizePath(paths[0]!);
    const targetPath = normalizePath(paths[1]!);
    const independentPath = normalizePath(paths[2]!);
    expect(chunks.some((chunk) => chunk.includes(sourcePath) && chunk.includes(targetPath))).toBe(true);
    expect(chunks.some((chunk) => chunk.includes(sourcePath) && chunk.includes(independentPath))).toBe(false);
  });

  test("connects selected roots through a loaded but unselected intermediate module", () => {
    const { root, paths } = fixture({
      "a.ts": "import { middle } from './middle'; export const a = middle + 1\n",
      "middle.ts": "import { b } from './b'; export const middle = b + 1\n",
      "b.ts": "export const b = 1\n",
    });

    const chunks = __partitionTypeScriptRootsForTesting([paths[0]!, paths[2]!], root, 2);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual([normalizePath(paths[0]!), normalizePath(paths[2]!)].sort());
    expect(chunks[0]).not.toContain(normalizePath(paths[1]!));
  });

  test("does not connect independent roots through the same external node_modules package", () => {
    const { root, paths } = fixture({
      "a.ts": "import { marker } from 'shared-package'; export const a = marker\n",
      "b.ts": "import { marker } from 'shared-package'; export const b = marker\n",
      "node_modules/shared-package/package.json": "{\"name\":\"shared-package\",\"types\":\"index.d.ts\"}\n",
      "node_modules/shared-package/index.d.ts": "export declare const marker: number\n",
    });

    const chunks = __partitionTypeScriptRootsForTesting([paths[0]!, paths[1]!], root, 2);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length === 1)).toBe(true);
  });

  test("does not split mixed-case imports on case-insensitive TypeScript hosts", () => {
    if (ts.sys.useCaseSensitiveFileNames) {
      expect(ts.sys.useCaseSensitiveFileNames).toBe(true);
      return;
    }
    const { root, paths } = fixture({
      "Foo.ts": "export const value = 1\n",
      "consumer.ts": "import { value } from './foo'; export const result = value + 1\n",
    });

    const chunks = __partitionTypeScriptRootsForTesting(paths, root, 2);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(2);
  });

  test.each([
    ["global script", { "a.ts": "function globalFunction() { return 1 }\n", "b.ts": "export const b = 2\n" }],
    ["triple-slash", { "a.ts": "/// <reference path='./b.ts' />\nexport const a = 1\n", "b.ts": "export const b = 2\n" }],
    ["module augmentation", { "a.ts": "declare module './b' { export const changed: true }\nexport {}\n", "b.ts": "export const b = 2\n" }],
    ["parse error", { "a.ts": "export const = ;\n", "b.ts": "export const b = 2\n" }],
  ])("falls back before launching workers for %s", async (_label, files) => {
    const { root, paths } = fixture(files);
    const result = await extractTypeScriptParallel(paths, root, 2);

    expect(result.parallelism.used).toBe(1);
    expect(result.parallelism.mode).toBe("preflight-fallback");
  });

  test("auto is capped and explicit values are bounded", () => {
    expect(resolveWorkerCount("auto", 100)).toBeGreaterThanOrEqual(1);
    expect(resolveWorkerCount("auto", 100)).toBeLessThanOrEqual(4);
    expect(resolveWorkerCount(8, 3)).toBe(3);
    expect(() => resolveWorkerCount(0, 3)).toThrow(/1 through 8/);
    expect(() => resolveWorkerCount(9, 3)).toThrow(/1 through 8/);
  });

  test("fails closed after a launched worker returns a malformed DTO", async () => {
    const { root, paths } = fixture({
      "a.ts": "export const a = 1\n",
      "b.ts": "export const b = 2\n",
    });
    __setExtractionWorkerFactoryForTesting(() => {
      let onmessage: ((event: { data: unknown }) => void) | null = null;
      const worker = {
        onerror: null as ((event: { message: string }) => void) | null,
        get onmessage() { return onmessage; },
        set onmessage(value: ((event: { data: unknown }) => void) | null) { onmessage = value; },
        postMessage() {
          queueMicrotask(() => onmessage?.({ data: { schemaVersion: 1, ok: true, extraction: {} } }));
        },
        terminate() {},
      };
      return worker as unknown as Worker;
    });

    let thrown: unknown;
    try {
      await extractTypeScriptParallel(paths, root, 2);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/malformed extraction DTO/);
  });

  test("fails closed when a worker returns a non-canonical repository path", async () => {
    const { root, paths } = fixture({
      "a.ts": "export const a = 1\n",
      "b.ts": "export const b = 2\n",
    });
    __setExtractionWorkerFactoryForTesting(() => {
      let onmessage: ((event: { data: unknown }) => void) | null = null;
      const worker = {
        onerror: null as ((event: { message: string }) => void) | null,
        get onmessage() { return onmessage; },
        set onmessage(value: ((event: { data: unknown }) => void) | null) { onmessage = value; },
        postMessage(value: unknown) {
          const request = value as { jobId: string; repoRoot: string; emitAbsPaths: string[] };
          const modulePath = relative(request.repoRoot, request.emitAbsPaths[0]!).replaceAll("\\", "/");
          queueMicrotask(() => onmessage?.({
            data: {
              schemaVersion: 1,
              jobId: request.jobId,
              ok: true,
              extraction: {
                modules: [modulePath],
                symbols: [],
                imports: [{ fromRelPath: modulePath, resolvedRelPath: "src/../escape.ts" }],
                calls: [],
              },
            },
          }));
        },
        terminate() {},
      };
      return worker as unknown as Worker;
    });

    let thrown: unknown;
    try {
      await extractTypeScriptParallel(paths, root, 2);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/malformed extraction DTO/);
  });

  test("terminates a launched worker and clears its timer when the next worker cannot be created", async () => {
    const { root, paths } = fixture({
      "a.ts": "export const a = 1\n",
      "b.ts": "export const b = 2\n",
    });
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const activeTimers = new Set<ReturnType<typeof setTimeout>>();
    let factoryCalls = 0;
    let terminations = 0;
    globalThis.setTimeout = ((handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
      const timer = originalSetTimeout(handler, timeout, ...args);
      activeTimers.add(timer);
      return timer;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
      activeTimers.delete(timer);
      originalClearTimeout(timer);
    }) as typeof clearTimeout;
    __setExtractionWorkerFactoryForTesting(() => {
      factoryCalls += 1;
      if (factoryCalls === 2) throw new Error("second worker unavailable");
      return {
        onerror: null,
        onmessage: null,
        postMessage() {},
        terminate() { terminations += 1; },
      } as unknown as Worker;
    });

    let thrown: unknown;
    try {
      await extractTypeScriptParallel(paths, root, 2);
    } catch (error) {
      thrown = error;
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("second worker unavailable");
    expect(terminations).toBe(1);
    expect(activeTimers.size).toBe(0);
  });

  test("fails closed when cloned DTO scalar fields do not match the extraction contract", async () => {
    const { root, paths } = fixture({
      "a.ts": "export const a = 1\n",
      "b.ts": "export const b = 2\n",
    });
    __setExtractionWorkerFactoryForTesting(() => {
      let onmessage: ((event: { data: unknown }) => void) | null = null;
      const worker = {
        onerror: null as ((event: { message: string }) => void) | null,
        get onmessage() { return onmessage; },
        set onmessage(value: ((event: { data: unknown }) => void) | null) { onmessage = value; },
        postMessage(value: unknown) {
          const request = value as { jobId: string; repoRoot: string; emitAbsPaths: string[] };
          const modulePath = relative(request.repoRoot, request.emitAbsPaths[0]!).replaceAll("\\", "/");
          queueMicrotask(() => onmessage?.({
            data: {
              schemaVersion: 1,
              jobId: request.jobId,
              ok: true,
              extraction: {
                modules: [modulePath],
                symbols: [],
                imports: [{
                  fromRelPath: modulePath,
                  moduleSpecifier: "./peer",
                  names: "not-an-array",
                  line: 1,
                }],
                calls: [],
              },
            },
          }));
        },
        terminate() {},
      };
      return worker as unknown as Worker;
    });

    let thrown: unknown;
    try {
      await extractTypeScriptParallel(paths, root, 2);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/malformed extraction DTO/);
  });
});
