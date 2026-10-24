import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comparisonValue, readAt, shardIndices, verifyFile } from "./t00-ts7-q-syntax-core.js";

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


test("digest relation compares two actual digests and refuses missing or ambiguous evidence", () => {
  expect(comparisonValue([{ digest: "abc" }, { digest: "abc" }], "outline-digest-relation")).toBe(true);
  expect(comparisonValue([{ digest: "abc" }, { digest: "def" }], "outline-digest-relation")).toBe(false);
  for (const value of [null, [], [{ digest: "abc" }], [{}, {}], [{ digest: "" }, { digest: "" }],
    [{ digest: 1 }, { digest: 1 }], [{ digest: "a" }, { digest: "a" }, { digest: "a" }]])
    expect(() => comparisonValue(value, "outline-digest-relation")).toThrow();
});

test("opaque callback projection keeps graph refusal transitions and rejects absent evidence", () => {
  expect(comparisonValue(["SOURCE_OPAQUE_CALLBACK_UNSUPPORTED"], "opaque-callback-reason")).toBe(true);
  expect(comparisonValue([], "opaque-callback-reason")).toBe(false);
  expect(comparisonValue(["OTHER_REASON"], "opaque-callback-reason")).toBe(false);
  for (const value of [null, [null], [1], [{}]])
    expect(() => comparisonValue(value, "opaque-callback-reason")).toThrow();
});

test("graph call count detects invented and missing call edges while refusing malformed facts", () => {
  expect(comparisonValue([{ kind: "contains" }, { kind: "calls" }], "call-edge-count")).toBe(1);
  expect(comparisonValue([{ kind: "contains" }], "call-edge-count")).toBe(0);
  expect(comparisonValue([], "call-edge-count")).toBe(0);
  for (const value of [null, [null], [{}], [{ kind: 1 }]])
    expect(() => comparisonValue(value, "call-edge-count")).toThrow();
});

test("construction refusal projection distinguishes absence from unreadable observations", () => {
  expect(comparisonValue(["SOURCE_CONSTRUCTION_UNSUPPORTED"], "construction-reason")).toBe(true);
  expect(comparisonValue([], "construction-reason")).toBe(false);
  expect(comparisonValue(["OTHER_REASON"], "construction-reason")).toBe(false);
  expect(() => comparisonValue([null], "construction-reason")).toThrow();
});
