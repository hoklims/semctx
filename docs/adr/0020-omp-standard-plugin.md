# ADR 0020: OMP loads the existing plugin as an Agent-Plugins package

Status: accepted for implementation by the maintainer-delegated Codex lead, 2026-09-08.
Supersedes OMP-specific installation and fallback decisions in ADR 0015; ADR 0007 guard policy,
ADR 0012 MCP contracts and ADR 0014 delivery-claim boundaries remain authoritative.

## Pre-action evidence and decision

LATENT_COMPASS_ROUTING_NOTE_V1
decision_id: semctx-v02-omp-route-20260908
objective: usable skills, embedded CLI, MCP and one opt-in guard without a mirror or Bun/OMP changes.
authority: maintainer asked Codex to verify both proposals and take ownership of the optimal solution.
candidates: A, root Git package plus generated copies; B, existing catalogue git-subdir plus standard manifest.
pre_action_evidence: A supports the old github command but installs the monorepo identity and expands
root discovery; byte-identical skill copies have wrong CLI paths. B reuses the existing catalogue
and nested package identity; standard MCP placeholders work, skill bodies remain verbatim. Both
need real isolated host proof; runtime single-guard and portability are UNKNOWN before testing.
cost: A needs copies and root namespace safeguards; B needs two manifests, a portable shim and adapter.
reversibility: both are opt-in package changes; existing Claude/Codex delivery must be preserved.
result: RECORD
claim_boundary: source verification is not installed delivery proof or proof of every future host.
handoff: Codex routing and acceptance authority.

Select B to meet the contributor's current expressed need, with explicit replacement of the earlier
literal github install form by the existing semctx-stable catalogue route. No new mirror, external
marketplace service, Bun change or OMP change is introduced. The main product tree is not an OMP
discovery namespace. The contributor's proposal is reference material, not an accepted patch.

## Contract

Keep OMP a consumer of plugins/claude-code, not a third generated host or duplicate bundle tree.
Add Agent-Plugins 1.0.0 plugin.json and closed mcp.json at that plugin root. MCP uses command bun,
args ["${PLUGIN_ROOT}/dist/semctx-mcp.js"], omits cwd and SEMCTX_ROOT, and binds repositoryRoot on
the first request exactly as the existing non-Claude MCP path does. Reject malformed manifests,
extra schema fields, unsafe launch substitutions and version drift in plugin:check.

The repository's existing .omp-plugin/marketplace.json remains the catalogue, with git-subdir
path plugins/claude-code. Its source.ref is the exact v<plugin-version> release tag; stable is a
moving distribution branch, not an immutable witness. Candidate recipes may use an explicit
temporary catalogue/source SHA without changing committed public identity. Release checks bind
the exact tag, package and runtime. OMP is experimental until its own recipe is observed; do not
extend --host all or claim stable-delivery attestation for OMP in this slice.

Standard skills are also loaded verbatim. Generate one ordinary JavaScript shim inside a skill's
scripts directory that invokes the existing bundled CLI by an import-relative path and preserves
argv and exit code. An OMP-specific instruction uses bun skill://semctx-control/scripts/omp-cli.mjs
(OMP resolves and quotes this URI). Do not use dirname, shell substitution, a required global CLI,
symlinks authored by Semctx or Bash-only tests. Claude's existing plugin-root and Codex's generated
fallbacks retain behavior. Change generator sources rather than hand-editing generated skills.

The OMP guard adapter lives outside conventionally scanned hooks/pre and hooks/post, under
omp/semctx-guard.ts, and is registered once via package.json#omp.extensions. Share the existing
ADR 0007 terminal Git evaluation with Claude rather than fork policy. Map OMP bash inputs including
effective cwd and structured env faithfully; disabled/advisory remains non-blocking, enabled
terminal Git operations retain stale/missing-proof and scope-escape rejection. Do not silently
turn an enabled policy evaluation failure into authorization. Resolve structured filesystem cwd
with OMP 18.1.11 path semantics (relative to the original session cwd, including its documented
path aliases), never relative to the extension process. OMP normally expands internal URLs before
Bash execution, but OMP 18.1.11 emits the extension `tool_call` event before that expansion. The
extension has no session-safe internal URL router, so it never guesses a filesystem target from an
unresolved internal-URL cwd or Git scope. It first applies the merged call environment and the
explicit `SEMCTX_GUARD=off` switch. It then evaluates guard enablement only from a valid filesystem
session root: known advisory mode remains non-blocking, while known guarded mode or an unknown or
failed enablement evaluation blocks the unresolved terminal Git operation. A guard enabled only in
the opaque target repository cannot be discovered at this event boundary; callers needing that
target-local opt-in must provide a resolved filesystem cwd/path or enable the session/environment
guard. Other tools and non-terminal commands are unaffected.

Retire obsolete OMP launch/manifest and mirror/snapshotter surfaces in the same coherent change so
a mixed package cannot disable MCP silently. Preserve Claude hooks/hooks.json, shadow lifecycle,
Claude/Codex manifest meanings and byte-identical runtime bundles. Document migration inventory
and removal of the old OMP installation before reinstall; no automatic user-profile deletion.

## Evidence and rollout

Source baseline: can1357/oh-my-pi e3106be68f778635da3a17106835ce2e0e6992af (18.1.11), especially
discovery/agent-plugin-format.ts, agent-plugins.ts, capability/index.ts, plugins/marketplace
resolution, extensions/loader.ts and tools/bash-skill-urls.ts. Fork commits and PR #139 are
unaccepted implementation references; do not import their assertions as proof.

Required evidence: schema/version/pin mutants; generated parity; real shim argv/exit in a path
with spaces on Windows and POSIX; matching Claude/OMP decisions for opt-in, stale proof, changed
cwd and structured Git env; effective one-factory/one-handler count including legacy providers;
isolated OMP install with claude-plugins disabled, three usable skills, MCP initialization and
tools/list, CLI execution, update and uninstall/rollback. Read discovery provenance and shadowed
entries, not only active counts. Run canonical verify:pr and cross-platform CI before delivery.

## Amendment — pinned Bun working directory (2026-09-11)

The closed `mcp.json` launch is now `command: bun`, `args: ["--cwd", "${PLUGIN_ROOT}",
"${PLUGIN_ROOT}/dist/semctx-mcp.js"]`. It still omits a `cwd` field and `SEMCTX_ROOT`, and the
server still binds `repositoryRoot` on the first request. The Claude Code `.mcp.json` carries the
same `--cwd ${CLAUDE_PLUGIN_ROOT}` prefix.

Reason: Bun executes `$cwd/bunfig.toml` `preload` scripts and loads `$cwd/.env` before the
entrypoint. A host that starts the server inside the analysed checkout therefore hands that
checkout code execution the moment the plugin auto-starts (quality audit 2026-09-09,
SEC-PPLUG-01). Bun's own `--cwd` pins the working directory to the installed plugin on every host,
whether or not the host exposes a working-directory setting. `plugin:check` pins the new argv;
`plugins/launch-isolation.test.ts` proves the vector with an unpinned launch and proves that the
shipped launches ignore a hostile checkout's `bunfig.toml` and `.env` while the bundle still starts.
