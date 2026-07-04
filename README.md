# semctx — repository change-impact analyzer

> A deterministic, local-first tool that computes the **semantic blast radius of a change** and
> enforces a repository's **contracts and invariants**. Given a diff, it reports the impacted
> symbols, the contracts and invariants at risk, the tests that should run, and a
> **PASS / WARN / BLOCK** verdict — every finding traced to file+line evidence.

> **Scope boundary.** `semctx` does **not** replace code search or semantic retrieval. It does
> not answer *"which files look relevant to this task?"* — grep, embeddings, and CocoIndex do
> that better (see [`benchmarks/change-impact-eval`](benchmarks/change-impact-eval/) and
> ADR 0005). It answers a narrower, verifiable question: *"given this change, what did it put at
> risk, and is it proven?"*

Everything is **deterministic** (a pure function of repository state plus one injected
timestamp), **inspectable** (every finding resolves to file+line evidence), and works with
**no LLM, no network, and no vector database**.

**What semctx does**

- maps diffs to symbols, contracts, invariants, and tests;
- provides explainable PASS/WARN/BLOCK verdicts;
- works locally, from coding agents, and in CI.

**What semctx does not do**

- replace search engines or semantic retrieval;
- claim full repository understanding;
- require an LLM;
- upload repository code, comment on PRs, or need a secret by default.

---

## What it does

`semctx verify diff` takes a unified git diff and, against a deterministic graph of the repo
(symbols, exports, cross-file call graph, tests, docs, migrations, and opt-in `@markers`),
reports:

- **impacted symbols** — every declaration whose line range the diff touches;
- **exported contracts at risk** — public interfaces/types the change alters;
- **invariants at risk** — `@invariant`-annotated constraints on touched code;
- **tests to run** — the tests that cover the changed symbols (`tested_by` edges);
- **contradictions** — deprecated/contradicted sources the change leans on (non-normative);
- **unknowns** — what static analysis cannot prove (e.g. a concurrency race), stated plainly;
- a **verdict** — `PASS` / `WARN` / `BLOCK`, driven by configurable rules.

### Severity tiers

| tier | → | fires when |
| --- | --- | --- |
| **strict** | `BLOCK` | an **invariant** — or a **critical** contract (author-tagged `critical`/`security`) — is changed with **no covering test**; or a security surface changes without verification. |
| **advisory** | `WARN` | a plain **exported contract** changes without a direct test; or the change touches an **unresolved contradiction**. |

Rules live in `.semctx/config.json` (`blockingRules[].tier` / `.severity`); `tier` is optional
and derived from `severity` when absent. `BLOCK` exits non-zero — usable as a commit/CI gate.

---

## Get started in ~5 minutes

