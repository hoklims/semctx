/**
 * Persistence for local, voluntary finding feedback (ADR 0021 / HOK-645).
 *
 * A single versioned JSON file confined under `.semctx/feedback/`. Reads never create it; writes
 * are atomic (temp file + rename) and optimistic-concurrency-checked against the digest of the
 * content the caller last read, so two interleaved writers cannot silently lose one's update.
 * Never mutates or initializes `.semctx/config.json`.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { SemctxError } from "@semantic-context/core";
import { FeedbackStoreFileSchema } from "@semantic-context/core";
import type { FeedbackStoreFileV1 } from "@semantic-context/core";
import { isLinkedEntry, semctxDir } from "./workspace";

export const FEEDBACK_DIR_NAME = "feedback";
export const FEEDBACK_FILE_NAME = "records.json";

export function feedbackDir(root: string): string {
  return join(semctxDir(root), FEEDBACK_DIR_NAME);
}

export function feedbackFilePath(root: string): string {
  return join(feedbackDir(root), FEEDBACK_FILE_NAME);
}

function contentDigestOf(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function assertNotSymlink(path: string, describe: string): void {
  // Only an absent entry passes; any other `lstat` failure is a real error, not a pass.
  if (isLinkedEntry(path)) {
    throw new SemctxError("STORE_ERROR", `${describe} must not be a symlink`, { path });
  }
}

/** Refuses a path that resolves outside `root` once every symlink in its chain is followed. */
function assertWithinRoot(root: string, path: string, describe: string): void {
  if (!existsSync(path)) return;
  const realRoot = realpathSync.native(resolve(root));
  const realPath = realpathSync.native(path);
  if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${sep}`)) {
    throw new SemctxError("STORE_ERROR", `${describe} escapes the repository root`, { root, path });
  }
}

function confine(root: string, path: string, describe: string): void {
  assertNotSymlink(path, describe);
  assertWithinRoot(root, path, describe);
}

function confineFeedbackAncestors(root: string): void {
  const resolvedRoot = resolve(root);
  if (!existsSync(resolvedRoot)) {
    throw new SemctxError("STORE_ERROR", "repository root does not exist");
  }
  // The root itself may be reached through a link (a checkout behind a symlinked projects
  // directory); only what lies below it must be link-free.
  assertWithinRoot(resolvedRoot, resolvedRoot, "repository root");
  confine(resolvedRoot, semctxDir(resolvedRoot), "Semctx directory");
  confine(resolvedRoot, feedbackDir(resolvedRoot), "feedback directory");
}

export type FeedbackStoreReadStatus = "absent" | "ok" | "corrupted";

export interface FeedbackStoreReadResult {
  status: FeedbackStoreReadStatus;
  file: FeedbackStoreFileV1 | undefined;
  /** Digest of the raw on-disk bytes, for optimistic-concurrency writes. `undefined` when absent/corrupted. */
  digest: string | undefined;
  path: string;
}

/** Query the store. Never creates `.semctx/feedback/` or `.semctx/` — an absent store stays absent. */
export function readFeedbackStore(root: string): FeedbackStoreReadResult {
  confineFeedbackAncestors(root);
  const dir = feedbackDir(root);
  const path = feedbackFilePath(root);
  confine(root, dir, "feedback directory");
  confine(root, path, "feedback store file");
  if (!existsSync(path)) return { status: "absent", file: undefined, digest: undefined, path };

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new SemctxError("STORE_ERROR", "failed to read feedback store", { path, cause: String(cause) });
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { status: "corrupted", file: undefined, digest: undefined, path };
  }
  const parsed = FeedbackStoreFileSchema.safeParse(parsedJson);
  if (!parsed.success) return { status: "corrupted", file: undefined, digest: undefined, path };
  return { status: "ok", file: parsed.data, digest: contentDigestOf(raw), path };
}

/**
 * Replace the store atomically. `expectedDigest` must equal the digest last observed via
 * `readFeedbackStore` (`undefined` when the caller last observed it absent); a mismatch means a
 * concurrent writer won the race and throws `FEEDBACK_CONFLICT` without touching the file, so the
 * caller can re-read and retry instead of silently losing the other writer's update.
 */
export function writeFeedbackStore(root: string, expectedDigest: string | undefined, file: FeedbackStoreFileV1): void {
  confineFeedbackAncestors(root);
  const dir = feedbackDir(root);
  const path = feedbackFilePath(root);
  confine(root, dir, "feedback directory");
  confine(root, path, "feedback store file");

  const validated = FeedbackStoreFileSchema.parse(file);
  mkdirSync(dir, { recursive: true });
  confineFeedbackAncestors(root);
  const lock = `${path}.lock`;
  // The lock has a fixed name, so a checkout can plant it: Windows `CREATE_NEW` follows a
  // dangling link and would create the lock outside the repository.
  assertNotSymlink(lock, "feedback writer lock");
  let lockFd: number;
  try {
    lockFd = openSync(lock, "wx");
  } catch (cause) {
    const exists = (cause as NodeJS.ErrnoException).code === "EEXIST";
    throw new SemctxError("STORE_ERROR", exists
      ? "feedback writer lock exists: wait for the active writer; after an interrupted writer, inspect .semctx/feedback/records.json.lock and follow the documented manual recovery before retrying"
      : "unable to acquire the feedback writer lock; check repository permissions");
  }
  const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(lockFd, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
    const currentDigest = existsSync(path) ? contentDigestOf(readFileSync(path, "utf8")) : undefined;
    if (currentDigest !== expectedDigest) {
      throw new SemctxError("FEEDBACK_CONFLICT", "feedback store changed since it was last read; re-read and retry");
    }
    writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(tmp, path);
  } finally {
    closeSync(lockFd);
    if (existsSync(tmp)) unlinkSync(tmp);
    if (existsSync(lock)) unlinkSync(lock);
  }
}
