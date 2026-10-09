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

describe("readHandoff — absence and malformed artifacts remain distinct", () => {
  it("returns undefined only when the handoff is absent", () => {
    root = mkdtempSync(join(tmpdir(), "semctx-handoff-"));
    expect(readHandoff(root)).toBeUndefined();
  });

  it("rejects a literal null as a partial capsule", () => {
    expectHandoffError(() => readHandoff(withHandoff("null")), "CAPSULE_INVALID");
  });

  it("rejects a structurally partial object with a distinct reason", () => {
    expectHandoffError(
      () => readHandoff(withHandoff('{"version":1,"createdAt":"2026-01-01"}')),
      "CAPSULE_INVALID",
    );
  });

  it("rejects invalid JSON with a distinct reason", () => {
    expectHandoffError(() => readHandoff(withHandoff("{not json")), "INVALID_JSON");
  });

  it.each([2, "1", null])("rejects unsupported capsule version %j", (version) => {
    const capsule = buildHandoffCapsule({ root: "/r", now: "2026-07-05", model: { nodes: [], changes: [] } });
    expectHandoffError(() => readHandoff(withHandoff(JSON.stringify({ ...capsule, version }))), "CAPSULE_INVALID");
  });

  for (const field of ["createdAt", "version", "touchedInvariants", "proofsObtained", "pendingProofs", "activeAssumptions", "exploredLinks", "openUnknowns", "nextValidations"]) {
    it(`rejects missing required field ${field}`, () => {
      const capsule: Record<string, unknown> = { ...buildHandoffCapsule({ root: "/r", now: "2026-07-05", model: { nodes: [], changes: [] } }) };
      delete capsule[field];
      expectHandoffError(() => readHandoff(withHandoff(JSON.stringify(capsule))), "CAPSULE_INVALID");
    });
  }

  for (const field of ["touchedInvariants", "proofsObtained", "pendingProofs", "activeAssumptions", "exploredLinks", "openUnknowns", "nextValidations"]) {
    it.each([42, null, {}, ["nested"]].map((element) => ({ element })))(`rejects a non-string element in ${field}: %j`, ({ element }) => {
      const capsule = buildHandoffCapsule({ root: "/r", now: "2026-07-05", model: { nodes: [], changes: [] } });
      expectHandoffError(() => readHandoff(withHandoff(JSON.stringify({ ...capsule, [field]: ["valid", element] }))), "CAPSULE_INVALID");
    });
  }

  for (const field of ["activeChangeId", "changeLifecycle", "statement", "note"]) {
    it.each([42, null, [], {}].map((value) => ({ value })))(`rejects a non-string optional ${field}: %j`, ({ value }) => {
      const capsule = buildHandoffCapsule({ root: "/r", now: "2026-07-05", model: { nodes: [], changes: [] } });
      expectHandoffError(() => readHandoff(withHandoff(JSON.stringify({ ...capsule, [field]: value }))), "CAPSULE_INVALID");
    });
  }

  it("names the schema failure and identifies the invalid field", () => {
    const capsule = buildHandoffCapsule({ root: "/r", now: "2026-07-05", model: { nodes: [], changes: [] } });
    for (const [patch, code, path] of [
      [{ version: 2 }, "invalid_literal", ["version"]],
      [{ proofsObtained: [42] }, "invalid_type", ["proofsObtained", 0]],
      [{ createdAt: undefined }, "invalid_type", ["createdAt"]],
    ] as const) {
      let caught: unknown;
      try { readHandoff(withHandoff(JSON.stringify({ ...capsule, ...patch }))); }
      catch (error) { caught = error; }
      expect(caught).toMatchObject({
        code: "CONFIG_INVALID",
        details: { reason: "CAPSULE_INVALID", issues: expect.arrayContaining([expect.objectContaining({ code, path })]) },
      });
      rmSync(root!, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("accepts a well-formed capsule round-trip", () => {
    const capsule = buildHandoffCapsule({ root: "/r", now: "2026-07-05T00:00:00.000Z", model: { nodes: [], changes: [] } });
    expect(readHandoff(withHandoff(JSON.stringify(capsule)))).toEqual(capsule);
  });
});

function expectHandoffError(action: () => unknown, reason: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect((caught as { code?: string } | undefined)?.code).toBe("CONFIG_INVALID");
  expect((caught as { details?: { reason?: string } } | undefined)?.details?.reason).toBe(reason);
}
