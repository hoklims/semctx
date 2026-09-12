# Getting started

<!-- semctx:compatibility:start -->
Semctx **0.2.1** requires **Bun >=1.4.0**.
The supported, tested host baseline is **Codex 0.147.0** and
**Claude Code 2.1.229**. Other host versions are **unknown** until tested;
these pins do not claim the earliest historically compatible versions.
[Baseline delivery evidence](https://github.com/hoklims/semctx/actions/runs/34664142432).
Installation does not reload an active session: open a new Codex task, or run
`/reload-plugins` in Claude Code (restart if reload fails).
<!-- semctx:compatibility:end -->

`semctx` verifies the semantic blast radius of a change: it maps a diff to affected symbols,
exported contracts, declared invariants and relevant tests, and returns a PASS/WARN/BLOCK verdict.
It is local-first, deterministic, and needs no LLM, network, or service.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.4.0 (the engine runs under Bun).
- A git repository with TypeScript sources.
- Optional: Codex and/or Claude Code with plugin support. `semctx install` detects whichever hosts
  are already available; it never installs the host applications themselves.

## 1. One-command agent onboarding

Run this from the target Git repository:

```bash
bunx semctx@latest install
```

The command installs or updates every detected Semctx agent plugin, prepares the repository, and
returns a final readiness report. It can be safely re-run. Preview with `--dry-run`, select a host
with `--host codex|claude|all`, or update only the machine plugins with `--skip-setup`.

After a successful run, open a new Codex task and/or restart Claude Code as reported.
If Windows has the legacy Codex cache locked in an active task, the install still succeeds after
verifying the replacement and completes that legacy cleanup automatically in the background.

### Upgrade or recover an existing installation

Before recovery, inventory and back up `.semctx/config.json`, authored `.sem` files and any
authored baselines. Preview machine changes with `bunx semctx@latest install --dry-run --skip-setup`,
then use `bunx semctx@latest install --skip-setup` to update the plugins without changing this
repository. Update a global CLI with `bun add -g semctx@latest`, and check `semctx --version` in
each shell you use; an old executable earlier in PATH can shadow the update.

Use `semctx doctor --json` and `semctx index-health --json` to distinguish installation problems,
source/index drift and missing coverage. Follow the reported repair for that state. Do not delete
`.semctx` or regenerate authored baselines to make a diagnostic green. If a repair cannot preserve
the authored state, stop and retain the backup for diagnosis. A plugin refresh does not refresh a
repository index or the version loaded by an already-open agent session.

## 2. CLI-only bootstrap

```bash
bunx semctx@latest setup
```

This combines configuration, semantic scaffold, indexing and validation. It is idempotent and does
not overwrite existing configuration or authored `.sem` files. Use
`semctx setup --preset github-claude` when the CI workflow and Claude note are also wanted.

The lower-level `init` and `index` commands remain available for custom flows:

```bash
semctx init --preset github-claude --dry-run
semctx init --preset github-claude
semctx index
```

## 3. Verify a change

```bash
semctx verify diff                             # working tree vs HEAD
semctx verify diff --base origin/main          # a branch range (real merge-base)
```

Read the verdict:

- **PASS** — nothing gated.
- **WARN** — attention, not failure (e.g. a plain exported contract changed without a direct test).
- **BLOCK** — an invariant, or a `critical`/`security`-tagged contract, changed with no covering
  test. Resolve it, or disable the rule in `.semctx/config.json`.

Run the tests listed under *recommended tests*.

## 4. Make it strict (optional): semantic markers

Without markers, `verify diff` still reports impacted symbols, exported contracts and tests.
Markers tell semctx which changes must be **proven**:

```ts
/**
 * @capability reservation-confirmation
 * @tag critical
 * @invariant  confirmed-never-exceeds-capacity: confirming must never overbook a slot
 */
export function confirmReservation(/* ... */) { /* ... */ }
```

Now a change to `confirmReservation` without a covering test is a strict-tier `BLOCK`.
Use `@tag critical` for an exported contract that must keep test coverage, or `@tag security` for a
security-sensitive symbol. These blocking rules arm only from explicit tags; semctx never guesses
criticality from a symbol or file name.

## 5. Gate it

- **Locally**: a [pre-commit hook](examples/pre-commit-hook.md) running `verify diff --staged`.
- **In CI**: the [GitHub Action](integrations/github-actions.md).
- **In an agent**: the Codex and Claude Code plugins share the same `semctx-control` workflow;
  choose the matching guide under [`docs/integrations`](integrations/claude-code.md).

## Next

- [CLI reference](reference/cli.md)
- [Configuration reference](reference/configuration.md)
- [Why the retriever was withdrawn (ADR 0005)](adr/0005-context-retrieval-pipeline-rejected.md)
