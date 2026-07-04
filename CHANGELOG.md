# Changelog

All notable changes to `semctx` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). `0.1.0` is the first tagged release;
nothing has been published to a package registry (npm) or the GitHub Marketplace.

## [Unreleased]

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
