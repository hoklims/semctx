import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { CampaignCase, FileRef } from "./t00-ts7-q-syntax-types.js";

export function validateYieldControl(
  control: NonNullable<CampaignCase["yieldControl"]>, oracle: unknown,
  compilation: { exitCode: number; stdout: string; stderr: string },
) {
  const fileScope = control === "file-scope-recovered";
  const expressions = readAt(oracle, ["observation", "yieldExpressions"]);
  if (!Array.isArray(expressions) || expressions.length !== 1 ||
      readAt(expressions[0], ["fileScope"]) !== fileScope ||
      readAt(oracle, ["observation", "statements", 0, "executesOnLoad"]) !== fileScope)
    throw new Error("yield AST scope or visitor control mismatch");
  const codes = [...(compilation.stdout + "\n" + compilation.stderr).matchAll(/error TS(\d+):/g)]
    .map(match => Number(match[1]));
  if (compilation.exitCode !== (fileScope ? 2 : 0) ||
      (fileScope ? codes.length !== 1 || codes[0] !== 1163 : codes.length !== 0))
    throw new Error("yield compiler diagnostic control mismatch");
  return { fileScope, executesOnLoad: fileScope, diagnosticCodes: codes, exitCode: compilation.exitCode };
}

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

export function comparisonValue(value: unknown, transform: CampaignCase["checks"][number]["transform"]): unknown {
  if (!transform) return value;
  if (!Array.isArray(value)) throw new Error("expected array");
  const entries: unknown[] = value;
  if (transform === "call-edge-count") {
    return entries.filter(edge => {
      const kind = readAt(edge, ["kind"]);
      if (typeof kind !== "string") throw new Error("expected edge kind");
      return kind === "calls";
    }).length;
  }
  if (transform === "opaque-callback-reason" || transform === "construction-reason") {
    if (!entries.every(reason => typeof reason === "string")) throw new Error("expected reason strings");
    return entries.includes(transform === "opaque-callback-reason" ? "SOURCE_OPAQUE_CALLBACK_UNSUPPORTED" : "SOURCE_CONSTRUCTION_UNSUPPORTED");
  }
  if (transform === "outline-digest-relation") {
    const digests = entries.map(entry => {
      const digest = readAt(entry, ["digest"]);
      if (typeof digest !== "string" || digest.length === 0) throw new Error("expected nonempty digest");
      return digest;
    });
    if (digests.length !== 2) throw new Error("expected two statement digests");
    return digests[0] === digests[1];
  }
  return entries.map(entry => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("expected statement object");
    const statement: Record<string, unknown> = { ...entry };
    delete statement.digest;
    return statement;
  });
}
