# semctx — repository change-impact analyzer

> A deterministic, local-first tool that computes the **semantic blast radius of a change** and
> enforces a repository's **contracts and invariants**. Given a diff, it reports the impacted
> symbols, the contracts and invariants at risk, the tests that should run, and a
> **PASS / WARN / BLOCK** verdict. Findings carry stable reason codes and include file/range
> locations whenever the underlying evidence has a concrete source location.

> **Scope boundary.** `semctx` does **not** replace code search or semantic retrieval. It does
> not answer *"which files look relevant to this task?"* — grep, embeddings, and CocoIndex do
> that better (see [`benchmarks/change-impact-eval`](benchmarks/change-impact-eval/) and
> ADR 0005). It answers a narrower, verifiable question: *"given this change, what did it put at
> risk, and is it proven?"*

Analysis and verification outputs are **deterministic** (a pure function of repository state plus
one injected timestamp) and **inspectable**. After installation, the analysis pipeline uses
**no LLM, network call, or vector database**.

> **Release 0.1.17.** This README and every release-bearing manifest describe the lockstep 0.1.17
> CLI and plugins. The annotated `v0.1.17` tag drives npm publication, the `stable` plugin channel,
> and the GitHub Release from one immutable commit. Pin an exact release when reproducibility
> matters.

**What semctx does**

- maps diffs to symbols, contracts, invariants, and tests;
- provides explainable PASS/WARN/BLOCK verdicts;
- works locally, from coding agents, and in CI.

**What semctx does not do**

- replace search engines or semantic retrieval;
- claim full repository understanding;
- require an LLM;
- upload repository code, comment on PRs, or need a secret by default.

## Current delivery status

