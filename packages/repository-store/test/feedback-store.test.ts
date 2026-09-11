import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyFeedbackStoreFile } from "@semantic-context/core";
import {
  feedbackDir,
  feedbackFilePath,
  readFeedbackStore,
  writeFeedbackStore,
} from "../src";

const roots: string[] = [];
function root(): string {
  const value = mkdtempSync(join(tmpdir(), "semctx-feedback-store-"));
  roots.push(value);
  return value;
}
afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("feedback store", () => {
  test("an absent read creates no Semctx state", () => {
    const repository = root();
    expect(readFeedbackStore(repository).status).toBe("absent");
    expect(existsSync(join(repository, ".semctx"))).toBe(false);
  });

  test("a stale digest and an active writer lock preserve existing bytes", () => {
    const repository = root();
    writeFeedbackStore(repository, undefined, emptyFeedbackStoreFile());
    const before = readFileSync(feedbackFilePath(repository));
    expect(() => writeFeedbackStore(repository, "stale", emptyFeedbackStoreFile())).toThrow("changed since it was last read");
    expect(readFileSync(feedbackFilePath(repository)).equals(before)).toBe(true);
    writeFileSync(`${feedbackFilePath(repository)}.lock`, "held");
    expect(() => writeFeedbackStore(repository, readFeedbackStore(repository).digest, emptyFeedbackStoreFile())).toThrow("manual recovery");
    expect(readFileSync(`${feedbackFilePath(repository)}.lock`, "utf8")).toBe("held");
    rmSync(`${feedbackFilePath(repository)}.lock`); // explicit recovery after confirming no active writer
    writeFeedbackStore(repository, readFeedbackStore(repository).digest, emptyFeedbackStoreFile());
    expect(readFileSync(feedbackFilePath(repository)).equals(before)).toBe(true);
  });

  test("corruption is reported without rewriting the file", () => {
    const repository = root();
    mkdirSync(feedbackDir(repository), { recursive: true });
    writeFileSync(feedbackFilePath(repository), "{broken");
    expect(readFeedbackStore(repository).status).toBe("corrupted");
    expect(readFileSync(feedbackFilePath(repository), "utf8")).toBe("{broken");
  });

  test("a planted writer-lock link is refused before the lock is created through it", () => {
    const repository = root();
    const outside = root();
    mkdirSync(feedbackDir(repository), { recursive: true });
    let planted = true;
    try {
      // Dangling on purpose: Windows `CREATE_NEW` would follow it and create the lock outside.
      symlinkSync(join(outside, "planted-lock"), `${feedbackFilePath(repository)}.lock`, "file");
    } catch {
      planted = false;
    }
    if (!planted) return;

    expect(() => writeFeedbackStore(repository, undefined, emptyFeedbackStoreFile())).toThrow("must not be a symlink");
    expect(existsSync(join(outside, "planted-lock"))).toBe(false);
    expect(existsSync(feedbackFilePath(repository))).toBe(false);
  });

  test("a feedback-directory junction outside the repository is rejected", () => {
    const repository = root();
    const outside = root();
    mkdirSync(join(repository, ".semctx"));
    symlinkSync(outside, feedbackDir(repository), "junction");
    expect(() => readFeedbackStore(repository)).toThrow("must not be a symlink");
    expect(existsSync(join(outside, "records.json"))).toBe(false);
  });

  test("a dangling store link is not misreported absent or replaced by a write", () => {
    const repository = root(); const outside = root();
    mkdirSync(feedbackDir(repository), { recursive: true });
    symlinkSync(join(outside, "missing"), feedbackFilePath(repository), process.platform === "win32" ? "junction" : "file");
    expect(() => readFeedbackStore(repository)).toThrow("symlink");
    expect(() => writeFeedbackStore(repository, undefined, emptyFeedbackStoreFile())).toThrow("symlink");
    expect(existsSync(join(outside, "missing"))).toBe(false);
  });
});
