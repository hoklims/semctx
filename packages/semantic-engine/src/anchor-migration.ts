/**
 * One-shot rewrite of deprecated line-bearing symbol anchors to their canonical form.
 *
 * This module is **temporary by construction**. It exists to move one population of anchors across
 * one identity change, and it is meant to be deleted in the release that retires
 * `LEGACY_SYMBOL_ANCHOR_SUPPORT`. It is not a general "rewrite authored intent" facility, and
 * nothing else may grow on top of it: rewriting what a human wrote is a privilege scoped to a
 * migration nobody has to repeat.
 *
 * Four properties decide its shape.
 *
 * It is *unauthorized until proved otherwise*. Anchors are resolved against an index, so an index
 * that is absent, stale, unsealed, mis-bound, or written under a schema this build no longer
 * normalizes cannot authorize a rewrite of authored files. The verdict is supplied by the caller —
 * the canonical control and freshness services live above this layer — and it is **re-asked
 * immediately before the first write**, so an index that expires mid-run stops the run.
 *
 * It is *textual*. Round-tripping through the parser and `formatModel` would drop every comment in
 * a versioned `.sem` file, so the migration edits `link:` lines in place. What lands in Git is a
 * diff a human can read line by line, which is the only way a maintainer can audit a rewrite that
 * touched authored intent.
 *
 * It *refuses* rather than guesses. An anchor matching several symbols, or none, is left exactly as
 * written. Picking one would be the silent rebinding the whole identity change exists to prevent.
 *
 * It is *atomic across the whole run*. Every rewrite is computed before anything is written, a
 * single refusal anywhere stops every write in the run, each write goes to an unpredictable
 * exclusive temporary inside the target's own directory, and a failure part-way restores every file
 * already replaced. The tree is therefore always entirely migrated or entirely untouched.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { SemctxError, attachSuppressedError, compareIds } from "@semantic-context/core";
import { parseSemanticSource } from "@semantic-context/semantic-dsl";
import {
  LEGACY_SYMBOL_ANCHOR_SUPPORT,
  buildRepositoryLinkIndex,
  repositoryLinkFromRef,
  resolveRepositoryLink,
  type LinkResolutionReasonCode,
  type RepositoryFacts,
} from "@semantic-context/semantic-model";
import { listSemFiles, relFile } from "./store";
import { semanticDir } from "./paths";
import { locateLinkRefs, type LocatedLinkRef } from "./anchor-link-locator";

export { LEGACY_SYMBOL_ANCHOR_SUPPORT };

/**
 * Why the index could not authorize a rewrite of authored files.
 *
 * Each code names a distinct failure of the same question — "does this index still speak for the
 * working tree?" — because the repairs differ: re-index, commit or revert, or rebuild a store that
 * predates the current binding.
 */
export const ANCHOR_MIGRATION_AUTHORITY_REASONS = [
  "INDEX_ABSENT",
  "INDEX_BINDING_INVALID",
  "INDEX_STALE",
  "INDEX_UNSEALED",
  "INDEX_SCHEMA_UNNORMALIZED",
  "INDEX_GENERATION_DRIFTED",
  "LEGACY_SUPPORT_REMOVED",
] as const;

export type AnchorMigrationAuthorityReason = (typeof ANCHOR_MIGRATION_AUTHORITY_REASONS)[number];

/**
 * Which immutable index generation a verdict was computed over.
 *
 * A verdict is a statement about one state of one index. Re-asking "is this still authorized?"
 * answers a question about whatever index exists *then*, so a re-index between planning and writing
 * can hand back a perfectly green verdict that licenses a plan built from facts that no longer
 * exist. Naming the generation turns "still authorized" into "still authorized, and still the same
 * index", which is the only version of the question worth asking.
 *
 * Both fields are needed. `snapshot` identifies the sealed Plane-A state; `facts` identifies the
 * repository facts that state binds, and is what the plan itself was resolved against.
 */
export interface AnchorMigrationGeneration {
  /** Fingerprint of the Plane-A index snapshot the verdict was computed over. */
  snapshot: string;
  /** The repository-facts hash that snapshot binds. A plan may only use facts hashing to this. */
  facts: string;
}

export interface AnchorMigrationAuthority {
  status: "authorized" | "refused";
  /** Sorted and unique, so two runs over the same state report the same thing. */
  reasons: AnchorMigrationAuthorityReason[];
  /**
   * The generation this verdict speaks for. `null` on a refusal, and on an authorization from a
   * caller that cannot identify one — which is itself refused before any plan is built, because an
   * unidentifiable generation cannot be shown to be the same one later.
   */
  generation: AnchorMigrationGeneration | null;
}

function sameGeneration(
  left: AnchorMigrationGeneration | null,
  right: AnchorMigrationGeneration | null,
): boolean {
  return left !== null
    && right !== null
    && left.snapshot === right.snapshot
    && left.facts === right.facts;
}

export type AnchorMigrationOutcome =
  | { status: "rewritten"; file: string; line: number; from: string; to: string }
  | { status: "already_canonical"; file: string; line: number; ref: string }
  | {
      status: "refused";
      file: string;
      line: number;
      ref: string;
      reasonCode: LinkResolutionReasonCode | "LINK_SYNTAX_UNREWRITABLE";
      candidates: string[];
    };

export interface AnchorMigrationFileResult {
  file: string;
  /** True only when the file was, or would be, rewritten. A refused run changes nothing. */
  changed: boolean;
  outcomes: AnchorMigrationOutcome[];
}

export interface AnchorMigrationReport {
  schemaVersion: 1;
  kind: "anchor_migration";
  /** False for a dry run, and false for an apply the authority refused: nothing was written. */
  applied: boolean;
  /** The index verdict this run was allowed to act on, re-checked before any write. */
  authority: AnchorMigrationAuthority;
  files: AnchorMigrationFileResult[];
  counts: { rewritten: number; refused: number; alreadyCanonical: number; filesChanged: number };
  /** True when at least one anchor could not be migrated without guessing. */
  hasRefusals: boolean;
}

/**
 * `generation` is required rather than optional on purpose: "authorized" is not expressible without
 * naming the index generation the verdict speaks for, so no caller can forget to bind one.
 */
export function authorized(generation: AnchorMigrationGeneration): AnchorMigrationAuthority {
  return { status: "authorized", reasons: [], generation };
}

export function refusedAuthority(
  reasons: readonly AnchorMigrationAuthorityReason[],
): AnchorMigrationAuthority {
  const unique = [...new Set(reasons)].sort(compareIds);
  return { status: "refused", reasons: unique, generation: null };
}

/**
 * A path is inside the semantic directory *after* every link and junction has been resolved.
 *
 * `listSemFiles` already refuses a symlinked `.sem` file, but a junction standing in for a
 * subdirectory would still hand back paths whose real location is outside the tree. Writing there
 * would put a rewrite of authored intent somewhere nobody is reviewing.
 */
