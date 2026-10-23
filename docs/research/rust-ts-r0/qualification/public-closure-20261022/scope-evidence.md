# Retained scope PUBLIC supplement

Seven new PUBLIC fixtures execute the unchanged TS5.9.3
`inspectRetainedQualifiedScope` with its actual retained input map and graph, then
real `indexRepository`/`runVerify`. The unchanged frozen native producer receives
an independently constructed retained request, creates its public C1 batch, and
consumes that batch through `verify working-tree --fail-on none` in an isolated
Git repository. Full inputs, source graphs, admission, native process captures,
Git descriptors and results remain in raw evidence.

| Case | Source admission | Frozen public native |
| --- | --- | --- |
| inherited ESNext/Bundler | admitted | admitted, CLI0 |
| unretained triple-slash reference | rejected, exact unretained-reference reason | CLI1, `UnexpectedOutcome`; no structured admission |
| optional manifest dependency | admitted, explicit opaque external limitation | rejected, CLI3, unresolved import |
| undeclared optional control | rejected | CLI1, `UnexpectedOutcome`; no structured admission |
| excluded dependent | rejected; inbound link closes over excluded file | same link, coverage, rejection, CLI3 |
| excluded computed import | rejected, exact computed-import reason | same subject reason; consumed generic dependency-scope rejection, CLI3 |
| excluded unresolved import | rejected, exact unresolved-import reason | same subject reason; consumed generic dependency-scope rejection, CLI3 |

These observations agree across macOS ARM64 and Linux ARM64. A corrupted index
stdout hash is independently refused by the native public receiver with CLI1
`OutputIncomplete` on both. Positive reports bind descriptor, producer and indexed
extraction; complete stdout/stderr captures are retained. This is one real guard
control, not universal receiver correctness. Source CLI execution was not observed.

Rows 0, 1, 233, 236 and 237 remain **not_qualified**. The two concrete mismatches
prevent finite property closure; the passing families provide bounded additional
PUBLIC evidence only. Formal R0 and ARB credit remain zero. No implementation,
old fixture, old runner or old ledger was changed.

Raw macOS evidence:
`/Users/sebastien/semctx-evidence/t00/20261022/public-closure/scope/macos-final-guard`.
Linux original:
`/work/evidence/qualification-20261022/public-closure/scope/linux-final-ownbaseline`,
inside existing network-disabled `semctx-t00-oct20-linux-v1`; host copy resides in
`/Users/sebastien/semctx-evidence/t00/20261022/public-closure/scope/linux-final-ownbaseline`.
Reports: `scope-macos.json`, `scope-linux.json`; tool hashes: `scope-manifest.json`.
The source function hash equals its frozen consumer-contract hash on both systems.

Reproduce with Python3 and the platform's frozen artifact/helper/SDK paths:

```sh
python3 tools/rust-ts-r0/qualification/public-closure-20261022/scope-replay.py \
  FREEZE_JSON BASELINE_ROOT BUN \
  ABSOLUTE_PATH_TO_scope-oracle.mjs NEW_OUTPUT_DIRECTORY
```

The runner writes an explicit tsconfig override derived from the baseline package
exports and its installed dependency entrypoints; it changes no baseline source.
macOS baseline is `/Users/sebastien/semctx-evidence/t00/20261022/suite-a`.
Linux uses an isolated copy of the existing `linux-oracle-baseline` packages and
tsconfigs under `scope/baseline`, with unchanged CLI package metadata copied from
the macOS baseline because the original Linux baseline omits `apps/cli/package.json`.
The copied package metadata is an input required by context-engine, not a native
expected value. Bun is 1.4.3 and TypeScript is 5.9.3 on both systems.

Checks: both native public executions and exact source operations completed for
all seven fixtures; native refusals are recorded as failures of the requested
structured observation, never promoted to successful admission equivalence.
No Windows target, remote CI, reserved cases or complete product parity was
exercised. No comments were added.
