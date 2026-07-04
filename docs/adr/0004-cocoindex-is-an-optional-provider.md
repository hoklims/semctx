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

When a provider is configured, its candidates are folded in as *additional* nodes to
consider — subject to the same gates and authority policies as everything else. When
absent, the deterministic TS analysis fully drives the pipeline.

## Consequences

- The system works with zero semantic providers.
- CocoIndex (or any future provider) is swappable and never authoritative by itself.
- Provider candidates carry provenance `sourceKind: "runtime"`/`manual` and are clearly
  attributed in `ContextPackMeta.candidateProviders`.
