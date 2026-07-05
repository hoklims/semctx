# Semctx Semantic Layer — v1 architecture

> Status: implemented (v1 vertical slice). Companion docs: [`semantic-model.md`](./semantic-model.md),
> [`change-contracts.md`](./change-contracts.md), the ADR
> [`0009-semantic-layer-is-separate-from-the-repository-graph.md`](../adr/0009-semantic-layer-is-separate-from-the-repository-graph.md),
> and the integration guide [`../integrations/claude-code-semantic-layer.md`](../integrations/claude-code-semantic-layer.md).

## Why a second layer

`semctx verify diff` answers one question precisely and deterministically:

> *given this change, what did it put at risk, and is it proven?*

It cannot answer a different, longer-lived question an agent needs while transforming a system:

> *which intention, invariants, decisions, evidence and unknowns must survive while an agent
> changes this code?*

The first question is about **repository facts** derived from source. The second is about
**authored semantic truth** — goals, business invariants, decisions, assumptions and unknowns that
a human or agent declares and links to the code. Conflating them is exactly the failure mode ADR
0005 warns against: `semctx` must not pretend to *find* what is relevant to a natural-language
task. The Semantic Layer therefore never selects files from a free-text task; it operates on
**explicit, authored declarations** and the **explicit links** they carry into the deterministic
graph.

## Two strictly separated planes

| Plane | Owner | Source of truth | Representation |
| --- | --- | --- | --- |
| **A — Repository facts** | derived from code | the repo + `semctx index` (SQLite is a regenerable cache) | `RepositoryGraph` nodes/edges, `Claim`s, `EvidenceRecord`s, `VerifyReport` |
| **B — Authored semantic truth** | authored by human/agent | Git-versioned `.semctx/semantic/**.sem` files | `SemanticNode`s, `ChangeContract`s |

Plane A already exists and is untouched. Plane B is new. The **only** coupling from B to A is an
explicit `RepositoryLink` on a semantic node, whose `ref` is a Plane-A id (`sym:…`, `inv:…`,
`contract:…`, `claim:…`, `test:…`, `mig:…`, `cap:…`, `ev:…`) or a repo-relative file path. A fact
and an intention never share a type without explicit `provenance`.

```
"handleStripeWebhook calls reserveInventory"   → Plane A structural fact (derived)
"an applied payment must never reserve twice"  → Plane B invariant   (author)
"the Stripe retry is probably the cause"       → Plane B assumption  (agent)
"the webhook-retry test passes"                → Plane A/B evidence  (tested)
```

## Packages (new)

Mirrors the existing split (`core` → `context-engine` → `mcp-server`/`cli`) and the `@semantic-context/*`
scope:

```
packages/
  semantic-model/    @semantic-context/semantic-model   pure types + Zod + deterministic ids (deps: core)
  semantic-dsl/      @semantic-context/semantic-dsl      tolerant parser + deterministic formatter + renderer (deps: semantic-model)
  semantic-engine/   @semantic-context/semantic-engine   files ↔ model, link resolution, stale, slice,
                                                         change-contract lifecycle, composed verify, handoff
                                                         (deps: core, context-engine, repository-store, semantic-model, semantic-dsl)
```

Wiring reuses existing surfaces, never forks them:

- `apps/cli` gains a `semantic` and a `change` command family (same `run*(root, args): number` shape).
- `packages/mcp-server` registers the new agent tools alongside `semctx_verify_change` (unchanged).
- `plugins/claude-code` gains a `semctx-semantic` skill and handoff/resume; the guarded hook is
  reused as-is.

## Storage & persistence decision

```
.semctx/
  semantic/                 ← Git-versioned SOURCE OF TRUTH (authored declarations)
    goals.sem
    invariants.sem
    decisions.sem
    assumptions.sem
    unknowns.sem
    changes/<change-id>.sem
  working/                  ← local, git-ignored (agent scratch)
    active-change.sem
    handoff.json
    handoff.md
  config.json               ← local (existing behaviour, git-ignored)
  semctx.db                 ← local regenerable index (Plane A; Semantic Layer does NOT persist here in v1)
```

- **`.semctx/semantic/**` is versioned in Git** — it is the declared truth and must diff, review
  and merge like code. `.gitignore` is refined from a blanket `.semctx/` to `.semctx/*` +
  `!.semctx/semantic/` so the rest of `.semctx/` stays local while `semantic/` is tracked.
