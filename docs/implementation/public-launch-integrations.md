# Public launch integrations — implementation plan

> Branch: `feat/public-launch-integrations`. Status: Phase 0 (plan). This document is the
> contract for the release-readiness work. It describes the target shape and is updated as
> phases land.

## Goal

Make `semctx` **plug-and-play** in an existing TypeScript repository across four experiences,
with no SaaS, no account, no remote server, no GitHub App, no mandatory LLM, and minimal GitHub
permissions:

1. **Local** — `semctx verify diff --base origin/main`
2. **Claude Code** — agent → `semctx_verify_change` (MCP) → tests/invariants → controlled commit
3. **GitHub PR** — checkout → `semctx verify` → annotations + summary → PASS/WARN/BLOCK
4. **Devcontainer** — clone → open in container → `bun install` → build/test → ready to contribute

The shipped product is `verify diff` (change-impact analysis). The `task → ContextPack` retriever
stays experimental (ADR 0005) and is **not** promoted, modified, or marketed here.

## Non-negotiables (carried into every phase)

- `WARN` never breaks CI by default; `BLOCK` is rare, justified, actionable, and traced to
  evidence.
- No automatic PR comments. No `pull_request_target`. No write-scoped token by default. No
  secret required for standard CI. No external API call in the critical path.
- Blocking hooks are opt-in; local enforcement is always disableable.
- No shell injection, no `eval`, no fragile git-command string parsing.
- Bun + TypeScript strict preserved. The existing CLI is not broken. The frozen benchmark and
  the `(b)` retrieval spike are untouched.

## Target architecture

```
core verify engine (Bun, bun:sqlite)         ← unchanged product core
  └─ apps/cli  `semctx verify diff`           ← Phase 1: --base/--head, formats, exit codes
       ├─ --format json  (schemaVersion N)    ← the stable machine contract (ADR 0008)
       └─ --format github  (derived view)     ← consumed by the Action adapter, no GH dep in core

packages/github-action  (composite, ADR 0006)  ← Phase 2: sets up Bun, runs the CLI,
  └─ adapter (Node, no bun:sqlite)                 emits annotations + job summary from JSON

plugins/claude-code                            ← Phase 3
  ├─ mcp.json  → semctx_verify_change / inspect
  ├─ skills/semctx-verify/SKILL.md
  └─ hooks  (advisory default / guarded opt-in, ADR 0007) → .semctx/verification-state.json

apps/cli  `semctx init --preset github-claude`  ← Phase 4: preview-first bootstrap
.devcontainer                                   ← Phase 5: contributor container
docs + release hygiene                          ← Phase 6
```

Key property: everything above the core reads the **JSON contract** of `verify diff`. The Action
adapter and the Claude hook never re-implement analysis; they consume `--format json`. GitHub
lives only in `packages/github-action`, never in `core`/`context-engine`.

## Components touched

| Component | Change |
| --- | --- |
| `apps/cli/src/commands/verify.ts` | `--base/--head`, merge-base, `--format`, `--fail-on`, `--output`, `--dry-run` |
| `apps/cli/src/commands/init.ts` | `--preset`, `--dry-run/--force/--with-*`, preview-first writes |
| `packages/context-engine` (verify-diff) | no analysis change; may expose a `changedSymbols` view helper |
| `packages/core` | a small stable `VerifyReport` (schemaVersion) type for the JSON contract |
| `packages/github-action` (new) | composite action + Node adapter + tests |
| `plugins/claude-code` (new) | plugin manifest, mcp, skill, hooks + tests |
| `.devcontainer` (new), `examples/`, `docs/` | onboarding + integration docs |

## Packaging decisions (see ADRs)

- **GitHub Action = composite, sets up Bun and runs the CLI** (ADR 0006). A bundled Node action
  cannot execute the verify engine because it depends on `bun:sqlite`. The annotation/summary
  adapter is a small Node script that consumes the CLI's JSON — Node-compatible and testable.
- **Guarded Claude hook = commit-bound verification-state** (ADR 0007). Advisory by default;
  guarded opt-in blocks only terminal `git commit`/`git push` when HEAD or the complete tracked and
  non-ignored untracked working state differs from the v2 baseline. State is git-ignored and atomic.
- **Stable machine output = versioned `schemaVersion`** (ADR 0008). `--format json` is additive-
  only within a major schema; `--format github` is a derived view.

## Risks

| Risk | Mitigation |
| --- | --- |
| `bun:sqlite` makes a pure-Node action impossible | composite action + setup-bun (ADR 0006); documented |
| Shallow checkout → base ref absent in CI | require `fetch-depth: 0`; fail clean with a concrete message; never implicit-fetch |
| Guarded hook false positives | block only terminal git verbs, keyed on commit-bound working state; advisory is default |
| CI noise from WARN | WARN exits 0 unless `--fail-on warn`; no auto PR comments |
| Marketing overreach | README states what semctx does NOT do; retriever stays experimental |

## Phase plan & acceptance criteria

| Phase | Deliverable | Acceptance |
| --- | --- | --- |
| 0 | this plan + ADRs 0006/0007/0008 | committed before implementation |
| 1 | `verify diff --base` + formats + exit codes | tests: merge-base, missing base, contract/invariant verdicts, text/json, exit codes, `--output`, no absolute-path dependence |
| 2 | GitHub Action | `action.yml` valid, inputs/outputs, adapter unit tests, smoke on fixture, PASS/WARN/BLOCK propagation, security (no PR comments, read-only) |
| 3 | Claude Code plugin + guarded hook | MCP tools documented, advisory default, guarded opt-in; hash-logic + behavior tests (unchanged→allow, changed→block, advisory→allow) |
| 4 | `init --preset` | e2e: dry-run preview, no overwrite, files created as expected, `verify diff` works after |
| 5 | devcontainer | `bun install/build/test` runnable; idempotent post-create; no auto Claude/API/publish |
| 6 | release docs + gates | typecheck/build/test/smoke/grep green; README does/does-not; no external publish |

## Shipped / future / out of scope

| | Item |
| --- | --- |
| **Shipped (this branch)** | `verify diff --base` + json/github/text + exit codes; GitHub Action (composite); Claude Code plugin (advisory + guarded); `init --preset`; devcontainer; release docs |
| **Future (not this branch)** | npm publish; GitHub Marketplace listing; GitHub Release; more languages; git-history freshness; `verify diff --base` for non-git VCS |
| **Explicitly out of scope** | the `(b)` retrieval spike; any SaaS/cloud/vector DB; auto PR comments by default; `guarded` mode as default; mandatory LLM; write-scoped GitHub tokens; fabricated badges/metrics |
