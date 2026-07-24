# Handoff — issue #27 ready

## Mission

Deliver issue #27: give an agent a versioned semantic `TaskEnvelope` before code edits, then prove
whether the actual diff realizes the intended change, without adding execution authority.

## Repo & run

- Repository: `C:\maintenence\semctx`
- Branch: `codex/task-envelope-diff-reconciliation`
- Baseline: `main` at merge commit `399720c842cb7ec35082368003f320146730d0f9`
- Verification:
  - `bun run plugin:check`
  - `bun run typecheck`
  - `bun test --timeout 30000 packages apps plugins`

## Read first

1. `AGENTS.md`
2. `HANDOFF.md`
3. `ROADMAP.md`
4. `.semctx/semantic/project/control-plane.sem`
5. `docs/architecture/semantic-layer-v1.md`
6. `docs/architecture/semantic-model.md`
7. <https://github.com/hoklims/semctx/issues/27>

## Durable state

- PR #32 merged the P0 trust boundary at
  `942be1c66cf66d6c6562c39fcd896ee23a69a9ef`.
- PR #33 merged issue #26 at
  `399720c842cb7ec35082368003f320146730d0f9`; issue #26 is closed.
- The final issue #26 head was
  `12a0d6198be248f628553d7003af82a43a6e4948`.
- Typed L6→L0→L6 refinement, exact observed-hunk identities, evidence-bearing relations,
  question-specific traversal, migrations, stale refusal, empty-trace reason codes and shared
  CLI/MCP reports are shipped.
- Post-merge verification on `main`:
  - plugin runtimes byte-identical at 4,206,802 bytes with 100 TypeScript libraries;
  - typecheck passed;
  - 406 tests passed, 0 failed, 1,981 assertions across 47 files.
- The ignored local `.semctx` state remains outside tracked delivery.

## Next action

Use `$ralplan` to freeze the ontology, versioned public contracts and adversarial test matrix for
issue #27, then implement the approved plan autonomously through a verified PR.

The plan must resolve:

- the exact boundary between `TaskFrame`, `TaskEnvelope`, `ChangeContract` and semantic
  `ChangeSet`;
- Git-versioned target-artifact identity, lifecycle and `hypothetical` provenance;
- refinement-plan profiles for local patch, refactor, feature, redesign and migration;
- the canonical `reconcile diff` report, reason codes and failure precedence;
- the round-trip properties that are certifiable rather than merely advisory.

## Active constraints

- `TaskEnvelope` and `ChangeSet` describe and reconcile intent; they grant no execution authority.
- Add no executor, cutover, delete operation or unrestricted patch application.
- Task text may classify mode, risk and required altitude, but never authoritatively bind files or
  symbols without explicit discovery and binding.
- Preserve Plane A facts, Plane B authored truth and Plane C deterministic control as distinct
  typed authorities.
- Imports, proximity, LLM-only relations, hypothetical targets and unsealed evidence cannot be
  load-bearing.
- CLI and MCP must share versioned schemas, reason codes, refusal semantics and canonical order.
- Lock determinism, compatibility/migrations, stale refusal, scope escape, missing planned edits,
  invariant drift and undeclared lifted impacts.
- Preserve the ignored `.semctx` state; use a clean detached worktree for final dogfood.

## Open decisions

The five contract questions listed under **Next action** remain open until the `$ralplan`
consensus is approved. No product or execution authority decision is otherwise open.

## Start

Read `HANDOFF.md`, the architecture sources and issue #27, then run `$ralplan` before editing code.
