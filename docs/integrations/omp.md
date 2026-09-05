# Oh My Pi integration

**Experimental, opt-in.** OMP is a consumer of the existing Claude plugin tree (ADR 0015), not a
stable-proven delivery target: it has no `plugin-status` support and no `deliver` attestation.
Tracked in HOK-456.

Oh My Pi installs the Claude plugin directory (`plugins/claude-code`) through `.omp-plugin/marketplace.json`. The catalog entry pins the plugin to `source: { source: "git-subdir", url: "https://github.com/hoklims/semctx.git", path: "plugins/claude-code", ref: "stable" }` — the marketplace name (`semctx-stable`) is a label, not a Git pin; only `source.ref` keeps the installed bytes off `main`. MCP launch is `plugins/claude-code/mcp-omp.json` (relative `bun ./dist/semctx-mcp.js`, `cwd: "."`). Claude `.mcp.json` placeholders are not used.

Requirements: Oh My Pi `>=17.1.8` (marketplace-capable, honors the manifest's `mcpServers` pointer), Bun `>=1.3.14` on PATH.

```bash
omp plugin marketplace add hoklims/semctx
omp plugin install semctx@semctx-stable --scope project
```

Then `/reload-plugins` or restart the session. Every MCP tool call must pass an absolute `repositoryRoot`, except `semctx_control_verify_authorization`, whose entire input is `{ request }` and which rejects `repositoryRoot`. Prefer MCP tools. For shell fallbacks use a global CLI on the same version as the plugin (`semctx --version` / `bunx semctx@latest`). Do not run `bun ./dist/semctx.js` from the user repository cwd.

OMP substitutes `${CLAUDE_PLUGIN_ROOT}` and its own `${OMP_PLUGIN_ROOT}` inside MCP server config fields, but never inside skill/agent markdown body text — the Claude skill still contains a literal, unsubstituted `${CLAUDE_PLUGIN_ROOT}` when read on OMP, so agents must prefer connected MCP tools over that text.

## Commit/push guard (experimental)

Registered from `plugins/claude-code/package.json` `omp.extensions`, which points at
`hooks/pre/semctx-guard.ts` — a default-export factory that subscribes to `tool_call`. It reaches
the same ADR 0007 decision function as Claude's `hooks/semctx-guard.mjs`, `evaluateBashGuard`,
matching the tool name case-insensitively (`bash` here, `Bash` on Claude). Advisory is the default:
the adapter is present but never blocks until the project opts in via `.semctx/guard.json`
`{ "enabled": true }` or `SEMCTX_GUARD=on`, which then blocks non-isolated `git commit` /
`git push` until the working state matches a recorded verification baseline.

`tool_call` fires before the tool executes, so `input` is still the raw model argument object. The
adapter normalizes it before evaluating, and both steps are load-bearing:

- `input.cwd` is resolved against the session directory. The host applies that resolution later, so
  a relative value such as `"."` would otherwise be anchored to the process working directory and
  the guard would read a different repository than the command runs in.
- `input.env` is folded into the command text as `NAME=value` assignments. The host passes that map
  as real child-process environment, so a `GIT_DIR` retargeting sent that way would otherwise skip
  the checks its inline shell equivalent fails.

Unlike Claude's out-of-process hook, this adapter runs inside the agent process and evaluates
synchronously, so a guarded `git commit` in a large repository blocks the event loop while the
worktree is hashed.

Claude's `hooks/hooks.json` `PreToolUse` registration remains Claude-only; OMP does not read it.
Block messages resolve the bundled CLI through `pluginCliPath`'s existing file-relative fallback:
OMP substitutes `${OMP_PLUGIN_ROOT}` only inside manifest strings and never exports it to a
process, so no host variable is involved and that function is unchanged.

The shadow lifecycle observer in `hooks/` is not loaded on OMP: `hooks/hooks.json` stays a Claude
surface (ADR 0015), so the lifecycle checkpoint remains fully manual on this host.