function assertWithinSemanticDir(rootReal: string, absPath: string): string {
  let directoryReal: string;
  try {
    directoryReal = realpathSync(dirname(absPath));
  } catch (error) {
    throw new SemctxError("CONFIG_INVALID", "semantic model directory could not be resolved", {
      file: absPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (directoryReal !== rootReal && !directoryReal.startsWith(`${rootReal}${sep}`)) {
    throw new SemctxError("CONFIG_INVALID", "semantic model file resolves outside .semctx/semantic", {
      file: absPath,
      resolvedDirectory: directoryReal,
    });
  }
  return join(directoryReal, absPath.slice(dirname(absPath).length + 1));
}

/**
 * Every file-system effect the apply phase performs, as one narrow port.
 *
 * It exists so the failure paths have deterministic, portable oracles. A temporary name that
 * collides, a staging error part-way through a run, and a rename that fails after other renames
 * succeeded are the three moments where this command could damage authored files — and none of them
 * can be provoked reliably through the real filesystem. A read-only bit is ignored by some
 * filesystems, so a test that depends on it does not fail there, it *vanishes* there, which is worse
 * than having no test: the suite still reports green.
 *
 * The default implementation is the only one used in production; `migrateAnchors` never exposes a
 * way to skip it by accident, because the field is optional and defaults to it.
 */
export interface AnchorMigrationFileSystem {
  readFile(path: string): string;
  /** Optional binary extension; omitted adapters retain the historical UTF-8 string contract. */
  readFileBytes?(path: string): Buffer;
  /**
   * `O_CREAT | O_EXCL`. Throws when anything already occupies the path — a stale `.tmp`, a file
   * planted by another process, or a symlink pointing elsewhere — so a pre-existing name can never
   * redirect a write. The caller answers a throw here by trying another name.
   */
  claimExclusive(path: string): number;
  /** Write the claimed path and close it. On failure the partial file is removed before rethrowing. */
  fillAndClose(handle: number, path: string, content: string): void;
  rename(from: string, to: string): void;
  writeFile(path: string, content: string): void;
  remove(path: string): void;
  fsyncPath?(path: string): void;
  /** Durably publish a rename/create in a directory, where the platform supports it. */
  syncDirectory?(path: string): void;
  chmod?(path: string, mode: number): void;
  /** Unguessable, so the name cannot be pre-created and turned into a redirect. */
  temporaryName(target: string): string;
}

export const NODE_ANCHOR_MIGRATION_FILE_SYSTEM: AnchorMigrationFileSystem = {
  readFile: (path) => readFileSync(path, "utf8"),
  readFileBytes: (path) => readFileSync(path),
  claimExclusive: (path) => openSync(path, "wx", 0o600),
  fillAndClose: (handle, path, content) => {
    try {
      const bytes = Buffer.from(content, "utf8");
      let written = 0;
      while (written < bytes.length) {
        written += writeSync(handle, bytes, written, bytes.length - written);
      }
      fsyncSync(handle);
    } catch (error) {
      // The exclusive claim succeeded, so this path exists and now holds a partial write. It is not
      // yet known to the run-wide cleanup, so unless it is removed right here it is left behind for
      // good — and a `.tmp` full of half a semantic model is exactly the litter an operator would
      // later mistake for a crashed migration's recoverable state.
      try {
        closeSync(handle);
      } catch {
        // Already closed, or the handle was invalidated by the same fault; the removal still stands.
      }
      rmSync(path, { force: true });
      throw error;
    }
    closeSync(handle);
  },
  rename: (from, to) => {
    renameSync(from, to);
  },
  writeFile: (path, content) => writeFileSync(path, content, "utf8"),
  remove: (path) => rmSync(path, { force: true }),
  fsyncPath: (path) => {
    // Windows rejects FlushFileBuffers on a read-only handle. The transaction owns this temporary,
    // so request a writable handle and propagate every actual flush failure.
    const handle = openSync(path, "r+");
    try {
      fsyncSync(handle);
    } finally { closeSync(handle); }
  },
  syncDirectory: (path) => fsyncDirectory(path),
  chmod: (path, mode) => chmodSync(path, mode),
  temporaryName: (target) => `${target}.${randomBytes(9).toString("hex")}.tmp`,
};

function readBytes(files: AnchorMigrationFileSystem, path: string): Buffer {
  return files.readFileBytes?.(path) ?? Buffer.from(files.readFile(path), "utf8");
}

interface PlannedFile {
  absPath: string;
  result: AnchorMigrationFileResult;
  before: Buffer;
  content: Buffer;
}

/** A line's content and the terminator that actually followed it, kept apart. */
interface SourceLine {
  text: string;
  terminator: string;
}

/**
 * Split into lines that remember their own terminator.
 *
 * Choosing one newline for the whole file and re-joining with it normalizes every line ending in a
 * file that mixes them — and files do mix them, through two editors, a partial `core.autocrlf`
 * conversion, or a patch written by a tool with a different default. Rewriting one anchor is a diff
 * a maintainer can read; rewriting one anchor *and* every line ending is not, and on a shared branch
 * it is a conflict on lines nobody touched.
 *
 * Only LF terminates a line, exactly as the previous `/\r?\n/` split did, so line numbers in
 * outcomes keep their meaning. A CR immediately before it belongs to the terminator; a lone CR
 * anywhere else stays inside the line's text and is written back untouched. Re-joining
 * `text + terminator` reproduces the input byte for byte, including the absence of a final newline.
 */
function splitPreservingTerminators(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "\n") continue;
    const carriage = index > start && source[index - 1] === "\r";
    lines.push({
      text: source.slice(start, carriage ? index - 1 : index),
      terminator: carriage ? "\r\n" : "\n",
    });
    start = index + 1;
  }
  // The remainder after the last terminator, kept even when empty: a file ending in a newline has an
  // empty final segment, and dropping it would delete that newline on the way back out.
  lines.push({ text: source.slice(start), terminator: "" });
  return lines;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8(bytes: Buffer, file: string): string {
  try {
    return UTF8.decode(bytes);
  } catch (error) {
    throw new SemctxError("CONFIG_INVALID", "anchor migration refused invalid UTF-8", {
      reason: "INVALID_UTF8",
      file,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function parsedLinkRefs(source: string, file: string): string[] {
  const parsed = parseSemanticSource(source, file);
  return [...parsed.model.nodes, ...parsed.model.changes]
    .flatMap((item) => item.repositoryLinks.map((link) => link.ref))
    .sort(compareIds);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareIds);
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

interface ByteEdit {
  start: number;
  end: number;
  replacement: Buffer;
}

function absoluteByteSpan(
  lines: readonly SourceLine[],
  span: LocatedLinkRef,
  bytePrefix = 0,
): { start: number; end: number } {
  let lineStart = bytePrefix;
  for (let index = 0; index < span.lineIndex; index += 1) {
    const line = lines[index]!;
    lineStart += Buffer.byteLength(line.text + line.terminator, "utf8");
  }
  const line = lines[span.lineIndex]!;
  return {
    start: lineStart + Buffer.byteLength(line.text.slice(0, span.start), "utf8"),
    end: lineStart + Buffer.byteLength(line.text.slice(0, span.end), "utf8"),
  };
}

function applyByteEdits(before: Buffer, edits: readonly ByteEdit[]): Buffer {
  let out = Buffer.from(before);
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = Buffer.concat([out.subarray(0, edit.start), edit.replacement, out.subarray(edit.end)]);
  }
  return out;
}

function planFile(
  absPath: string,
  relPath: string,
  index: ReturnType<typeof buildRepositoryLinkIndex>,
  files: AnchorMigrationFileSystem,
): PlannedFile {
  const before = readBytes(files, absPath);
  // TextDecoder consumes a UTF-8 BOM before handing text to the DSL parser. Its three bytes still
  // exist in `before`, so every edit offset must explicitly start after them.
  const bytePrefix = before.length >= 3 && before[0] === 0xef && before[1] === 0xbb && before[2] === 0xbf ? 3 : 0;
  const source = decodeUtf8(before, relPath);
  const lines = splitPreservingTerminators(source);
  const located = locateLinkRefs(lines.map((line) => line.text));
  const outcomes: AnchorMigrationOutcome[] = [];
  const parserRefs = uniqueSorted(parsedLinkRefs(source, relPath));
  const locatorRefs = uniqueSorted(located.map((span) => span.ref));
  if (!sameValues(parserRefs, locatorRefs)) {
    outcomes.push({
      status: "refused",
      file: relPath,
      line: 1,
      ref: relPath,
      reasonCode: "LINK_SYNTAX_UNREWRITABLE",
      candidates: [],
    });
    return { absPath, result: { file: relPath, changed: false, outcomes }, before, content: before };
  }

  const edits: ByteEdit[] = [];
  const expected = new Map<string, string>();
  for (const span of located) {
    const ref = span.ref;
    const link = repositoryLinkFromRef(ref);
    if (link.kind !== "symbol") continue;

    const resolution = resolveRepositoryLink(link, index);
    if (resolution.legacy !== true) {
      if (resolution.resolved) {
        outcomes.push({ status: "already_canonical", file: relPath, line: span.lineIndex + 1, ref });
        continue;
      }
      outcomes.push({
        status: "refused",
        file: relPath,
        line: span.lineIndex + 1,
        ref,
        reasonCode: resolution.reasonCode ?? "symbol_gone",
        candidates: resolution.candidates ?? [],
      });
      continue;
    }

    const target = resolution.targets[0];
    if (target === undefined) {
      outcomes.push({
        status: "refused",
        file: relPath,
        line: span.lineIndex + 1,
        ref,
        reasonCode: "ambiguous",
        candidates: resolution.candidates ?? [],
      });
      continue;
    }
    outcomes.push({ status: "rewritten", file: relPath, line: span.lineIndex + 1, from: ref, to: target.id });
    expected.set(ref, target.id);
    edits.push({ ...absoluteByteSpan(lines, span, bytePrefix), replacement: Buffer.from(target.id, "utf8") });
  }

  const wouldChange = outcomes.some((outcome) => outcome.status === "rewritten");
  const content = applyByteEdits(before, edits);
  if (wouldChange) {
    const reparsed = parsedLinkRefs(decodeUtf8(content, relPath), relPath);
    const expectedRefs = parsedLinkRefs(source, relPath)
      .map((ref) => expected.get(ref) ?? ref)
      .sort(compareIds);
    if (!sameValues(reparsed, expectedRefs)) {
      outcomes.length = 0;
      outcomes.push({
        status: "refused",
        file: relPath,
        line: 1,
        ref: relPath,
        reasonCode: "LINK_SYNTAX_UNREWRITABLE",
        candidates: [],
      });
      return { absPath, result: { file: relPath, changed: false, outcomes }, before, content: before };
    }
  }
  return {
    absPath,
    result: { file: relPath, changed: wouldChange, outcomes },
    before,
    content,
  };
}

type TransactionState =
  | "BEGIN"
  | "PREPARED"
  | "REPLACE_STARTED"
  | "REPLACED"
  | "COMMITTED"
  | "ROLLBACK_STARTED"
  | "RESTORED"
  | "ROLLED_BACK";

interface TransactionEntry {
  relPath: string;
  beforeHash: string;
  afterHash: string;
  mode: number;
}

interface TransactionRecord {
  state: TransactionState;
  at: string;
  transactionId?: string;
  entries?: TransactionEntry[];
}

const TRANSACTION_DIRECTORY = "anchor-migration-v1";
const TRANSACTION_ACTIVE = "active";
const TRANSACTION_TOMBSTONE = "cleanup";
const TRANSACTION_OWNER = "owner.json";
const RECOVERY_ACTIVE = "recovery-active";

function transactionDir(root: string): string {
  return join(root, ".semctx", "working", TRANSACTION_DIRECTORY);
}

function transactionActiveDir(root: string): string {
  return join(transactionDir(root), TRANSACTION_ACTIVE);
}

function transactionTombstoneDir(root: string): string {
  return join(transactionDir(root), TRANSACTION_TOMBSTONE);
}

function assertSafeTransactionDirectory(
  root: string,
  files: AnchorMigrationFileSystem,
  create: boolean,
): void {
  const rootReal = realpathSync(root);
  const assertDirectory = (directory: string, expected: string): void => {
    const actual = realpathSync(directory);
    const info = lstatSync(directory);
    if (actual !== expected || info.isSymbolicLink() || !info.isDirectory()) {
      throw new SemctxError("STORE_ERROR", "anchor migration transaction directory is unsafe", {
        reason: "TRANSACTION_WORKSPACE_UNSAFE",
        directory,
        resolvedDirectory: actual,
      });
    }
  };
  const semctx = join(root, ".semctx");
  assertDirectory(semctx, join(rootReal, ".semctx"));
  const working = join(semctx, "working");
  if (!create && !existsSync(working)) return;
  if (create) {
    const created = mkdirSync(working, { recursive: true });
    if (created !== undefined) syncDirectory(files, semctx);
  }
  assertDirectory(working, join(rootReal, ".semctx", "working"));
  const directory = transactionDir(root);
  if (!create && !existsSync(directory)) return;
  if (create) {
    const created = mkdirSync(directory, { recursive: true });
    if (created !== undefined) syncDirectory(files, working);
  }
  assertDirectory(directory, join(rootReal, ".semctx", "working", TRANSACTION_DIRECTORY));
  for (const child of [
    transactionActiveDir(root),
    transactionTombstoneDir(root),
    join(transactionDir(root), RECOVERY_ACTIVE),
  ]) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (!existsSync(child)) break;
      try {
        const childInfo = lstatSync(child);
        const childReal = realpathSync(child);
        if (childInfo.isSymbolicLink() || !childInfo.isDirectory() || childReal !== child) {
          throw new SemctxError("STORE_ERROR", "anchor migration transaction state is unsafe", {
            reason: "TRANSACTION_WORKSPACE_UNSAFE",
            directory: child,
          });
        }
        break;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        if (!existsSync(child)) break;
        if (attempt === 7) {
          throw new SemctxError("STORE_ERROR", "anchor migration transaction state kept changing", {
            reason: "TRANSACTION_ALREADY_ACTIVE",
            directory: child,
          });
        }
      }
    }
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

interface TransactionOwner {
  pid: number;
  token?: string;
}

function activeOwner(activeDir: string): TransactionOwner {
  const path = join(activeDir, TRANSACTION_OWNER);
  if (!existsSync(path)) {
    throw new SemctxError("STORE_ERROR", "anchor migration transaction owner is missing", {
      reason: "TRANSACTION_JOURNAL_CORRUPT",
      directory: activeDir,
    });
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; token?: unknown };
    if (!Number.isInteger(value.pid) || Number(value.pid) <= 0) throw new Error("invalid pid");
    if (value.token !== undefined && (typeof value.token !== "string" || !/^[0-9a-f]{32}$/.test(value.token))) {
      throw new Error("invalid token");
    }
    return { pid: Number(value.pid), ...(value.token === undefined ? {} : { token: value.token }) };
  } catch (error) {
    throw new SemctxError("STORE_ERROR", "anchor migration transaction owner is corrupt", {
      reason: "TRANSACTION_JOURNAL_CORRUPT",
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function refuseLiveOwner(activeDir: string, allowedToken?: string): void {
  const owner = activeOwner(activeDir);
  if (processIsAlive(owner.pid) && (allowedToken === undefined || owner.token !== allowedToken)) {
    throw new SemctxError("STORE_ERROR", "an anchor migration transaction is already active", {
      reason: "TRANSACTION_ALREADY_ACTIVE",
      ownerPid: owner.pid,
    });
  }
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/**
 * POSIX directory fsync is part of the power-loss contract. Windows does not expose the same
 * portable Node primitive: opening a directory may explicitly fail with EPERM/EISDIR/EINVAL/
 * ENOTSUP/EBADF. Only those unsupported-operation results are tolerated there; storage failures
 * such as EIO and ENOSPC always propagate.
 */
function fsyncDirectory(path: string): void {
  try {
    const handle = openSync(path, "r");
    try { fsyncSync(handle); } finally { closeSync(handle); }
  } catch (error) {
    const unsupportedOnWindows = process.platform === "win32"
      && new Set(["EPERM", "EISDIR", "EINVAL", "ENOTSUP", "EBADF"]).has(errorCode(error) ?? "");
    if (!unsupportedOnWindows) throw error;
  }
}

function syncDirectory(files: AnchorMigrationFileSystem, path: string): void {
  (files.syncDirectory ?? NODE_ANCHOR_MIGRATION_FILE_SYSTEM.syncDirectory!)(path);
}

function appendRecord(activeDir: string, record: TransactionRecord): void {
  const path = join(activeDir, "journal.ndjson");
  const handle = openSync(path, "a", 0o600);
  try {
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    let written = 0;
    while (written < bytes.length) written += writeSync(handle, bytes, written, bytes.length - written);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function readRecords(
  activeDir: string,
  files: AnchorMigrationFileSystem = NODE_ANCHOR_MIGRATION_FILE_SYSTEM,
): TransactionRecord[] {
  const path = join(activeDir, "journal.ndjson");
  if (!existsSync(path)) return [];
  let bytes = readFileSync(path);
  const lastCompleteBoundary = bytes.lastIndexOf(0x0a) + 1;
  if (lastCompleteBoundary < bytes.length) {
    const handle = openSync(path, "r+");
    try {
      ftruncateSync(handle, lastCompleteBoundary);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    syncDirectory(files, activeDir);
    bytes = bytes.subarray(0, lastCompleteBoundary);
  }
  const text = decodeUtf8(bytes, path);
  const lines = text.split("\n");
  const records: TransactionRecord[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line === "") continue;
    try {
      const value = JSON.parse(line) as Partial<TransactionRecord>;
      if (!isTransactionRecord(value)) throw new Error("invalid record");
      records.push(value as TransactionRecord);
    } catch (error) {
      const isTail = index === lines.length - 1 && !text.endsWith("\n");
      if (isTail) break;
      throw new SemctxError("STORE_ERROR", "anchor migration journal is corrupt", {
        reason: "TRANSACTION_JOURNAL_CORRUPT",
        line: index + 1,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
  validateRecordSequence(records);
  return records;
}

const TRANSACTION_STATES = new Set<TransactionState>([
  "BEGIN", "PREPARED", "REPLACE_STARTED", "REPLACED", "COMMITTED",
  "ROLLBACK_STARTED", "RESTORED", "ROLLED_BACK",
]);

function isTransactionEntry(value: unknown): value is TransactionEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<TransactionEntry>;
  return typeof entry.relPath === "string"
    && isCanonicalSemanticRelPath(entry.relPath)
    && /^[0-9a-f]{64}$/.test(entry.beforeHash ?? "")
    && /^[0-9a-f]{64}$/.test(entry.afterHash ?? "")
    && Number.isInteger(entry.mode);
}

function isTransactionRecord(value: Partial<TransactionRecord>): value is TransactionRecord {
  if (typeof value.state !== "string" || !TRANSACTION_STATES.has(value.state as TransactionState)) return false;
  if (typeof value.at !== "string") return false;
  if (value.state === "BEGIN") return typeof value.transactionId === "string" && value.transactionId.length > 0;
  if (value.state === "PREPARED") {
    return Array.isArray(value.entries)
      && value.entries.length > 0
      && value.entries.every(isTransactionEntry)
      && new Set(value.entries.map((entry) => entry.relPath)).size === value.entries.length;
  }
  return value.entries === undefined && value.transactionId === undefined;
}

function validateRecordSequence(records: readonly TransactionRecord[]): void {
  const states = records.map((record) => record.state);
  const validForward: TransactionState[] = ["BEGIN", "PREPARED", "REPLACE_STARTED", "REPLACED", "COMMITTED"];
  let index = 0;
  while (index < states.length && states[index] === validForward[index]) index += 1;
  if (index === states.length) return;
  const rollback: TransactionState[] = ["ROLLBACK_STARTED", "RESTORED", "ROLLED_BACK"];
  let rollbackIndex = 0;
  while (index < states.length && states[index] === rollback[rollbackIndex]) {
    index += 1;
    rollbackIndex += 1;
  }
  if (index !== states.length || rollbackIndex === 0) {
    throw new SemctxError("STORE_ERROR", "anchor migration journal has an invalid state sequence", {
      reason: "TRANSACTION_JOURNAL_CORRUPT",
      states,
    });
  }
}

function writeBlob(activeDir: string, bytes: Buffer, files: AnchorMigrationFileSystem): string {
  const digest = hash(bytes);
  const path = join(activeDir, "blobs", digest);
  if (!existsSync(path)) {
    const handle = openSync(path, "wx", 0o600);
    try {
      let written = 0;
      while (written < bytes.length) written += writeSync(handle, bytes, written, bytes.length - written);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    syncDirectory(files, dirname(path));
  }
  const verified = readFileSync(path);
  if (hash(verified) !== digest) {
    throw new SemctxError("STORE_ERROR", "anchor migration transaction blob is corrupt", {
      reason: "TRANSACTION_BLOB_CORRUPT",
      hash: digest,
    });
  }
  return digest;
}

function readBlob(activeDir: string, digest: string): Buffer {
  const path = join(activeDir, "blobs", digest);
  let bytes: Buffer;
  try { bytes = readFileSync(path); } catch (error) {
    throw new SemctxError("STORE_ERROR", "anchor migration transaction blob is missing", {
      reason: "TRANSACTION_BLOB_MISSING",
      hash: digest,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (hash(bytes) !== digest) {
    throw new SemctxError("STORE_ERROR", "anchor migration transaction blob is corrupt", {
      reason: "TRANSACTION_BLOB_CORRUPT",
      hash: digest,
    });
  }
  return bytes;
}

function isCanonicalSemanticRelPath(relPath: string): boolean {
  if (isAbsolute(relPath) || relPath.includes("\\") || relPath.includes("\0")) return false;
  const segments = relPath.split("/");
  return segments.length >= 3
    && segments[0] === ".semctx"
    && segments[1] === "semantic"
    && segments.slice(2).every((segment) => segment !== "" && segment !== "." && segment !== "..")
    && segments.at(-1)!.endsWith(".sem");
}

function unsafeJournalTarget(relPath: string, details: Record<string, unknown> = {}): never {
  throw new SemctxError("STORE_ERROR", "anchor migration journal contains an unsafe target", {
    reason: "TRANSACTION_JOURNAL_CORRUPT",
    file: relPath,
    ...details,
  });
}

function targetPath(root: string, relPath: string): string {
  if (!isCanonicalSemanticRelPath(relPath)) unsafeJournalTarget(relPath);
  const rootReal = realpathSync(root);
  const semanticReal = realpathSync(join(rootReal, ".semctx", "semantic"));
  if (semanticReal !== join(rootReal, ".semctx", "semantic")) {
    unsafeJournalTarget(relPath, { resolvedSemanticDirectory: semanticReal });
  }
  const target = join(rootReal, ...relPath.split("/"));
  const parentReal = realpathSync(dirname(target));
  if (parentReal !== semanticReal && !parentReal.startsWith(`${semanticReal}${sep}`)) {
    unsafeJournalTarget(relPath, { resolvedDirectory: parentReal });
  }
  let targetInfo: ReturnType<typeof lstatSync>;
  try { targetInfo = lstatSync(target); } catch (error) {
    throw new SemctxError("STORE_ERROR", "anchor migration target is missing", {
      reason: "TRANSACTION_TARGET_MISSING",
      file: relPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
    unsafeJournalTarget(relPath, { targetType: targetInfo.isSymbolicLink() ? "symlink" : "non-file" });
  }
  const targetReal = realpathSync(target);
  if (targetReal !== target) {
    unsafeJournalTarget(relPath, { resolvedTarget: targetReal });
  }
  return target;
}

function durableSwap(
  target: string,
  bytes: Buffer,
  mode: number,
  expectedHash: string,
  files: AnchorMigrationFileSystem,
): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const temp = files.temporaryName(target);
    let handle: number;
    try { handle = files.claimExclusive(temp); } catch (error) { lastError = error; continue; }
    try {
      files.fillAndClose(handle, temp, bytes.toString("utf8"));
      (files.fsyncPath ?? NODE_ANCHOR_MIGRATION_FILE_SYSTEM.fsyncPath!)(temp);
      (files.chmod ?? NODE_ANCHOR_MIGRATION_FILE_SYSTEM.chmod!)(temp, mode & 0o777);
      files.rename(temp, target);
      syncDirectory(files, dirname(target));
      const landed = readBytes(files, target);
      const landedMode = statSync(target).mode & 0o777;
      if (hash(landed) !== expectedHash || (process.platform !== "win32" && landedMode !== (mode & 0o777))) {
        throw new SemctxError("STORE_ERROR", "anchor migration swap did not verify", {
          reason: "TRANSACTION_SWAP_UNVERIFIED",
          file: target,
        });
      }
      return;
    } catch (error) {
      try { files.remove(temp); } catch { /* best effort */ }
      throw error;
    }
  }
  throw new SemctxError("STORE_ERROR", "could not create an exclusive temporary file", {
    target,
    cause: lastError instanceof Error ? lastError.message : String(lastError),
  });
}

function preparedEntries(records: readonly TransactionRecord[]): TransactionEntry[] | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (record.state === "PREPARED" && Array.isArray(record.entries)) return record.entries;
  }
  return undefined;
}

function cleanupTombstone(root: string, files: AnchorMigrationFileSystem): void {
  const tombstone = transactionTombstoneDir(root);
  if (!existsSync(tombstone)) return;
  rmSync(tombstone, { recursive: true, force: true });
  syncDirectory(files, transactionDir(root));
}

function cleanupAbandonedAcquisitions(root: string, files: AnchorMigrationFileSystem): void {
  const directory = transactionDir(root);
  for (const name of readdirSync(directory)) {
    const candidate = join(directory, name);
    const terminal = /^(?:acquire-failed|recovery-(?:release|stale))-[1-9][0-9]*-[0-9a-f]{18}$/.test(name);
    const acquisition = /^(?:acquire|recovery-acquire)-([1-9][0-9]*)-[0-9a-f]{18}$/.exec(name);
    if (!terminal && acquisition === null) continue;
    let info: ReturnType<typeof lstatSync>;
    try { info = lstatSync(candidate); } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    let candidateReal: string;
    try { candidateReal = realpathSync(candidate); } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory() || candidateReal !== candidate) {
      throw new SemctxError("STORE_ERROR", "anchor migration acquisition state is unsafe", {
        reason: "TRANSACTION_WORKSPACE_UNSAFE",
        directory: candidate,
      });
    }
    if (acquisition !== null) {
      const ownerPid = Number(acquisition[1]);
      if (processIsAlive(ownerPid)) {
        throw new SemctxError("STORE_ERROR", "an anchor migration transaction acquisition is in progress", {
          reason: "TRANSACTION_ALREADY_ACTIVE",
          ownerPid,
        });
      }
    }
    try { rmSync(candidate, { recursive: true, force: true }); } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    syncDirectory(files, directory);
  }

  const recovery = join(directory, RECOVERY_ACTIVE);
  if (!existsSync(recovery)) return;
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(recovery); } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  let recoveryReal: string;
  try { recoveryReal = realpathSync(recovery); } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory() || recoveryReal !== recovery) {
    throw new SemctxError("STORE_ERROR", "anchor migration recovery state is unsafe", {
      reason: "TRANSACTION_WORKSPACE_UNSAFE",
      directory: recovery,
    });
  }
  const owner = activeOwner(recovery);
  if (processIsAlive(owner.pid)) {
    throw new SemctxError("STORE_ERROR", "an anchor migration recovery is already active", {
      reason: "TRANSACTION_ALREADY_ACTIVE",
      ownerPid: owner.pid,
    });
  }
  const stale = join(directory, `recovery-stale-${process.pid}-${randomBytes(9).toString("hex")}`);
  try {
    renameSync(recovery, stale);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  syncDirectory(files, directory);
  try { rmSync(stale, { recursive: true, force: true }); } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  syncDirectory(files, directory);
}

function recoveryRelease(
  root: string,
  token: string,
  files: AnchorMigrationFileSystem,
): () => void {
  const directory = transactionDir(root);
  const recovery = join(directory, RECOVERY_ACTIVE);
  return () => {
    if (!existsSync(recovery)) return;
    const owner = activeOwner(recovery);
    if (owner.pid !== process.pid || owner.token !== token) {
      throw new SemctxError("STORE_ERROR", "anchor migration recovery ownership changed", {
        reason: "TRANSACTION_RECOVERY_CLAIM_LOST",
      });
    }
    const release = join(directory, `recovery-release-${process.pid}-${randomBytes(9).toString("hex")}`);
    renameSync(recovery, release);
    syncDirectory(files, directory);
    crashAt("after-recovery-release-rename");
    rmSync(release, { recursive: true, force: true });
    syncDirectory(files, directory);
  };
}

function removeCandidateAndThrow(candidate: string, primary: Error): never {
  try {
    rmSync(candidate, { recursive: true, force: true });
  } catch (cleanupError) {
    throw attachSuppressedError(primary, cleanupError);
  }
  throw primary;
}

function claimRecovery(root: string, files: AnchorMigrationFileSystem): () => void {
  const directory = transactionDir(root);
  const recovery = join(directory, RECOVERY_ACTIVE);
  const token = randomBytes(16).toString("hex");
  const candidate = join(directory, `recovery-acquire-${process.pid}-${randomBytes(9).toString("hex")}`);
  try {
    mkdirSync(candidate);
    const ownerPath = join(candidate, TRANSACTION_OWNER);
    const ownerHandle = openSync(ownerPath, "wx", 0o600);
    try {
      const bytes = Buffer.from(`${JSON.stringify({ pid: process.pid, token })}\n`, "utf8");
      writeSync(ownerHandle, bytes);
      fsyncSync(ownerHandle);
    } finally {
      closeSync(ownerHandle);
    }
    syncDirectory(files, candidate);
    crashAt("after-recovery-candidate");
  } catch (error) {
    removeCandidateAndThrow(candidate, new SemctxError("STORE_ERROR", "could not claim anchor migration recovery", {
      reason: "TRANSACTION_RECOVERY_CLAIM_FAILED",
      cause: error instanceof Error ? error.message : String(error),
    }));
  }

  try {
    renameSync(candidate, recovery);
  } catch (error) {
    if (existsSync(recovery)) {
      removeCandidateAndThrow(candidate, new SemctxError("STORE_ERROR", "an anchor migration recovery is already active", {
        reason: "TRANSACTION_ALREADY_ACTIVE",
        cause: error instanceof Error ? error.message : String(error),
      }));
    }
    removeCandidateAndThrow(candidate, new SemctxError("STORE_ERROR", "could not publish anchor migration recovery claim", {
      reason: "TRANSACTION_RECOVERY_CLAIM_FAILED",
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
  const releaseRecovery = recoveryRelease(root, token, files);
  try {
    syncDirectory(files, directory);
  } catch (error) {
    const primary = new SemctxError("STORE_ERROR", "anchor migration recovery claim durability failed", {
      reason: "TRANSACTION_RECOVERY_CLAIM_FAILED",
      cause: error instanceof Error ? error.message : String(error),
    });
    try { recoveryRelease(root, token, NODE_ANCHOR_MIGRATION_FILE_SYSTEM)(); } catch (releaseError) {
      throw attachSuppressedError(primary, releaseError);
    }
    throw primary;
  }
  return releaseRecovery;
}

interface AcquiredTransaction {
  activeDir: string;
  token: string;
}

function discardOwnPublishedTransaction(root: string, token: string): void {
  const directory = transactionDir(root);
  const activeDir = transactionActiveDir(root);
  if (!existsSync(activeDir)) return;
  const owner = activeOwner(activeDir);
  if (owner.pid !== process.pid || owner.token !== token) {
    throw new SemctxError("STORE_ERROR", "anchor migration transaction ownership changed", {
      reason: "TRANSACTION_ACQUISITION_FAILED",
    });
  }
  const failed = join(directory, `acquire-failed-${process.pid}-${randomBytes(9).toString("hex")}`);
  renameSync(activeDir, failed);
  syncDirectory(NODE_ANCHOR_MIGRATION_FILE_SYSTEM, directory);
  rmSync(failed, { recursive: true, force: true });
  syncDirectory(NODE_ANCHOR_MIGRATION_FILE_SYSTEM, directory);
}

function acquireTransaction(root: string, files: AnchorMigrationFileSystem): AcquiredTransaction {
  assertSafeTransactionDirectory(root, files, true);
  cleanupTombstone(root, files);
  cleanupAbandonedAcquisitions(root, files);
  const activeDir = transactionActiveDir(root);
  const token = randomBytes(16).toString("hex");
  const candidate = join(transactionDir(root), `acquire-${process.pid}-${randomBytes(9).toString("hex")}`);
  try {
    mkdirSync(candidate);
    const ownerPath = join(candidate, TRANSACTION_OWNER);
    const ownerHandle = openSync(ownerPath, "wx", 0o600);
    try {
      const bytes = Buffer.from(`${JSON.stringify({ pid: process.pid, token })}\n`, "utf8");
      writeSync(ownerHandle, bytes);
      fsyncSync(ownerHandle);
    } finally {
      closeSync(ownerHandle);
    }
    syncDirectory(files, candidate);
    mkdirSync(join(candidate, "blobs"));
    syncDirectory(files, candidate);
  } catch (error) {
    removeCandidateAndThrow(candidate, new SemctxError("STORE_ERROR", "could not prepare anchor migration transaction", {
      reason: "TRANSACTION_ACQUISITION_FAILED",
      cause: error instanceof Error ? error.message : String(error),
    }));
  }

  let publicationError: unknown;
  let published = false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      renameSync(candidate, activeDir);
      published = true;
      break;
    } catch (error) {
      publicationError = error;
      if (existsSync(activeDir)) {
        removeCandidateAndThrow(candidate, new SemctxError("STORE_ERROR", "an anchor migration transaction is already active", {
          reason: "TRANSACTION_ALREADY_ACTIVE",
          cause: error instanceof Error ? error.message : String(error),
        }));
      }
      if (!new Set(["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"]).has(errorCode(error) ?? "")) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  }
  if (published) {
    try {
      syncDirectory(files, transactionDir(root));
      return { activeDir, token };
    } catch (error) {
      const primary = new SemctxError("STORE_ERROR", "anchor migration transaction publication durability failed", {
        reason: "TRANSACTION_ACQUISITION_FAILED",
        cause: error instanceof Error ? error.message : String(error),
      });
      try { discardOwnPublishedTransaction(root, token); } catch (cleanupError) {
        throw attachSuppressedError(primary, cleanupError);
      }
      throw primary;
    }
  }
  removeCandidateAndThrow(candidate, new SemctxError("STORE_ERROR", "could not publish anchor migration transaction", {
    reason: "TRANSACTION_ACQUISITION_FAILED",
    cause: publicationError instanceof Error ? publicationError.message : String(publicationError),
  }));
}

function cleanupTransaction(root: string, files: AnchorMigrationFileSystem): void {
  const activeDir = transactionActiveDir(root);
  cleanupTombstone(root, files);
  if (!existsSync(activeDir)) return;
  const tombstone = transactionTombstoneDir(root);
  renameSync(activeDir, tombstone);
  syncDirectory(files, transactionDir(root));
  crashAt("after-cleanup-rename");
  cleanupTombstone(root, files);
}

function recoverAnchorMigrationOwned(
  root: string,
  files: AnchorMigrationFileSystem,
  ownerToken?: string,
): string[] {
  // The common no-transaction path is read-only, including for dry runs. Only a published
  // transaction directory gives recovery authority to touch `.semctx/working`.
  if (!existsSync(transactionDir(root))) return [];
  assertSafeTransactionDirectory(root, files, false);
  cleanupTombstone(root, files);
  cleanupAbandonedAcquisitions(root, files);
  const activeDir = transactionActiveDir(root);
  if (!existsSync(activeDir)) return [];
  refuseLiveOwner(activeDir, ownerToken);
  const releaseRecovery = claimRecovery(root, files);
  let result: string[] | undefined;
  let primaryError: unknown;
  try {
    crashAt("after-recovery-claim");
    const holdMs = Number.parseInt(process.env["SEMCTX_ANCHOR_MIGRATION_HOLD_AFTER_RECOVERY_CLAIM_MS"] ?? "0", 10);
    if (Number.isFinite(holdMs) && holdMs > 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
    }
    if (!existsSync(activeDir)) {
      result = [];
    } else {
      refuseLiveOwner(activeDir, ownerToken);
      result = recoverClaimedAnchorMigration(root, activeDir, files);
    }
  } catch (error) {
    primaryError = error;
  }
  try {
    releaseRecovery();
  } catch (releaseError) {
    if (primaryError !== undefined) throw attachSuppressedError(primaryError, releaseError);
    throw releaseError;
  }
  if (primaryError !== undefined) {
    if (primaryError instanceof Error) throw primaryError;
    throw new Error("non-Error thrown during anchor migration recovery", { cause: primaryError });
  }
  return result ?? [];
}

export function recoverAnchorMigration(root: string, files = NODE_ANCHOR_MIGRATION_FILE_SYSTEM): string[] {
  return recoverAnchorMigrationOwned(root, files);
}

function recoverClaimedAnchorMigration(
  root: string,
  activeDir: string,
  files: AnchorMigrationFileSystem,
): string[] {
  const records = readRecords(activeDir, files);
  const entries = preparedEntries(records);
  if (records.at(-1)?.state === "COMMITTED") {
    if (entries === undefined) {
      throw new SemctxError("STORE_ERROR", "anchor migration journal committed without a manifest", {
        reason: "TRANSACTION_JOURNAL_CORRUPT",
      });
    }
    for (const entry of entries) {
      readBlob(activeDir, entry.beforeHash);
      readBlob(activeDir, entry.afterHash);
      const current = readBytes(files, targetPath(root, entry.relPath));
      if (hash(current) !== entry.afterHash) {
        throw new SemctxError("STORE_ERROR", "committed anchor migration target is corrupt", {
          reason: "TRANSACTION_TARGET_CORRUPT",
          file: entry.relPath,
        });
      }
    }
    cleanupTransaction(root, files);
    return [];
  }
  if (entries === undefined) {
    cleanupTransaction(root, files);
    return [];
  }

  const lastState = records.at(-1)?.state;
  if (lastState === "PREPARED") {
    // PREPARED is durable before REPLACE_STARTED, so this transaction has not authored target
    // bytes yet. A concurrent writer may already have landed bytes equal to our planned `after`;
    // treating those as ours would roll back someone else's committed work.
    for (const entry of entries) {
      readBlob(activeDir, entry.beforeHash);
      readBlob(activeDir, entry.afterHash);
    }
    cleanupTransaction(root, files);
    return [];
  }

  // Validate every blob and target before restoring the first one. A third hash, missing blob, or
  // corrupt blob is a global fail-closed condition and must not leave a partially recovered tree.
  const recovery = entries.map((entry) => {
    const before = readBlob(activeDir, entry.beforeHash);
    readBlob(activeDir, entry.afterHash);
    const target = targetPath(root, entry.relPath);
    let current: Buffer;
    try { current = readBytes(files, target); } catch (error) {
      throw new SemctxError("STORE_ERROR", "anchor migration target is missing", {
        reason: "TRANSACTION_TARGET_MISSING",
        file: entry.relPath,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const currentHash = hash(current);
    if (currentHash !== entry.beforeHash && currentHash !== entry.afterHash) {
      throw new SemctxError("STORE_ERROR", "anchor migration recovery refused a third hash", {
        reason: "TRANSACTION_TARGET_CORRUPT",
        file: entry.relPath,
      });
    }
    return { entry, before, target, restore: currentHash === entry.afterHash };
  });

  if (lastState === "ROLLED_BACK") {
    cleanupTransaction(root, files);
    return [];
  }
  if (lastState !== "ROLLBACK_STARTED" && lastState !== "RESTORED") {
    appendRecord(activeDir, { state: "ROLLBACK_STARTED", at: new Date().toISOString() });
    crashAt("after-rollback-started");
  }
  if (lastState !== "RESTORED") {
    for (const item of [...recovery].reverse()) {
      if (item.restore) durableSwap(item.target, item.before, item.entry.mode, item.entry.beforeHash, files);
    }
    crashAt("after-restore");
    appendRecord(activeDir, { state: "RESTORED", at: new Date().toISOString() });
    crashAt("after-restored");
  }
  appendRecord(activeDir, { state: "ROLLED_BACK", at: new Date().toISOString() });
  crashAt("after-rolled-back");
  cleanupTransaction(root, files);
  return recovery.filter((item) => item.restore).map((item) => item.entry.relPath);
}

function crashAt(point: string): void {
  if (process.env["SEMCTX_ANCHOR_MIGRATION_CRASH_AT"] === point) process.exit(86);
}

function runTransaction(root: string, planned: readonly PlannedFile[], files: AnchorMigrationFileSystem): void {
  const { activeDir, token: ownerToken } = acquireTransaction(root, files);
  const holdMs = Number.parseInt(process.env["SEMCTX_ANCHOR_MIGRATION_HOLD_AFTER_ACQUIRE_MS"] ?? "0", 10);
  if (Number.isFinite(holdMs) && holdMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
  appendRecord(activeDir, {
    state: "BEGIN",
    at: new Date().toISOString(),
    transactionId: randomBytes(16).toString("hex"),
  });
  const entries = planned.map((file) => ({
    relPath: file.result.file,
    beforeHash: writeBlob(activeDir, file.before, files),
    afterHash: writeBlob(activeDir, file.content, files),
    mode: statSync(file.absPath).mode & 0o777,
  }));
  appendRecord(activeDir, { state: "PREPARED", at: new Date().toISOString(), entries });

  const drifted = planned
    .filter((file) => hash(readBytes(files, file.absPath)) !== hash(file.before))
    .map((file) => file.result.file);
  if (drifted.length > 0) {
    recoverAnchorMigrationOwned(root, files, ownerToken);
    throw new SemctxError("STORE_ERROR", "anchor migration refused changed preimages", {
      reason: "PREIMAGE_CHANGED",
      files: drifted.sort(compareIds),
    });
  }

  appendRecord(activeDir, { state: "REPLACE_STARTED", at: new Date().toISOString() });
  let committed = false;
  try {
    for (let index = 0; index < planned.length; index += 1) {
      const file = planned[index]!;
      const entry = entries[index]!;
      durableSwap(file.absPath, file.content, entry.mode, entry.afterHash, files);
      if (index === 0) crashAt("after-first-replace");
    }
    crashAt("after-all-replaces");
    appendRecord(activeDir, { state: "REPLACED", at: new Date().toISOString() });
    appendRecord(activeDir, { state: "COMMITTED", at: new Date().toISOString() });
    committed = true;
    crashAt("after-commit");
    cleanupTransaction(root, files);
  } catch (error) {
    const journalSaysCommitted = existsSync(activeDir)
      && readRecords(activeDir, files).at(-1)?.state === "COMMITTED";
    // A fault-injection port may deliberately keep failing every subsequent rename. Recovery is a
    // separate process-equivalent path and therefore uses the production filesystem adapter.
    const restored = recoverAnchorMigrationOwned(root, NODE_ANCHOR_MIGRATION_FILE_SYSTEM, ownerToken);
    if (committed || journalSaysCommitted) {
      throw new SemctxError("STORE_ERROR", "anchor migration committed but cleanup durability failed", {
        reason: "TRANSACTION_COMMITTED_CLEANUP_FAILED",
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    throw new SemctxError("STORE_ERROR", "anchor migration failed and was rolled back", {
      reason: "TRANSACTION_ROLLED_BACK",
      cause: error instanceof Error ? error.message : String(error),
      restored,
    });
  }
}

export interface AnchorMigrationOptions {
  apply: boolean;
  /**
   * Whether the index may authorize a rewrite. Computed by the caller from the canonical control
   * and freshness services, which live above this package.
   */
  authority: AnchorMigrationAuthority;
  /**
   * Re-asked immediately before the first write. Defaults to `authority`, which is honest for a
   * caller that has no way to re-derive it, but a caller that does must pass it: an index can go
   * stale between planning a rewrite of authored files and performing it.
   */
  revalidateAuthority?: () => AnchorMigrationAuthority;
  /**
   * Identity of the facts handed in, as the caller's own fingerprint of them.
   *
   * The authority is computed from the index; `facts` is loaded from the store separately. Nothing
   * ties the two together unless the caller says so, and a re-index landing between those two reads
   * hands this function a plan built from one generation and a licence issued for another. Omitted
   * means "cannot identify", which is refused rather than assumed to match.
   */
  factsIdentity?: string;
  /** Defaults to the real filesystem. Present so failure paths have deterministic oracles. */
  fileSystem?: AnchorMigrationFileSystem;
}

function refusedReport(authority: AnchorMigrationAuthority): AnchorMigrationReport {
  return {
    schemaVersion: 1,
    kind: "anchor_migration",
    applied: false,
    authority,
    files: [],
    counts: { rewritten: 0, refused: 0, alreadyCanonical: 0, filesChanged: 0 },
    hasRefusals: false,
  };
}

/**
 * Plan — and, when everything lines up, apply — the anchor migration.
 *
 * `facts` is the indexed repository the anchors are resolved against. This function never indexes
 * on its own and never decides for itself whether that index is current; both are the caller's
 * responsibility, expressed through `options.authority`.
 */
export function migrateAnchors(
  root: string,
  facts: RepositoryFacts,
  options: AnchorMigrationOptions,
): AnchorMigrationReport {
  const files = options.fileSystem ?? NODE_ANCHOR_MIGRATION_FILE_SYSTEM;
  // Recovery is a mandatory gate for every invocation, including dry runs and authority refusals:
  // a new plan must never be reported over a tree left between transaction states by an older one.
  recoverAnchorMigration(root, files);

  // Refused before planning, not merely before writing. Planning against an index that no longer
  // speaks for the tree would print an outcome list — "rewrite this, refuse that" — derived from
  // facts nobody can vouch for, and a reader has no way to tell that report from a sound one.
  if (options.authority.status !== "authorized") return refusedReport(options.authority);

  // Same reasoning one level down: an authorization whose generation cannot be named, or whose
  // generation does not own the facts being planned against, licenses nothing. Refusing here rather
  // than at write time keeps an unfounded plan from being printed as a finding.
  const planningGeneration = options.authority.generation;
  if (
    planningGeneration === null
    || options.factsIdentity === undefined
    || options.factsIdentity !== planningGeneration.facts
  ) {
    return refusedReport(refusedAuthority(["INDEX_GENERATION_DRIFTED"]));
  }

  const directory = semanticDir(root);
  const index = buildRepositoryLinkIndex(facts);
  let rootReal: string;
  try {
    rootReal = realpathSync(directory);
  } catch {
    rootReal = resolve(directory);
  }
  const planned = listSemFiles(directory)
    .map((absPath) => {
      assertWithinSemanticDir(rootReal, absPath);
      return planFile(absPath, relFile(root, absPath), index, files);
    })
    .sort((left, right) => compareIds(left.result.file, right.result.file));

  const outcomes = planned.flatMap((file) => file.result.outcomes);
  const count = (status: AnchorMigrationOutcome["status"]): number =>
    outcomes.filter((outcome) => outcome.status === status).length;
  const hasRefusals = count("refused") > 0;

  // A refusal anywhere quarantines the *whole run*, not just its own file. Rewriting the anchors
  // around one semctx declined to rebind leaves the author reviewing a diff that looks finished
  // while the case they most need to see is still unaddressed — and leaves the tree in a state
  // neither fully migrated nor untouched.
  let authority = options.authority;
  const applied = options.apply
    && !hasRefusals
    && authority.status === "authorized"
    && planned.some((file) => file.result.changed);

  if (applied) {
    // The window between planning and writing is exactly where an index goes stale: planning reads
    // the working tree, and a rewrite of authored intent must not outlive the proof that authorized
    // it.
    authority = (options.revalidateAuthority ?? (() => options.authority))();
    // "Still authorized" is not enough. A re-index between planning and writing produces a fresh,
    // green verdict for a *different* generation, and consuming it would apply a plan resolved
    // against facts that no longer exist. The verdict has to be green and about the same index.
    if (
      authority.status === "authorized"
      && !sameGeneration(planningGeneration, authority.generation)
    ) {
      authority = refusedAuthority(["INDEX_GENERATION_DRIFTED"]);
    }
    if (authority.status === "authorized") {
      runTransaction(root, planned.filter((file) => file.result.changed), files);
    }
  }

  const wrote = applied && authority.status === "authorized";
  return {
    schemaVersion: 1,
    kind: "anchor_migration",
    applied: wrote,
    authority,
    files: planned.map((file) => ({
      ...file.result,
      // "changed" describes the tree, not the plan: a run that wrote nothing changed nothing.
      changed: wrote && file.result.changed,
    })),
    counts: {
      rewritten: count("rewritten"),
      refused: count("refused"),
      alreadyCanonical: count("already_canonical"),
      filesChanged: wrote ? planned.filter((file) => file.result.changed).length : 0,
    },
    hasRefusals,
  };
}
