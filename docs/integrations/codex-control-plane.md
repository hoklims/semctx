# Codex integration: semantic reconstruction control plane

The `semctx-control` Codex plugin combines two surfaces:

- a skill that tells the agent when and how to use semctx without overstating certainty;
- a local stdio MCP server that exposes deterministic repository, semantic, and control-plane tools.

The workflow skill is byte-identical to `plugins/claude-code/skills/semctx-control/SKILL.md`, so
Codex and Claude Code use the same lanes, verdict semantics, generic demo objective and completion
contract. Host-specific installation, approval and guard behaviour remains separate.

The plugin does not add an executor. It helps Codex trace intent, compile a shadow-first plan, and
prove a change; Codex still edits code with its normal tools and runs the repository's real tests.

```text
user request
  -> Codex skill chooses an evidence workflow
  -> semctx MCP reads the active repository
  -> Plane A: observed graph and diff impact
  -> Plane B: authored goals, invariants, evidence, unknowns
  -> Plane C: L0-L6 trace and fail-closed migration plan
  -> Codex edits only when the user requested writes
  -> semctx verdict + runtime tests close the proof loop
```

## Install from a clone

Requirements: Codex CLI with plugin support, Bun 1.3 or newer, and this repository's dependencies.

```powershell
bun install --frozen-lockfile
Push-Location packages/mcp-server
bun link
Pop-Location
codex plugin marketplace add .
codex plugin add semctx-control@personal
```

`bun link` registers the `semctx-mcp` executable in Bun's global bin directory. The plugin launches
that executable without forcing a `cwd`, so Codex starts it against the active workspace. The link
continues to point at this clone: pull the repository and run `bun install` to update the server code.
Read-only Plane C tools are auto-approved from their MCP annotations; tools that may initialize an
index or write authored state retain Codex's approval prompt.

If semctx was previously registered directly in `~/.codex/config.toml`, remove that legacy entry
after the plugin is installed to avoid duplicate server definitions:

```powershell
codex mcp remove semctx
```

Start a new Codex task after installation. Plugins and their MCP tools are resolved when a task is
created; an already-running task does not hot-load the new surface.

## How Codex uses it

The skill is eligible for implicit use on migrations, architecture reconstruction, non-trivial
refactors, invariant-preservation work, and verification in a semctx-enabled repository. It can also
be invoked explicitly as `$semctx-control`.

For a generic demonstration, it identifies the project's most critical functional path from
repository evidence, reconstructs its contracts and invariants, and selects a weakness only when it
can prove one. Otherwise it reports the leading risk and missing proof instead of inventing work.

Typical tool sequence:

1. Use normal Git/code search to find the implementation surface.
2. Call `semctx_resume`, `semctx_semantic_inspect`, or `semctx_semantic_slice` when authored intent
   already exists.
3. Call `semctx_control_trace` to connect a repository or semantic coordinate to L0-L6 intent.
4. Call `semctx_control_plan` only with an explicit target architecture. A missing target produces
   `BLOCKED`; the agent must not invent one.
5. For a user-authorized code change, open or update a proof-carrying change contract.
6. After editing, call `semctx_verify_change`, run the selected runtime checks, and then call
   `semctx_change_verify` when a change contract exists.
7. Call `semctx_handoff` before context compaction and `semctx_resume` in the next task.

For a read-only request, the skill forbids the mutating change-contract and handoff tools. For a
write request, those tools may version authored intent under `.semctx/semantic/`; they never modify
application code themselves.

## Decision semantics

- `PASS` says the deterministic diff policy found no blocking condition. It does not replace tests.
- `WARN` says the change needs attention but the configured static policy does not block it.
- `BLOCK`, `BLOCKED`, and `STALE` prevent a completion claim.
- `PARTIAL` must remain partial until the missing evidence is actually obtained.
- `READY` is a planning state, never execution authority for a cutover or legacy deletion.

The control plane stays fail-closed: missing target architecture, unresolved unknowns, stale links,
or insufficient deletion proof remain explicit blockers instead of being filled in by the model.

## Update or uninstall

After changing the plugin manifest or skill, bump the plugin version before reinstalling it. For a
local development reinstall:

```powershell
codex plugin remove semctx-control@personal
codex plugin add semctx-control@personal
```

To remove the integration completely:

```powershell
codex plugin remove semctx-control@personal
bun unlink @semantic-context/mcp-server
```
