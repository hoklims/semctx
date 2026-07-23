# Handoff — merge PR #32, then deliver issue #26

## Mission

Merge the completed P0 trust-boundary PR, then implement the typed L6-to-L0 refinement round trip
defined by issue #26 without adding execution authority.

## Repo and run

- Repository: `C:\maintenence\semctx`
- Checkpoint branch: `codex/p0-trust-boundary`
- Target branch after merge: create `codex/l6-l0-refinement-round-trip` from updated `main`
- Verification:
  - `bun run plugin:check`
  - `bun run typecheck`
  - `bun test --timeout 30000 packages apps plugins`

## Read first

1. `AGENTS.md`
2. `ROADMAP.md`, especially the P0 gate and the next vertical-refinement section
3. `.semctx/semantic/project/control-plane.sem`
4. `docs/architecture/semantic-layer-v1.md`
5. `docs/architecture/semantic-model.md`
6. `docs/adr/0004-cocoindex-is-an-optional-provider.md`
7. `docs/adr/0007-claude-code-guarded-hook-is-diff-hash-gated.md`
8. GitHub PR #32: `https://github.com/hoklims/semctx/pull/32`
9. GitHub issue #26: `https://github.com/hoklims/semctx/issues/26`

## State

- PR #31 is merged into `main` at `8d1fd70`.
- PR #32 is open, ready, mergeable, and targets `main`.
- PR #32 code commits:
  - `f2d0f91 feat(control): close the P0 trust boundary`
  - `48fa8bf fix(guard): reject terminal command wrappers`
- PR #32 closes issue #25, the first dependency of epic #24.
- The checkpoint worktree was clean before this handoff file.
- Fresh checkpoint verification:
  - `bun run plugin:check`: PASS, packaged runtimes byte-identical
  - `bun run typecheck`: PASS
  - GitHub `plugin-runtime` run `29976743979`: SUCCESS
- Full verification already recorded on code head `48fa8bf`:
  - 322 tests passed, 0 failed
  - adversarial review: PASS, no remaining P0/P1
  - clean-worktree dogfood indexed 1,137 nodes / 2,956 edges / 281 claims
  - commit-bound freshness was `FRESH`
  - a tracked mutation produced `STALE`; status and traversal both refused with exit 3 and
    `CONTROL_INPUTS_UNSAFE`; restoring the bytes returned to `FRESH`
- The only known remaining observation is non-blocking P2 observability: optional-provider
  fallbacks may omit failure details, but cannot authorize unsealed facts.

## Next action

Inspect PR #32 reviews/checks and merge it only if the current head is green. Then update local
`main`, create `codex/l6-l0-refinement-round-trip`, and execute issue #26 to completion.

## Active constraints and gotchas

- Preserve the user's ignored local `.semctx` working state; use a clean detached worktree for
  commit-bound dogfood and do not overwrite local pointers or baselines.
- Issue #26 remains read-only Plane C work. It does not authorize writes, an executor, cutover,
  deletion, TaskEnvelope, ChangeSet, or arbitrary working-diff reconciliation.
- Imports and graph proximity are discovery signals, never semantic justification.
- Separate semantic kind from level through explicit `appliesAtLevel`.
- Every `realizes`, `implements`, `decomposes_to`, `constrained_by`, and `proved_by` relation must
  carry evidence and epistemic status; LLM-only relations must never become load-bearing.
- Keep CLI/MCP schemas versioned and behaviorally identical, with canonical reason ordering and
  explicit empty-trace causes.
- Lock determinism with negative, property, migration-compatibility, stale/refusal, and clean
  round-trip dogfood tests before claiming completion.

## Open decisions

- Exact corrected L6-to-L0 ontology and normative level definitions.
- Stable representation for observed L0 hunks or bounded AST edit operations.
- Question-specific traversal policies and the refinement-coverage report schema.

Resolve these from repository evidence and issue #26 acceptance criteria before broad implementation.

## Start

Read the ordered references, inspect and merge PR #32 if still green, then branch from updated
`main` and implement issue #26 with a sealed golden lower-and-lift round trip.
