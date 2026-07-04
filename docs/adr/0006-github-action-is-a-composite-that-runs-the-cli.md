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
