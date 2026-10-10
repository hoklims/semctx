# semctx

semctx reads a Git diff of a TypeScript repository and reports what the change touches: the
symbols it edits, the exported interfaces and types other code depends on, the rules you declared
with `@invariant`, and the test files that import the changed code. It ends with a verdict: PASS,
WARN or BLOCK. BLOCK exits with code 3, so a hook, a CI job or a coding agent can stop on it.

With no markers in your code, it warns when an exported interface or type changes and no test file
imports it. To make it block, mark the code that matters: `@invariant` on any declaration,
`@tag security` on a security-sensitive symbol, or `@tag critical` on an exported interface or type
(see [Declare what must not break](#declare-what-must-not-break)).

Analysis runs on your machine: it makes no network or LLM calls and needs no vector database. The
same repository state gives the same report, apart from timestamps. semctx only reads your code. It
never builds it or runs your tests, so treat the report as a list of what to re-check. It works from
the command line, in GitHub Actions, in Claude Code and Codex, and over MCP.

Despite the name, semctx does not search code or pick the files an agent should read: grep and
embedding search do that better ([ADR 0005](docs/adr/0005-context-retrieval-pipeline-rejected.md)).

## Quick start

You need [Bun](https://bun.sh) 1.4.0 or newer and a Git repository with at least one commit.

```sh
bunx semctx@latest setup         # write the config, build the local index, check the setup
# ...edit some code...
bunx semctx@latest index         # refresh the index after your edits
bunx semctx@latest verify diff   # verdict for your uncommitted changes
```

To drop the `bunx semctx@latest` prefix, install the CLI once with `bun add -g semctx@latest`. The
rest of this README writes plain `semctx`.

`setup` writes `.semctx/config.json` and six `.sem` templates in `.semctx/semantic/`, for goals,
invariants, decisions, assumptions, evidence and unknowns. They hold only comments until you write
something down, so you can ignore them at first. Commit the config and the templates. The SQLite
index stays local and git-ignored, and rerunning `setup` is harmless.

The first run usually prints `OK ready (analysis partial)`, even on a small repository. That is
expected: the analyzer does not claim it found every reference to your code, so an empty report
never proves that nothing was affected. `semctx index-health` lists the reasons.

Rerun `semctx index` after you edit. If you skip it, `verify diff` still reports, with a note under
`Unknowns` that the index is not fresh. After a commit, pull or branch switch you must rerun it:
until you do, `verify diff` returns BLOCK with `index_binding_stale`.

## What a verdict looks like

The [demo script](docs/contributing/first-use-demo.md) creates a small repository with no tests,
commits it, then makes three edits. One adds a required field to an exported interface:

```diff
 export interface CartTotal {
   subtotalCents: number;
   taxCents: number;
+  discountCents: number;
 }
```

After `semctx index`, `semctx verify diff` prints this and exits 0:

```text
Verdict: WARN
  range         : working tree
  changed files : 3
  impacted nodes: 7

Impacted contracts
  Exported interface "CartTotal" is a public, compiler-enforced contract. [statically_verified]

Recommended tests
  none

Findings
  [WARN ] contract_changed_without_test: exported contract changed without a covering test: CartTotal
```

`impacted nodes` counts the files and declarations whose lines the diff touches. The label in
brackets says how semctx knows a fact: `statically_verified` is read from the code's structure,
`tested` means a test file imports the code, and `inferred` rests only on a marker comment.

WARN is advisory, hence exit 0. `CartTotal` is exported, so semctx treats it as a public contract
and asks for a covering test, which in semctx means a test file that imports it. The demo has none.

The other two edits, a reworded comment and an off-by-one in an unexported discount helper, get no
finding. The second is a real bug that semctx misses: the helper is not exported and carries no
marker. The demo report is also [published online](https://hoklims.github.io/semctx/demo/).

## Declare what must not break

To make semctx stop a change, state the rule in a one-line JSDoc tag on the code it protects, as in
[`examples/consumer-typescript-repo`](examples/consumer-typescript-repo/src/index.ts):

```ts
/**
 * @invariant greeting-non-empty: a greeting must never be an empty string
 */
export function greet(name: string): string {
  return `Hello, ${name}!`;
}
```

Change the body of `greet` while no test file imports it, and `verify diff` exits with 3:

```text
[BLOCK] invariant_touched_without_test: invariant-constrained code changed without a covering test: greet
```

Add a test file that imports `greet`, run `semctx index` again, and the finding clears. See
[Limits](#limits) for what counts as a test.

`semctx index` builds a graph of symbols, imports, calls, tests and markers with the TypeScript
compiler API. `verify diff` maps the changed lines onto it and applies these default rules from
`.semctx/config.json`; the most severe finding sets the verdict.

| Rule | Default | Fires when |
| --- | --- | --- |
| `invariant_touched_without_test` | BLOCK | code under an `@invariant` changes with no covering test |
| `critical_contract_changed_without_test` | BLOCK | an exported interface or type tagged `@tag critical` or `@tag security` changes with no covering test |
| `security_surface_without_verification` | BLOCK | a symbol tagged `@tag security` changes with no covering test |
| `contract_changed_without_test` | WARN | any other exported interface or type changes with no covering test |
| `contradiction_unresolved` | WARN | the change touches a Markdown doc marked deprecated or declaring `contradicts`, or a marker id written with two different statements |

semctx only uses markers you write; it never adds them. `@capability` and `@contract` only describe
code: for the rules above, only exported interfaces and types count as contracts.

To relax a rule, set its `severity` to `warn` or remove it
([blocking rules](docs/reference/configuration.md#blocking-rules-and-severity-tiers)). Two checks
cannot be configured. `index_binding_stale` always blocks. With config v2 (see [Limits](#limits)),
`analysis_scope_incomplete` blocks when a changed file in scope has no usable analysis, and warns
when the analysis is only partial.

## Use it from the command line

```sh
semctx verify diff                                      # uncommitted changes against HEAD
semctx verify diff --base origin/main                   # your branch, from its merge-base
semctx verify diff --staged                             # what the next commit contains
semctx verify diff --fail-on warn                       # exit 3 on WARN as well
semctx verify diff --format json --output report.json   # versioned JSON report
semctx impact diff --base origin/main                   # what the change can reach, no verdict
```

`verify diff` exits 0 on PASS or WARN and 3 on BLOCK. Any other code means the run failed, for
example on an invalid option, and produced no verdict.
`--format github` prints workflow annotations. `--base` needs a local ref, because semctx never
fetches. A pre-commit hook can run `semctx index` and then `semctx verify diff --staged`
([example](docs/examples/pre-commit-hook.md)).

Write options after the command. In `semctx --json status`, `--json` takes `status` as its value
and the CLI prints the general help. `semctx --help` lists the commands with their main options
(`semctx <command> --help` prints the same page), and the [CLI reference](docs/reference/cli.md)
has the rest.

For a larger change, start with `semctx change open change.<slug>`: it records which invariants the
change must keep and which evidence it still owes. `semctx change verify change.<slug>` later runs
`verify diff` against that record and tells you whether the evidence is in place
([walkthrough](docs/examples/semantic-layer-reservation-example.md)).

## Use it in CI

Copy [`examples/github-actions/semctx.yml`](examples/github-actions/semctx.yml) to
`.github/workflows/`, or let `semctx setup --preset github-claude` write it (with a short
`.claude/semctx.md` note for Claude Code):

```yaml
name: Semctx
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
jobs:
  semctx:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # semctx needs the merge base and never fetches
      - uses: hoklims/semctx/packages/github-action@v0.4.2
        with:
          base: ${{ github.event.pull_request.base.sha }}
          head: ${{ github.sha }}
          fail-on: block
```

The action installs Bun itself, indexes the checkout, runs `verify diff`, and writes annotations on
the affected declarations, a job summary and step outputs such as `verdict`. BLOCK fails the job;
WARN fails it only with `fail-on: warn`. It needs no secrets and posts no PR comments. It never
loads `bunfig.toml` or `.env` from the pull request, so a PR cannot run code on the runner that way.

Pin a release tag, because `main` and `stable` move ([guide](docs/integrations/github-actions.md)).

## Use it from Claude Code or Codex

Run `bunx semctx@latest install` from the repository you want to check. It installs or updates the
semctx plugin for each detected host (Claude Code or Codex must already be installed), then runs
`setup`. Rerunning it is harmless. `--dry-run` prints the plan, and `--host codex|claude|all`
limits it to certain hosts.

<!-- semctx:compatibility:start -->
Semctx **0.4.2** requires **Bun >=1.4.0**.
The supported, tested host baseline is **Codex 0.147.0** and
**Claude Code 2.1.229**. Other host versions are **unknown** until tested;
these pins do not claim the earliest historically compatible versions.
[Baseline delivery evidence](https://github.com/hoklims/semctx/actions/runs/34664142432).
Installation does not reload an active session: open a new Codex task, or run
`/reload-plugins` in Claude Code (restart if reload fails).
<!-- semctx:compatibility:end -->

The plugins give the agent the semctx MCP tools and skills, for example `semctx_verify_change` to
check its own diff before it says it is done. The plugin hooks run on Node, so Node must be on your
`PATH` too. See the [Claude Code](docs/integrations/claude-code.md) and
[Codex](docs/integrations/codex-control-plane.md) guides.

By default the plugins only report. On Claude Code, a `.semctx/guard.json` containing
`{"enabled": true}` turns on [guarded mode](docs/integrations/claude-code-guarded-mode.md):
`git commit` and `git push` are refused until `semctx verify diff --record` has recorded a
non-BLOCK verdict for exactly that content. `SEMCTX_GUARD=off` turns it off.

Codex has no guarded mode. When the Codex agent runs semctx from the shell instead of through MCP,
it calls a global `semctx`, so install one with `bun add -g semctx@latest`.

Plugins update from the `stable` branch, which moves only when a release is published to npm.
`semctx plugin-status` shows the version you have.

Other MCP clients can run the server from a source checkout
([config snippet](docs/integrations/claude-code.md#mcp-without-the-plugin)). The server registers
39 schema-declared tools (typed inputs and outputs), listed in
[`tool-contract.ts`](packages/mcp-server/src/tool-contract.ts). Tools that read a repository take
its absolute path as `repositoryRoot`; `semctx_control_verify_authorization`, which checks a capsule
offline, takes none. `SEMCTX_ROOT`, if set, must be absolute.

### Reference for agent integrators

You need this only to build or tune an agent workflow; the plugin skills already follow it.

The planning tools check that the index is fresh, follow code up to the intent written in
`.semctx/semantic/`, and compare a real diff with a plan. On the CLI they are `semctx status` and
`semctx control ...`; over MCP, `semctx_control_status`, `semctx_control_trace`,
`semctx_control_plan` and the other `semctx_control_*` tools. Most only read. Two write:
`control target-propose` saves a target architecture artifact under `.semctx/semantic/targets/`, and
`control handoff` stores a capsule in git-ignored local state.

A `READY` plan grants no execution authority: these tools never edit code, commit, delete or deploy
([design](docs/architecture/control-plane-v1.md)).

Both plugins expose `semctx_control_agent_lifecycle`, a read-only checklist tool. Each call carries
a `requiredAltitude`, which says how high-level the work is, from L0 (diff hunks) to L6 (strategy).
The agent calls it at four points:

- `before_implementation_write`, before its first write at L2 (component level) or above;
- `after_repository_edits`, after editing, with the ids of what it touched;
- `before_completion`, before saying the work is done;
- `before_compaction`, before compacting its context or handing the work over.

The answer is `NO_OP` (nothing required, as for pre-write work at L0 or L1), `RECORDED` (every
required step was reported) or `INCOMPLETE` (some are missing). It checks that the steps were
reported, not what they found.

semctx takes touched ids on the agent's word (`caller_observed_advisory`) and keeps nothing between
calls (`stateless_caller_reinjected_unbound`), so the agent resends earlier ids on every call.

Each plugin ships one lifecycle hook that automates only the before_completion checkpoint. It
records which semctx MCP tools ran, as step ids in a git-ignored file, and reports on stderr at the
end of a turn when that set changed.

It never blocks. From the host event it uses only the event name, session id, working directory and
tool name, and it never opens the transcript or reads source code. Set `SEMCTX_LIFECYCLE=off` to
turn it off.

The hook sees MCP calls only, so a step run through the shell CLI shows as missing. The other three
checkpoints have no automatic host hook ([details](docs/integrations/claude-code.md#lifecycle-foundation)).

## Limits

- A file counts as a test by its name, its directory or a test-runner import. It covers a symbol
  when it imports it as a value under its exported name (`import { greet }`), even if it never runs
  the changed line. Aliased imports (`import { greet as subject }`), namespace imports
  (`import * as m`) and `import type` do not count. The `testGlobs` config field is not applied.
- A behaviour change inside any function gives no finding unless a marker covers it.
- Calls that cannot be resolved statically are left out, and runtime behaviour such as races is out
  of reach. `Unknowns` lists only a few known gaps, such as untested invariants or partial
  analysis, so an empty `Unknowns` section does not mean nothing was missed.
- The default config (v1) ignores `include` and `docsDirs`, matches `exclude` as a plain substring,
  and walks the whole repository except `node_modules`, `dist`, `build` and similar directories.
  Config v2 applies `include` and `exclude` as globs. Create it with `semctx setup --polyglot`. An
  existing v1 config converts through a reviewed plan
  ([config migration](docs/reference/configuration.md#config-migration-v1-to-v2)).
- Markers and `.sem` statements must fit on one line. Links from `.sem` files name a file and a
  symbol, so renaming the symbol or its file can mark them stale. `semctx migrate anchors --apply`
  rewrites older links that still carry line numbers; without `--apply` it only shows the changes.

## Current delivery status

semctx is pre-1.0 (0.4.x). The CLI, both plugins and the GitHub Action share one version and ship
together from one release tag. Pin an exact version when you need reproducible results. Minor
releases can still contain breaking changes; the [changelog](CHANGELOG.md) lists them.

- Languages: TypeScript (`.ts`, `.tsx`, `.mts`, `.cts`) is the baseline. Python through 3.12 is
  opt-in with config v2 and limited to modules, classes, functions, imports and markers (no calls,
  no test links). Markdown and SQL are only classified as documents and migrations. Other languages
  are skipped.
- Released: `verify diff`, `impact diff`, the GitHub Action, the Claude Code and Codex plugins, the
  MCP server, change records and the planning tools.
- Opt-in: config v2 (`setup --polyglot`) and guarded mode on Claude Code.
- Experimental: the [Oh My Pi](docs/integrations/omp.md) package and `context prepare`
  (`semctx_prepare_task` over MCP). [Grok](docs/integrations/grok.md) can load the Claude Code
  plugin but is outside the tested host baseline.
- Withdrawn: the task-to-files retriever, which lost to plain BM25 search
  ([ADR 0005](docs/adr/0005-context-retrieval-pipeline-rejected.md),
  [results](benchmarks/change-impact-eval/RESULTS.md)). `context prepare` is what is left of it.
- Partial: agent checkpoints, of which only `before_completion` is automated
  ([reference](#reference-for-agent-integrators), [#28](https://github.com/hoklims/semctx/issues/28)).
- Not built: anything that applies a plan for you.
- Not measured: accuracy. The [public replay corpus](docs/pilot/public-corpus-2026-09-08.json) has
  30 real changes, but none has a known expected result yet, so none is scored.

Planned work is in the [roadmap](ROADMAP.md).

## Documentation

The [documentation index](docs/README.md) lists every guide. Start with
[getting started](docs/getting-started.md) or [troubleshooting](docs/troubleshooting.md). The
[architecture overview](docs/architecture/overview.md) and the [design decisions](docs/adr/) split
semctx into three "planes": A is the facts derived from code plus the diff check, B is the intent
you write down in `.semctx/semantic/`, and C is the planning tools.

## Contributing, support, license

Contributors start with the [first contributor check](docs/contributing/first-check.md) and
[CONTRIBUTING.md](CONTRIBUTING.md). Questions and bug reports go through [SUPPORT.md](SUPPORT.md),
vulnerabilities through [SECURITY.md](SECURITY.md). `semctx support` and `semctx feedback` stay on
your machine and upload nothing ([details](docs/reference/cli.md#local-feedback-and-support-reports)).

semctx is licensed under [Apache-2.0](LICENSE).
