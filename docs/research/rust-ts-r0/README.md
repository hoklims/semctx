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
The corpus dependency closures, case expectations and native candidate executions
remain unqualified. Source archives alone do not supply those proofs.

[arbitrations.json](arbitrations.json) records the owner's decision to correct
ambiguous star-export call resolution in Rust. The historical baseline commit
remains pinned; its order-dependent call edge is not the expected Rust result.
No separate TypeScript correction is requested and no native correction is yet
demonstrated.

## Independence and effort

Development uses the baseline fixtures and newly authored microcases.
Qualification snapshots are separate from the reserved repositories. The reserved
case author is a distinct agent that must not implement the producer. Its public
acquisition manifest is identified in the experiment; case contents and expectations
remain outside the producer checkout until the selected candidate is frozen.
Failure exposes a reserved set; correction requires a new independently prepared
set within the remaining approved envelope.

Record active work intervals by agent and activity. Parallel work contributes to
cumulative effort; it does not enlarge the approved envelope. Candidate first runs
and correction passes require their own scopes and remaining-budget entries before
execution. No native composition or correction pass has started at this checkpoint.

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
branch's base. Its exact tooling source is available separately without restacking
the chain. Reuse its native supervision and Cargo test discovery rather than
copying a process controller. Its existing CLI/MCP scenario qualification does not
qualify fact batches or semantic precision. In particular, its `no_product` report
is not evidence that a producer ran.

New dependencies require exact versions and committed lockfiles; new GitHub
Actions references require full commit SHAs. No dependencies, workflow changes or
runtime code are introduced by this preregistration.
