import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePrePushHook, parsePrePushRefs } from "../src";

const OID = "a".repeat(40);
const ZERO = "0".repeat(40);

describe("parsePrePushRefs", () => {
  it("parses Git's four-field lines, tolerating blank lines and CRLF", () => {
    const refs = parsePrePushRefs(`refs/heads/main ${OID} refs/heads/main ${ZERO}\r\n\n(delete) ${ZERO} refs/heads/old ${OID}\n`);
    expect(refs).toEqual([
      { localRef: "refs/heads/main", localObjectId: OID, remoteRef: "refs/heads/main", remoteObjectId: ZERO },
      { localRef: "(delete)", localObjectId: ZERO, remoteRef: "refs/heads/old", remoteObjectId: OID },
    ]);
    expect(parsePrePushRefs("")).toEqual([]);
  });

  it("rejects lines that are not four fields with object ids", () => {
    expect(() => parsePrePushRefs("not a ref line")).toThrow("pre-push stdin must carry");
    expect(() => parsePrePushRefs(`refs/heads/main notanoid refs/heads/main ${ZERO}`)).toThrow("pre-push stdin must carry");
  });
});

describe("evaluatePrePushHook — unreadable stdin", () => {
  it("refuses instead of falling back to HEAD when the ref stream could not be read", () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-hook-stdin-"));
    try {
      const outcome = evaluatePrePushHook(root, null);
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("unreachable");
      expect(outcome.reason).toBe("STDIN_UNREADABLE");
      expect(outcome.message).toContain("only an empty ref stream may fall back to HEAD");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