- **`.semctx/working/**` is local** and git-ignored (recommended). It holds the active change and
  the handoff capsule — regenerable scratch, never authoritative.
- **SQLite stays a Plane-A index.** The Semantic Layer reads `.sem` files directly (Git is the
  source of truth); no semantic rows are persisted in v1. This keeps determinism and avoids a DB
  migration surface. A compiled semantic index is a v2 option, regenerable and non-authoritative.

## DSL (v1) — line/indentation, ASCII-canonical

A small, tolerant, deterministic, hand-written line-oriented format — **not** YAML (YAML quoting
is a determinism hazard) and **not** a generated parser. One block per node:

```
goal goal.checkout.reliable-payment
  statement: A payment event must be applied at most once.
  status: declared
  provenance: author
  tag: checkout

invariant invariant.payment.idempotent
  statement: retry(event) is equivalent to apply_once(event)
  status: declared
  link: inv:confirmed-never-exceeds-capacity
  link: sym:function:src/domain/confirmation.ts:confirmReservation:12
  tag: critical
```

- Header: `<kind> <id>`. `id` prefix must match `kind` (`goal.`, `invariant.`, `decision.`,
  `assumption.`, `unknown.`, `change.`, `evidence.`/`proof.`).
- Fields are 2-space indented `key: value`. Scalars: `statement` (`rule` accepted as a synonym on
  invariants), `status`, `provenance`.
- Relation fields (each maps to a `SemanticRelationKind`): `serves`, `preserves`, `implements`,
  `depends_on`, `justifies`, `requires_evidence` (`requires` synonym), `proved_by`, `risks`,
  `contradicts`, `supersedes`. Change-only: `unknown` (open unknowns).
- Multi-value forms, all unambiguous: repeated `key: v`, inline `key: [a, b]`, or a block list of
  `  - item` lines under a bare `key:`.
- `link: <ref>` adds a `RepositoryLink`; the link kind is inferred from the id prefix (`file:<path>`
  or a bare path → a file link). `tag: <t>` adds a tag. `meta: k=v` adds string metadata.
- Diagnostics carry `{ file, line, column, message }`. The **formatter is deterministic and
  idempotent** (canonical field order, relation targets sorted by code-unit). A **symbol renderer**
  projects `◇ □ ⊳ Δ ⊢ ? ⊥` for humans; an **ASCII renderer** is always available. Glyphs are never
  required to parse, compile or query.

## Model (see `semantic-model.md` for the full contract)

```ts
type SemanticNodeKind   = "goal" | "invariant" | "decision" | "assumption" | "unknown" | "change" | "evidence";
type SemanticStatus     = "declared" | "proposed" | "assumed" | "tested" | "statically_verified" | "runtime_verified" | "contradicted" | "stale";
type SemanticProvenance = "author" | "agent" | "derived";
type SemanticRelationKind = "implements" | "preserves" | "serves" | "justifies" | "depends_on" | "requires_evidence" | "proved_by" | "risks" | "contradicts" | "supersedes";
type ChangeLifecycle    = "draft" | "active" | "verified" | "partial" | "blocked" | "stale" | "superseded";
```

- `SemanticNode` (the six truth kinds) carries `id, kind, statement, status, provenance,
  sourceRefs, repositoryLinks, relations, tags, metadata?`.
- `ChangeContract` (kind `change`) is its own type carrying `id, statement, lifecycle, provenance,
  sourceRefs, serves[], preserves[], requiresEvidence[], openUnknowns[], repositoryLinks, tags,
  metadata?`.
- `SemanticModel = { nodes: SemanticNode[]; changes: ChangeContract[] }`.
- Deterministic ids: `semanticNodeId(kind, slug)` reusing `core.slugify`; the id itself is the
  authored `goal.*`/`invariant.*`/… label (already namespaced), validated, never randomised.

## Link resolution & stale detection (Plane B → Plane A)

`resolveRepositoryLinks(model, { graph, claims, evidence })` resolves each `RepositoryLink`:

| link kind | resolves against | stale when |
| --- | --- | --- |
| `symbol`/`invariant`/`contract`/`capability`/`test`/`migration` | graph node id | id absent from graph |
| `claim` | claim id | id absent from claims |
| `evidence` | evidence id | id absent from evidence |
| `file` | node `filePath` set | path indexed by no node |

