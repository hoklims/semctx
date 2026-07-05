# semctx

> Deterministic, local-first repository **change-impact analyzer**. Given a git diff, it computes
> the semantic blast radius — impacted symbols, exported contracts, invariants at risk, tests to
> run — and returns a **PASS / WARN / BLOCK** verdict, every finding traced to file+line evidence.
> No LLM, no network, no vector database.

`semctx` is **not** a code-search tool. It does not answer *"which files are relevant to this
task?"* — it answers *"given this change, what did it put at risk, and is it proven?"* (ADR 0005).

## Install

Requires [Bun](https://bun.sh) ≥ 1.3. The CLI ships as a single self-contained bundle that runs on
Bun (no `node_modules` to install).

```bash
bunx semctx --help          # run without installing
bun add -g semctx           # or install globally
```

## Use

```bash
semctx init --preset github-claude     # config + CI workflow + Claude Code note (preview first)
semctx index                           # build the deterministic graph
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
