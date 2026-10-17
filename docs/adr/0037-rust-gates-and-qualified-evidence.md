# ADR 0037 — Rust gates and explicit qualification evidence

- Status: accepted by the maintainer's implementation request on 2026-10-15.
- Related: ADR 0008, ADR 0010, ADR 0027, ADR 0031 and the Rust migration program [#365](https://github.com/hoklims/semctx/issues/365).
- Supersedes the TypeScript CI execution entry points in ADR 0031; retains its single required result, native OS coverage and conservative fallback.

## Problem

Successful component tests and installation smokes do not establish useful behavior in every
environment. The previous planner selected changed folders without their transitive consumers.
The background gate ran four regressions while its package contained a substantially larger
suite. Some of those tests inspect a particular maintainer's private host installation and cannot
be represented as portable product evidence. The planned native product must not inherit these
ambiguities or depend on its own analyzer to decide its verification obligations.

## Decision

Build the gate engine and product qualification harness in Rust now, independently of the
product migration. The existing Bun product remains an explicit transitional test subject.
`tools/gates` owns planning, bounded process execution, receipts and final admission;
`tools/qualification` owns independent CLI/MCP scenario expectations and evidence validation.
No gate requires a Semctx index to bootstrap itself.

The native lane also discovers tracked product Cargo manifests rather than maintaining a list
of product crates. Cargo supplies actual workspace ownership; each workspace and tracked lock
must remain inside the repository. Each product member executes once with
`cargo test --package MEMBER --locked` using that workspace owner, so another member's
tests cannot qualify an untested crate.
Adding a crate therefore adds an obligation automatically. A missing lock, failed test, or
compilation without a positive test summary refuses qualification. No native product yet is
reported explicitly, not as proof that the future Rust product works.

The Rust planner binds the exact base commit, candidate commit, tree and compiled gate policy.
It discovers workspace dependencies and follows reverse transitive consumers, including CLI,
MCP, Action and plugin integration boundaries. Unknown paths, missing targets and empty diffs
select the complete three-OS fallback. A missing immutable Git subject refuses planning.

The contract lane runs shared static quality once. Full product test files remain partitioned
across Ubuntu, Windows and macOS; runtime integration checks and the worker equivalence smoke
run once per OS rather than once per shard. Invalid coordinates and unclassified scope do not
silently remove tests. The retained TypeScript evaluators are differential references, not CI
policy owners. Existing `verify-pr.ts` callers use a thin adapter to the Rust verifier.

Each selected lane produces a versioned receipt containing its subject, plan, commands,
outcomes, complete bounded outputs and digests. The aggregator recomputes the plan and demands
exactly every planned lane and step. Missing, duplicated, foreign, altered, skipped or failed
evidence cannot satisfy `semctx-required`. Digests establish content integrity, not signatures.

The separate Rust matrix executes both Rust suites on all three OSes and qualifies real CLI/MCP
artifacts outside the source checkout. Qualification covers named positive, partial, refused,
stale and recovery scenarios. Its verifier checks all expected OS reports, case inventories,
artifact identities and raw observations. Host activation remains `not_observed`; a correct
controlled refusal does not become a successful product operation.

Background discovery is exhaustive against an explicit test inventory. Every portable case is
executed; unexpected discovery changes, failures, expected failures and selected runtime skips
refuse the gate. Tests requiring unshipped host files or installed optional providers remain
named external obligations, explicitly unqualified. Platform-specific exclusions identify their
required native OS. The original four recovery regressions remain mandatory everywhere.

Process supervision owns a dedicated process group on Unix and a Job Object on Windows. A
child helper waits for assignment before launching the real command. Timeouts, cancellation,
output limits, invalid output and nonzero/native crash codes are distinct from success; outputs
are drained and descendants terminated before reader teardown. These controls are not a sandbox
against an adversarial process escaping the declared process boundary.

## Compatibility, bootstrap and authority

Keep the existing npm, public CLI/MCP, schemas and plugin contracts unchanged. Keep the stable
`semctx-required` name and require both selected product lanes and native Rust qualification.
The canonical local and release command now enters Rust. Rust 1.95.0 is an explicit developer
toolchain, not a new requirement for consumers of the published Bun package.

This PR bootstraps the Rust verifier under the existing required CI, independent aggregate
review and negative witnesses. It does not change rulesets or install a new status authority.
The GitHub workflow and verifier are still editable repository content: a same-name check alone
does not establish an immutable external evaluator. No stronger isolation or signature claim is
introduced. A future protected verifier must be independently provisioned and validated.

No positive result cache or automatic receipt reuse is enabled. Old receipts retain their
original subjects and cannot satisfy a new candidate merely by changing metadata. A future
cache or schema transition needs its own accepted contract and invalidation witnesses.

## Migration and rollback

The engine can qualify a legacy artifact before the native product exists. Replace each legacy
executor only after its scenarios and obligations are covered by native evidence; retain external
integration boundaries where their runtime belongs to an official host or another component.
The product's G01–G28 obligations and T00–T11 milestones remain owned by #365.

If the new gate finds a real defect, repair it or withhold the dependent qualification. Do not
relax the oracle, fabricate host observations or relabel an error as a refusal. Rollback restores
the prior checked execution contract through the normal reviewed change; no automatic bypass.

## Validation

Required evidence includes real subprocess failures/timeouts/pipe holders, transitive consumer
selection, complete shard admission, altered/foreign/missing receipts, exact refusal reasons,
MCP persistence and recovery, and workflow mutations dropping an actual producer or verifier.
Run native Rust tests, format and Clippy, affected existing checks, the declared portable
background inventory, and the complete required CI on the actual candidate.

The historical 30-minute CI observation is a cost baseline, not a Rust speedup. Measure cold
build, warm execution, compilation, fixture setup, runtime, teardown and runner consumption
separately. No performance improvement or universal environment qualification is assumed.

See the [Rust gates operator guide](../contributing/rust-gates.md) for commands and limits.
