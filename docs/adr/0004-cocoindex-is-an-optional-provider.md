# ADR 0004 — CocoIndex is an optional candidate provider

- Status: accepted
- Date: 2026-07-04

## Context

CocoIndex provides good semantic candidate retrieval. But making the product depend on
it would break local-first determinism and couple us to an external index.

## Decision

Define a narrow `SemanticCandidateProvider` interface in `cocoindex-adapter`. Ship a
`NullSemanticCandidateProvider` (default, returns nothing) and an isolated
`CocoIndexCandidateProvider` behind the same interface. The `context-engine` depends on
the interface, never on CocoIndex directly.

When a provider is configured, a candidate may be folded in as an *additional* node to consider
only after the provider returns candidates, version, and the exact source-repository seal in one
atomic attested-result envelope, while the caller recaptures that same seal before and after
retrieval. The derived-provider seal then binds exact provider
identity/version, query input digest, source seal, capture time, provenance, and fact bytes.
Unsealed, tampered, replayed, source-mismatched, or mid-capture candidates remain diagnostic-only.
The current `ccc` CLI exposes no source-state attestation, so its candidates intentionally remain
diagnostic-only until that capability exists.
When absent, the deterministic TS analysis fully drives the pipeline.

## Consequences

- The system works with zero semantic providers.
- CocoIndex (or any future provider) is swappable and never authoritative by itself.
- Accepted provider candidates carry explicit `provenance: "derived"`, provider version, input
  digest and source-state seal; rejected facts expose canonical reason codes in pack warnings.
- A provider candidate can orient secondary consideration, but never becomes an authoritative
  claim, hard constraint, or recommended read by itself.
