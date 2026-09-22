# Index worker benchmark

Observational baseline harness for ADR 0026 (`docs/adr/0026-repeated-index-baselines-before-optimization.md`).
It measures whether indexing with 1, 2 or 4 workers produces equivalent results, and how long and
how much memory each configuration used — it does not certify performance or a memory/time budget.

## Running it

```
bun run bench:index-workers [packages] [filesPerPackage]
```

Both arguments are positional and optional:

- `packages` — integer 1 through 200, default 24.
- `filesPerPackage` — integer 2 through 200, default 20.

An out-of-range or non-integer value exits nonzero before any fixture is materialized or indexed.
Both dimensions only bound the safe `disconnected-modules` corpus; the two hostile fallback
corpora (`global-script-fallback`, `module-augmentation-fallback`) always use a fixed, small
dimension regardless of the CLI arguments, since fallback is a property of one hostile file, not
of scale.

The script also accepts an internal `--worker-run <root> <workers>` form used to launch each
fresh-subprocess sample; it is not a supported public entry point.

## What it measures

The harness runs 27 samples total across the three corpora (9 per corpus):
three repetitions of worker counts 1, 2 and 4, in a deterministic alternating subprocess order
(`1,2,4` / `4,1,2` / `2,4,1`). Every sample is a fresh Bun subprocess indexing an unchanged,
already-committed fixture with a fixed `capturedAt` — no process is warmed up or reused.

Each sample independently fingerprints the returned graph, claims, unresolved-reference
diagnostics and evidence, plus the persisted graph/claims/evidence/index-health and canonical
index metadata read back through the store, and the freshness seal. Metadata includes the
Plane-A snapshot, unresolved references, observed hunks, control snapshot and scalar index
identity/count fields; physical SQLite file bytes are excluded. All samples in a corpus must match the first sample on every
fingerprint component; a missing or divergent component fails the benchmark and names the corpus,
sample index and exact differing component.

Before equivalence is checked, every sample must also report the parallelism path its corpus
requires: one requested worker runs `single`; `disconnected-modules` at two or four workers runs
`parallel` with exactly the requested workers; the two hostile corpora at two or four workers run
`preflight-fallback` on one worker with their named fallback reason. Any other path fails the
benchmark and names the corpus, sample and requested worker count, so a disabled parallel path
cannot pass by comparing single-worker results with themselves.

Duration and native peak RSS are summarized per worker count (median, min, max, range), computed
only over the samples where that metric was actually measured. Native peak RSS (`maxRSS`, bytes)
and CPU time (`user`/`system`/`total`, microseconds) come from the subprocess's own lifetime
resource usage, not from a post-run in-process sample; a missing, zero (RSS only), negative,
non-finite or otherwise unsafe value is reported as `NOT_MEASURED` with a reason, never inferred
or treated as a zero-memory success. CPU time may legitimately measure zero.

## Output

The default invocation emits a single `schemaVersion: 2` JSON document on stdout: host identity
(Bun version, platform, architecture, total RAM), implementation identity (this repository's HEAD
and full dirty-source state, so an uncommitted or untracked change is visible), each corpus's
fixture identity, samples, equivalence verdict and per-worker-count summary. Version 1 consumers
must select the new version 2 fields explicitly; current CI only checks the exit status, so no
threshold is applied to duration or memory. CI archives each operating system's report as a
workflow artifact, including when the benchmark fails.

## Known limits

- `crossOsComparability` is always reported as `UNKNOWN`: native resource-usage APIs are
  OS-specific, so only same-host, same-runtime comparisons are meaningful. Windows-vs-other-OS
  comparability is not established by this harness.
- Real-repository (non-synthetic) and Apple Silicon baselines remain `NOT_MEASURED`; this harness
  has not been run on Apple Silicon hardware (none is available to the maintainer) and does not
  claim to represent one from a Windows or synthetic-corpus run.
- The benchmark proves equivalence and reports the observed cost of that equivalence; it makes no
  performance-improvement claim and applies no automatic time or memory threshold.
