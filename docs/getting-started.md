# Getting started

`semctx` verifies the semantic blast radius of a change: it maps a diff to affected symbols,
exported contracts, declared invariants and relevant tests, and returns a PASS/WARN/BLOCK verdict.
It is local-first, deterministic, and needs no LLM, network, or service.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3 (the engine runs under Bun).
- A git repository with TypeScript sources.
- `semctx` is not yet on npm — run it from source. In this repo, `bun apps/cli/src/index.ts` is
  the CLI; below it is written as `semctx`.

## 1. Bootstrap

```bash
semctx init --preset github-claude --dry-run   # preview what will be created
semctx init --preset github-claude             # write config + CI workflow + Claude note
```

The preset never overwrites an existing file (use `--force`), adds no blocking hook by default,
and prints exactly what it created or skipped. Add `--with-devcontainer` for a consumer dev
container. Plain `semctx init` (no preset) just creates `.semctx/`.

## 2. Index

```bash
semctx index
```

This builds the deterministic graph (symbols, exports, cross-file calls, tests, docs, migrations,
`@markers`). Re-run after large changes.

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
