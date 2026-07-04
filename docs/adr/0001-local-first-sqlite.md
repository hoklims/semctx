# ADR 0001 — Local-first persistence on SQLite

- Status: accepted
- Date: 2026-07-04

## Context

semctx must be trivially droppable into any repository, run offline, produce
inspectable artifacts, and never require a service to stand up. Agents run in
sandboxes and CI without network guarantees.

## Decision

Persist the repository graph, claims, evidence, task frames and context packs in a
single local SQLite database under `.semctx/semctx.db`, using Bun's built-in
`bun:sqlite`. No external database, no daemon, no server.

## Consequences

- Zero external dependency for storage; the DB file is a portable, diffable artifact.
- `bun:sqlite` is synchronous and fast for the sizes we target (thousands of nodes).
- No Neo4j / graph database (explicitly out of scope for the MVP). Graph traversal is
  done in-process over adjacency lists loaded from SQLite.
- If we ever outgrow SQLite, the store is behind a `RepositoryStore` interface, so the
  backend is replaceable without touching the engine.
