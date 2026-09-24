# ADR 0030 — ChangeImpact: a machine-readable impact contract that decides no proof

- Status: proposed
- Date: 2026-09-23
- Related: ADR 0008 (versioned machine output), ADR 0009 (Plane A/Plane B separation), ADR 0010
  (negative evidence), ADR 0029 (guarded content proof)

## Context

`verify diff` answers two questions in one report: *what can this change affect* and *is it
acceptable*. Its `verdict` mixes impact, proof sufficiency and index admissibility; its
`recommendedTests` are file-level test imports presented downstream as tests that must pass; an
invariant with no finding reads as satisfied. An external proof planner that wants only the first
answer cannot get it without inheriting the second.

The shape of that report also hides the boundaries that matter to such a planner. Impact is
attributed at module granularity, so a one-line change to a private constant impacts the whole
module and every importer of it; nothing distinguishes a behavioural link (a caller executes the
changed code) from a structural one (a file imports the changed file); and absence of a finding is
the only signal for "not affected". A small replay change in a consumer repository was requalified
far beyond its real reach for exactly these reasons: nothing in the machine output said where the
reach stopped, or why.

## Decision

Add a separate, versioned `ChangeImpact` report (`kind: "change_impact"`, `schemaVersion: 1`),
produced by `semctx impact diff` and by the shared `runChangeImpact` use case. It reports what a
change can affect, through which link, with what confidence, and where the modeled reach stops. It
contains no proof verdict, no proof level, no test obligation, no proof count and no allow/block
decision; its one `verdict` field is the freshness state of the index the binding read.

**Machine source of truth**: `packages/core/src/change-impact.ts` (types and the producer-side zod
schema every emitted document is validated against in tests). The schema checks the relations
between fields, not only their shape: a broken binding nulls every index-derived field and has
confidence `none`; the reach is complete exactly when no gap affects it, and confidence, blast-radius
scope and `not_reached` surfaces follow; every chain is as long as its distance. Consumer documentation:
[`docs/reference/change-impact.md`](../reference/change-impact.md).

### Tiers are defined by the kind of link, never by a score

