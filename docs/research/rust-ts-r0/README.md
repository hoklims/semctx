# T00 / R0 research record

This directory records the bounded TS/JS feasibility experiment for
[#365](https://github.com/hoklims/semctx/issues/365), section 2. That issue owns
acceptance. The [final decision is STOP_BUDGET](final/README.md): both compositions and
both correction passes are closed without R0. This record does not change the
accepted language profiles or declare `READY_TS_NATIVE`.

## Preregistration

[experiment.json](experiment.json) records the baseline, approved envelope,
public snapshot acquisitions and the tooling reference before candidate selection.
The baseline remains its exact commit, not this branch's newer analyzer. Changes
between those sources must be inventoried separately rather than silently changing
expected results.

The owner authorized execution, commits and incremental normal pushes on
`rust/365-t00`, and PR-description updates. No merge, release, deployment or push
to another owner's branch is authorized. One historical owner-requested bug comment is linked in the arbitration.
The resumed session strictly prohibits every new GitHub comment, including#365;
progress is published only in the PR386 description.

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
execution. [Composition C1](composition1/record-index.json) records the initial native
composition and its first correction pass. The private prototype lives in
[`tools/rust-ts-r0`](../../../tools/rust-ts-r0/README.md). Its DEV results are
separate from the 268 frozen qualification records and the reserved corpus.

[The selected optimized checkpoint](selection/README.md) freezes C1 after its
first correction pass. The six native development vectors pass on macOS ARM64;
they establish no qualification or reserved-case result. The checkpoint records
its artifact/source identities, actual process Outcomes, reported input reads and
the remaining native observation gaps. The native CI job now also executes the
same optimized TS/JS vectors and retains its artifacts. At that historical checkpoint Windows/Linux execution was pending.
[The final platform dossier](selection/platforms-49fa/README.md) now preserves
actual optimized C1 DEV evidence on native Windows/Linux/macOS.


## Current qualification checkpoint

[C1 pass2](selection/pass2/README.md) freezes the final allowed C1 correction.
Its immutable optimized macOS artifact is SHA256
eecefd52e7813ff498ffaf55c0f79a73c46de2fcc8e4a34d313507b59d527081.
The [second campaign](qualification/c1-pass2/second-replay-summary.json)
processed 354 units: 283 passed their limited projected or controlled scope,
7 were NONPASS and 64 remained gaps. Of 51 supports, 42 passed their exercised
scope, 4 were NONPASS and 5 remained gaps. None of the 240 obligations is declared
qualified. The first campaign and both raw archives remain preserved. The separate
[reproduction supplement](qualification/reproduction/README.md) contains the
original observers, recipes, source snapshots and reconstruction commands.

The [source-backed triage](qualification/c1-pass2/second-replay-triage.json)
separates recipe/context defects from a confirmed native divergence: an isolated
UTF16 high surrogate produces diagnostic 1490 instead of frozen diagnostic 1127.
The frozen expectations are unchanged. C1 has no correction pass remaining;
its successful DEV checks do not cancel qualification failures or missing proofs.
No reserved case has been executed.

[C2 preregistration](composition2/registration.json) records the distinct Ezno
native checker hypothesis. [Its initial run](composition2/initial/README.md)
panicked after six SDK reads. The first correction isolates definition-local
mappings; [its replay](composition2/pass1-replay/report.json) read all63SDK files
but returned734errors and7warnings before project loading.

[The final C2 correction](composition2/pass2-producer/README.md) preserves188source
files and33passing native DEV tests. [One final independent replay](composition2/pass2-replay/report.json)
completes in357ms with exit0,458unchanged identities and63exact SDK reads, but
returns541errors and17warnings before any project module or expression mapping.
The aliasValue and String.trim targets remain unexercised. No classified
parser/lexer error or panic recurs; that limited result does not qualify grammar
or semantics. Both C2 corrections are now closed. Baseline skipLibCheck and native
nullability differences remain explicit; no SDK errors or expected values are
suppressed to obtain a pass.

[The final R0 dossier](final/README.md) records STOP_BUDGET from the actual
composition/correction limits, with0qualified obligations and no reserved-case
execution. It does not claim that five days were spent or that Rust is impossible.
T01 and substantial ports remain closed. [The independent terminal claim audit](final/claim-audit.json)
records no current finding within its bounded evidence scope.

[The exact-head CI entry](selection/ci-dispatch/README.md) binds its base and
immutable head. [The platform evidence](selection/platforms-49fa/README.md)
contains optimized C1 common DEV vectors on native Windows/Linux/macOS. General
CI has an unrelated Windows test failure; no aggregate green is claimed. C2
remains macOS ARM64 DEV only. The [fresh delivery checks](selection/ci-dispatch/canonical-final/record.json)
pass all four verify:pr shards locally with Bun1.4.3 and GIT_CONFIG_GLOBAL removed.
Later research-only documentation is checked separately.

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

At the initial import, merged [#383](https://github.com/hoklims/semctx/pull/383)
was absent from the historical coordination base 382c084f. That checkpoint reused
the canonical tooling and integration Git blobs listed in
[tooling-reuse.json](tooling-reuse.json), without then restacking the chain or
creating another process controller. The subsequent restack inherits #383 and
the complete #399 CI policy from main through coordination 4e80d36c; the original
execution records retain their historical source and artifact identities. Its existing CLI/MCP scenario qualification does not
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