A node with any unresolved link is reported **stale**. Evidence whose linked test node is gone is
**stale**; an invariant with a `contradicts` relation to a contradicted claim is **contradicted**.
`semantic check` surfaces these; `change verify` folds them into the verdict.

## Semantic slice (bounded, deterministic, no free-text retrieval)

`sliceSemanticModel(model, { changeId?, symbolRef?, claimRef?, maxNodes })`:

1. **Seed** from explicit scopes only: the named change/nodes, plus semantic nodes whose
   `repositoryLinks` target the given `--symbol`/`--claim`.
2. **Expand** along semantic relations (bounded hops), capped at `maxNodes` (default 60), ordered
   by `compareIds`.
3. **Project** into sections: *Intentions, Invariants, Decisions, Linked symbols & claims, Evidence
   obtained, Open unknowns, Forbidden / safety constraints, Next expected proofs*.

Guarantees: deterministic, bounded, stable order, every line points to a source, nothing invented,
absent items are shown as **unknown** — never asserted true or false.

## Composed change verification (Plane A ∘ Plane B)

`verifyChangeContract({ contract, model, graph, claims, evidence, verifyReport, config })` composes,
never bypasses, `verify diff`:

1. Run the existing `analyzeDiff` → `buildVerifyReport` (Plane-A impact/verdict), reused verbatim.
2. `preserves`: each preserved invariant is checked resolvable and proven (linked repo invariant is
   covered / not among untested-touched).
3. `requiresEvidence`: each required evidence node must have a *proved* status
   (`tested`/`statically_verified`/`runtime_verified`); otherwise it is an open proof obligation.
4. `openUnknowns`: listed; non-critical → PARTIAL, critical → escalates.
5. Stale/contradicted links and superseded-decision usage feed the policy.

Verdict policy (config-driven, Section 6), and **never more optimistic than the data**:

```
VERIFIED  all preserved invariants proved, all required evidence proved, no open blocking unknown,
          no stale/contradiction, underlying verdict ≠ BLOCK
PARTIAL   open non-critical unknowns or unproven required evidence, but nothing blocking
BLOCKED   underlying BLOCK, a critical preserved invariant with no proof, a contradicted invariant,
          or (per config) a superseded decision used by an active change
STALE     a repository link no longer resolves, or evidence points at a removed/renamed test
```

Output is a versioned `ChangeVerifyReport` (schemaVersion 1) that embeds the underlying
`VerifyReport` and adds the semantic verdict, preserved/proved/partial/stale breakdowns.

## Config (additive, backward-compatible)

`SemctxConfig` gains an optional `semantic` block (unknown keys were previously stripped by Zod; the
schema is extended so existing configs still parse and omitting the block uses defaults):

```jsonc
"semantic": {
  "enabled": true,
  "criticalInvariantTags": ["critical", "security"],
  "openUnknownSeverity": "warn",              // warn | block
  "supersededDecisionSeverity": "warn",       // warn | block
  "requireProofForActiveChange": true
}
```

## Claude Code integration

New MCP tools (advisory; the guarded hook is unchanged and still only gates `git commit`/`push`):
`semctx_semantic_slice`, `semctx_change_open`, `semctx_change_update`, `semctx_change_verify`,
`semctx_semantic_inspect`, `semctx_handoff`, `semctx_resume`. A `semctx-semantic` skill drives the
loop: open/select a `ChangeContract` → request a targeted slice → edit → `semctx_verify_change` →
`semctx_change_verify` → run recommended tests → update evidence/unknowns/status → never conclude on
a BLOCK, and state what remains unproven on PARTIAL.

## Determinism & honesty invariants (carried from the core product)

- The only non-deterministic input is the injected timestamp (`nowIso()` clock). Ids, parses,
  formats, slices and verdicts are byte-identical across runs on identical inputs.
- `established / assumed / unverified / contradicted / stale` stay distinct at all times: a
  `SemanticStatus` and a `RepositoryLink` resolution state are never silently upgraded.
- The layer is useful with **no LLM** (deterministic CLI), better with Claude Code, and honest in
  both cases: it shows what is present, and marks the rest unknown.
```