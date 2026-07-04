# ADR 0002 — No mandatory vector database / embeddings

- Status: accepted
- Date: 2026-07-04

## Context

RAG-style code tooling usually centres on an embeddings index. Embeddings are
probabilistic, opaque, costly to keep fresh, and cannot answer "which source is
authoritative". Our value proposition is deterministic, justified selection.

## Decision

The core pipeline uses **no embeddings and no vector database**. Selection is driven
by deterministic structural analysis (TS Compiler API, imports/exports, tests,
migrations, explicit semantic markers) plus task-relative authority policies.

Semantic candidate providers (e.g. CocoIndex) are **optional** and sit behind
`SemanticCandidateProvider`. They may *add* candidates; they never become the source of
truth and never gate the deterministic core.

## Consequences

- The tool runs fully offline and reproducibly by default.
- Results are explainable line-by-line; no "the vector said so".
- We accept lower lexical recall on fuzzy phrasing in exchange for trustworthy,
  gated authority. Optional providers close the recall gap when present.
