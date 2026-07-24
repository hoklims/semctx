import {
  createObservedDiffHunkV1,
  normalizeObservedDiffPath,
} from "@semantic-context/control-model/reconciliation";
import type { ObservedDiffHunkV1 } from "@semantic-context/control-model/reconciliation";
import type { DiffFile, DiffHunk } from "./verify-diff";

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const INDEX_RE = /^index ([0-9A-Fa-f]+)\.\.([0-9A-Fa-f]+)(?:\s|$)/;
const decoder = new TextDecoder("utf-8", { fatal: true });

interface LineSlice {
  start: number;
  contentEnd: number;
}

interface FileState {
  oldPath: string | null;
  newPath: string | null;
  oldBlobId: string | null;
  newBlobId: string | null;
}

interface ActiveHunk {
  path: string;
  range: DiffHunk;
  rawStart: number;
  oldConsumed: number;
  newConsumed: number;
  file: FileState;
}

export interface ParseObservedDiffHunksArgs {
  repositoryIdentity: string;
  diffBytes: Uint8Array;
}

/**
 * Parse immutable Plane-A unified-diff observations without decoding or rewriting hunk
 * bodies. Only ASCII/UTF-8 metadata lines are decoded; every returned raw slice points at
 * the exact bytes supplied by the caller, including its original line endings.
 */
export function parseObservedDiffHunks(
  args: ParseObservedDiffHunksArgs,
): ObservedDiffHunkV1[] {
  const bytes = new Uint8Array(args.diffBytes);
  const lines = splitPhysicalLines(bytes);
  const observations: ObservedDiffHunkV1[] = [];
  let file = emptyFileState();
  let active: ActiveHunk | undefined;

  const finish = (rawEnd: number): void => {
    if (active === undefined) return;
    if (
      active.oldConsumed !== active.range.oldLines
      || active.newConsumed !== active.range.newLines
    ) {
      throw new Error(
        `observed diff hunk body does not match declared ranges for ${active.path}`,
      );
    }
    observations.push(createObservedDiffHunkV1({
      repositoryIdentity: args.repositoryIdentity,
      normalizedPath: active.path,
      oldRange: {
        start: active.range.oldStart,
        lines: active.range.oldLines,
      },
      newRange: {
        start: active.range.newStart,
        lines: active.range.newLines,
      },
      oldBlobId: active.file.oldBlobId,
      newBlobId: active.file.newBlobId,
      rawHunkBytes: bytes.slice(active.rawStart, rawEnd),
    }));
    active = undefined;
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;

    if (active !== undefined) {
      const marker = bytes[line.start];
      if (marker === 0x5c) {
        if (!equalsAscii(bytes, line, "\\ No newline at end of file")) {
          throw new Error(`invalid observed diff no-newline marker for ${active.path}`);
        }
        index += 1;
        continue;
      }

      const complete = active.oldConsumed === active.range.oldLines
        && active.newConsumed === active.range.newLines;
      if (complete) {
        finish(line.start);
        continue;
      }

      if (marker === 0x20) {
        active.oldConsumed += 1;
        active.newConsumed += 1;
      } else if (marker === 0x2d) {
        active.oldConsumed += 1;
      } else if (marker === 0x2b) {
        active.newConsumed += 1;
      } else {
        throw new Error(`invalid observed diff hunk body marker for ${active.path}`);
      }
      if (
        active.oldConsumed > active.range.oldLines
        || active.newConsumed > active.range.newLines
      ) {
        throw new Error(`observed diff hunk body exceeds declared ranges for ${active.path}`);
      }
      index += 1;
      continue;
    }

    if (startsWithAscii(bytes, line, "diff --git ")) {
      file = emptyFileState();
      index += 1;
      continue;
    }

    if (startsWithAscii(bytes, line, "index ")) {
      const match = INDEX_RE.exec(decodeLine(bytes, line));
      if (match !== null) {
        file.oldBlobId = nullableBlobId(match[1]!);
        file.newBlobId = nullableBlobId(match[2]!);
      }
      index += 1;
      continue;
    }

    if (startsWithAscii(bytes, line, "--- ")) {
      file.oldPath = parseFileHeaderPath(decodeLine(bytes, line), "--- ", "a/");
      if (file.oldPath === null) file.oldBlobId = null;
      index += 1;
      continue;
    }

    if (startsWithAscii(bytes, line, "+++ ")) {
      file.newPath = parseFileHeaderPath(decodeLine(bytes, line), "+++ ", "b/");
      if (file.newPath === null) file.newBlobId = null;
      index += 1;
      continue;
    }

    if (startsWithAscii(bytes, line, "@@ ")) {
      const match = HUNK_RE.exec(decodeLine(bytes, line));
      if (match === null) throw new Error("invalid unified diff hunk header");
      const path = file.newPath ?? file.oldPath;
      if (path === null) throw new Error("observed diff hunk is missing a repository-relative path");
      active = {
        path,
        range: {
          oldStart: parseU32(match[1]!),
          oldLines: match[2] === undefined ? 1 : parseU32(match[2]),
          newStart: parseU32(match[3]!),
          newLines: match[4] === undefined ? 1 : parseU32(match[4]),
        },
        rawStart: line.start,
        oldConsumed: 0,
        newConsumed: 0,
        file: { ...file },
      };
      index += 1;
      continue;
    }

    index += 1;
  }

  finish(bytes.byteLength);
  return observations.sort(compareObservedHunks);
}

