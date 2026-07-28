# Codex integration: semantic reconstruction control plane

The `semctx-control` Codex plugin combines two surfaces:

- a skill that tells the agent when and how to use semctx without overstating certainty;
- a local stdio MCP server that exposes deterministic repository, semantic, and control-plane tools.

The ordered lifecycle in the host-neutral workflow is generated from the strict
`AgentWorkflowContractV1`. The resulting body is byte-identical to Claude's after stripping the
generated `host-cli-ladder` region (#40), so Codex and Claude Code use the same stage order, tool
surfaces, write effects, verdict semantics and completion gate. Shell CLI resolution ladders are
host-generated (Codex: global `semctx` only). Host-specific installation, approval and guard
behaviour remains separate.

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

## Install or update

Requirements: Codex CLI with plugin support and Bun 1.3 or newer. The plugin contains its own MCP
runtime and a bundled CLI (`dist/semctx.js`); no global package link is required for agent use.

```powershell
bunx semctx@latest install --host codex
```

Run it from a target repository to install/update the plugin and prepare that repository together,
or add `--skip-setup` for a machine-only refresh. The command is idempotent, migrates the legacy
`semctx-control@personal` and interim `semctx-control@semctx` registrations to
`semctx-control@semctx-stable`, and refuses to overwrite an unrelated marketplace. A migration
installs and verifies the replacement before removing a legacy registration, so a failed
replacement leaves the working plugin intact. Normal updates follow the release-managed `stable`
branch.
On Windows, an already-running task can hold the old cache open. After the stable replacement is
verified, `semctx install` marks that cleanup as deferred and retries it automatically in a hidden
background helper; unexpected removal errors still fail the install.

Manual install from a clone remains available:

```powershell
codex plugin marketplace add .
codex plugin add semctx-control@semctx-stable
```

Codex launches the committed `dist/semctx-mcp.js` bundle from the plugin cache through Bun. Because
Codex does not currently expose the active workspace root to a plugin-launched MCP process, the
shared skill passes the absolute `repositoryRoot` on every tool call. The server then targets that
repository instead of the plugin cache. Read-only Plane C tools are auto-approved from their MCP
annotations; authored-state writes retain Codex's approval prompt.

The plugin ships `dist/semctx.js` (the full CLI) next to the MCP bundle for release lockstep with
the MCP runtime. Codex does not substitute a plugin-root placeholder into skill content and the
agent's shell runs in the user's repository, not in the plugin package root — so the control skill
generated for this host documents only a global install (no Claude-only placeholder). Shell
fallbacks:

```text
semctx setup
semctx verify diff --base origin/main
```

The bundled CLI is still worth running by absolute path when you know it (`bun
/path/to/plugin/dist/semctx.js …`), since it is guaranteed to match the MCP runtime's release.
See #40: host-generated skill ladders keep the shared workflow contract host-neutral.

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
2. Call `semctx_index_health`; preserve binding, freshness, coverage, candidate outcomes, workspace
   diagnostics, and reasons as separate fields. Do not use a current freshness verdict as proof of
   complete analysis.
3. Call `semctx_resume`, `semctx_semantic_inspect`, or `semctx_semantic_slice` when authored intent
   already exists.
4. Call `semctx_control_status`; continue high-risk control work only for `FRESH` or `DIRTY_KNOWN`.
5. Call `semctx_control_trace` to connect a repository or semantic coordinate to L0-L6 intent.
6. Record the returned status, seal hash, and any current/indexed mismatch as explicit facts.
7. Call `semctx_control_plan` only with an explicit target architecture. A missing target produces
   `BLOCKED`; the agent must not invent one.
8. For a user-authorized code change, open or update a proof-carrying change contract.
9. After editing, call `semctx_verify_change`, run the selected runtime checks, and then call
   `semctx_change_verify` when a change contract exists.
10. Call `semctx_handoff` before context compaction and `semctx_resume` in the next task.

Every call includes the absolute `repositoryRoot`. Each target repository must first be prepared
once with `semctx setup`; inspect and verify fail closed and never initialize or index implicitly.

For a read-only request, the skill forbids the mutating change-contract and handoff tools. For a
write request, those tools may version authored intent under `.semctx/semantic/`; they never modify
application code themselves.

## Decision semantics

- `PASS` says the deterministic diff policy found no blocking condition. It does not replace tests.
- `WARN` says the change needs attention but the configured static policy does not block it.
- `BLOCK`, `BLOCKED`, and `STALE` prevent a completion claim.
- `PARTIAL` must remain partial until the missing evidence is actually obtained.
- `READY` is a planning state, never execution authority for a cutover or legacy deletion.
- Index coverage is `complete`, `partial`, or `insufficient`. It remains independent from control
  freshness and task-relative authority.
- A `ControlFreshnessSeal` is a local input attestation, not an authenticity signature.
  `semctx_control_status` owns the `FRESH` / `DIRTY_KNOWN` / `STALE` / `UNSEALED` verdict, and Codex
  preserves its reasons and current/indexed evidence verbatim.

The control plane stays fail-closed: missing target architecture, unresolved unknowns, stale links,
or insufficient deletion proof remain explicit blockers instead of being filled in by the model.

## Update or uninstall

The supported update path is the same idempotent command:

```powershell
bunx semctx@latest install --host codex --skip-setup
```

To remove the integration completely:

```powershell
codex plugin remove semctx-control@semctx-stable
codex plugin marketplace remove semctx-stable
```
