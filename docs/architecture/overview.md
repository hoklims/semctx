# Architecture Overview

> Status: post-ADR-0010 with a provisional multi-language runtime. `semctx` is a
> **repository change-impact analyzer** built around
> `verify diff`. The `task → ContextPack` retriever is withdrawn as a primary retriever
> (ADR 0005); graph traversal is retained for impact analysis and justification only. ADR 0010
> defines the multi-language Plane A trust model. Its runtime boundary remains private and
> provisional; no stable language-adapter API is claimed. Where a mechanism is heuristic, it is
> labelled as such.

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

## Current implementation

TypeScript remains Plane A's compatibility baseline:

- config v1 preserves the historical repository walk, approximate `exclude`, inactive `include`,
  and TypeScript/Markdown/SQL selection;
- config v2 explicitly opts into deterministic `globs-v1` include/exclude selection and
  per-language `on`/`off` modes;
- TypeScript receives Compiler-API semantic extraction for symbols, imports, calls, markers and
  test links;
- Markdown documents and SQL migrations receive bounded structural extraction, not general
  language support;
- the first Python vertical emits bounded local syntax facts through a private Plane-A sidecar.

Adding a file glob, detecting a workspace, or producing a file node still does not establish
capability or authority. Unsupported, disabled, failed, or partially analysed code must not be
treated as evidence of absence.

### Pipeline

```
repository  -> Repository graph   (TS semantic extraction + Markdown/SQL structural discovery)
git diff    -> impact analysis     (touched symbols, exported contracts, annotated invariants, tests)
            -> gates + verdict      (strict/advisory rules -> PASS / WARN / BLOCK, with provenance)
```

Every stage is a pure function of repository state plus the diff. No stage depends on an LLM, a
network call, or CocoIndex. The only intentionally non-deterministic value is the wall-clock
timestamp stamped on outputs, injected through a `Clock` so tests pin it.

> The `task → ContextPack` pipeline (`TaskFrame → claims → authority → pack`) still exists in
> `context-engine` and is reused for impact/justification, but it is **experimental** and is not
> a task-to-code retriever (ADR 0005).

Current freshness is reported independently as `FRESH`, `DIRTY_KNOWN`, `STALE` or `UNSEALED`.
It binds the captured source/index inputs; it does not prove that every language, workspace or fact
kind was analysed. Additive index health reports coverage and producer/capability failures without
replacing that freshness verdict.

## Provisional multi-language Plane A

[ADR 0010](../adr/0010-multilanguage-plane-a-capability-and-authority.md) freezes the trust
contract. The runtime implementation keeps five dimensions independent:

1. discovery state for the exact artifact scope;
2. provider/result binding and integrity;
3. current freshness;
4. fact capability for the requested fact kind and scope;
5. task-relative authority under the requested operation.

No dimension substitutes for another. In particular, a valid seal or `FRESH` state does not imply
support, coverage, completeness or authority.

The design binds facts to an exact `ArtifactScope` and a `CapabilityProfile`, including the selected
path or manifest-evidenced workspace, language/dialect, fact kind, producer and version, relevant
configuration/schema digests, evidence contract, resolution semantics, and soundness/completeness
claims. Human-friendly labels such as `structural` or `precise` may summarize capability, but cannot
authorize a gate.

Absence becomes evidence only when completeness is established for the exact fact kind and scope.
Without that negative-evidence eligibility, conclusions such as “no test”, “no reference” or “no
impacted contract” remain `UNKNOWN` / `INSUFFICIENT_ANALYSIS`, never PASS.

Index health composes discovery outcomes, capability gaps, fact batches, producer results, and
workspace diagnostics without replacing the existing freshness verdict. Workspace membership
requires explicit supported manifest or workspace metadata; directory names such as `packages/`
and `apps/` are candidate signals only and never establish membership, language support or
authority. Dedicated private sidecar relations preserve the meaning and bytes of legacy
`belongs_to`.

The implementation is split across:

- [#58 — Plane A language-neutral adapter and graph assembly boundary](https://github.com/hoklims/semctx/issues/58)
- [#59 — Honor include/exclude with explicit selection compatibility](https://github.com/hoklims/semctx/issues/59)
- [#60 — Manifest-evidenced workspaces and separate index health](https://github.com/hoklims/semctx/issues/60)
- [#61 — First real second-language Plane A vertical and corpus gate](https://github.com/hoklims/semctx/issues/61)

See [Multi-language Plane A runtime](./multilanguage-plane-a-runtime.md) for the exact compatibility,
selection, health, workspace, Python, and public-status boundaries.

## Packages

| Package                         | Responsibility                                              |
| ------------------------------- | ---------------------------------------------------------- |
| `@semantic-context/core`        | Domain model, ids, errors, Zod boundary schemas.           |
| `@semantic-context/ts-analyzer` | TypeScript Compiler API -> graph nodes/edges; docs, tests, migrations, semantic markers. |
| `@semantic-context/plane-a-internal` | Private provisional fact assembly, binding, sidecar and admissibility gates; not a public adapter API. |
| `@semantic-context/python-analyzer` | Private Python-through-3.12 syntax extractor for the first second-language vertical. |
| `@semantic-context/workspace-analyzer-internal` | Private manifest-evidenced workspace projection and containment relations. |
| `@semantic-context/repository-store` | SQLite (`bun:sqlite`) persistence of graph, claims, evidence, task frames, packs. |
| `@semantic-context/context-engine` | TaskFrame extraction, claim building, authority policies, priority gates, contradiction detection, pack + verify assembly. |
| `@semantic-context/semantic-model` | Authored semantic truth (Plane B): goals, invariants, decisions and change contracts. |
| `@semantic-context/semantic-engine` | Plane B file model, link/stale checks, bounded slices, composed verification and handoff. |
| `@semantic-context/control-model` | Plane C coordinates, snapshots/deltas, plans, proofs and versioned authorization reports. |
| `@semantic-context/control-engine` | Read-only A+B projection, bounded traversal, architecture comparison and fail-closed migration policy. |
| `@semantic-context/app-services` | Shared indexing, index-health, verification, change-lifecycle and control use cases; owns Git/store lifetimes for CLI and MCP. |
| `@semantic-context/cocoindex-adapter` | Optional `SemanticCandidateProvider` interface + isolated CocoIndex adapter. |
| `@semantic-context/mcp-server`  | MCP server exposing repository, semantic, control, and read-only index-health tools. |
| `@semantic-context/test-fixtures` | Fixture repo paths + helpers for end-to-end tests.       |
| `apps/cli`                      | `semctx` CLI (zero-framework arg router).                  |

## Separation of concerns (hard boundaries)

- **Parsing** (`ts-analyzer`) never persists and never ranks. It emits a graph.
- **Storage** (`repository-store`) never parses and never ranks. It reads/writes rows.
- **Ranking** (`context-engine`) never touches the filesystem AST directly; it consumes
  the stored graph + claims and produces packs and verdicts.
- **CLI / MCP** are thin transports over `app-services`; engines remain pure and graph-in.
- **Plane C** reads A+B through explicit adapters; it never mutates either source and has no executor.
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
