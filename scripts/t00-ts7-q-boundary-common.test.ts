import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asset, checkAsset, createContext, isolatedEnvironment, parseArguments, resultStatus, sdkMatchesLibraries, selectShard } from "./t00-ts7-q-boundary-common";

test("shards partition obligations deterministically and reject invalid boundaries", () => {
  const ids = [0, 1, 2, 3, 4, 5];
  expect(selectShard(ids, "1/2")).toEqual([0, 2, 4]);
  expect(selectShard(ids, "2/2")).toEqual([1, 3, 5]);
  for (const value of ["0/2", "3/2", "1/0", "1/2junk", "1.5/2"]) expect(() => selectShard(ids, value)).toThrow();
});

test("CLI refuses missing, unknown and duplicate flags", () => {
  expect(parseArguments(["--candidate", "c", "--platform", "macos", "--out", "o"]).platform).toBe("macos");
  for (const args of [[], ["--candidate"], ["--platform", "windows"], ["--out", "a", "--out", "b"], ["--unknown", "x"]]) expect(() => parseArguments(args)).toThrow();
});

test("qualification refuses rehearsal, empty evidence, incomplete and failed properties", () => {
  const observation = { index: 5, complete: true, reason: "", properties: [{ name: "control", pass: true, expected: 1, actual: 1, oracle: "contract" }], evidence: [{ path: "/evidence", sha256: "a".repeat(64), bytes: 1 }] };
  expect(resultStatus(observation, false)).toBe("qualified");
  expect(resultStatus(observation, true)).toBe("not_qualified");
  expect(resultStatus({ ...observation, evidence: [] }, false)).toBe("not_qualified");
  expect(resultStatus({ ...observation, properties: [] }, false)).toBe("not_qualified");
  expect(resultStatus({ ...observation, complete: false }, false)).toBe("not_qualified");
  expect(resultStatus({ ...observation, properties: [{ ...observation.properties[0]!, pass: false }] }, false)).toBe("not_qualified");
});

test("artifact verification detects altered bytes, size and missing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "t00-boundary-assets-"));
  try {
    const path = join(root, "producer");
    await writeFile(path, "original");
    const pinned = await asset(path);
    await checkAsset(pinned);
    await writeFile(path, "modified");
    await rejects(checkAsset(pinned), /mismatch/);
    await rejects(checkAsset({ ...pinned, bytes: 0 }));
    await rm(path);
    await rejects(checkAsset(pinned));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK comparison requires every independent library exactly once with unchanged bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "t00-boundary-sdk-"));
  try {
    const files: Record<string, string> = {};
    const inventory = [];
    for (let index = 0; index < 115; index++) {
      const name = `lib.${index}.d.ts`, text = `declare const library${index}: string;`;
      await writeFile(join(root, name), text);
      inventory.push({ ...await asset(join(root, name)), path: name });
      files[`/sdk/lib/${name}`] = text;
    }
    const manifest = join(root, "manifest.json");
    await writeFile(manifest, JSON.stringify(inventory));
    expect(await sdkMatchesLibraries({ files }, root, manifest)).toBe(true);
    const repeated = Object.fromEntries(Array.from({ length: 115 }, (_, index) => [`/sdk/${index}/lib.0.d.ts`, files["/sdk/lib/lib.0.d.ts"]]));
    expect(await sdkMatchesLibraries({ files: repeated }, root, manifest)).toBe(false);
    expect(await sdkMatchesLibraries({ files: { ...files, "/sdk/lib/lib.0.d.ts": "altered" } }, root, manifest)).toBe(false);
    const missing = { ...files }; delete missing["/sdk/lib/lib.0.d.ts"];
    expect(await sdkMatchesLibraries({ files: missing }, root, manifest)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fixture Git ignores inherited external index and repository selectors", async () => {
  const root = await mkdtemp(join(tmpdir(), "t00-boundary-git-"));
  const previousIndex = process.env.GIT_INDEX_FILE;
  try {
    const external = join(root, "foreign-index");
    process.env.GIT_INDEX_FILE = external;
    const env = isolatedEnvironment(root);
    const initialized = Bun.spawnSync(["git", "init", "-q", root], { env });
    expect(initialized.exitCode).toBe(0);
    await writeFile(join(root, "file"), "fixture");
    const staged = Bun.spawnSync(["git", "-C", root, "add", "--", "file"], { env });
    expect(staged.exitCode).toBe(0);
    await access(join(root, ".git/index"));
    await rejects(access(external));
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_CONFIG_GLOBAL"]) expect(env[key]).toBeUndefined();
  } finally {
    if (previousIndex === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previousIndex;
    await rm(root, { recursive: true, force: true });
  }
});

test("extraction proof refuses an omitted independent oracle", async () => {
  const root = await mkdtemp(join(tmpdir(), "t00-boundary-oracle-"));
  try {
    const sdk = join(root, "sdk.json");
    await writeFile(sdk, "{}");
    const evidence = await asset(sdk);
    const context = await createContext(root, "macos", { producer: evidence, helper: evidence, observer: evidence, sdk: evidence, oracle: evidence, oracleLibraries: evidence });
    await rejects(context.extractionOracle("missing", { files: {}, roots: [] }), /independent extraction oracle missing/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
