import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";

export type Artifact = { path: string; sha256: string; bytes: number };
export type SemanticWitness = {
  index: number;
  id: string;
  consumer: string;
  files: Record<string, string>;
  path: string;
  controlFiles: Record<string, string>;
  contractSource: string;
  expectedReasons: string[] | null;
  controlExpectedReasons: string[] | null;
  qualificationGap: string | null;
  requiredFacts: string[];
};

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export const digest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

export function selectShard<T extends { index: number }>(rows: T[], shard = "1/1"): T[] {
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(shard);
  if (!match) throw Error("INVALID_SHARD: expected i/n with 1 <= i <= n");
  const index = Number(match[1]), count = Number(match[2]);
  if (!Number.isSafeInteger(count) || index > count) throw Error("INVALID_SHARD: expected i/n with 1 <= i <= n");
  return rows.toSorted((a, b) => a.index - b.index).filter((_, position) => position % count === index - 1);
}

export function selectIndices<T extends { index: number }>(rows: T[], range?: string): T[] {
  if (range === undefined) return rows;
  const match = /^(\d+)-(\d+)$/.exec(range);
  if (!match) throw Error("INVALID_INDICES: expected first-last");
  const first = Number(match[1]), last = Number(match[2]);
  const selected = rows.filter(row => row.index >= first && row.index <= last);
  if (!Number.isSafeInteger(last) || first > last || selected.length === 0 || selected.length !== last - first + 1 || new Set(selected.map(row => row.index)).size !== selected.length) throw Error("INVALID_INDICES: range must name existing obligations exactly once");
  return selected;
}

export function verifyArtifact(value: unknown): Artifact {
  const input = record(value);
  if (typeof input["path"] !== "string" || !isAbsolute(input["path"]) || typeof input["sha256"] !== "string" || !/^[a-f0-9]{64}$/.test(input["sha256"])) throw Error("INVALID_ARTIFACT");
  const bytes = readFileSync(input["path"]);
  if (digest(bytes) !== input["sha256"] || (input["bytes"] !== undefined && input["bytes"] !== bytes.length)) throw Error("ARTIFACT_MISMATCH:" + input["path"]);
  return { path: input["path"], sha256: input["sha256"], bytes: bytes.length };
}

export function compareReasons(value: unknown, expected: string[] | null): boolean {
  const observation = record(value);
  const reasons: unknown = observation["reasons"];
  return expected !== null && observation["executed"] === true && isDeepStrictEqual(observation["unsupported"], []) && Array.isArray(reasons) && reasons.every((item: unknown) => typeof item === "string") && isDeepStrictEqual((reasons as string[]).toSorted(), [...expected].sort());
}

export function semanticObservation(value: unknown, path: string): Record<string, unknown> {
  const subjects: unknown = record(value)["subjects"];
  if (!Array.isArray(subjects)) return {};
  return record(record(subjects.find((subject: unknown) => record(subject)["path"] === path))["semanticObservation"]);
}

export function verifyProducerCompletion(capture: { exitCode: number | null; signal: string | null; error: string | null }): void {
  if (capture.error !== null || capture.signal !== null || ![0, 1].includes(capture.exitCode ?? -1)) throw Error("PRODUCER_EXECUTION_FAILED");
}
