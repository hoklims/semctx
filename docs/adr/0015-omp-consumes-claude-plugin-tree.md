# ADR 0015 — Oh My Pi consumes the Claude plugin tree with a replaced MCP launch file

- Status: accepted
- Date: 2026-08-23
- Related: ADR 0012 (stable MCP surface), ADR 0014 (plugin delivery observation)
- Scope: **experimental, opt-in.** OMP is a consumer of the Claude plugin tree, not a stable-proven
  delivery target; the gap with Codex/Claude `deliver` attestation is tracked in HOK-456.

## Context

Oh My Pi (marketplace-capable, `>=17.1.8`) substitutes `${CLAUDE_PLUGIN_ROOT}` and its own
`${OMP_PLUGIN_ROOT}` inside the MCP server config it launches, but never `${CLAUDE_PROJECT_DIR}`,
the token Claude's `.mcp.json` uses to bind `SEMCTX_ROOT`.
Pointing OMP straight at `plugins/claude-code/.mcp.json` would therefore hand it a `SEMCTX_ROOT`
value it can never resolve. `mcp-omp.json` is not a rescue for a launch file that would otherwise
fail outright: it is an explicit, non-project-bound OMP contract that omits `SEMCTX_ROOT` and pins
the repository root on the first tool call instead, the same pattern Codex already uses. Config
substitution and skill-body substitution are separate: OMP does not substitute `${CLAUDE_PLUGIN_ROOT}`
inside skill/agent markdown content, only inside the MCP server config fields. A third generated
host (`plugins/omp/`, new `SkillHost`, duplicated `dist/`) would expand `plugin-parity` and
`plugin:build` without changing MCP tool schemas.

## Decision

Oh My Pi is a **consumer of the existing Claude plugin directory** (`plugins/claude-code`), not a third generated host.

1. Repository catalog `.omp-plugin/marketplace.json` lists plugin `semctx` at
   `source: { source: "git-subdir", url: "https://github.com/hoklims/semctx.git", path: "plugins/claude-code", ref: "stable" }`,
   marketplace name `semctx-stable`, version equal to `plugins/claude-code/.claude-plugin/plugin.json`.
   The marketplace name alone is not a Git pin — `omp plugin marketplace add hoklims/semctx` can
   fetch the catalog file itself from whatever ref the host resolves by default; only `source.ref`
   binds the installed plugin bytes to `stable`, independent of that catalog fetch.
2. Plugin manifest `plugins/claude-code/.omp-plugin/plugin.json` sets `"mcpServers": "./mcp-omp.json"`. OMP reads this file before `.claude-plugin/plugin.json` and **replaces** default `.mcp.json`.
3. `plugins/claude-code/mcp-omp.json` launches the committed bundle the same way Codex does, without Claude placeholders and without `SEMCTX_ROOT`:
   `command: bun`, `args: ["./dist/semctx-mcp.js"]`, `cwd: "."`. No `default_tools_approval_mode` (Codex-only).
4. Claude `.mcp.json`, Codex `.mcp.json`, `SkillHost`, generated skills, and `dist/` stay unchanged. `semctx plugin-status --host` is **not** extended (still `auto|codex|claude|all` per ADR 0014).
5. Shell fallbacks on OMP use global `semctx` / `bunx semctx@latest`. The Claude skill still mentions `${CLAUDE_PLUGIN_ROOT}` in its body text (unsubstituted by OMP); agents must prefer connected MCP tools.
6. Compatibility floor: Oh My Pi `>=17.1.8` (the first marketplace-capable release that honors the
   manifest's `mcpServers` pointer) and Bun `>=1.3.14` on `PATH`.

## Consequences

- `omp plugin marketplace add hoklims/semctx` then `omp plugin install semctx@semctx-stable` is the supported install; the plugin itself always resolves from `ref: "stable"` regardless of which ref the marketplace add step fetched.
- `.omp-plugin/marketplace.json`, `plugins/claude-code/.omp-plugin/plugin.json` and the generated `plugins/claude-code/package.json` join the release-lockstep version SSOT (`plugins/plugin-parity.test.ts`, `docs/publishing.md`) alongside the Claude/Codex surfaces.
- Cross-host `dist/` byte equality and Claude/Codex parity tests remain the SSOT; OMP adds a manifest test only, and is excluded from the `deliver` stable-delivery-proof job — no `plugin-status` support, no delivery attestation. Closing that gap is HOK-456, not this ADR.
- Guard `hooks/hooks.json` stays Claude-only. OMP has a sibling adapter at
  `hooks/pre/semctx-guard.ts`, registered from `package.json#omp.extensions`, that reaches the same
  `evaluateBashGuard` decision. It runs in-process on a pre-execution event, so it normalizes that
  host's raw call shape first — a relative `input.cwd` is resolved against the session directory and
  a structured `input.env` is folded into the command text — otherwise guarded mode would be weaker
  there than on Claude. The shadow lifecycle observer remains Claude-only and manual on OMP.
