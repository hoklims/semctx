# semctx

<!-- semctx:compatibility:start -->
Semctx **0.2.0** requires **Bun >=1.4.0**.
The supported, tested host baseline is **Codex 0.147.0** and
**Claude Code 2.1.229**. Other host versions are **unknown** until tested;
these pins do not claim the earliest historically compatible versions.
[Baseline delivery evidence](https://github.com/hoklims/semctx/actions/runs/34433110104).
Installation does not reload an active session: open a new Codex task, or run
`/reload-plugins` in Claude Code (restart if reload fails).
<!-- semctx:compatibility:end -->

> Deterministic, local-first repository **change-impact analyzer**. Given a git diff, it computes
> the semantic blast radius — impacted symbols, exported contracts, invariants at risk, tests to
> run — and returns a **PASS / WARN / BLOCK** verdict, every finding traced to file+line evidence.
> No LLM, no network, no vector database.

`semctx` is **not** a code-search tool. It does not answer *"which files are relevant to this
task?"* — it answers *"given this change, what did it put at risk, and is it proven?"* (ADR 0005).

## Install

Requires [Bun](https://bun.sh) ≥ 1.4.0. The CLI ships as a single self-contained bundle that runs on
Bun (no `node_modules` to install).

```bash
bunx semctx@latest install  # detected agent plugins + this Git repository
bunx semctx@latest setup    # CLI-only repository bootstrap
bun add -g semctx@latest    # optional global shell/CI install
```

`install` is idempotent and supports `--dry-run`, `--host codex|claude|all`, `--skip-setup`, and
`--json`. It does not install Codex or Claude Code themselves, overwrite an unrelated marketplace,
or initialise a directory that is not a Git repository.

## Use

```bash
semctx install                         # plugins + setup + readiness report
semctx verify diff --base origin/main  # analyse a range → PASS / WARN / BLOCK
```

- `verify diff` — impact + strict/advisory verdict; `--base/--head` ranges, `text|json|github`
  formats (the JSON is a versioned contract), `--fail-on`, `--output`, `--record`.
- `inspect symbol|capability <q>` — inspect the graph around a symbol or capability.
- `doctor` — workspace health check.

`BLOCK` exits non-zero — usable as a commit or CI gate. Verdicts are deterministic: a pure function
of repository state plus one injected timestamp, with every finding resolving to file+line
evidence.

## Learn more

- Full documentation, integrations (Claude Code plugin, GitHub Action) and the scope-boundary
  rationale (ADR 0005): <https://github.com/hoklims/semctx#readme>
- CLI reference: <https://github.com/hoklims/semctx/blob/main/docs/reference/cli.md>

## License

Apache-2.0 — see [LICENSE](./LICENSE).
