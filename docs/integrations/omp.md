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

Neither hook in `plugins/claude-code/hooks/` is loaded on OMP: not the commit/push guard, and
not the shadow lifecycle observer. OMP consumes the Claude plugin directory, but `hooks/hooks.json`
stays a Claude surface (ADR 0015), so the lifecycle checkpoint remains fully manual on this host.
