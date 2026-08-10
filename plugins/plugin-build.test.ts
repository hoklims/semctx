import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  PLUGIN_BUILD_BUN_VERSION,
  assertPluginBuildBunVersion,
  assertPluginRuntimeArtifactsExact,
  buildPortablePluginArtifacts,
} from "../scripts/build-plugin-runtime";

const repoRoot = resolve(import.meta.dir, "..");
const portableTypeScriptPrelude =
  'var __dirname=import.meta.dir+"/typescript-lib",__filename=__dirname+"/typescript.js";';
const temporary: string[] = [];
let builtArtifacts: Promise<Map<string, Uint8Array>> | undefined;

function artifacts(): Promise<Map<string, Uint8Array>> {
  builtArtifacts ??= buildPortablePluginArtifacts();
  return builtArtifacts;
}

function chunkPath(paths: string[]): string {
  const chunks = paths.filter((path) => path === "semctx-shared.js");
  expect(chunks).toHaveLength(1);
  return chunks[0]!;
}

function materialize(built: Map<string, Uint8Array>): string {
  const dist = mkdtempSync(join(tmpdir(), "semctx-plugin-artifacts-"));
  temporary.push(dist);
  for (const [relativePath, bytes] of built) {
    const output = resolve(dist, relativePath);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, bytes);
  }
  return dist;
}

afterEach(() => {
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("split plugin runtime build", () => {
  test("emits both public entries and one shared chunk", async () => {
    const built = await artifacts();
    const paths = [...built.keys()].sort();

    expect(paths).toContain("semctx-mcp.js");
    expect(paths).toContain("semctx.js");
    expect(paths).toHaveLength(3);
    chunkPath(paths);
  }, 30_000);

  test("places the portable TypeScript payload only in the shared chunk", async () => {
    const built = await artifacts();
    const paths = [...built.keys()];
    const sharedChunk = chunkPath(paths);

    for (const [relativePath, bytes] of built) {
      const body = new TextDecoder().decode(bytes);
      expect(body).not.toContain(JSON.stringify(repoRoot).slice(1, -1));
      expect(body).not.toMatch(/typescript@[^"']+node_modules[^"']+typescript[^"']+lib/);
      expect(body.includes(portableTypeScriptPrelude)).toBe(relativePath === sharedChunk);
    }
  }, 30_000);

  test("diagnoses an unsupported Bun generator version", () => {
    expect(Bun.version).toBe(PLUGIN_BUILD_BUN_VERSION);
    expect(() => assertPluginBuildBunVersion("0.0.0-test")).toThrow(
      new RegExp(`requires Bun ${PLUGIN_BUILD_BUN_VERSION}`),
    );
  });
});

describe("exact plugin runtime artifact set", () => {
  test("accepts the complete generated set", async () => {
    const built = await artifacts();
    const dist = materialize(built);

    expect(() => assertPluginRuntimeArtifactsExact(dist, built)).not.toThrow();
  }, 30_000);

  test("rejects a missing shared chunk", async () => {
    const built = await artifacts();
    const dist = materialize(built);
    const sharedChunk = chunkPath([...built.keys()]);
    rmSync(resolve(dist, sharedChunk));

    expect(() => assertPluginRuntimeArtifactsExact(dist, built)).toThrow(/artifact set/);
  }, 30_000);

  test("rejects stale shared chunk bytes", async () => {
    const built = await artifacts();
    const dist = materialize(built);
    const sharedChunk = chunkPath([...built.keys()]);
    writeFileSync(resolve(dist, sharedChunk), "stale");

    expect(() => assertPluginRuntimeArtifactsExact(dist, built)).toThrow(/stale generated plugin artifact/);
  }, 30_000);

  test("rejects an extra generated chunk", async () => {
    const built = await artifacts();
    const dist = materialize(built);
    const extra = resolve(dist, "stale-extra.js");
    mkdirSync(dirname(extra), { recursive: true });
    writeFileSync(extra, "extra");

    expect(() => assertPluginRuntimeArtifactsExact(dist, built)).toThrow(/artifact set/);
  }, 30_000);
});
