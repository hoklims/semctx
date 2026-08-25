import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  extractTypeScript,
  extractTypeScriptParallel,
  resolveWorkerCount,
  __setExtractionWorkerFactoryForTesting,
} from "../src/ts-symbols";

const temporary: string[] = [];

function fixture(files: Record<string, string>): { root: string; paths: string[] } {
  const root = mkdtempSync(join(tmpdir(), "semctx-parallel-ts-"));
  temporary.push(root);
  const paths = Object.entries(files).map(([name, content]) => {
    const path = resolve(root, name);
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
      "a.ts": "export function a(input: SharedShape) { return input.value }\n",
      "b.ts": "import { a } from './a'; export function b() { return a({ value: 'ok' }) }\n",
    });
    const one = await extractTypeScriptParallel(paths, root, 1);
    const two = await extractTypeScriptParallel(paths, root, 2);

    expect(one.parallelism).toMatchObject({ used: 1, mode: "single" });
    expect(two.parallelism).toMatchObject({ used: 2, mode: "parallel" });
    expect(JSON.stringify(two.extraction)).toBe(JSON.stringify(one.extraction));
    expect(JSON.stringify(two.extraction)).toBe(JSON.stringify(extractTypeScript(paths, root)));
    expect(two.extraction.modules).toEqual(["a.ts", "b.ts"]);
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