/** Binary-input compatibility projection into the legacy structural diff shape. */
export function parseUnifiedDiffBytes(diffBytes: Uint8Array): DiffFile[] {
  const byPath = new Map<string, DiffFile>();
  for (const observed of parseObservedDiffHunks({
    repositoryIdentity: "repo:legacy-diff-projection",
    diffBytes,
  })) {
    let file = byPath.get(observed.normalizedPath);
    if (file === undefined) {
      file = {
        filePath: observed.normalizedPath,
        hunks: [],
        wholeFile: false,
      };
      byPath.set(observed.normalizedPath, file);
    }
    file.hunks.push({
      oldStart: observed.oldRange.start,
      oldLines: observed.oldRange.lines,
      newStart: observed.newRange.start,
      newLines: observed.newRange.lines,
    });
  }
  return [...byPath.values()]
    .map((file) => ({
      ...file,
      hunks: [...file.hunks].sort(compareDiffHunks),
    }))
    .sort((left, right) => compareAscii(left.filePath, right.filePath));
}

function splitPhysicalLines(bytes: Uint8Array): LineSlice[] {
  const lines: LineSlice[] = [];
  let start = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += 1) {
    if (bytes[offset] !== 0x0a) continue;
    const contentEnd = offset > start && bytes[offset - 1] === 0x0d ? offset - 1 : offset;
    lines.push({ start, contentEnd });
    start = offset + 1;
  }
  if (start < bytes.byteLength) {
    lines.push({ start, contentEnd: bytes.byteLength });
  }
  return lines;
}

function startsWithAscii(
  bytes: Uint8Array,
  line: LineSlice,
  prefix: string,
): boolean {
  if (line.contentEnd - line.start < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[line.start + index] !== prefix.charCodeAt(index)) return false;
  }
  return true;
}

function equalsAscii(
  bytes: Uint8Array,
  line: LineSlice,
  expected: string,
): boolean {
  return line.contentEnd - line.start === expected.length
    && startsWithAscii(bytes, line, expected);
}

function decodeLine(bytes: Uint8Array, line: LineSlice): string {
  return decoder.decode(bytes.subarray(line.start, line.contentEnd));
}

function parseFileHeaderPath(
  line: string,
  header: "--- " | "+++ ",
  prefix: "a/" | "b/",
): string | null {
  const value = line.slice(header.length);
  if (value === "/dev/null") return null;
  if (!value.startsWith(prefix)) {
    throw new Error(`observed diff ${header.trim()} path must use ${prefix} or /dev/null`);
  }
  return normalizeObservedDiffPath(value.slice(prefix.length));
}

function nullableBlobId(value: string): string | null {
  return /^0+$/.test(value) ? null : value;
}

function parseU32(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
    throw new RangeError("diff range must be an unsigned 32-bit integer");
  }
  return parsed;
}

function emptyFileState(): FileState {
  return {
    oldPath: null,
    newPath: null,
    oldBlobId: null,
    newBlobId: null,
  };
}

function compareObservedHunks(
  left: ObservedDiffHunkV1,
  right: ObservedDiffHunkV1,
): number {
  return compareAscii(left.normalizedPath, right.normalizedPath)
    || left.oldRange.start - right.oldRange.start
    || left.newRange.start - right.newRange.start
    || compareAscii(left.identity, right.identity);
}

function compareDiffHunks(left: DiffHunk, right: DiffHunk): number {
  return left.oldStart - right.oldStart
    || left.newStart - right.newStart
    || left.oldLines - right.oldLines
    || left.newLines - right.newLines;
}

function compareAscii(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
