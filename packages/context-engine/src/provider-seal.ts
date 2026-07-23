import { createHash } from "node:crypto";
import type {
  DerivedProviderFactSeal,
  SemanticCandidate,
  SemanticSearchInput,
} from "@semantic-context/cocoindex-adapter";

export const PROVIDER_FACT_REASON_ORDER = [
  "PROVIDER_FACT_UNSEALED",
  "PROVIDER_FACT_INVALID",
  "PROVIDER_INPUT_DIGEST_MISMATCH",
  "PROVIDER_SOURCE_SEAL_MISMATCH",
] as const;

export type ProviderFactReason = (typeof PROVIDER_FACT_REASON_ORDER)[number];

export interface ProviderCaptureContext {
  sourceRepositorySealHash: string;
  capturedAt: string;
}

export interface ProviderFactValidation {
  accepted: boolean;
  reason?: ProviderFactReason;
}

export interface ProviderValidationContext {
  expectedSourceRepositorySealHash?: string;
  expectedInput?: SemanticSearchInput;
}

/** Accept a repository seal only when every capture is present and byte-identical. */
export function stableProviderSourceSeal(
  ...captures: Array<string | undefined>
): string | undefined {
  const first = captures[0];
  return first !== undefined && captures.length > 0 && captures.every((capture) => capture === first)
    ? first
    : undefined;
}

function hash(domain: string, payload: string): string {
  const digest = createHash("sha256")
    .update(`semctx:${domain}:v1\0`, "utf8")
    .update(payload, "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

function factPayload(candidate: SemanticCandidate): Record<string, unknown> {
  return {
    filePath: candidate.filePath.replace(/\\/g, "/"),
    ...(candidate.symbolName !== undefined ? { symbolName: candidate.symbolName } : {}),
    score: candidate.score,
    ...(candidate.snippet !== undefined ? { snippet: candidate.snippet } : {}),
    ...(candidate.startLine !== undefined ? { startLine: candidate.startLine } : {}),
    ...(candidate.endLine !== undefined ? { endLine: candidate.endLine } : {}),
    provider: candidate.provider,
  };
}

function sealPayload(candidate: SemanticCandidate, seal: Omit<DerivedProviderFactSeal, "sealHash">): string {
  return JSON.stringify({ fact: factPayload(candidate), seal });
}

function providerInputDigest(
  input: SemanticSearchInput,
  providerIdentity: string,
  providerVersion: string,
): string {
  return hash("derived-provider-input", JSON.stringify({
    providerIdentity,
    providerVersion,
    query: input.query,
    repositoryRoot: input.repositoryRoot.replace(/\\/g, "/"),
    limit: input.limit,
  }));
}

/** Bind provider candidates to their exact query and source-repository freshness seal. */
export function sealProviderCandidates(
  candidates: readonly SemanticCandidate[],
  input: SemanticSearchInput & { providerIdentity: string; providerVersion: string },
  capture: ProviderCaptureContext,
): SemanticCandidate[] {
  const inputDigest = providerInputDigest(input, input.providerIdentity, input.providerVersion);
  return candidates.map((candidate) => {
    if (candidate.provider !== input.providerIdentity) return { ...candidate };
    const unsigned: Omit<DerivedProviderFactSeal, "sealHash"> = {
      schemaVersion: 1,
      kind: "derived_provider_fact_seal",
      providerIdentity: input.providerIdentity,
      providerVersion: input.providerVersion,
      inputDigest,
      sourceRepositorySealHash: capture.sourceRepositorySealHash,
      capturedAt: capture.capturedAt,
      provenance: "derived",
    };
    return { ...candidate, seal: { ...unsigned, sealHash: hash("derived-provider-fact-seal", sealPayload(candidate, unsigned)) } };
  });
}

/** Fail-closed validation used before a provider fact may affect a compiled pack. */
export function validateProviderCandidate(
  candidate: SemanticCandidate,
  context: ProviderValidationContext,
): ProviderFactValidation {
  const seal = candidate.seal;
  if (seal === undefined) return { accepted: false, reason: "PROVIDER_FACT_UNSEALED" };
  const validShape = seal.schemaVersion === 1
    && seal.kind === "derived_provider_fact_seal"
    && seal.providerIdentity === candidate.provider
    && seal.providerVersion.length > 0
    && /^sha256:[0-9a-f]{64}$/.test(seal.inputDigest)
    && /^sha256:[0-9a-f]{64}$/.test(seal.sourceRepositorySealHash)
    && Number.isFinite(Date.parse(seal.capturedAt))
    && seal.provenance === "derived"
    && /^sha256:[0-9a-f]{64}$/.test(seal.sealHash);
  if (!validShape) return { accepted: false, reason: "PROVIDER_FACT_INVALID" };
  const { sealHash: _sealHash, ...unsigned } = seal;
  const expectedFactSeal = hash("derived-provider-fact-seal", sealPayload(candidate, unsigned));
  if (seal.sealHash !== expectedFactSeal) return { accepted: false, reason: "PROVIDER_FACT_INVALID" };
  if (
    context.expectedInput === undefined
    || seal.inputDigest !== providerInputDigest(context.expectedInput, seal.providerIdentity, seal.providerVersion)
  ) {
    return { accepted: false, reason: "PROVIDER_INPUT_DIGEST_MISMATCH" };
  }
  if (
    context.expectedSourceRepositorySealHash === undefined
    || seal.sourceRepositorySealHash !== context.expectedSourceRepositorySealHash
  ) {
    return { accepted: false, reason: "PROVIDER_SOURCE_SEAL_MISMATCH" };
  }
  return { accepted: true };
}
