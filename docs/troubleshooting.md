# Troubleshooting and FAQ

Start with the symptom you can observe. Semctx is local-first: these checks do not upload repository
source or telemetry.

## The command is missing or reports the wrong version

Run `bunx semctx@0.2.0 --version`. Semctx 0.2.0 requires Bun >=1.4.0. If a global `semctx` command
shows another version, use the explicit `bunx` command or update the global installation before
comparing behavior.

## A plugin was installed but the current agent session does not see it

Installation does not reload an active session. Open a new Codex task. In Claude Code, run
`/reload-plugins`; restart Claude Code if reload fails. Then run `semctx plugin-status --json` from a
shell to inspect the installed marketplace and version. Delivery evidence proves what a new session
can resolve; it does not prove that an already-open session activated the update.

## `doctor` reports a workspace failure

Run `semctx doctor --json` from the repository you intend to inspect. Read each named check rather
than treating the process exit code as the whole diagnosis. A missing workspace configuration is
different from a broken CLI runtime. Use `semctx init --dry-run --json` to preview the files that
initialization would create. The full `semctx setup --json` command writes configuration and index
state; run it only when you intend to initialize the repository.

## `index-health` is stale, partial, or blocked

Run `semctx index-health --json`. Confirm that the reported repository root is the intended checkout,
then rebuild the index with `semctx index`. `FRESH` describes the captured source/index identity; it
does not claim complete language coverage. Unsupported, excluded, failed, stale, and unbound scopes
remain distinct states.

## A verification result is `WARN` or `BLOCK`

Use the stable reason code and attached evidence location. `WARN` preserves an unknown or incomplete
proof; `BLOCK` means the configured gate refuses the change. Semctx selects risks and candidate checks
statically. Run the relevant build or tests separately to prove runtime behavior.

## GitHub Actions uses a different result from my machine

Confirm the workflow pins `hoklims/semctx/packages/github-action@v0.2.0`, fetches full Git history,
and compares the intended base and head SHAs. Do not replace the version tag with `main` or `stable`.
See the [GitHub Actions guide](integrations/github-actions.md).

## What can I share safely?

Prefer the allowlisted output of `semctx support --output semctx-support.json`, review it locally,
and share only what is needed. Do not share secrets, private source, proprietary diffs, personal data,
or the full local database. See [SUPPORT.md](../SUPPORT.md) for the correct reporting route.
