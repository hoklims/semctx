# ADR 0026 — Measure repeated equivalent indexes before optimization

- Status: accepted
- Date: 2026-09-13
- Authority: maintainer-authorized v0.3 implementation; bounded lead decision for HOK-461.

## Context

The existing observational multicore benchmark uses a fresh Bun process for each worker count,
but only one ordered pass and a post-run RSS sample. Graph and seal equality do not independently
demonstrate claim, diagnostic or persisted-index equivalence. These observations cannot yet
establish the HOK-460 memory and multicore targets on real Apple Silicon repositories.

## Decision

Extend the existing benchmark into a reproducible baseline harness, before changing indexing.
Keep `bun run bench:index-workers <packages> <files>` valid for current CI callers. Emit a
version 2 observational JSON report. Default to three repetitions per worker count, with a
deterministic alternating order: 1/2/4, 4/1/2, 2/4/1. Every sample runs in a fresh subprocess,
with fixed capturedAt and unchanged source/config state. Do not warm up or share a process.

Exercise disconnected modules, global-script fallback and module/global-augmentation fallback
as separately identified deterministic corpora. The supplied dimensions control the safe
synthetic corpus; bounded hostile fixtures establish fallback equivalence without duplicating
large resource cost. Record requested/used workers, mode and fallback reason. Report the source
fixture commit/content identity, implementation HEAD and dirty-state identity, Bun version,
OS/platform/architecture, total RAM, config identity, corpus dimensions and capturedAt.

Measure each fresh process using the runtime's native subprocess resource usage when supported.
TypeScript Worker instances are threads in that process. Record native lifetime maxRSS in bytes
and CPU data with their named API, units and availability. A missing, zero, non-finite or invalid
peak is NOT_MEASURED with a reason, never a zero-memory success. Keep post-run RSS separately.
Cross-OS comparability is UNKNOWN; compare performance only on the same host/runtime protocol.
No external process-tree collector is necessary for worker threads. Do not infer a peak from
the final sample or infer Apple Silicon behavior from Windows.

Each sample computes canonical fingerprints of complete returned analysis, claims and the
logical persisted graph/claims/index metadata/sidecars, as well as the freshness seal. Compare
these across all worker counts and repetitions per corpus. Exclude only identified operational
telemetry (timing, worker mode, PID), never facts, diagnostics, unresolved references or evidence.
Do not compare physical SQLite/WAL bytes. A missing component or divergent component is a failed
benchmark, with the corpus, sample and first differing component identified. Keep measurement
noise out of the equivalence decision.

Emit raw samples plus per-worker medians, range and dispersion for duration and available peak
RSS. Unsupported metrics retain their missingness in summaries. Success means equivalent
outputs, not faster output. CI has no absolute duration/RSS thresholds and no automatic tuning.
The output explicitly says real-repository and Apple Silicon baselines remain NOT_MEASURED.

## Ownership, compatibility and failure

Machine ownership remains scripts/benchmark-multicore-index.ts and narrowly scoped reusable
benchmark helpers/tests. Product analyzers, index schemas, runtime policy and CI wiring do not
change in this slice. Benchmark report version 1 consumers must select the new version 2 fields;
the current CI consumes only the exit status. Invalid dimensions fail before fixture mutation.
Fresh temporary fixture directories are removed by their owner even on failure. Results never
write into a consumer repository. Real lobby measurements will use separately authorized
isolated source copies and the same sample protocol, not synthetic claims of representativeness.

## Evidence and rollback

Require schema/input/summary tests, known equivalence and independent corruption of a claim,
diagnostic and persisted component, plus missing-peak behavior. Demonstrate a real child-process
run with small dimensions and the full repeated protocol. Capture raw JSON outside the checkout.
Canonical verify:pr and independent proof review remain required before acceptance. Reverting
the harness is a code-only rollback; no product or persisted data migration is required.

## Pre-action decision record

LATENT_COMPASS_ROUTING_NOTE_V1

- decision_id: semctx-hok461-metrics-20260913
- objective: obtain repeatable memory/time observations bound to equivalent indexing results.
- authority: maintainer-authorized scope; Codex lead owns metric meaning and acceptance.
- candidates: A retain after-run RSS; B use native subprocess maxRSS; C add an OS tree sampler.
- pre_action_evidence: A is implemented and cheap but cannot establish lifetime peak. B has
  runtime type support and covers Worker threads in one process; Windows comparability and
  observed availability are UNKNOWN until tested. C would add OS-specific implementation and
  sampling loss without a demonstrated subprocess tree. All are reversible local changes;
  cost of full corpus runs and performance outcomes are UNKNOWN. B can reveal metric support;
  A cannot resolve the peak question; C needs separate collector validation.
- result: RECORD
- claim_boundary: no measurement, performance improvement or platform equivalence is certified.
- handoff: Codex metric decision follows this record.

Codex selects B with explicit missingness and same-host comparisons. A remains a separate
diagnostic sample; C is deferred unless runtime evidence demonstrates a measurement gap.

## Amendment 2026-09-22: the recorded path is asserted (HOK-823)

Recording requested/used workers, mode and fallback reason left one false success: had the parallel
path been disabled, every disconnected-modules sample would have run on one worker and compared
single-worker results with themselves, so equivalence would have held trivially. Each sample must
now report the path its corpus requires, or the benchmark fails before equivalence and names the
corpus, the sample and the expected and observed path: one requested worker runs `single`;
disconnected modules at two or four workers run `parallel` with exactly the requested workers; the
hostile corpora at two or four workers run `preflight-fallback` on one worker with their named
fallback reason. The observed CI runs of 2026-09-22 on Ubuntu and macOS already matched this
policy. A deliberate change to the parallelism policy (HOK-464) updates this assertion with it.

CI also archives each operating system's complete JSON report as a workflow artifact, so a run's
samples no longer live only in its log. Thresholds are unchanged: success still means equivalent
outputs on the expected paths, never faster output.
