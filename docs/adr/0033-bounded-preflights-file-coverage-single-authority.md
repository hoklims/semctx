# ADR 0033 — Bounded preflights, per-file coverage and single-authority invariants

Status: proposed; awaiting maintainer acceptance with the pull request that implements it.

## Context

The proof-integrity policy now makes semctx the source that bounds the claims of a change: impact
and obligations, admissible only on a fresh index that covers the changed files. A `PASS` with no
analysed symbol proves nothing. On a real repository (127 changed paths across TypeScript, C#,
Rust, YAML and Markdown, observed 2026-10-09) every way of asking failed to answer:

- `semctx_index_health` and `semctx_control_status` closed the MCP connection. The host log shows
  the cause: the 0.4.1 server wrote more than 16 MB on stdout without a JSON-RPC boundary, and the
  host disconnects at that size. #316 bounded `index_health` alone; any other tool can still do it.
- The SessionStart preflight was cut after 5 s and reported "no verdict": a cold `semctx status`
  on that repository took 22 s, and a synchronous status cannot be interrupted in-process.
- `status` said `UNSEALED: SEMANTIC_LIFECYCLE_INVALID` without the finding behind it
  (`EVIDENCE_BASELINE_STALE`) or the command that seals again.
- `impact diff` listed every changed path, but nothing said which ones a producer had read: 27 of
  127 paths are in languages semctx does not analyse, and the rest were behind a broken binding.
- A trust-policy digest hard-coded in six files diverged from the owner's decision. Nothing could
  declare that this value has one source, so no impact surfaced it; an auditor found it by hand.

## Decision

1. **Transport bound.** Every MCP tool result is refused with the catalogue error
   `RESPONSE_TOO_LARGE` above 8 MiB serialized, well under the host's 16 MB line limit. The
   connection stays open; `index_health` keeps its tighter 255 KiB bound.
2. **Budgeted preflights.** `semctx_control_status` and `semctx_index_health` compute in a one-shot
   child of the same server entry, stopped at a deadline (`budgetMs`, default 15 000 ms, 1 000 to
   600 000). Past it they answer a typed timeout: for status, `verdict: "TIMEOUT"`,
   `reasons: ["STATUS_BUDGET_EXCEEDED"]`, `canRunHighRiskControl: false`, `freshnessSeal: null`,
   `budget`; for health, `status: "timeout"`, `reason: "HEALTH_BUDGET_EXCEEDED"`. A timeout
   observed nothing and authorizes nothing. `semctx status --budget-ms N` gives the CLI the same
   answer, with the budget counted from process start so an outer hook's limit holds. Without
   `--budget-ms` the CLI never answers `TIMEOUT`. The internal freshness verdict and every
   consumer of `ControlFreshnessStatusReport` are unchanged: `TIMEOUT` exists only at these
   public preflight boundaries.
3. **Explained status.** `semctx status` and `semctx_control_status` add `explanation`: one entry
   per reason, `{ reason, code, detail, remedy }`, taken from the embedded seal or from the failure
   that left the input unsealed. Remedies are documented commands; semctx never runs them. The one
   sealing path — `semctx index --record` at a checkpoint — is documented in the CLI reference.
4. **Per-file coverage.** `impact diff` adds `changes.files[].coverage` (`analyzed` or
   `not_analyzed`, the language named from the path, and a reason such as `LANGUAGE_UNSUPPORTED`,
   `OUTSIDE_SELECTION`, `INDEX_BINDING_BROKEN` or `NOT_INDEXED`) and `analysis.fileCoverage`
   counts. C# and Rust are declared not covered, file by file; no analyser is added. No file is
   ever `analyzed` through a broken binding.
5. **Single-authority invariants.** An authored `invariant` can declare
   `meta: authority.value=…`, `meta: authority.source=<path>` and optional
   `meta: authority.retired=…`. `impact diff` searches both diff sides with Git, outside `.semctx/`,
   and reports exposed declarations in `authorityInvariants` with every occurrence and a status
   (`single_source`, `duplicated`, `diverged`, `absent`). It reads Git, not the index, so it holds
   through a broken binding. It is a fact, not a verdict.

## Compatibility

All `ChangeImpact` v1 additions are optional fields and open codes (ADR 0030); the producer schema
checks their coherence with the rest of the report. `semctx status --json` gains the `explanation`
field. The MCP output schemas of `semctx_control_status` and `semctx_index_health` become two-branch
unions (`anyOf`), as `semctx_setup` and `semctx_resume` already are; a consumer that reads only
`canRunHighRiskControl` stays fail-closed. MCP clients see `TIMEOUT` without opting in: that is the
point, since the previous behaviour was a closed connection. CLI and plugin stay at the same version;
no artifact is added to the plugin runtime.

Rejected: raising the host buffer (not ours, and linear growth remains); an in-process timer (a
synchronous computation cannot be interrupted); a worker artifact (one more shipped file for the
same bound the existing entry already provides); adding `TIMEOUT` to the core freshness verdict
(every authority and refinement consumer would then have to reason about an unobserved state);
regex-based authority detection (dialect differences between Git and JavaScript, and noise).

## Evidence

- `packages/mcp-server/test/response-bound.test.ts`: an oversized result is `RESPONSE_TOO_LARGE`.
- `packages/app-services/test/bounded-process.test.ts`, `packages/mcp-server/test/bounded-preflight.test.ts`:
  deadlines hold even with a grandchild holding the pipes; finished answers equal the in-process
  reports; timeouts are schema-valid and authorize nothing.
- `apps/cli/test/control-cli.test.ts`, `apps/cli/test/index-record.test.ts`: explanations, budget
  bounds, and the documented sealing path from an explained `UNSEALED` to `FRESH`.
- `packages/app-services/test/change-impact-coverage-authority.test.ts`: per-file coverage under
  bound and broken bindings, and the two-file digest fixture for single authority.
