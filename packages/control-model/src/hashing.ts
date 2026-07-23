import { createHash } from "node:crypto";
import { serializeControlReport } from "./canonical";
import { compareCodeUnits } from "./ordering";
import type {
  CanonicalProofAttestationV1,
  ControlFreshnessSealV2,
  EvidenceRefV1,
  ObservedDiffHunkV1,
  RefinementRelationV1,
} from "./refinement";
import type { ProofReference, Sha256Hash } from "./types";

const encoder = new TextEncoder();
const L0_MAGIC = encoder.encode("SEMCTXL0");
const FRESHNESS_V2_DOMAIN = encoder.encode("SEMCTX_CONTROL_FRESHNESS_SEAL_V2\0");
const U32_MAX = 0xffff_ffff;

export function sha256HashBytes(bytes: Uint8Array): Sha256Hash {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function sha256HashUtf8(value: string): Sha256Hash {
  return sha256HashBytes(encoder.encode(value));
}

export function sha256HashCanonicalJson(value: unknown): Sha256Hash {
  return sha256HashUtf8(serializeControlReport(value));
}

export function normalizeObservedDiffPath(input: string): string {
  const normalized = input.replaceAll("\\", "/").normalize("NFC");
  if (
    normalized.length === 0
    || normalized.startsWith("/")
    || normalized.startsWith("//")
    || /^[A-Za-z]:/.test(normalized)
    || normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("observed diff path must be a non-empty repository-relative normalized path");
  }
  return normalized;
}

export function frameObservedDiffHunkV1(
  input: Omit<ObservedDiffHunkV1, "schemaVersion" | "identity" | "normalizedPath"> & { normalizedPath: string },
): Uint8Array {
  const normalizedPath = normalizeObservedDiffPath(input.normalizedPath);
  const chunks = [
    L0_MAGIC,
    u32be(1),
    prefixedUtf8(input.repositoryIdentity),
    prefixedUtf8(normalizedPath),
    u32be(input.oldRange.start),
    u32be(input.oldRange.lines),
    u32be(input.newRange.start),
    u32be(input.newRange.lines),
    nullableAscii(input.oldBlobId),
    nullableAscii(input.newBlobId),
    prefixedBytes(input.rawHunkBytes),
  ];
  return concatBytes(chunks);
}

export function createObservedDiffHunkV1(
  input: Omit<ObservedDiffHunkV1, "schemaVersion" | "identity" | "normalizedPath"> & { normalizedPath: string },
): ObservedDiffHunkV1 {
  if (input.repositoryIdentity.length === 0) throw new Error("repositoryIdentity must not be empty");
  const normalizedPath = normalizeObservedDiffPath(input.normalizedPath);
  const framed = frameObservedDiffHunkV1({ ...input, normalizedPath });
  return {
    schemaVersion: 1,
    ...input,
    normalizedPath,
    rawHunkBytes: new Uint8Array(input.rawHunkBytes),
    identity: sha256HashBytes(framed),
  };
}

export function canonicalizeProofReferences(
  references: readonly ProofReference[],
): readonly ProofReference[] {
  const sorted = references
    .map((reference) => ({ ...reference }))
    .sort((left, right) =>
      compareCodeUnits(left.kind, right.kind)
      || compareCodeUnits(left.uri, right.uri)
      || Number(left.nonLlm) - Number(right.nonLlm)
    );
  for (let index = 1; index < sorted.length; index += 1) {
    if (
      sorted[index - 1]!.kind === sorted[index]!.kind
      && sorted[index - 1]!.uri === sorted[index]!.uri
      && sorted[index - 1]!.nonLlm === sorted[index]!.nonLlm
    ) throw new Error("proof references must be unique");
  }
  return sorted;
}

export function computeCanonicalProofAttestationDigest(
  input: Omit<CanonicalProofAttestationV1, "attestationDigest">,
): Sha256Hash {
  return sha256HashCanonicalJson({
    ...input,
    references: canonicalizeProofReferences(input.references),
  });
}

export function canonicalizeEvidenceRefs(
  evidenceRefs: readonly EvidenceRefV1[],
): readonly EvidenceRefV1[] {
  const sorted = evidenceRefs
    .map((evidence) => ({
      ...evidence,
      digest: { ...evidence.digest },
    }))
    .sort((left, right) =>
      compareCodeUnits(left.kind, right.kind)
      || compareCodeUnits(left.locator, right.locator)
      || compareCodeUnits(left.digest.value, right.digest.value)
    );
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (
      previous.kind === current.kind
      && previous.locator === current.locator
      && previous.digest.value === current.digest.value
    ) throw new Error("evidence references must be unique");
  }
  return sorted;
}

export function computeRefinementRelationDigest(
  relation: Omit<RefinementRelationV1, "relationDigest"> & { relationDigest?: Sha256Hash },
): Sha256Hash {
  const { relationDigest: _relationDigest, ...payload } = relation;
  return sha256HashCanonicalJson({
    ...payload,
    evidenceRefs: canonicalizeEvidenceRefs(payload.evidenceRefs),
  });
}

export function computeAttestationSetHash(digests: readonly Sha256Hash[]): Sha256Hash {
  return sha256HashCanonicalJson([...new Set(digests)].sort(compareCodeUnits));
}

export function computeControlFreshnessSealV2Hash(
  seal: Omit<ControlFreshnessSealV2, "sealHash">,
): Sha256Hash {
  return sha256HashBytes(concatBytes([
    FRESHNESS_V2_DOMAIN,
    encoder.encode(serializeControlReport(seal)),
  ]));
}

function u32be(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
    throw new RangeError("u32 value must be an integer between 0 and 4294967295");
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function prefixedUtf8(value: string): Uint8Array {
  return prefixedBytes(encoder.encode(value));
}

function prefixedBytes(value: Uint8Array): Uint8Array {
  return concatBytes([u32be(value.byteLength), value]);
}

function nullableAscii(value: string | null): Uint8Array {
  if (value === null) return Uint8Array.of(0);
  if (!/^[\x20-\x7e]*$/.test(value)) throw new Error("blob id must contain ASCII characters only");
  return concatBytes([Uint8Array.of(1), prefixedUtf8(value)]);
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
