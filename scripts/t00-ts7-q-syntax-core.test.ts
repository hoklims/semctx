import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAt, shardIndices, verifyFile } from "./t00-ts7-q-syntax-core.js";

test("shards partition indices independently of input ordering and reject invalid slices", () => {
  expect(shardIndices([9, 2, 5, 0], "1/2")).toEqual([0, 5]);
  expect(shardIndices([9, 2, 5, 0], "2/2")).toEqual([2, 9]);
  for (const shard of ["0/2", "3/2", "1/0", "1.5/2", "1/2/3"])
    expect(() => shardIndices([0], shard)).toThrow();
});

test("exact comparison paths distinguish absent fields, null and empty arrays", () => {
  expect(readAt({ rows: [{ x: null }] }, ["rows", 0, "x"])).toBeNull();
  expect(readAt({ rows: [] }, ["rows"])).toEqual([]);
  expect(() => readAt({ rows: [] }, ["rows", 0])).toThrow("missing");
  expect(() => readAt({}, ["toString"])).toThrow("missing");
});

test("artifact verification refuses changed bytes, missing files and forged lengths", async () => {
  const root = await mkdtemp(join(tmpdir(), "t00-ts7-q-syntax-integrity-"));
  try {
    const path = join(root, "artifact");
    await writeFile(path, "trusted");
    const ref = { path, bytes: 7, sha256: createHash("sha256").update("trusted").digest("hex") };
    expect(await verifyFile(ref)).toEqual(ref);
    expect(await verifyFile({ ...ref, bytes: 8 }).catch(error => error as unknown)).toBeInstanceOf(Error);
    await writeFile(path, "changed");
    expect(await verifyFile(ref).catch(error => error as unknown)).toBeInstanceOf(Error);
    await rm(path);
    expect(await verifyFile(ref).catch(error => error as unknown)).toBeInstanceOf(Error);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
