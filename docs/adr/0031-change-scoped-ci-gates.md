# ADR 0031 — Select verification by the changed guarantee

- Status: accepted by the maintainer for the September 2026 gate reduction.
- Supersedes the fixed PR matrix and mandatory local full-gate clauses of ADR 0013 and ADR 0022.
- Keeps the release-source verification and publication authority of ADR 0013.

## Context

PR #200 at `2267cbe8` completed its required CI in about 1 hour 55 minutes. Its final
Windows job spent about 32 minutes in `verify:pr`, then about 83 minutes in the repeated
24-by-100 worker benchmark. Ubuntu and macOS repeated the same full gate and benchmark.
The benchmark is observational: ADR 0026 applies no performance threshold and does not claim
that its measurements are comparable across hosts. Repeating it for every unrelated PR adds
latency without deciding an affected guarantee.

## Decision

`semctx-required` remains the single stable required result. An immutable, full-depth base-to-head
diff selects a matrix before verification. The matrix always contains an Ubuntu contract lane:
diff hygiene, compatibility and documentation checks, static quality, and CI-routing regressions.

- Markdown-only changes use the contract lane. Changes confined to the CI selector/runner also
  run its routing tests on Windows and macOS, without replaying the product suite.
- Product changes run the canonical complete `verify:pr` gate on Ubuntu. Windows and macOS run
  the test suites of each changed package, app or plugin. Generated plugin parity is checked
  again on these hosts when plugins change.
- Worker/indexing changes additionally run a real, small three-OS equivalence smoke using the
  existing benchmark protocol with dimensions 4 by 2. The full repeated 24-by-100 benchmark
  stays available on demand for performance claims and investigations; it is no longer a
  universal PR prerequisite.
- Unknown paths, new packages, missing test roots, invalid paths, empty or unavailable diffs,
  toolchain changes and release-workflow changes select the full three-OS gate plus the small
  equivalence smoke. A failed planner or matrix cannot produce a successful required result.

The matrix is built only from static lane names and test roots. A focused lane refuses an unknown
or absent target. `semctx-required` requires both the planner and every selected gate job to
finish with `success`; `skipped`, `cancelled`, and failed results are refusals. The selected profile
and each step's elapsed time appear in CI logs so routing and cost can be checked against a
particular SHA.

The local `verify:pr` command remains the complete oracle and the release workflow still runs it
on the tagged source before packaging. Contributors may use targeted local checks and the
required adaptive CI for ordinary PRs. A release, unknown impact, uncovered obligation or failed
targeted check calls for the full gate. Changed proof mechanisms also require a fresh independent
aggregate audit and relevant negative witnesses; the candidate's new selector cannot approve
itself.

## Validation and limits

Routing tests cover documentation, selector-only changes, product packages, workers, renames,
unknown paths, absent bases and missing test roots. Governance tests reject a missing planner
dependency, a skipped-gate acceptance and a disabled always-run aggregate. The release gate is
independent and unchanged. These tests establish routing behavior, not unexecuted runtime or
release efficacy. Measure the first candidate CI against PR #200 before claiming a speedup.

## Amendment — suite sharding and documentation figures (2026-10-11)

On 2026-10-11 the Windows full lane spent 1 812 s of its 34 minutes in one serial `bun test` run
(Ubuntu 652 s, macOS 617 s), and PR #321, which adds about fifty test files, exceeded the
60-minute job limit on Windows. Its pushes were cancelled before any run finished. PR #323, which
only touched the READMEs, their SVG figures and the landing page, still selected the full
three-OS gate because `README.fr.md` and `docs/assets/` were unclassified.

- `README.fr.md`, and SVG files under `docs/assets/`, are documentation. Other non-Markdown files
  under `docs/` (for example the pilot JSON data) remain unclassified and select the full gate.
- Every lane that runs the product suite (full lanes and affected focused lanes) is split by test
  file across a fixed number of runners per OS: Ubuntu 2, Windows 4, macOS 2. Each shard runs the
  lane's other commands unchanged and `bun test --shard=i/N` over its slice. Bun sorts the
  discovered files and assigns each to exactly one shard, so the shard set of one OS covers the
  same files as the unsharded command. `semctx-required` still requires every selected job.
- Files stay serial inside a runner. In-runner parallelism (`bun test --parallel`) was rejected:
  on Windows several guard tests already take 13–15 s of a 30 s budget and an MCP test 36 s of
  60 s, and a local four-worker run timed out four tests. Sharding keeps each test's host and
  timing margin as before.
- Routing-only focused lanes and the contract lane are not sharded.

The local `verify:pr` and the release gate still run every test file in one process. A
`--test-shard i/N` option narrows only their test step and is used only by CI lanes. Routing tests
pin complete shard sets for every planned suite lane, and the gate refuses a malformed shard or a
count other than its host's. The speedup is measured on the first candidate CI run, not assumed.
