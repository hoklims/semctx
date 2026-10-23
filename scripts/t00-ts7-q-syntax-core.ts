import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FileRef } from "./t00-ts7-q-syntax-types.js";

export function shardIndices(indices: number[], shard: string): number[] {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard);
  if (!match) throw new Error("invalid shard; expected i/n, 1 <= i <= n");
  const i = Number(match[1]);
  const n = Number(match[2]);
  if (!Number.isSafeInteger(i) || !Number.isSafeInteger(n) || i > n)
    throw new Error("invalid shard range");
  return [...indices].sort((a, b) => a - b).filter((_, position) => position % n === i - 1);
}

export function readAt(value: unknown, path: (string | number)[]): unknown {
  for (const key of path) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key))
      throw new Error(`missing comparison path ${JSON.stringify(path)}`);
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}

export async function verifyFile(ref: FileRef): Promise<FileRef> {
  const bytes = await readFile(ref.path);
  if (bytes.length !== ref.bytes || createHash("sha256").update(bytes).digest("hex") !== ref.sha256)
    throw new Error(`artifact mismatch: ${ref.path}`);
  return ref;
}