Requires [Bun](https://bun.sh) ≥ 1.3. `semctx` is not yet on npm; run it from source
(`bun apps/cli/src/index.ts …`, aliased below as `semctx`). Once published the same commands run
as `bunx @semantic-context/cli …`.

```bash
bun install                                   # once, in this repo

# in your TypeScript repo:
semctx init --preset github-claude            # preview + write config, CI workflow, Claude note
semctx index                                  # build the deterministic graph
semctx verify diff --base origin/main         # analyse the branch → PASS / WARN / BLOCK
```

`init --preset` previews everything first, never overwrites without `--force`, and adds no
blocking hook by default. Example verdict on a change that alters an invariant-constrained symbol
with no test:

```
Verdict: BLOCK
  range         : 8c1f2a..d4e9b0
  impacted invariants : confirmed-never-exceeds-capacity [inferred]
  recommended tests   : test/confirmation.test.ts
  Findings
    [BLOCK] invariant_touched_without_test: invariant-constrained code changed without a covering test: confirmReservation
```

See [`docs/getting-started.md`](docs/getting-started.md) and the CLI reference
([`docs/reference/cli.md`](docs/reference/cli.md)).

---

## Integrations

### Local CLI

```bash
semctx verify diff                            # working tree vs HEAD
semctx verify diff --base origin/main         # a range (real merge-base)
semctx verify diff --format json --output report.json   # stable, versioned machine report
```

A documented **pre-commit gate** (`docs/examples/pre-commit-hook.md`) runs `verify diff
--staged` and blocks the commit only on `BLOCK`.

### Claude Code

The plugin ([`plugins/claude-code`](plugins/claude-code)) exposes `semctx_verify_change` (MCP)
and a skill that has the agent verify after non-trivial edits and never finish on a `BLOCK`. An
opt-in **guarded mode** blocks `git commit`/`git push` until the diff is verified. Advisory (never
blocks) is the default. See [`docs/integrations/claude-code.md`](docs/integrations/claude-code.md).

### GitHub Actions

A composite action ([`packages/github-action`](packages/github-action)) gates PRs — annotations,
a job summary, and a `PASS/WARN/BLOCK` verdict. `WARN` never fails the check; `BLOCK` does. No PR
comments, no secrets, `contents: read` only. Copy
[`examples/github-actions/semctx.yml`](examples/github-actions/semctx.yml) and see
[`docs/integrations/github-actions.md`](docs/integrations/github-actions.md).

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- uses: hoklims/semctx/packages/github-action@v0.1.0
  with:
    base: ${{ github.event.pull_request.base.sha }}
    head: ${{ github.sha }}
    fail-on: block
```

---

## Semantic markers (opt-in)

Contracts, invariants and capabilities come from **explicit, machine-readable markers** — never
LLM inference. That is what makes the verdict deterministic and traceable:

```ts
/**
 * @capability reservation-confirmation
 * @invariant  confirmed-never-exceeds-capacity: confirming must never overbook a slot
 * @contract   reservation-repository-port: getSlot / save
 */
export function confirmReservation(/* ... */) { /* ... */ }
```

Markers are **optional**: without them `verify diff` still reports impacted symbols, exported
contracts, and `tested_by` links. Markers are what unlock the strict-tier invariant/contract
BLOCK rules — they are how you tell `semctx` which changes must be proven.

---

## MCP server (agents)

The first-class tool is **`semctx_verify_change`** — hand it a diff, get the impact analysis and
verdict; `semctx_inspect` queries the graph. The easiest path is the Claude Code plugin above; to
register the server directly (stdio):

```json
{
  "mcpServers": {
    "semctx": {
      "command": "bun",
      "args": ["/abs/path/to/semctx/packages/mcp-server/src/index.ts"],
      "env": { "SEMCTX_ROOT": "." }
    }
  }
}
```

Full guide: [`docs/integrations/claude-code.md`](docs/integrations/claude-code.md).

---

## Architecture

```
repository  → deterministic graph   (TS Compiler API + docs + migrations + tests + @markers)
git diff    → impact analysis        (touched symbols, contracts, invariants, tests)
            → gates + verdict         (strict/advisory rules → PASS / WARN / BLOCK)
```

Monorepo (Bun workspaces, TypeScript strict):

| Package | Responsibility |
| --- | --- |
| `@semantic-context/core` | domain model, deterministic ids, errors, Zod boundary schemas |
| `@semantic-context/ts-analyzer` | TS Compiler API → graph; docs, tests, migrations, `@markers` |
| `@semantic-context/repository-store` | `bun:sqlite` persistence behind a `RepositoryStore` interface |
| `@semantic-context/context-engine` | graph index, claims, **impact analysis + verify**, gates |
| `@semantic-context/mcp-server` | MCP server: `verify_change` (first-class), `inspect` |
| `@semantic-context/github-action` | composite GitHub Action + Node annotation/summary adapter |
| `apps/cli` | the `semctx` CLI (zero-framework arg router) |
| `plugins/claude-code` | Claude Code plugin: MCP + skill + guarded hook |
| `benchmarks/change-impact-eval` | the comparative retrieval benchmark behind ADR 0005 |

`@semantic-context/cocoindex-adapter` and the `context prepare` command remain in the tree but
are **experimental** — see below.

---

## What changed, and why (ADR 0005)

`semctx` originally also shipped `task → ContextPack`: compile a task into a ranked, justified
set of files to read (a *retriever*). A comparative evaluation on 16 real commits
([`benchmarks/change-impact-eval`](benchmarks/change-impact-eval/)) showed that retriever loses
to a plain BM25 content search on every metric (R@10 0.31 vs 0.97; MRR 0.06 vs 0.88), and that
semctx's own graph+scoring stages are **net-negative** on un-annotated code. The deficiency is
architectural — the pipeline seeds from symbol/file *names* and never reads file *content*.

So the retriever is **withdrawn, not tuned**. Graph traversal is retained only for **impact
analysis** and **justification** (which `verify diff` needs), never as a primary task-to-code
retriever without a content-retrieval front end. `context prepare` still exists (it is that
impact/justification engine) but is **experimental** and is not advertised as code search. See
ADR 0005 and `ROADMAP.md`.

---

## Determinism & honesty

- The **only** non-deterministic values are the `generatedAt` / `createdAt` timestamps, injected
  via a clock. Everything else is byte-identical across runs on identical repo state.
- Heuristic steps are **labelled as heuristic**; verified facts (exported types are
  `statically_verified`, passing tests are `tested`) are labelled as such. Nothing claims more
  than the code computes — including the benchmark, which is a committed *negative* result.

## Status

Implemented and tested (full suite via `bun test`):

- deterministic TS graph (symbols, imports/exports, cross-file call graph, tests, docs,
  migrations, semantic markers);
- `verify diff` — impact analysis + strict/advisory PASS/WARN/BLOCK, with provenance;
  `--base/--head` merge-base ranges, `text/json/github` formats (versioned JSON contract),
  `--fail-on`, `--output`, `--record`;
- MCP server (`verify_change`, `inspect`) + Claude Code plugin (advisory + guarded hook);
- composite GitHub Action (annotations, summary, PASS/WARN/BLOCK gate);
- `init --preset github-claude` bootstrap; contributor dev container;
- committed comparative benchmark (`benchmarks/change-impact-eval`).

### Known limitations

- The call graph is best-effort static analysis (unresolved dynamic calls are omitted).
- Semantic markers are single-line; multi-line marker statements are not yet parsed.
- Concurrency/runtime properties are surfaced as **unknowns**, not statically proven — by design.
- `context prepare` (task → pack) is experimental and **not** a code-search replacement (ADR 0005).

See [`ROADMAP.md`](ROADMAP.md) for the shipping vs research split.

## License

Apache-2.0 — see [LICENSE](./LICENSE). The explicit patent grant lowers legal friction for
enterprise adoption (reasoning in `docs/architecture/decision-log.md`).