- `changes.units` — what changed, classified: a symbol, a top-level declaration without a node, a
  module statement, a comment or trivia (`behavioral: false`, recognised by an unchanged token
  stream reached the same way on both sides), an added or removed declaration, or an
  `unclassified` text the outline could not place or a directive comment whose effect is not
  modeled (itself a boundary). Code that runs as its module loads carries `runsOnLoad`, and its importers
  are dependents whether it is exported or not. The classification rules are part of the contract
  ([reference](../reference/change-impact.md#how-a-change-is-classified)).
- `directlyAffected` — one link from a changed unit: a resolved caller or a same-file statement
  referencing it (behavioural), or a test importing it by name (the test names it; it is not shown
  to exercise the change).
- `transitivelyAffected` — the same relations followed further, up to `maxDistance`.
- `possiblyAffected` — a structural link only (the dependent imports, re-exports or loads a file
  whose exported behaviour changed), one hop, never expanded except through re-exporters, capped at
  `maxTargets` with the omitted count reported.
- `explicitlyUnaffected` — always empty in schema version 1. No producer is negative-evidence
  eligible (ADR 0010); stating non-impact would require a new schema version and an eligible
  producer.
- `unresolved` — every boundary where the modeled reach stops, typed and scoped, with what it leaves
  incomplete (`reach`, `claims`, or `none`).

Every target carries `reason`, `distance` and its shortest `via` chain back to a changed unit (or
`file:<path>` for a change reported at file level).

### The index is joined only on the diff side whose coordinates it provably carries

Indexed line ranges are frozen at indexing time. They are joined with the hunks of the side that
has the same coordinates: the old side of a working-tree or staged diff against an index of the
clean head, the new side of a range ending at the indexed head. An index built on a dirty tree is
bound per file: a file that was already dirty then (with the same Git status record now: same
bytes, same staging) is joined on its new side, any other file on its committed side; which local
changes existed at indexing is recovered by testing subsets of today's local changes (at most 12;
beyond that the search is not attempted and the break says so) against the indexed working-diff
hash. An untracked file proven unchanged that way is a new file, not an unknown. When no side can
be proven — a file changed (or staged) after being indexed dirty, a staged or range diff over an
index that read any uncommitted file or missed a committed one (its edges then describe neither
side), a worktree, Git index or semctx index that changes during the analysis, or any break the
shared index-binding probe observes — the binding is `broken` and every index-derived field is `null`,
never empty.

### Surfaces are declared, never inferred

A functional surface (runtime-live, replay, scoring, …) is an explicit JSON map given with
`--surfaces`. The engine only projects tiers onto it. `not_reached` is emitted only when the reach
is complete and the possible tier is untruncated, and still means "no modeled path", not "safe".

### Confidence is a projection, not a probability

`none` when the binding is broken, `low` when any gap affects the reach, otherwise `moderate` — the
ceiling for static reach. A higher level would require a new schema version.

## What semctx refuses to decide

Proof levels, which tests must run, how many proofs are needed, whether a change may proceed, and
whether an exposed invariant still holds. Those are the planner's policy over this report.

## Compatibility

Additive. `verify diff`, `VerifyReport` v1 (ADR 0008), the MCP tools and the hooks are unchanged;
`runVerify` is characterized byte-for-byte by
`packages/app-services/test/verify-computation-characterization.test.ts`, whose pins were replayed
on a7cd55c with the same fixture, and the working-diff hash that seals verification state is
computed by the same algorithm, now split into entries and hash: the seal of a non-empty local
delta is pinned to the value a7cd55c computes. The strict diff parser `verify` uses keeps its input
contract; only the collecting parser added for this report reads `diff --git` header paths.
The generated plugin runtimes embed the CLI, so they gain `impact diff` additively and are
regenerated with this change. The new command exits 0 whenever it produces a report: a broken
binding or incomplete reach is data, not a failure. Within `schemaVersion: 1`, additions are
optional fields and new codes in the open code sets (`reason`, `unresolved[].code`,
`limits[].code`, `confidence.reasons`, `blastRadius.rationale`, binding `breaks`); consumers must
treat unknown codes as opaque rather than as absence. Removing or re-meaning a field requires
schema version 2.

Not in this decision: an MCP tool, `--from-file` input (a diff semctx did not compute cannot be
bound), and non-TypeScript call reach (Python reports `language_has_no_call_edges`).

## Evidence

- `packages/context-engine/test/change-impact.test.ts` — tiers, reach direction, private constants,
  comment-only changes, truncation, re-export barrels, unscanned and non-literal module links,
  determinism.
- `packages/app-services/test/change-impact.test.ts` — end to end on
  `examples/change-impact-replay`: local replay change with package-scope blast radius and the live
  path only possible; private constant; comment-only; barrel consumer; staged, range, dirty-index
  (new side), per-file mixed binding; staged and range breaks over an index that read uncommitted
  files or missed a committed one; a new-side file taking over a module; a range removing a local
  declaration or an import binding whose readers fall back to a global; untracked files, proven
  unchanged or not; broken binding nulls; no proof vocabulary.
- `packages/app-services/test/change-impact-classification.test.ts` — one witness per way an edit
  could be misread as inert (uncommented call, blank line replaced by code, `export default`
  local, continuation line, decorator, load-time initializer, explicit re-export next to
  `export *`, deleted empty module, shadowing file, flipped operator, `export type`, a comment
  paired with code, `import type` becoming a value import, reordered imports, parameter
  decorator, directive comments, marker lines inserted or nested, a declaration or import binding
  shadowing a global the file reads) or as broader than it is (comment and formatting edits, prose
  next to a marker, added import binding, an added declaration nothing reads, private nested
  symbol); each asserts that every `via` chain starts at the change and is as long as its
  distance.
- `packages/ts-analyzer/test/top-level-outline.test.ts` — the token digest (operators, keywords,
  flags, raw templates, type-only forms change it; comments, whitespace, list commas and a final
  `;` do not), load-time evaluation and module-load levels.
- `packages/app-services/test/change-impact.test.ts` also covers a reach gap that caps confidence
  at `low` and turns unreached surfaces `unknown`, and a worktree or index changed during the
  analysis.
- `packages/app-services/test/verify-computation-characterization.test.ts` and
  `packages/context-engine/test/diff-changes.test.ts` — `verify` unchanged: computation pins, the
  working-diff seal of a non-empty local delta pinned from a7cd55c, and the strict parser's input
  contract.
- `apps/cli/test/impact-cli.test.ts` — CLI contract, schema validation, refusal of unbindable input.
