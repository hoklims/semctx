import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHandoff, handoffJsonPath, workingDir, buildHandoffCapsule } from "../src/index";

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function withHandoff(content: string): string {
  root = mkdtempSync(join(tmpdir(), "semctx-handoff-"));
  mkdirSync(workingDir(root), { recursive: true });
  writeFileSync(handoffJsonPath(root), content, "utf8");
  return root;
}

describe("readHandoff — malformed files degrade to undefined (never crash resume)", () => {
  it("rejects a literal null", () => {
    expect(readHandoff(withHandoff("null"))).toBeUndefined();
  });

  it("rejects a structurally partial object (older schema, missing array fields)", () => {
    expect(readHandoff(withHandoff('{"version":1,"createdAt":"2026-01-01"}'))).toBeUndefined();
  });

  it("rejects invalid JSON", () => {
    expect(readHandoff(withHandoff("{not json"))).toBeUndefined();
  });

  it("accepts a well-formed capsule round-trip", () => {
    const capsule = buildHandoffCapsule({ root: "/r", now: "2026-07-05T00:00:00.000Z", model: { nodes: [], changes: [] } });
    expect(readHandoff(withHandoff(JSON.stringify(capsule)))?.createdAt).toBe("2026-07-05T00:00:00.000Z");
  });
});