| capability | state on `main` |
| --- | --- |
| Plane A change-impact verification | implemented and tested; TypeScript is the compatibility baseline |
| Config-v2 polyglot runtime | implemented and tested for TypeScript, bounded Python-through-3.12 facts, Markdown documents, and SQL migrations; adapter boundary remains private/provisional |
| Plane B authored intent | implemented; Git-versioned declarations and proof-carrying change contracts |
| Plane C reconstruction/control | implemented as read-only planning, authority reporting, and diff reconciliation, plus content-addressed local Control Handoff v2 capture/resume; no executor |
| Codex/Claude MCP and workflow parity | implemented for shared tools, contracts, and generated workflow instructions |
| Agent lifecycle | explicit MCP checkpoint and machine-validated Control Handoff v2 are manual and shadow-only; a shipped shadow hook automates `before_completion` on both hosts without blocking, while the other three checkpoints, persisted/measured telemetry, and enforcement remain open in [#28](https://github.com/hoklims/semctx/issues/28) |
| P4 competitive evidence/replay gate / P5 persisted executor | not shipped; the committed 16-change retrieval benchmark is historical negative evidence, not the P4 competitive gate |

> **Static, not dynamic — a scope selector for runtime checks.** semctx is a *static* impact
> analyzer: it reasons about the diff against the graph without building or running the code. It is
> **complementary** to *dynamic* verification (build-and-run harnesses such as a coding agent's
> `/verify` step). semctx answers *"what did this change put at risk, and what should be
> re-tested?"* **before** the dynamic step answers *"does it still work when actually run?"*. Use
> semctx to select the scope; use a runtime check to confirm behaviour. They compose — impact
> first, behaviour second — they do not compete.

---

## What it does

`semctx verify diff` takes a unified git diff and, against a deterministic graph of the repo
(symbols, exports, cross-file call graph, tests, docs, migrations, and opt-in `@markers`),
reports:

- **impacted symbols** — every declaration whose line range the diff touches;
- **exported contracts at risk** — public interfaces/types the change alters;
- **invariants at risk** — `@invariant`-annotated constraints on touched code;
- **tests to run** — statically linked test candidates inferred from test-file imports
  (`tested_by` edges), not executed or measured coverage;
- **contradictions** — deprecated/contradicted sources the change leans on (non-normative);
- **unknowns** — what static analysis cannot prove (e.g. a concurrency race), stated plainly;
- a **verdict** — `PASS` / `WARN` / `BLOCK`, driven by configurable rules.

### Language coverage and analysis health

The default version-1 configuration preserves the historical TypeScript-family analysis path:
TypeScript receives semantic extraction, Markdown is classified as documentation, and SQL as
migrations. Version 2 is an explicit `--polyglot` opt-in with deterministic include/exclude globs
and separate TypeScript, Python, Markdown, and SQL modes.

TypeScript remains the compatibility baseline. The first Python vertical is deliberately bounded
to syntax through Python 3.12: it extracts modules, classes, functions, static imports, explicit
markers, source ranges, and uniquely resolved selected-module imports. It does not infer Python
calls, unmarked contracts, test coverage, or negative completeness. Markdown and SQL receive
structural classification, not general language analysis.

Selection is not proof of coverage. `semctx index-health` (and `semctx_index_health` over MCP)
reports binding, freshness, coverage, candidate outcomes, and producer capabilities separately.
With config v2, `verify diff` blocks when a changed selected scope is missing, disabled,
unsupported, failed, stale, or invalidly bound; partial Python negative evidence stays an explicit
warning/unknown rather than becoming a green absence claim.

### Severity tiers

| tier | → | fires when |
| --- | --- | --- |
| **strict** | `BLOCK` | an **invariant** — or a **critical** contract (author-tagged `critical`/`security`) — is changed with **no eligible statically linked test**; a security surface changes without verification; or config-v2 analysis is incomplete for a changed selected scope. |
| **advisory** | `WARN` | a plain **exported contract** changes without an eligible statically linked test; or the change touches an **unresolved contradiction**. |

Rules live in `.semctx/config.json` (`blockingRules[].tier` / `.severity`); `tier` is optional
and derived from `severity` when absent. The config-v2 `analysis_scope_incomplete` preflight is an
independent safety gate, not a user-authored blocking rule. `BLOCK` exits non-zero — usable as a
commit/CI gate.

---

## Get started

Requires [Bun](https://bun.sh) ≥ 1.3. From a Git repository using the legacy TypeScript-family
baseline, one command detects Codex and/or Claude Code, installs or updates the matching plugins,
prepares the repository, and verifies the result:

```bash
bunx semctx@latest install
```

It is safe to run again. Existing installs are refreshed through the release-managed `stable`
channel, legacy marketplace names are migrated, existing Semctx configuration and authored `.sem`
files are preserved, and a non-Git directory is never initialised accidentally. Use `--dry-run`
to preview, `--host codex|claude|all` to target a host, or `--skip-setup` for a machine-only plugin
refresh. Open a new Codex task when required; in an active Claude Code session, run
`/reload-plugins` after installation or update and restart only if the reload fails.
On Windows, if a running Codex task still holds the legacy plugin cache open, the replacement stays
installed and verified while cleanup automatically retries in the background after the task exits.

To see where your plugins actually stand, without changing anything:

```bash
semctx plugin-status            # local evidence only, no network call
semctx plugin-status --attest   # also ask the remote what 'stable' points at right now
```

Three facts that version numbers alone will not tell you:

- **Merging `main` does not update an installed plugin.** `main` is the development branch. Plugins
  are delivered only through the release-managed `stable` channel, which the tag workflow advances
  after npm publication. A clone can sit ahead of `stable` at the *same* version number, so
  `plugin-status` compares commits rather than version strings.
- **`stable` is the public release channel.** Both installers register their marketplace against
  `stable`, never `main`, and nothing else licenses an up-to-date verdict. Without `--attest` the
  local `origin/stable` mirror is reported as evidence but stays informational — matching a
  possibly stale mirror never produces a false green. `--attest` asks the canonical public
  repository instead, in a throwaway store outside your project and with the ambient Git
  configuration removed, so no local setting can decide what the release is. It works from any
  project, writes nothing you own, and reports `unknown` when offline.
- **A fresh installed cache does not prove a running session loaded it.** An installed version is
  what the *next* session resolves; a session already open keeps what it started with. No host
  exposes the loaded version, so `plugin-status` reports it as `unknown` with the activation step
  (a new Codex task, or `/reload-plugins` in Claude Code) instead of inferring it from the cache.

For CLI-only use without a coding-agent plugin:

```bash
bunx semctx@latest setup
bunx semctx@latest verify diff --base origin/main
```

On current `main`, create a new config-v2 polyglot workspace explicitly:

```bash
semctx setup --polyglot
```

This never overwrites an existing version-1 configuration; migrate that file deliberately. See
the [configuration reference](docs/reference/configuration.md) for the exact selection and
language-capability boundaries.

For development from this checkout:

```bash
bun install
bun apps/cli/src/index.ts install --dry-run
```

`semctx setup --preset github-claude` also drops a CI workflow and a Claude Code note. The
individual steps are still available if you want them (`init`, `index`, `semantic init`,
`semantic check`).

`init --preset` previews everything first, never overwrites without `--force`, and adds no
blocking hook by default. Example verdict on a change that alters an invariant-constrained symbol
with no eligible static test link (the CLI's current text calls this a "covering test"; semctx does
not run or measure test coverage):

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

### Shared lifecycle checkpoint and manual Control Handoff v2

Codex and Claude Code expose the same read-only `semctx_control_agent_lifecycle` MCP tool. Agents
must invoke it explicitly at `before_implementation_write` before the first eligible L2+ write,
`after_repository_edits` after edits, `before_completion` before claiming completion, and
`before_compaction` before compaction or owner transfer. The request carries `requiredAltitude`; a
pre-write request at L0-L1 has no stage-presence obligation.

The report is presence-only: `NO_OP` means no stage-presence obligation applies, `RECORDED` means
all required stage ids were recorded, and `INCOMPLETE` means required stage ids are missing. These
values evaluate neither stage outcomes nor admissibility. A non-Semctx repository returns an
explicit `non_semctx` no-op; a Semctx repository whose index is not ready remains
`semctx_unready`.

Touched coordinates in the lifecycle checkpoint carry `caller_observed_advisory` evidence. The
tool folds prior and newly observed ids as `stateless_caller_reinjected_unbound`: the caller must
reinject prior ids, and this checkpoint persists or binds none of them to a task, session, diff,
commit, or handoff.

The separate manual Control Handoff v2 surface is available as `semctx control handoff
<input.json>` / `resume-handoff <capsule-hash>` and the MCP tools `semctx_control_handoff` /
`semctx_control_resume`. A `step_completed` pointer requests validation of one proof-bearing
boundary from the current worktree; it is never an execution-history assertion. Fresh
reconciliation accepts that boundary only when every proof-bearing step through it is currently
provable. The exact sealed observed hunk SHA-256 coordinate is a valid L0 focus for an edit-only
step.

Planner phases with explicit zero obligations are reported separately as
`descriptiveRefinementStepIds`. They are labels, never completed steps, and
`nextValidTransition` may skip only those explicit descriptive phases. An empty legacy step without
the explicit completion-evidence field is `legacy_ambiguous` and fails closed. Canonical migration
step obligations remain load-bearing; evidence that cannot currently be derived or otherwise
satisfied leaves reconciliation `UNPROVEN`.

The content-addressed record stays under ignored local working state; exact-hash resume re-runs
reconciliation and returns no stale capsule.

Both surfaces run in `shadow` mode, block nothing, grant `executionAuthority: "none"`, and collect
no source content in the canonical capsule. A non-Semctx repository returns a write-free `NO_OP`.
Normal post-edit changes can make global control freshness `STALE`; Handoff v2 therefore uses fresh
task/diff reconciliation as its validation basis instead of treating global freshness as post-edit
proof or execution authority.
Each plugin also ships one shadow lifecycle hook that automates only the before_completion
checkpoint. It observes which Semctx MCP tools the host actually invoked, keeps canonical stage ids
in a session-local git-ignored ledger, and reports that checkpoint when the agent turn ends -
only when the observed set has changed, so a completed cycle never keeps reporting a stale green
over later turns that produced no evidence. It never blocks, never collects prompts, transcripts,
tool payloads or source, and grants no authority;
`SEMCTX_LIFECYCLE=off` disables it. The other three checkpoints have no automatic host hook.
Persisted or measured telemetry, enforcement, and an executor remain open.

### Claude Code

The plugin ([`plugins/claude-code`](plugins/claude-code)) exposes the same shared
`semctx-control` workflow as Codex: `semctx_control_status`, `semctx_control_trace`,
`semctx_control_plan`, `semctx_control_plan_change`, `semctx_control_reconcile_diff`, manual
`semctx_control_handoff` / `semctx_control_resume`, proof-carrying change contracts, and
`semctx_verify_change`. The narrower `semctx-semantic` and
`semctx-verify` skills remain available for focused Plane B or Plane A work. Planning bundles carry
`executionAuthority: "none"`; `READY` and `REALIZED` are verdicts, never execution authority. An
opt-in **guarded mode** blocks `git commit`/`git push` until the diff is verified; advisory mode is
the default.

The plugin ships portable MCP (`dist/semctx-mcp.js`) and CLI (`dist/semctx.js`) entries with a fixed
root shared runtime chunk (`dist/semctx-shared.js`), so agent shell fallbacks and guard messages stay
on the same release as the tools; the skills and the guard hand the agent the CLI's resolved
absolute path. A global `semctx` remains optional for CI and non-plugin shells. See
[`docs/integrations/claude-code.md`](docs/integrations/claude-code.md).

### Grok

Grok can load the same Claude Code plugin. It does not expand `${CLAUDE_PROJECT_DIR}` in
`.mcp.json`, so `SEMCTX_ROOT` arrives as a literal placeholder. The MCP server treats that as
unset and pins on the first absolute `repositoryRoot` argument — the same start path Codex
uses. See [`docs/integrations/grok.md`](docs/integrations/grok.md).

### Codex

The repo-local [`semctx-control`](plugins/semctx-control) plugin gives Codex the full semctx MCP
surface plus the same proof-honest workflow shipped for Claude Code. It uses
`semctx_control_status`, `semctx_control_trace`, `semctx_control_plan`,
`semctx_control_plan_change`, `semctx_control_reconcile_diff`, and the manual
`semctx_control_handoff` / `semctx_control_resume` pair; it maintains proof-carrying change
contracts on write-scoped tasks and verifies the resulting diff. It never treats a planning or
reconciliation verdict as execution authority. Plane C planning and reconciliation remain
read-only; Control Handoff v2 writes only ignored local working state. It ships the same portable
`dist/semctx.js` CLI and fixed root `dist/semctx-shared.js` runtime chunk, though Codex has no
placeholder substitution to hand the agent the CLI path — shell fallbacks there use a global
`semctx`. Install and usage guide:
[`docs/integrations/codex-control-plane.md`](docs/integrations/codex-control-plane.md).

### GitHub Actions

A composite action ([`packages/github-action`](packages/github-action)) gates PRs — annotations,
a job summary, and a `PASS/WARN/BLOCK` verdict. `WARN` never fails the check; `BLOCK` does. No PR
comments, no secrets, `contents: read` only. Copy
[`examples/github-actions/semctx.yml`](examples/github-actions/semctx.yml) and see
[`docs/integrations/github-actions.md`](docs/integrations/github-actions.md).

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- uses: hoklims/semctx/packages/github-action@v0.1.17
  with:
    base: ${{ github.event.pull_request.base.sha }}
    head: ${{ github.sha }}
    fail-on: block
```

The generated `github-claude` preset and all copyable integration examples pin this same release
tag. Historical ADR and changelog references retain the version that was current when authored.

---

## Semantic markers (opt-in)

Contracts, invariants and capabilities come from **explicit, machine-readable markers** — never
LLM inference. That is what makes the verdict deterministic and traceable:

```ts
/**
 * @capability reservation-confirmation
 * @tag critical
 * @invariant  confirmed-never-exceeds-capacity: confirming must never overbook a slot
 * @contract   reservation-repository-port: getSlot / save
 */
export function confirmReservation(/* ... */) { /* ... */ }
```

Markers are **optional**: without them `verify diff` still reports impacted symbols, exported
contracts, and `tested_by` links. Markers are what unlock the strict-tier invariant/contract
BLOCK rules — they are how you tell `semctx` which changes must be proven.
`@tag critical` arms the critical exported-contract rule and `@tag security` arms the security
surface rule on the annotated symbol; these defaults are marker-driven, never inferred from names.

---

## Semantic layer (Plane B, optional)

Beside the derived repository graph, `semctx` can carry **authored** intent designed to remain
explicit while an agent transforms a system: goals, business invariants, decisions, assumptions,
unknowns and **proof-carrying change contracts**, each explicitly linked to code. It answers a
different question from `verify diff`:

```
verify diff       →  "given this change, what did it put at risk, and is it proven?"   (derived facts)
semantic layer    →  "which intention, invariants, decisions, evidence and unknowns must remain
                      while I change this system?"                                       (authored truth)
```

It is a **separate plane** (ADR 0009), never conflated with the graph, and it is **not** code search
(the slice seeds only from explicit scopes; ADR 0005 stands). Authored declarations live in
Git-versioned `.semctx/semantic/**.sem` (a small, deterministic, ASCII DSL — the `◇ □ ⊳ Δ ⊢ ?` glyphs
are a view, never required to parse). It works with no LLM. Claude Code additionally offers a
guarded commit/push hook and a resolved bundled-CLI path; Codex uses the same control contracts but
requires a global `semctx` for shell fallbacks.

```bash
semctx semantic init                                   # scaffold inert, commented .semctx/semantic/ guidance
semctx semantic check                                  # model + links + lifecycle/baseline reason codes
semctx change open change.<slug> --preserves <inv-ids> --requires <ev-ids> --unknown <unk-ids>
semctx semantic slice --change change.<slug> --format agent   # bounded rehydration capsule
semctx change verify change.<slug> --base origin/main  # composes verify diff -> VERIFIED/PARTIAL/BLOCKED/STALE
```

`change verify` **composes** `verify diff` (never bypasses it) and is **never more optimistic than
the data** — it will not turn PARTIAL into VERIFIED on its own; obtaining a proof (running the test,
recording the evidence status) is your step. Full walkthrough:
[`docs/examples/semantic-layer-reservation-example.md`](docs/examples/semantic-layer-reservation-example.md);
design: [`docs/architecture/semantic-layer-v1.md`](docs/architecture/semantic-layer-v1.md) and
[ADR 0009](docs/adr/0009-semantic-layer-is-separate-from-the-repository-graph.md).

## Reconstruction control plane (Plane C, read-only)

Plane C projects the observed graph and authored intent into explicit L0-L6 coordinates. It can trace
up/down the model, compare an explicit target architecture, compile a versioned semantic planning
bundle before edits, and reconcile the actual working diff afterward. The general planner supports
`local_patch`, `refactor`, `feature`, `redesign` and `migration`; the typed shadow-first migration
plan remains one specialization. Plane C is deliberately fail-closed: task text alone binds no
file or symbol, LLM-only evidence authorizes nothing, and legacy deletion stays denied without
fresh static, runtime, test and human proof.

Indexing also emits a versioned local freshness seal. `semctx status` evaluates that attestation as
`FRESH`, `DIRTY_KNOWN`, `STALE`, or `UNSEALED`; trace and plan carry the same status and fail closed
before consuming stale or unsealed inputs. The seal binds repository root, current/indexed Git state,
direct analyzer inputs, Plane A, Plane B, and schema/tool versions.

```bash
semctx status --json
semctx control trace repo:<graph-id> --direction lift --to 5 --json
semctx control plan change.<slug> --target target-architecture.json --json
semctx control plan-change change.<slug> --task-id <task-id> --input planner.json --json
semctx control reconcile-diff reconciliation-input.json --json
```

`plan-change` produces a `PlanningBundleV1` containing a sealed `TaskEnvelopeV1` and
`SemanticChangeSetV1`. Only explicit discovery or authored links can become load-bearing scope;
an addition/rename `newPath` is exact planned intent, not a fabricated pre-edit fact.
`reconcile-diff` observes the current worktree and returns `REFUSED`, `VIOLATED`, `UNPROVEN` or
`REALIZED` after checking stale/TOCTOU state, scope, required edits, invariants, lifted impact,
accepted targets, evidence and exact round trips. All planning objects carry
`executionAuthority: "none"`. The v1 surface has no executor, cutover, deletion or patch
application. See
[`docs/architecture/control-plane-v1.md`](docs/architecture/control-plane-v1.md).

## MCP server (agents)

Current `main` registers **37 schema-declared tools with validated structured outputs**. Individual
machine reports remain versioned where their public contract defines a schema version. The
[authoritative catalogue](packages/mcp-server/src/tool-contract.ts) groups them into these
surfaces:

| surface | representative tools | purpose |
| --- | --- | --- |
| Bootstrap | `semctx_setup` | plugin-native workspace init (config + scaffold + index + check); confirm-gated; no global CLI required |
| Plane A | `semctx_index_health`, `semctx_inspect`, `semctx_verify_change` | separate index binding/freshness/coverage, query observed facts, and verify a diff |
| Plane B | `semctx_semantic_check`, `semctx_semantic_slice`, `semctx_change_open`, `semctx_change_update`, `semctx_change_verify`, `semctx_change_close`, `semctx_handoff`, `semctx_resume` | preserve authored intent, proof-carrying change contracts, and resumable state |
| Plane C | status, authority, trace, graph, traversal, coverage, impact, explanation, architecture comparison, target proposal, scope binding, planning, reconciliation, and manual Control Handoff v2 tools | produce bounded, fail-closed reports and resumable local capsules with `executionAuthority: "none"` |
| Lifecycle | `semctx_control_agent_lifecycle` | record explicit shadow checkpoint presence without telemetry, enforcement, or authority; the shipped hook automates `before_completion` only |
| Compatibility | `semctx_cli_compatibility` | compare the MCP/plugin runtime with the global CLI offline; advisory only, with no executable path exposed |
| Explorer | `semctx_control_explorer` | return a bounded read-only snapshot for model clients and the Control Explorer MCP App |

`semctx_prepare_task` remains experimental and is not a code-search replacement. Plane C
authorization tools report whether a transition, step, or deletion is admissible; they do not
execute it.

The server uses the stable MCP 2026-07-28 stdio surface with legacy-serve compatibility. Successful
calls return the same canonical object as structured content and deterministic JSON text. The
Control Explorer resource is `ui://semctx/control-explorer-v1.html`; it has no network or write
permission and always displays `executionAuthority: "none"`.

CLI and MCP are thin transports over the same application services, schemas, reason precedence,
and canonical serialization. The easiest path is the Codex or Claude Code plugin above; to
register the server directly over stdio:

```json
{
  "mcpServers": {
    "semctx": {
      "command": "bun",
      "args": ["/abs/path/to/semctx/packages/mcp-server/src/index.ts"]
    }
  }
}
```

No `SEMCTX_ROOT` is set here: the server starts unbound and pins on the first absolute
`repositoryRoot` it receives, the same start path Codex uses. Set it only to hard-bind the process
to one checkout, and only to an absolute path — a relative value such as `.` is rejected at
construction and the handshake fails.

Full guide: [`docs/integrations/claude-code.md`](docs/integrations/claude-code.md).

---

## Architecture

```
repository  → deterministic graph   (TS Compiler API + bounded Python + Markdown/SQL structure)
git diff    → impact analysis        (touched symbols, contracts, invariants, tests)
            → gates + verdict         (strict/advisory rules → PASS / WARN / BLOCK)
```

Monorepo (Bun workspaces, TypeScript strict):

| Package | Responsibility |
| --- | --- |
| `@semantic-context/core` | domain model, deterministic ids, errors, Zod boundary schemas |
| `@semantic-context/ts-analyzer` | TS Compiler API → graph; docs, tests, migrations, `@markers` |
| `@semantic-context/plane-a-internal` | private provisional multi-language fact assembly, binding, capability and admissibility gates |
| `@semantic-context/python-analyzer` | private Python-through-3.12 syntax extractor for the first second-language vertical |
| `@semantic-context/workspace-analyzer-internal` | manifest-evidenced workspace projection and containment relations |
| `@semantic-context/repository-store` | `bun:sqlite` persistence behind a `RepositoryStore` interface |
| `@semantic-context/context-engine` | graph index, claims, **impact analysis + verify**, gates |
| `@semantic-context/semantic-model` | authored semantic truth (Plane B): nodes, change contracts, target bindings, ids |
| `@semantic-context/semantic-dsl` | tolerant `.sem` parser + deterministic formatter + renderers |
| `@semantic-context/semantic-engine` | links, stale, slice, change contracts, immutable target artifacts, composed verify, handoff |
| `@semantic-context/control-model` | Plane C coordinates, planning/reconciliation schemas, architecture deltas, proofs and authorization reports |
| `@semantic-context/control-engine` | deterministic traversal, general refinement planning, actual-diff reconciliation and fail-closed policy |
| `@semantic-context/app-services` | shared indexing, index-health, CLI compatibility, verification, lifecycle and control use cases used by CLI and MCP |
| `@semantic-context/mcp-server` | MCP server: Plane A verification, Plane B semantic tools and Plane C read-only control |
| `@semantic-context/github-action` | composite GitHub Action + Node annotation/summary adapter |
| `apps/cli` | the `semctx` CLI (zero-framework arg router) |
| `plugins/claude-code` | Claude Code plugin: shared control skill + focused skills + guarded hook + bundled CLI |
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

Implemented and tested (full suite via `bun run test`):

- deterministic Plane A graph: TypeScript semantic facts, bounded Python-through-3.12 facts,
  Markdown documents, SQL migrations, explicit selection ledgers, manifest-evidenced workspaces,
  and a separate `index-health` report;
- `verify diff` — impact analysis + strict/advisory PASS/WARN/BLOCK, with provenance;
  `--base/--head` merge-base ranges, `text/json/github` formats (versioned JSON contract),
  `--fail-on`, `--output`, `--record`, and fail-closed config-v2 analysis-health preflight;
- MCP 2026-07-28 stdio server (37 schema-declared tools with validated structured results and a
  bounded Control Explorer App)
  + aligned Codex/Claude Code plugins (shared control workflow; Claude advisory + guarded profiles);
- composite GitHub Action (annotations, summary, PASS/WARN/BLOCK gate);
- `init --preset github-claude` bootstrap; contributor dev container;
- committed comparative benchmark (`benchmarks/change-impact-eval`);
- **semantic layer (Plane B)**: authored model + `.sem` DSL (parser/formatter/renderer), semantic
  slice, proof-carrying change contracts, composed `change verify` (VERIFIED/PARTIAL/BLOCKED/STALE),
  handoff/resume, CLI (`semantic`/`change`), MCP tools + skill (ADR 0009).
- **control plane (Plane C)**: sealed TaskEnvelope/ChangeSet planning, immutable reviewed target
  identities, five refinement profiles and actual-worktree reconciliation with canonical
  CLI/MCP parity, plus manual content-addressed Control Handoff v2 capture/resume; no execution
  authority.
- **agent lifecycle foundation**: one shared stage-presence policy/report for four explicit
  checkpoints; shadow-only, non-blocking, non-authorizing and source-non-collecting. The tool
  itself stays stateless; the shipped shadow hook automates `before_completion` only, and its
  session-local ledger holds canonical stage ids and nothing else.

### Known limitations

- The call graph is best-effort static analysis (unresolved dynamic calls are omitted).
- TypeScript `tested_by` links come from resolved imports in test files. They select test
  candidates; they are not runtime or measured code coverage.
- Config v2/polyglot selection is opt-in and never silently replaces a legacy v1 config.
- Python analysis is a bounded syntax vertical, not TypeScript-equivalent semantic coverage: it
  does not infer calls, unmarked contracts, test coverage, or negative completeness.
- `FRESH` describes captured source/index identity, not complete analysis. Keep freshness,
  index-health coverage, producer capability, and task-relative authority separate.
- Semantic markers are single-line; multi-line marker statements are not yet parsed.
- Concurrency/runtime properties are surfaced as **unknowns**, not statically proven — by design.
- `context prepare` (task → pack) is experimental and **not** a code-search replacement (ADR 0005).
- The semantic layer is **authored**, not inferred: `semctx` never invents goals/invariants; a
  proof is obtained only when you run the test and record the evidence status (static, not dynamic).
- `.sem` statements are single-line (like `@markers`); the semantic slice does not do content
  retrieval (explicit scopes only); no SQLite index for Plane B in v1 (Git is the source of truth).
- Authored symbol links currently use exact node ids that include source lines. Harmless line shifts
  can produce `STALE_REPOSITORY_LINK`; stable anchors and an explicit relink workflow remain open
  in [#37](https://github.com/hoklims/semctx/issues/37).
- `before_implementation_write`, `after_repository_edits`, `before_compaction` and Control
  Handoff v2 require explicit agent calls: they have no automatic host hook and no proof that a
  host lifecycle event invoked them. Only `before_completion` is automated, by a hook that
  observes tool calls and never blocks. Persisted or measured telemetry and enforcement remain
  unshipped for every checkpoint, so a shadow advisory is not a measurement.

See [`ROADMAP.md`](ROADMAP.md) for the shipping vs research split.

## License

Apache-2.0, including its explicit patent grant — see [LICENSE](./LICENSE).
