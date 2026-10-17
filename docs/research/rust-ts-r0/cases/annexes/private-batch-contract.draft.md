# T00 private capture and batch boundary — draft

Author task: `/root`. Claim auditor: `/root/r0_batch_claim_audit`.
Status: proposal implementing the approved targets in #365 sections 2 and 4.2;
no implementation, oracle execution, compatibility or guarantee is asserted here.
The auditor's complete ledger accompanies the eventual reconciled document.

Source-inventory closure requires a stable obligation row for every baseline
Compiler API/checker/resolver use and its consumer paths: exact source coordinate,
product rule and consumers, input closure, positive and negative expectations,
Rust mechanism, independent oracle, state and proof. The independent verifier
checks the source/call-path inventory for unmatched uses and consumer paths;
closure requires none. A method-name search does not establish closure.

The baseline is Semctx 0.4.5 at
`3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b`, including TypeScript/SDK 5.9.3
and `modelo-suite-static-v1`. Branch changes, including the renamed qualified
profile and TS-only path mapping, are separately inventoried inputs rather than
changes to the expected baseline.

```text
captured bytes + explicit scope/configuration + SDK inventory
                  |
          Rust experimental producer
                  |
private result: facts, reasons, outcomes, consumed-input observations
                  |
    independent case comparison and consumer evidence
```

The terminal producer cannot require Bun, Node, JavaScript or Go to perform its
analysis. The pinned TypeScript oracle and the independent verifier may run in a
separate experiment process. Their outputs never become producer inputs or the
sole authority for expected results. An upstream crate's Go-derived type names
do not establish a Go process dependency; the actual runtime must be observed.

## Input and capture

Use one private invocation per explicit request and snapshot. Its inputs identify
the logical repository root, selected and discovered inventories, profile and
configuration version, compiler option inputs, source/configuration/manifests,
declarations and SDK files. Keep repository identity, snapshot identity, request
identity and producer artifact identity distinct.

The experimental captured filesystem supplies bytes, existence, directory
membership, realpath/link disposition and case semantics needed by the resolver.
No source/configuration/SDK fallback to unidentified live files is admissible.
Record attempted reads as well as actual consumption: an absent file or directory
probe can influence resolution. Supplied-but-unused files are distinct from
consumed files. SDK default-library provenance is distinct from repository `.d.ts`
eligibility. Captured bytes do not by themselves prove a coherent acquisition;
each experiment must state the acquisition boundary and its mutation witnesses.

The implementation must name any ambient inputs retained by the chosen library,
including cwd and native case sensitivity. Observe these on each exercised host;
an injected file reader alone does not prove that ambient state is absent.
Do not replace compiler defaults, module modes or the SDK version silently.

Own UTF-8/UTF-16 conversion at one boundary and carry explicit units internally.
Preserve the baseline's profile-specific decoded-text behavior; ordinary system
reads and retained strings are not assumed to strip the BOM identically.
Use independently authored BOM/shebang/CRLF/astral and scoped-homonym vectors.
The full identity/schema migration remains T02.

## Result and acceptance boundary

A versioned private result binds request/snapshot, producer/artifact, effective
options and capabilities, inventory/scope, consumed dependencies and observations,
facts/relations with provenance/ranges, diagnostics, per-subject analysis outcomes
and explicit completeness. The existing `FactBatchV1` vocabulary is a reference,
not a frozen Rust public ABI. This experiment does not require SQLite, services,
the public CLI or MCP.

Selection exclusion and analysis outcomes remain separate. Preserve `disabled`,
`unsupported`, `failed` and `analyzed`; a syntax-recovered tree is not successful
analysis. A complete result with zero facts is distinct from an omitted result.
Unexplained extra facts, widened admission and `UNKNOWN` replacing a supported
baseline behavior all prevent R0 passage.

The receiving experiment checks expected subjects and cardinality from its own
frozen case inventory, identities, conflicting duplicates, endpoints, ranges,
terminal outcome and truncation. It does not discover its expected denominator
from the producer's report. Cancellation invalidates admissibility; timeout,
malformed/empty output, unexpected process failure and foreign or late results
cannot be accepted as completed evidence. A controlled product refusal can
satisfy its refusal obligation when its structured reason, complete output and
declared exit code all match the frozen expectation, including a contractually
nonzero exit. A crash or unexpected exit never does. Reuse #383's supervision
primitives from merge commit
`d4e73e74709a369ff908041ea370b39a76d9cd3a` for process bounds rather than write
a second controller. The acquired tooling archive has SHA-256
`12b379c97b69374d755ed53f3481db6555d488267f3453c5ce5ef6f913438805`.

Qualified admission is a consumer decision over the distinct trust dimensions,
not a producer-supplied authority bit. Native reason/fact production and any
consumer/verification observation must be identified separately. This private
prototype does not rewrite or weaken the six public gates.
No negative conclusion or asserted absence is eligible unless the exact fact
kind and scope have sufficient completeness and negative-evidence eligibility.

## Evidence and limits

Every native case result names its exact candidate, frozen expectation, inputs,
command, exit, bounded raw output and execution environment. Compiler API source
closure, semantic expectation closure and actual runtime coverage are separate.
The final optimized candidate must execute the same portability vectors on native
Windows and Linux in GitHub Actions. macOS compilation or WSL is insufficient.

Keep development, qualification and reserved sets separate, using pinned public
sources. Freeze qualification inputs and independently controlled expectations
before candidate selection/correction. Reserved cases require at least two
repository snapshots, one a TS/JS monorepo, authored by a verifier who does not
implement the producer. Preserve their hidden expectations and custody record
until the selected candidate is frozen. Qualification and still-hidden reserved
cases run against that candidate; an exposed failing reserved set requires a new
independently prepared set and cannot be retried as reserved.

The approved envelope is at most two native compositions, at most two correction
passes after each composition's first execution, and five cumulative working days
including preparation and arbitration. Parallel-agent effort is cumulative.
Record scope and remaining effort before each pass; extensions require explicit
new budget. Check this journal manually before each scoped experiment. This
design adds no budget validator or mirror gate.
The research record reports unknowns and stop conditions without certifying the
later product ports or performance targets.
