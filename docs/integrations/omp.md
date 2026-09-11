# Oh My Pi integration

**Experimental, opt-in.** OMP is a consumer of the existing Claude plugin tree (ADR 0020), not a
stable-proven delivery target: it has no `plugin-status` support and no `deliver` attestation.
Tracked in HOK-456.

Oh My Pi installs the Claude plugin directory (`plugins/claude-code`) through
`.omp-plugin/marketplace.json`. The catalog entry uses the existing `git-subdir` source and pins
`source.ref` to the exact release tag (`v<version>`). The marketplace name (`semctx-stable`) is a
label, not the Git authority. OMP reads the Agent-Plugins 1.0.0 `plugin.json` and `mcp.json` at that
subdirectory root. MCP launches `bun --cwd ${PLUGIN_ROOT} ${PLUGIN_ROOT}/dist/semctx-mcp.js`,
without a `cwd` field or `SEMCTX_ROOT`; the first absolute `repositoryRoot` request binds the
server as on Codex. Bun's `--cwd` keeps the project's `bunfig.toml` and `.env` out of the server
process.

Requirements: Oh My Pi `18.1.11` (the currently observed Agent-Plugins baseline) and Bun `>=1.4.0`
on PATH. Other OMP versions remain unverified.

Run these commands from the intended project directory. Create its `.omp` directory first:
OMP 18.1.11 searches for an ancestor `.omp` before falling back to the Git root, so `--scope project`
alone may select an ancestor profile when the project has no `.omp` directory.

```bash
bun -e "require('node:fs').mkdirSync('.omp', { recursive: true })"
omp plugin marketplace add hoklims/semctx
omp plugin install semctx@semctx-stable --scope project
```

Then `/reload-plugins` or restart the session. Every MCP tool call must pass an absolute `repositoryRoot`, except `semctx_control_verify_authorization`, whose entire input is `{ request }` and which rejects `repositoryRoot`. Prefer MCP tools. For shell fallbacks use a global CLI on the same version as the plugin (`semctx --version` / `bunx semctx@latest`). Do not run `bun ./dist/semctx.js` from the user repository cwd.

OMP resolves `${PLUGIN_ROOT}` in MCP fields and `skill://` links in Bash commands, but does not
substitute `${CLAUDE_PLUGIN_ROOT}` inside skill markdown. The shared skill therefore gives OMP its
own embedded CLI rung:

```text
bun skill://semctx-control/scripts/omp-cli.mjs status --json
bun skill://semctx-control/scripts/omp-cli.mjs verify diff --base origin/main
```

The shim imports the bundled CLI relative to its installed location, so no global Semctx CLI is
required and arguments or exit status are not translated by another shell.

`package.json#omp.extensions` registers one OMP adapter for the opt-in ADR 0007 terminal Git guard.
It reuses the Claude guard evaluator, including the effective call `cwd` and structured environment;
non-Bash tools and non-terminal commands remain unaffected. Claude's `hooks/hooks.json` stays a
Claude surface, so the shadow lifecycle checkpoint remains fully manual on OMP.

For terminal Git calls, the adapter supports the filesystem path forms normalized by OMP 18.1.11:
session-relative paths, `/`, `~`, `file://`, Unicode spaces, `@`/leading-colon path aliases,
extended Windows paths, and native Windows/WSL drive aliases. In OMP 18.1.11 the extension receives
the raw `tool_call` before Bash expands an internal URL used as `cwd`, a `cd` target, or a Git
repository option. The adapter has no session-safe router for that URL and does not guess a path.
It applies the merged call environment first: `SEMCTX_GUARD=off` remains authoritative. Otherwise
it checks enablement only in the valid filesystem session root. Advisory sessions remain
non-blocking; an environment- or session-enabled guard blocks the unresolved terminal Git call, as
does an unknown or failed enablement check. A guard configured only inside the opaque target cannot
be discovered until the caller supplies a resolved filesystem cwd/path. Non-terminal Bash commands
and non-Bash tools keep their existing behavior.

Before reinstalling a release that used ADR 0015, remove the old OMP plugin installation through
OMP's normal plugin command, then install this catalog entry again. Semctx never deletes a user
profile or an old install automatically.
