# Architecture Overview

> Status: post-ADR-0005. `semctx` is a **repository change-impact analyzer** built around
> `verify diff`. The `task → ContextPack` retriever is withdrawn as a primary retriever
> (ADR 0005); graph traversal is retained for impact analysis and justification only. Where a
> mechanism is heuristic, it is labelled as such.

## Problem

Given a change, an agent (or a reviewer) needs to know what it put at risk *before* it lands:

- Which **symbols** did the diff actually touch?
- Which **exported contracts** does it alter?
- Which **invariants** (author-annotated) constrain the touched code?
- Which **tests** cover it — and are they present at all?
- Which **deprecated/contradicted** sources does the change lean on (non-normative)?
- What can static analysis **not** prove (e.g. a concurrency race)?

`semctx` answers these deterministically and issues a **PASS / WARN / BLOCK** verdict.

> It does **not** answer *"which files look relevant to this task?"* — grep, embeddings and
> CocoIndex do that better. A comparative benchmark (`benchmarks/change-impact-eval`) showed the
> former retriever losing to plain BM25; hence ADR 0005.

## Pipeline

```
repository  -> Repository graph   (deterministic TS + docs + migrations + tests + @markers)
git diff    -> impact analysis     (touched symbols, exported contracts, annotated invariants, tests)
            -> gates + verdict      (strict/advisory rules -> PASS / WARN / BLOCK, with provenance)
```

Every stage is a pure function of repository state plus the diff. No stage depends on an LLM, a
network call, or CocoIndex. The only intentionally non-deterministic value is the wall-clock
timestamp stamped on outputs, injected through a `Clock` so tests pin it.

> The `task → ContextPack` pipeline (`TaskFrame → claims → authority → pack`) still exists in
> `context-engine` and is reused for impact/justification, but it is **experimental** and is not
> a task-to-code retriever (ADR 0005).

## Packages

| Package                         | Responsibility                                              |
| ------------------------------- | ---------------------------------------------------------- |
| `@semantic-context/core`        | Domain model, ids, errors, Zod boundary schemas.           |
| `@semantic-context/ts-analyzer` | TypeScript Compiler API -> graph nodes/edges; docs, tests, migrations, semantic markers. |
| `@semantic-context/repository-store` | SQLite (`bun:sqlite`) persistence of graph, claims, evidence, task frames, packs. |
| `@semantic-context/context-engine` | TaskFrame extraction, claim building, authority policies, priority gates, contradiction detection, pack + verify assembly. |
| `@semantic-context/cocoindex-adapter` | Optional `SemanticCandidateProvider` interface + isolated CocoIndex adapter. |
| `@semantic-context/mcp-server`  | MCP server exposing `prepare_task`, `inspect`, `verify_change`. |
| `@semantic-context/test-fixtures` | Fixture repo paths + helpers for end-to-end tests.       |
| `apps/cli`                      | `semctx` CLI (zero-framework arg router).                  |

## Separation of concerns (hard boundaries)

- **Parsing** (`ts-analyzer`) never persists and never ranks. It emits a graph.
- **Storage** (`repository-store`) never parses and never ranks. It reads/writes rows.
- **Ranking** (`context-engine`) never touches the filesystem AST directly; it consumes
  the stored graph + claims and produces packs and verdicts.
- **CLI / MCP** are thin transports over the engine. No business logic lives there.
- `core` depends on nothing but Zod. Everything depends on `core`.

## Determinism & provenance

- Ids are content-addressed and human-readable (`sym:function:src/x.ts:foo:12`).
- Every node, edge and claim carries `EvidenceRef`s (file + line + source kind).
- Every ContextPack recommendation resolves to evidence ids; nothing is asserted
  without a pointer to a checkable source.
- Authority is **task-relative**: `priority(source, task)`, not a global score.

## Authority is not a number

Numeric signals (authority, freshness, confidence) never *alone* decide selection. A
source can be **eliminated by a gate** before scoring — deprecated, contradicted,
outside the selected bounded context, insufficiently verified for a security claim, or
not reachable from a relevant entrypoint. This is the property that stops a
lexically-similar but obsolete document from becoming normative.

See `docs/concepts/claims-and-authority.md` and `docs/architecture/data-model.md`.
