# Changelog

All notable changes to `semctx` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). `0.1.0` is the first tagged release.
Since `0.1.11`, the npm CLI, both marketplace plugins, the release-managed `stable` branch and the
GitHub Release advance together through the tag-driven lockstep workflow documented in
[`docs/publishing.md`](docs/publishing.md).

## [Unreleased]

### Added

- **Bun 1.4 and native macOS verification**: the runtime, plugin generator, release workflow and
  composite GitHub Action now share the Bun 1.4.0 baseline. The required CI matrix also runs on
  Apple Silicon (`macos-15`) and checks out the pull-request head SHA explicitly, so macOS proof is
  bound to the reviewed candidate rather than GitHub's temporary merge commit.

- **Cross-host plugin delivery observability**
  ([#89](https://github.com/hoklims/semctx/issues/89)): `semctx plugin-status [--json]` reports the
  five states that were previously conflated — the repository checkout, the public `stable`
  release, each host's marketplace snapshot, the versioned cache each host executes, and the
  version a running session loaded. Per host it carries the configured source and ref, the
  snapshot commit, the installed version and path, and `updateAvailable`. `UP_TO_DATE` is
  impossible unless the executed cache is proven equal to the public `stable` release; repository
  state is informative only and `repository.conveysDelivery` is the literal `false`. A version
  string is never proof on its own, because `main` and `stable` routinely carry the same SemVer at
  different commits — measured 2026-08-10, `main` at `1acf1f14…` and `stable` at `0173f893…`, both
  `0.1.17`: snapshot and cache runtime bundles are SHA-256-bound directly to immutable release
  witnesses, so jointly altered snapshot/cache bytes cannot impersonate stable and a locked cache
  cannot hide behind its version-keyed directory. Host-reported paths are accepted only when local
  and canonically confined to that host's own home — UNC/device and junction/symlink escapes are refused
  as `HOST_PATH_REJECTED` before any filesystem call, since reading one would be network egress —
  and host strings are stripped of control characters and URL userinfo so a hostile host cannot
  repaint a terminal verdict and a marketplace token cannot leak into `--json`. `verdict` and
  `delivery` stay separate dimensions and neither
  upgrades the other; exit status follows `delivery` (0 / 2 / 3). No supported host exposes the
  plugin version a running session loaded, so that state is reported as `unknown` with the host's
  activation action and is never inferred from the cache. The default probe performs no network
  call: it reports the local `origin/stable` witness but treats it as informational, because an
  unattested mirror cannot prove that no newer public release exists. Any requested missing host,
  failed query, malformed JSON, unreadable cache, or unattested release yields explicit `UNKNOWN`
  with a canonical reason code. The command never installs, updates, enables, promotes or advances
  `stable`; Semctx writes neither the inspected project nor host trees, although a queried host may
  keep its own process-usage bookkeeping. By default it performs no network operation at all,
  running host inventory queries and local reads only, while `--attest` additionally fetches the
  canonical release into a throwaway store it then deletes. Guidance
  emits the exact supported convergence path, identical to what `semctx install` performs.
  `publicRelease.authority` types the provenance as `attested-release`, `local-mirror`, `absent`
  or `unrecognised`, and only the first licenses `UP_TO_DATE`; an authority this build does not
  recognise fails closed. `--attest` adds the one step that leaves the machine, and its trust root
  is canonical rather than local: it resolves `https://github.com/hoklims/semctx.git` — a constant
  of the build, never the inspected project's `origin` — inside a throwaway repository created
  outside that project and with the ambient Git configuration removed, so no `url.*.insteadOf`
  rewrite, forged object, replacement ref, promisor remote or consumer repository can decide what
  the public release is. One deadline-bounded shallow fetch brings a single commit into that scratch
  store; transferred bytes have no hard ceiling, so the completed store is acceptance-capped before
  the version and per-host bundle digests are read. The store is removed whatever the outcome; it
  consequently works from any project, including one that is
  not a semctx clone. Each host is proven against its own plugin in that release and the two
  payloads must agree, so a release whose Codex and Claude bundles differ fails closed with
  `PUBLIC_RELEASE_HOST_ARTIFACTS_DIVERGED`. Offline, timed-out or malformed attestation degrades to
  `absent` rather than to the mirror. Every probe carries a deterministic time and output budget,
  enforced while it runs and across stdout and stderr alike, and exceeding either is refused whole
  as `HOST_QUERY_TIMEOUT` or `HOST_OUTPUT_TOO_LARGE` instead of being parsed as a prefix; local
  manifests and bundles are refused on their size before they are read. `--host auto|codex|claude|all` separates the two questions: `auto` omits a host that is
  not installed, while naming a host keeps its absence in the answer. Design:
  [ADR 0014](docs/adr/0014-plugin-delivery-is-observed-across-five-states.md).

### Fixed

- **Reconcile a converged Codex update behind an active-cache lock**
  ([#91](https://github.com/hoklims/semctx/issues/91)): on Windows, `codex plugin add` writes the new
  payload before archiving the one it replaces, so a live task holding the old cache entry makes it
  exit non-zero (`failed to back up plugin cache entry … os error 5`) even though the update landed.
  `semctx install` now re-reads the host on that signature and reports success with
  `cleanupDeferred: true` and `restartRequired: true` — but only once the expected plugin is
  installed, enabled and at the expected version, **and** the versioned cache entry Codex actually
  executes declares that version and holds three regular, non-empty runtime bundles whose SHA-256
  match the approved marketplace snapshot. The marketplace snapshot (`source.path`), the installed
  cache and the version a running session has loaded are treated as three distinct states.
  The override is bounded to Windows and to the exact codes `os error 5` / `os error 32`; unproven
  convergence, an unlocatable cache root, a malformed plugin list and arbitrary permission errors
  all stay blocking. The existing `os error 32` legacy-cleanup path is unchanged, outstanding work
  is listed additively under `deferrals` (several can coexist), and the superseded cache entry is
  retired by a detached, idempotent helper that renames before deleting — so a still-loaded cache is
  never partially removed. Before and after that rename, the helper re-reads Codex and aborts unless
  the expected version is still installed, enabled and selected; the expected version is never a
  target.

## [0.1.17] - 2026-08-10

### Fixed

- **Shareable `.semctx/config.json` across clones** ([#82](https://github.com/hoklims/semctx/issues/82)):
  `repositoryRoot` is no longer persisted (optional/ignored on load; always injected from the
  CLI/MCP call root). `.gitignore` policy now tracks `!.semctx/config.json` alongside
  `.semctx/semantic/`, so selection policy (`include` / `exclude` / blocking rules) can be
  versioned while `semctx.db` and other machine state stay local.
- **Release-pinned GitHub Action examples**: the generated preset and every copyable integration
  example now pin `hoklims/semctx/packages/github-action@v0.1.17`. Historical ADR and v0.1.0
  release notes retain their original references.

### Changed

- **`SETUP_READY` is fail-closed for all config versions** ([#73](https://github.com/hoklims/semctx/pull/73)):
  the legacy v1 short-circuit that treated analysis as ready regardless of coverage/freshness is
  removed. Agents must not see `SETUP_READY` when `indexHealth.coverage.status === "insufficient"`.

### Documentation

- **Configuration reference** ([#82](https://github.com/hoklims/semctx/issues/82)): document
  policy-only `config.json`, legacy `repositoryRoot` ignored on load, and gitignore tracking.
- **Public MCP contract review guide** ([#73](https://github.com/hoklims/semctx/pull/73)):
  `docs/contributing/public-mcp-contracts.md` (linked from CONTRIBUTING) implements ADR 0012 for
  contributors — PUBLIC_CONTRACT / DOMAIN_FEATURE / TRANSPORT_DX tiers (not Plane A/B/C), domain
  outcomes as structured results without handler-authored `isError`, and a self-check with
  common vs conditional sections.

### Added

- **Plugin-native workspace bootstrap over MCP** ([#73](https://github.com/hoklims/semctx/pull/73)):
  shared `setupRepository` in `@semantic-context/app-services` powers both `semctx setup` and the
  new confirm-gated `semctx_setup` tool, so agents can initialise `.semctx/` without a global
  package install. Default MCP calls are dry preflight; `confirm: true` runs config + semantic
  scaffold + index + check. Policy refusals (e.g. polyglot against an existing v1 config) and
  not-ready analysis return ordinary schema-valid structured results (`setup_refused` /
  `SETUP_NOT_READY`) with guidance — **not** handler-authored `isError` (ADR 0012). Agent success
  requires `kind === "setup"` and `verdict === "SETUP_READY"`. Readiness uses namespaced `verdict`
  values distinct from Plane C `READY`/`BLOCKED`. CLI `--json` emits the same envelope; live phase
  progress uses a shared `onPhase` port. The shared control skill documents the fail-closed agent
  policy. Global CLI remains optional for CI and non-plugin shells.
- **Split plugin runtime** ([#39](https://github.com/hoklims/semctx/issues/39)): one Bun build now
  emits `dist/semctx-mcp.js`, `dist/semctx.js`, and the fixed root `dist/semctx-shared.js` chunk for
  both host plugins. The generator requires Bun 1.3.13, rewrites build-checkout paths in every
  emitted JavaScript file, and rejects missing, stale, or extra artifacts; Claude Code can apply an
  installed update with `/reload-plugins`, with restart retained as the fallback.
- **Offline global CLI compatibility advisory** ([#35](https://github.com/hoklims/semctx/issues/35)):
  one shared bounded probe now powers `doctor --json` and the path-free
  `semctx_cli_compatibility` MCP preflight. Exact pre-1.0 version drift, absence, malformed output,
  timeout, and subprocess failure produce canonical non-blocking reasons plus an explicit manual
  upgrade command; Semctx never contacts a registry or installs from the advisory.
- **0.1.17 multi-language Plane A runtime**: config v2 can select and analyze mixed TypeScript and
  Python workspaces while preserving TypeScript compatibility. CLI/MCP `index-health` and `setup`
  report partial or insufficient analysis explicitly. Exact capability requirements, source/result
  binding, freshness, negative completeness, generic admissibility, and the app-services authority
  policy remain independent fail-closed gates.

## Historical cumulative notes (0.1.1–0.1.16)

Before v0.1.17, these notes accumulated under `Unreleased` instead of being cut into one section
per tag. They are retained verbatim as historical context and are not attributed to v0.1.17.

### Added

- **Cross-host top-down diagnosis**: the shared `semctx-control` skill now locates the highest
  broken contract from L6 strategy/constraints to L0 sealed observed hunks, records why higher and
  lower levels are excluded, and defines the smallest falsification check before substantial
  edits. Codex and Claude receive the same generated diagnostic contract; missing links,
  `STALE`, and `UNSEALED` never trigger an automatic reindex or reseal.
- **One-command onboarding and update**: `bunx semctx@latest install` detects Codex and/or Claude
  Code, adds or refreshes their Semctx marketplaces and plugins, prepares the current Git
  repository with the existing idempotent `setup` pipeline, and returns one readiness report.
  `--host`, `--skip-setup`, `--dry-run`, and `--json` cover targeted, machine-only, preview, and
  automated flows. Missing hosts, non-Git directories, partial failures, and unrelated marketplace
  name conflicts remain explicit and recoverable.
- **Stable marketplace channel and safe migration**: the release-managed marketplace is named
  `semctx-stable`; `semctx install` automatically migrates the legacy
  `semctx-control@personal`, interim `semctx-control@semctx`, and Claude `semctx@semctx`
  registrations only after the replacement is installed and verified. A different marketplace
  source is never overwritten.
- **Portable npm release pipeline**: the npm CLI build now uses the same portable TypeScript-path
  rewrite and colocated `typescript-lib` declarations as the plugins. A foreign-directory package
  smoke proves `--version` and a real `setup`. Tag-driven publication is version-gated,
  test-gated, plugin-artifact-gated, publishes npm first, then advances the `stable` plugin branch
  and creates the GitHub Release. It is ready for npm trusted publishing with OIDC provenance.
- **Plugin-bundled CLI** (`dist/semctx.js`): Claude Code and Codex plugins now ship a portable Bun
  CLI next to `dist/semctx-mcp.js`, built from the same `plugin:build` pipeline, so a
  marketplace/plugin update keeps MCP and CLI in lockstep. Global `semctx` remains optional for CI
  and non-plugin shells (#35). Packaged CLI smoke covers `setup` / `doctor` /
  `verify diff --dry-run` outside the checkout.
- **Correct plugin-root resolution**: skills use the `${CLAUDE_PLUGIN_ROOT}` **placeholder**, which
  Claude Code substitutes into skill content at load time (regex `/\$\{CLAUDE_PLUGIN_ROOT\}/g` — the
  braces are part of the syntax). The guard hook resolves and shell-quotes the bundle path itself
  instead of emitting a deferred `"$CLAUDE_PLUGIN_ROOT/…"`: the variable is exported to hook and MCP
  processes only, never to the agent's shell, where an unexpanded reference silently collapses to
  `bun "/dist/semctx.js"`. `guardDecision` is pure (no env read, no filesystem access); command
  resolution lives in `verifyRecordCommand`. `plugin-parity` fails on any bare `$CLAUDE_PLUGIN_ROOT`
  in a shipped file; the guard end-to-end test replays the printed command in a shell stripped of
  the variable.
- **Release version SSOT**: npm CLI (`apps/cli`) aligned to the plugin/MCP release (`0.1.10`);
  `plugin-parity` asserts CLI package version matches marketplace plugins; `semctx --version` and
  `doctor` report the CLI version (`doctor --json` gains a top-level `version`); skills document a
  shell CLI resolution ladder for hosts that do not substitute the placeholder (#35 residual).
  `--version` / `version` print the package version and exit 0 only when that is the command —
  they do not short-circuit a real subcommand such as `verify`.
- **Codex shell fallback**: the shared skill dropped the `bun ./dist/semctx.js` rung. That path
  assumed the agent's cwd was the plugin package root; on Codex the shell runs in the user's
  repository, so the rung could never resolve.
- **Host-generated CLI ladder in the control skill** (#40 option A): one authored template
  (`plugins/shared/skills/semctx-control/SKILL.md`) holds the host-neutral workflow contract;
  `plugin:build` fills a marked host region per plugin. Claude gets the `${CLAUDE_PLUGIN_ROOT}`
  plugin-CLI rung; Codex gets only global `semctx` instructions. `plugin-parity` asserts the
  shared body is still byte-identical after stripping the host region, forbids any
  `CLAUDE_PLUGIN_ROOT` in the Codex skill/manifest/MCP config, and `plugin:check` fails on a stale
  generated skill.
- **Machine-generated agent workflow contract** (P3,
  [#28](https://github.com/hoklims/semctx/issues/28)): `AgentWorkflowContractV1` is the strict,
  versioned source for the complete Codex/Claude lifecycle from repository inspection through
  framing, scope binding, altitude authority, refinement, actual-diff reconciliation, composed
  verification and handoff. Every stage declares its MCP surface, write effect, condition and need
  for user write scope. The policy is fixed to shadow mode, blocking disabled, `no_op` for
  repositories without Semctx and `executionAuthority: "none"`. `plugin:build` renders this machine
  contract into both host skills; parity tests reject reordered/missing stages or stale host leaves.
- **CI runs the full suite**: `plugin-runtime` now runs `bun run test` instead of a three-file
  selection that skipped the guard-hook and CLI tests gating plugin packaging.

- **Explicit control freshness verdict**: read-only CLI `semctx status` and MCP
  `semctx_control_status` report `FRESH`, `DIRTY_KNOWN`, `STALE`, or `UNSEALED` from the persisted
  index snapshot. Trace rejects stale/unsealed inputs and migration planning returns a structured
  fail-closed blocker before consuming them.

- **Control freshness seal**: indexing atomically binds Git `HEAD`, the complete tracked/untracked
  working delta, the direct analyzer-input manifest (including Git-ignored inputs), Plane A graph,
  Plane B model, repository root, store schema and producer version.
  `semctx index --json`, CLI Plane C reports and equivalent MCP reports expose the same strict,
  domain-separated SHA-256 attestation that the separate status preflight evaluates.

- **Semantic Reconstruction Control Plane (Plane C, read-only)**:
  - `@semantic-context/control-model`: L0-L6 coordinates, explicit coverage, architecture
    snapshots/deltas, proof attestations, migration states/steps and versioned authorization reports.
  - `@semantic-context/control-engine`: deterministic lift/lower/impact/explanation traversal,
    current/target comparison, shadow-first migration planning and fail-closed step/deletion policy.
  - CLI `semctx control trace` / `control plan` and MCP `semctx_control_trace` /
    `semctx_control_plan`, backed by a strict read-only SQLite reader.
  - A bounded project intent kernel under `.semctx/semantic/project/**`; sibling local scaffold files
    remain ignored and the default full-semantic gitignore policy remains compatible.
  - Architecture contract: `docs/architecture/control-plane-v1.md`.
  - Repo-local Codex plugin `semctx-control`: MCP registration, an implicit proof-honest workflow
    skill, a local marketplace entry, and an installation/agent-usage guide.
  - Codex and Claude Code now share one byte-identical `semctx-control` workflow contract across
    Planes A/B/C, including the generic project demo objective, verdict namespaces and
    `READY`-is-not-authority rule. The Claude plugin gains a validated local marketplace manifest
    and loads the same committed `dist/semctx-mcp.js` as Codex (no separate launcher); its skills,
    hook and MCP server live in Claude Code's standard auto-discovery locations and validate as
    installable components.

- **Semantic layer (Plane B)** — authored intent beside the derived repository graph (ADR 0009):
  - `@semantic-context/semantic-model`: `SemanticNode` / `ChangeContract` types, statuses,
    relations, deterministic ids, Zod boundary schemas.
  - `@semantic-context/semantic-dsl`: a tolerant line/indentation `.sem` parser with file/line/column
    diagnostics, a deterministic idempotent formatter, and `symbols` / `ascii` renderers (glyphs are
    a view — never required to parse).
  - `@semantic-context/semantic-engine`: Git-versioned `.semctx/semantic/**` file store, repository
    link resolution + stale detection, a bounded deterministic **semantic slice** (explicit scopes
    only — not code search), proof-carrying **change contracts** with a composed `change verify`
    (VERIFIED / PARTIAL / BLOCKED / STALE), and `handoff` / `resume` working deltas.
  - CLI: `semctx semantic <init|check|inspect|render|format|slice|handoff|resume>` and
    `semctx change <open|update|inspect|verify|close>`. `change verify` **composes** `verify diff`
    (via the extracted `computeVerifyReport`) and is never more optimistic than the data.
  - MCP: advisory tools `semctx_semantic_slice`, `semctx_change_open`/`_update`/`_verify`,
    `semctx_semantic_inspect`, `semctx_handoff`, `semctx_resume`; a `semctx-semantic` skill. The
    first-class `semctx_verify_change` and the guarded hook are unchanged.
  - Config: optional, additive `semantic` policy block on `.semctx/config.json`.
  - `.gitignore` policy refined so `.semctx/semantic/` is tracked while the rest of `.semctx/` stays
    local (migrates a blanket `.semctx/` rule).
  - Docs: semantic-layer-v1, semantic-model, change-contracts, the Claude Code integration guide, a
    reservation walkthrough, and ADR 0009.

- **Task framing as a standalone agent primitive** (P3, [#28](https://github.com/hoklims/semctx/issues/28)):
  `semctx control frame-task` and MCP `semctx_control_frame_task` compile a diagnostic `TaskEnvelope`
  and resolve its repository bindings without requiring a plan. Previously the only agent path was
  `plan-change`, which demanded expectations and a `rollbackDescription` before reporting whether the
  anchors resolved at all — so the model had to assemble the whole control-plane payload up front and
  guess. The envelope returned by the framing step is byte-identical to the one the planning bundle
  embeds for the same inputs, asserted by test. `certifying: false`,
  `executionAuthority: "none"`, no writes and no caller-selected Git refs. The focused scope and
  target-proposal slices are described below; host lifecycle work remains open on #28.

- **Focused target proposal primitive** (P3, [#28](https://github.com/hoklims/semctx/issues/28)):
  CLI `semctx control target-propose` and MCP `semctx_control_target_propose` accept only target
  content. The shared application boundary derives the exact current commit and repository-graph
  seal from a `FRESH` control state, fixes authorship to `agent`, then creates one immutable
  Git-versioned `proposed` artifact. Callers cannot inject source refs or claim human authorship.
  The result is non-certifying with `executionAuthority: "none"`; review remains the only path to an
  `accepted` revision.

- **Required-altitude authority policy** (P3, [#28](https://github.com/hoklims/semctx/issues/28)):
  one canonical table turns a change's abstraction altitude into the authority it requires — L0-L1
  `autonomous`, L2 `constrained`, L3 `reviewed_plan`, L4-L6 `human_authority` — with obligations
  accumulating as a strict superset at each step. Exposed identically as CLI
  `semctx control authority` and MCP `semctx_control_authority`, so both hosts derive the regime
  from the same contract instead of restating it. Autonomy is a conjunction of the regime and a
  trusted preflight: a `STALE` or `UNSEALED` verdict withdraws autonomous write at every altitude,
  including L0. The report carries `executionAuthority: "none"`; it names the authority a change
  requires and never grants it. Host lifecycle integration, handoff v2, telemetry and shadow
  enforcement remain open on #28.

### Changed

- `SemctxConfigSchema` gains an optional `semantic` object (backward-compatible; pre-semantic configs
  still validate, and a `semantic` block is no longer silently stripped).
- `verify diff` internals: the report computation is extracted into a reusable `computeVerifyReport`
  so `change verify` composes it verbatim (no behaviour change to `verify diff`).

### Fixed

- **MCP tool failures now cross one bounded, non-leaking boundary.** Input, handler, observer, and
  output-contract failures are normalized as `isError: true` JSON text with a stable code and a
  fixed public message; they never expose raw exception text, Zod diagnostics, repository paths,
  trace data, or successful `structuredContent`. Tool input keeps the same advertised JSON Schema,
  but is now gated fail-fast and parsed by Zod inside `ToolRegistrar`, so oversized SDK validation
  diagnostics cannot bypass the canonical envelope. Read-only, writer, Explorer, legacy stdio, and
  2026 stdio calls share the same behavior.
- **Guarded Git scope now fails closed** (#47): unexpanded cwd paths in `cd` / `git -C` and Git
  repository retargeting through direct or `env`-wrapped `GIT_DIR`, `GIT_WORK_TREE`, related
  repository-state environment, `--git-dir`, `--work-tree`, namespaces, bare mode, or
  `core.worktree` / `core.bare` config are rejected as non-isolated. A guarded session remains
  authoritative when the command's target cannot be resolved structurally, so the hook never
  compares one repository's verification hash before committing or pushing another.
- **The freshness preflight always returns a verdict.** `semctx status` and `semctx_control_status`
  raised `CONFIG_INVALID` ("semantic model cannot be projected into Plane C") instead of reporting a
  verdict when the authored model carried error-severity diagnostics, duplicate ids, or
  error-severity lifecycle findings. Callers received an untyped transport error, so a fail-closed
  consumer could neither proceed nor prove it had to stop — and the same drift also blocks
  `semctx index`, leaving no supported way to learn what needed repairing. Two `UNSEALED`-family
  reason codes now carry the classification: `SEMANTIC_MODEL_INVALID` and
  `SEMANTIC_LIFECYCLE_INVALID`. Other Plane C operations still refuse the projection; only the
  preflight's answer changed. Existing verdicts, seals and reason ordering are unaffected, and
  `canRunHighRiskControl` stays `false` for both new reasons.

## [0.1.0] - 2026-07-04

First public release. The GitHub Action is referenced as
`hoklims/semctx/packages/github-action@v0.1.0` (no `v1` moving tag until the Action contract is
declared stable).

### Added

- `verify diff --base <ref> / --head <ref>`: analyse a real merge-base range for CI. Fails
  cleanly (`GIT_BASE_UNAVAILABLE`) when the base is not available locally; never fetches implicitly.
- `verify diff --format text|json|github`. `json` is a **stable, versioned** report
  (`schemaVersion 1`, ADR 0008); `github` emits workflow annotations.
- `verify diff --fail-on block|warn|none`, `--output <path>` (atomic write), `--dry-run`,
  `--record` (writes `.semctx/verification-state.json` for the guarded hook).
- Severity tiers `strict` (BLOCK) / `advisory` (WARN), and a `critical_contract_changed_without_test`
  rule for `critical`/`security`-tagged exported contracts.
- **GitHub Action** (`packages/github-action`): composite action + Node adapter — annotations, job
  summary, outputs, PASS/WARN/BLOCK gate. `contents: read` only, no PR comments, no secrets.
- **Claude Code plugin** (`plugins/claude-code`): MCP (`verify_change`, `inspect`), a verify skill,
  and an opt-in guarded hook (diff-hash gated, blocks only `git commit`/`git push`).
- `init --preset github-claude`: preview-first bootstrap (`.semctx/config.json`, CI workflow,
  Claude note, optional dev container). Never overwrites without `--force`.
- Contributor **dev container** (`.devcontainer`).
- Documentation: getting started, CLI and configuration references, integration guides
  (GitHub Actions, Claude Code, guarded mode), pre-commit hook.
- ADRs 0006 (Action packaging), 0007 (guarded hook), 0008 (versioned machine output).

### Changed

- Repositioned the product as a **repository change-impact analyzer** built around `verify diff`
  (ADR 0005). The `task → ContextPack` retriever is withdrawn as a primary retriever after a
  comparative evaluation (`benchmarks/change-impact-eval`); it remains in the tree as experimental.
- Ordering is byte-identical across environments (code-unit comparison; ADR context in the
  decision log).

### Security

- GitHub Action passes all user-controlled inputs through the step `env:` (no `${{ }}` template
  interpolation into run scripts) to prevent Actions injection.

[Unreleased]: https://github.com/hoklims/semctx/compare/v0.1.17...HEAD
[0.1.17]: https://github.com/hoklims/semctx/compare/v0.1.16...v0.1.17
