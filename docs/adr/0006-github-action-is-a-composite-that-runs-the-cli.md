# ADR 0006 — The GitHub Action is a composite that runs the CLI (not a bundled Node action)

- Status: accepted
- Date: 2026-07-04

## Context

We want a plug-and-play GitHub Action so a consumer repo can gate PRs with `semctx verify diff`
via `uses: hoklims/semctx/packages/github-action@v0.1.0`. The instinctive packaging is a bundled
JavaScript action (`dist/index.js` run by the runner's Node), which needs nothing installed.

But `semctx`'s verify engine loads the repository graph from a `bun:sqlite` database
(`@semantic-context/repository-store`). `bun:sqlite` only exists under the Bun runtime. A Node
process — which is what a bundled JS action runs as — cannot execute the analysis. Rewriting the
store on `better-sqlite3`/`node:sqlite` purely to enable a Node action would fork the persistence
layer and add a heavy native dependency, for no product benefit.

## Decision

Ship the Action as a **composite action** (`action.yml` with `runs.using: "composite"`) that:

1. sets up a pinned Bun toolchain on the runner;
2. installs the action's own dependencies (the action ships with the `semctx` source it needs);
3. runs `semctx verify diff --base … --head … --format json --output <report>`;
4. hands the JSON report to a **small Node adapter** that emits GitHub annotations and a job
   summary and sets the action outputs.

The adapter is pure Node (it only reads JSON and writes to `$GITHUB_STEP_SUMMARY` /
`::error`/`::warning` workflow commands) — no `bun:sqlite`, unit-testable off-runner. GitHub
specifics live only in `packages/github-action`; `core`/`context-engine` never import a GitHub SDK.

## Consequences

- The runner needs Bun; the composite step installs it (a setup step, not the verify critical
  path). Documented in the Action README.
- No large `dist/` bundle of the verify engine is committed (a bundle could not run under Node
  anyway). The Node adapter *is* small enough to run unbundled.
- The Action requires `contents: read` only; no `pull_request_target`, no secrets, no write token.
- If a future Node-native store lands, a bundled JS action becomes possible; this ADR is revisited
  then. Until then, composite is the only honest packaging.

## Amendment — Bun runs from the action checkout, never from the analysed repository (2026-09-11)

Bun executes `$cwd/bunfig.toml` `preload` scripts and loads `$cwd/.env` before any entrypoint.
The original verify step ran `bun` with `working-directory: ${{ inputs.working-directory }}`, so
a pull request could plant a `bunfig.toml` and run code on the runner before semctx started
(quality audit 2026-09-09, SEC-PPLUG-02) — contradicting the "does not execute arbitrary PR
scripts" statement in `SECURITY.md`.

Decision: every `bun` step keeps `working-directory: ${{ github.action_path }}/../..` (the
action's own checkout, already used for `bun install`). A preceding `node` step resolves the
consumer directory to an absolute forward-slash path, and the CLI receives it as `--root`.
`config-path` and `report-path` remain relative to the analysed directory. Node reads no
configuration from its working directory, and the adapter step is unchanged.
The resolved directory must stay inside `GITHUB_WORKSPACE` (a `working-directory` that is, or
contains, a link to elsewhere on the runner is refused), and the step output uses the
multi-line delimiter form so a path cannot inject a second output.
`packages/github-action/test/launch-isolation.test.ts` pins the step shapes, runs the resolution
step against a workspace subdirectory and an outside directory, and proves with a hostile
checkout that the CLI started from the action checkout ignores that checkout's `bunfig.toml`.
