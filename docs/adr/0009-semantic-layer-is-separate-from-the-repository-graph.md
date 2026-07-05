# ADR 0009 — The semantic layer is a separate plane from the repository graph

- Status: accepted
- Date: 2026-07-05
- Related: ADR 0001 (local-first SQLite), ADR 0005 (retriever rejected), ADR 0008 (versioned output)

## Context

`semctx verify diff` computes, deterministically, *"given this change, what did it put at risk, and
is it proven?"* over a graph **derived** from source. Agents transforming a system need a second,
longer-lived thing the derived graph cannot hold: the **authored** intent, business invariants,
decisions, assumptions, evidence and unknowns that must survive across many edits and across context
compactions — and the explicit links between that authored truth and the code.

The temptation is to fold this into the existing graph (add "goal" and "decision" node kinds and
let the analyzer infer them). ADR 0005 is the standing warning against that: the moment `semctx`
*infers* what matters from names/structure it loses to a content retriever and stops being honest.

## Decision

Introduce a **Semantic Layer** as a strictly separate plane, and keep the boundary sharp.

1. **Two planes, never conflated.**
   - **Plane A — repository facts** (derived): symbols, imports, calls, contracts, invariants,
     tests, markers, claims, `verify diff` results. Owned by the analyzer; a fact.
   - **Plane B — authored semantic truth** (declared): goals, invariants, decisions, assumptions,
     unknowns, change contracts, evidence. Owned by a human/agent; an intention.
   - A fact and an intention never share a type without explicit `provenance` (`author` / `agent` /
     `derived`). The only coupling from B to A is an explicit `RepositoryLink`.

2. **The DSL is canonical; Unicode is a view.** The `.sem` source is a line/indentation, ASCII
   format with a deterministic formatter and file/line/column diagnostics. The glyphs
   (`◇ □ ⊳ Δ ⊢ ? ⊥ ≈ →`) are a *rendering* only: an ASCII projection is always available and no glyph
   is ever required to parse, compile or query. This avoids a glyph cult and a determinism hazard
   (no ambiguous quoting, no generated parser, no YAML).

3. **Semctx Semantic does not do content retrieval.** The semantic slice seeds **only** from
   explicit scopes (a change id, a repository symbol/claim ref) and expands along authored
   relations under a node cap. It never ranks files for a natural-language task — that is grep /
   BM25 / embeddings / CocoIndex / a human (ADR 0005 stands). The layer *consumes* a selection; it
   does not pretend to *produce* one.

4. **Git is the source of truth; SQLite is a local index.** Authored declarations live in
   Git-versioned `.semctx/semantic/**.sem` — they diff, review and merge like code. The SQLite
   store remains a regenerable Plane-A cache (ADR 0001); the Semantic Layer persists nothing
   authoritative there in v1. Working scratch (`.semctx/working/**`) is local and git-ignored.

5. **Proof, assumption and unknown stay distinct — always.** `SemanticStatus` keeps `declared`
   (unverified), `assumed`, `tested`/`statically_verified`/`runtime_verified` (proven),
   `contradicted` and `stale` separate. The composed `change verify` verdict is **never more
   optimistic than the data**: it never turns PARTIAL into VERIFIED on its own. Because `semctx` is
   static, obtaining a proof is the agent's dynamic step (run the test, then record the evidence
   status) — the layer only tracks what has been declared/obtained, and shows the rest as unknown.

## Consequences

- The product story stays honest: `verify diff` is the impact analyzer; the semantic layer is a
  memory of authored intent; neither claims to *find* relevant code.
- `change verify` **composes** `verify diff` (via the shared `computeVerifyReport` /
  `buildVerifyReport`), it does not bypass or re-implement it. A more optimistic verdict is
  structurally impossible.
- A new `ChangeVerifyReport` is versioned (`schemaVersion 1`) like the `VerifyReport` (ADR 0008), so
  external consumers depend on the version, not internal types.
- The additive `semantic` config block is optional; pre-semantic configs keep validating. The Zod
  schema is extended so a `semantic` block is no longer silently stripped.
- Cost of the boundary: authored truth must be **written and maintained** by humans/agents; the tool
  will not invent it. That is the point — the alternative (inference) is what ADR 0005 rejected.
