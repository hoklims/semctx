# Handoff — issue #26 pre-publication checkpoint

## Mission

Deliver the typed L6-to-L0 refinement round trip from issue #26 without adding execution
authority.

## Current state

- Repository: `C:\maintenence\semctx`
- Branch: `codex/l6-l0-refinement-round-trip`
- Baseline: PR #32 merged into `main` at
  `942be1c66cf66d6c6562c39fcd896ee23a69a9ef` after its justified review findings were fixed and
  the updated head was green.
- The issue #26 implementation, tests, documentation and local final reviews are complete on the
  working branch.
- The ignored local `.semctx` state was audited separately and is not part of the tracked delivery.

## Implemented contracts

- Normative L6 strategy → L5 product intent → L4 invariants/policies → L3 capabilities → L2
  components/boundaries → L1 symbols/tests/schemas/contracts → immutable observed L0 hunks.
- Semantic kind is separate from explicit `appliesAtLevel`; missing levels remain unmapped.
- Typed, evidence-bearing `decomposes_to`, `realizes`, `implements`, `constrained_by` and
  `proved_by` relations with epistemic status and tagged cross-plane endpoints.
- Exact `ObservedDiffHunkV1` byte framing and content addressing; reading and traversal preserve
  raw hunk bytes.
- Question-specific read-only traversal, honest coverage, stable reason codes, named compatibility
  normalizers, and shared versioned CLI/MCP report envelopes.
- Descriptive authorization resolves attestations from sealed indexed evidence only.
  `authorize-deletion` produces a read-only report; it exposes no delete operation or deletion
  capability.
- Plane C remains read-only: the delivery adds no executor, mutation, cutover, `TaskEnvelope` or
  `ChangeSet`.

## Verified local evidence

- Final AI-slop review: PASS with no changes required.
- `bun run plugin:check`: PASS; both generated runtimes are byte-identical at `4,206,776` bytes
  and expose 100 libraries.
- `bun run typecheck`: PASS.
- `bun test --timeout 30000 packages apps plugins`: PASS; 404 tests passed, 0 failed, 1,975
  assertions across 47 files.
- Public L6→L0→L6 E2E: 4/4 passed.
- Pure golden round trip: 11/11 passed.
- Former review-blocker suites: 45/45 passed.
- Diff check: PASS.
- Ignored `.semctx` audit: PASS.
- Independent code review: APPROVE.
- Independent architecture review: CLEAR, with no P0, P1 or P2 findings.

The golden sources remain:

- `.semctx/semantic/project/control-plane.sem`
- `packages/control-engine/test/fixtures/l6-l0-refinement.patch`
- `packages/control-engine/test/l6-l0-refinement-round-trip.test.ts`
- `packages/app-services/test/l6-l0-public-round-trip.test.ts`

The golden proves complete L6→L0 coverage, L0→L6 lift to the same goal, both critical L4
constraints, canonical shuffled-input output, exact byte preservation, exclusion of
import/proximity/LLM-only/multi-level decoys, and `REFINEMENT_DISCONNECTED` after removing each
sole load-bearing edge.

## Publication verification protocol

The next action is to commit the candidate, then validate that exact commit from a clean detached
worktree:

1. Install dependencies with `bun install --frozen-lockfile`.
2. Run:
   - `bun run plugin:check`
   - `bun run typecheck`
   - `bun test --timeout 30000 packages apps plugins`
3. Re-run the public E2E and pure golden round-trip suites.
4. Confirm the detached worktree stays clean, push
   `codex/l6-l0-refinement-round-trip`, and open the issue #26 pull request.

GitHub PR checks and CI on the published head are the authoritative final publication evidence.
The detached-worktree and GitHub publication checks are pending; this checkpoint does not claim
that they have already run.
