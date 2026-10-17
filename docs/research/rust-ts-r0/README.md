# T00 / R0 research record

This directory records the bounded TS/JS feasibility experiment for
[#365](https://github.com/hoklims/semctx/issues/365), section 2. That issue owns
acceptance. This record neither changes the accepted language profiles nor
declares `READY_TS_NATIVE`.

## Preregistration

[experiment.json](experiment.json) records the baseline, approved envelope,
public snapshot acquisitions and the tooling reference before candidate selection.
The baseline remains its exact commit, not this branch's newer analyzer. Changes
between those sources must be inventoried separately rather than silently changing
expected results.

The owner authorized execution, commits and incremental normal pushes on
`rust/365-t00`, and PR-description updates. No merge, release, deployment or push
to another owner's branch is authorized. One owner-requested bug comment is linked in the arbitration; no other GitHub
comments are authorized.

Each completed stage is a separate checkpoint:

1. Record prerequisites, identities and the research envelope.
2. Close the ordinary and qualified Compiler API obligations inventory.
3. Freeze development, qualification and independently prepared reserved cases.
4. Implement and exercise the bounded native compositions.
5. Freeze the selected optimized candidate and its process/input inventory.
6. Exercise qualification, reserved cases and common native portability vectors.
7. Preserve arbitrations and issue the reproducible R0 decision.

The source inventory in [inventory](inventory/README.md) records 240 usage and
consumer groups, their exact baseline sites, input/rule references and unknown
native states. Its source census is separate from behavioral case coverage.
The case bundle in [cases](cases/README.md) separates authored expectations from
execution evidence. Its bounded public-source projections do not claim complete
upstream project qualification. Actual native input consumption and capture
coherence still require execution evidence.

[arbitrations.json](arbitrations.json) records the owner's decision to correct
ambiguous star-export call resolution in Rust. The historical baseline commit
remains pinned; its order-dependent call edge is not the expected Rust result.
No separate TypeScript correction is requested. Native DEV controls now exercise
the ambiguity correction; frozen qualification was unexecuted at the stage-5 selection checkpoint.

## Independence and effort

Development starts with ten separately authored bootstrap cases, containing
seventeen variants. The 268 qualification records and their supporting vectors
are excluded from initial implementation inputs. Historical baseline assertion
references establish source context; they are neither additional executable cases
nor the sole authority for expected results. Qualification diagnosis and correction
retain the frozen expectations and count within the approved passes.

Qualification snapshots are separate from the reserved repositories. The reserved
case author is a distinct agent that must not implement the producer. Its public
acquisition manifest is identified in the experiment; case contents and expectations
remain outside the producer checkout until the selected candidate is frozen.
The public custody receipt commits to 23 cases and 26 variants, including two
public repository snapshots and one monorepo. Its exclusions remain explicit;
these counts establish no native proof.
Failure exposes a reserved set; correction requires a new independently prepared
set within the remaining approved envelope.

Record active work intervals by agent and activity. Parallel work contributes to
cumulative effort; it does not enlarge the approved envelope. Candidate first runs
and correction passes require their own scopes and remaining-budget entries before
execution. [Composition C1](composition1/record-index.json) now records the first
native composition and its first correction pass. The private prototype lives in
[`tools/rust-ts-r0`](../../../tools/rust-ts-r0/README.md). Its DEV results are
separate from the 268 frozen qualification records and the reserved corpus.

[The selected optimized checkpoint](selection/README.md) freezes C1 after its
first correction pass. The six native development vectors pass on macOS ARM64;
they establish no qualification or reserved-case result. The checkpoint records
its artifact/source identities, actual process Outcomes, reported input reads and
the remaining native observation gaps. The native CI job now also executes the
same optimized TS/JS vectors and retains its artifacts. Windows/Linux execution
evidence remains pending.

## Verification and tooling

The immediate Git base remains `rust/365-coordination`. With Bun 1.4.3 and the
pinned quality tools on PATH, stage every intended new file before running:

```sh
env -u GIT_CONFIG_GLOBAL SEMCTX_VERIFY_BASE=rust/365-coordination bun run verify:pr
```

Keep raw check logs outside the checkout and record their hashes and environment
with each checkpoint. A local check does not qualify native Windows or Linux.
Those candidate executions use GitHub Actions. The owner excluded unrelated
unstable Windows tests from this investigation; such failures remain reported and
cannot count as successful R0 portability evidence or a green required aggregate.

[#383](https://github.com/hoklims/semctx/pull/383) is merged, but absent from this
branch's base. The initial import reused its canonical tooling and integration
files at the exact Git blobs listed in [tooling-reuse.json](tooling-reuse.json), without
restacking the chain or creating another process controller. Its existing CLI/MCP scenario qualification does not
qualify fact batches or semantic precision. In particular, its `no_product` report
is not evidence that a producer ran.

New dependencies require exact versions and committed lockfiles; new GitHub
Actions references require full commit SHAs. The initial preregistration changed
only documents. The subsequent tooling reuse introduces the existing Rust gates,
qualification tools and CI integration from #383. The subsequent C1 prototype
reuses that supervisor and native workspace discovery. Its configured Windows,
Linux and macOS executions do not count as results until their actual CI runs
succeed; local DEV checks establish no cross-platform qualification.
The C1 workflow adaptation adds the prototype's lint checks, explicit captured-SDK
environment and retained DEV observations; the canonical process controller and
workspace discovery remain unchanged.
