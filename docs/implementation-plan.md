# Implementation Plan

Concrete, phase-by-phase. Each phase ends with green tests before moving on.

## Phase 0 — Scaffold + docs (done first)

- Bun monorepo, TS strict, tsconfig, bunfig.
- `core`: full domain model + ids + errors + Zod boundary schemas.
- `docs/architecture/overview.md`, ADR 0001-0004, this plan.

## Phase 1 — Vertical slice

Goal: `init -> index -> task create -> context prepare` produces a justified pack on the
sample fixture, with no LLM / network / CocoIndex.

- `ts-analyzer`:
  - `analyzeRepository(config)` -> `RepositoryGraph`.
  - Modules, imports/exports, functions/classes/interfaces/types/enums, call edges
    (best-effort static), test files (Vitest by import + naming), `tested_by` via import
    resolution, markdown docs, migrations by convention.
  - Semantic markers: `@capability`, `@invariant`, `@contract`, `@risk`,
    `@boundedContext` in JSDoc; frontmatter `capabilities/invariants/status/contradicts`
    in docs. These create capability/invariant/contract/decision nodes deterministically.
- `repository-store`: SQLite schema + DAO (upsert graph, evidence, claims, task frames,
  packs; load graph; query by id/name/capability).
- `context-engine`:
  - Heuristic `TaskFrameExtractor` (no LLM): mode detection, capability/invariant/context
    keyword extraction, hypotheses from observed/expected phrasing.
  - `buildClaims(graph)` -> claims with verification status derived from evidence.
  - `ContextPackBuilder`: classify question kind, apply authority policy + gates, rank,
    assemble primary/secondary nodes, impact paths, tests, contradictions, unknowns,
    recommended reads, verification plan.
- `apps/cli`: `init`, `index`, `task create`, `context prepare` (+ `--json`).
- `examples/sample-typescript-repo`: booking domain, overbooking bug, invariant,
  migration, tests, ADR, contradictory doc, lexical-neighbour decoy.
- Tests: analyzer, store, extractor, pack builder, end-to-end fixture.

## Phase 2 — Authority + contradictions

- `AuthorityPolicy` table per question kind (already modelled).
- Priority gates as first-class, with `PriorityExplanation`.
- Contradiction detection (frontmatter `contradicts`, deprecated status, invariant vs
  documented-behaviour mismatch).
- Non-regression test: deprecated/contradicted lexical neighbour never authoritative.

## Phase 3 — verify diff

- `git diff` parse -> changed files/hunks -> impacted nodes/claims/invariants/contracts.
- Recommend tests via `tested_by`; flag contradictions/unknowns.
- Verdict PASS/WARN/BLOCK from configured `blockingRules`; non-zero exit on BLOCK.

## Phase 4 — MCP server

- `semctx_prepare_task`, `semctx_inspect`, `semctx_verify_change`.
- Zod-validated inputs; installable locally; documented Claude Code integration.

## Phase 5 — CocoIndex adapter + review

- `SemanticCandidateProvider` interface, `NullSemanticCandidateProvider`, isolated
  CocoIndex adapter (simulated/documented per environment availability).
- Final adversarial multi-agent review; fix; complete docs + README.

## Determinism budget

The only non-deterministic value is the output timestamp, injected via `Clock`. Any
future non-determinism (provider order, git availability) must be explicit and reflected
in `ContextPackMeta.deterministic` / `warnings`.
