# T01 research record

This directory records the architecture and frontier-protocol work of
[#365](https://github.com/hoklims/semctx/issues/365), milestone T01, sections 3 and 4. That
issue owns acceptance. This record declares neither `ECONOMIC_PROTOTYPE_PASS` nor
`STOP_OPTIMIZATION`, and it does not open the substantial ports.

## Status

T01 depends on T00. T00 has not reached `READY_TS_NATIVE`; its record reports stage 1 and
`r0Decision: NOT_RUN`. Hypotheses H1–H3, the prototype and the economic gate therefore remain
unstarted. This checkpoint only covers work #365 places in T01 before any comparison: baseline
characterization, workload preparation and the measurement protocol (D6). No Rust code,
dependency, workflow change or product change is introduced.

[protocol.json](protocol.json) is the machine record of this checkpoint.

## Owner input on workload sizes

The T01 owner set the expected usage on 2026-10-17: every repository size, with native
adaptation. This record translates that input as follows. The translation is a draft for the
owner to confirm before the protocol is frozen.

1. **Workloads span the whole size range.** The matrix covers small, medium, large and very
   large TS/JS snapshots plus at least one monorepo. Each snapshot is classified by selected
   source files and bytes before any candidate result exists. No size class is dropped after a
   failure.
2. **Absolute budgets are functions of size, not single numbers.** Each budget is a fixed
   startup term plus a per-unit term, with an explicit growth bound for time and for aggregate
   memory. Coefficients and growth bounds come from the baseline characterization below; none
   is chosen here. A missing coefficient blocks comparisons, as #365 section 3.1 requires.
3. **The candidate adapts natively to the host and the repository.** Worker count, batch sizes
   and memory use follow the host and the snapshot without user tuning. This adaptation does not
   replace the reference comparison at an equal worker count, and adaptive defaults remain
   evidence-gated (G28). Any adaptive policy that changes facts, refusals or identities is a
   defect, not a tuning.

## Baseline phases

The baseline indexing path is `indexRepositoryAsync` in
`packages/app-services/src/indexing.ts` at commit `3e94997`. Measurements attribute time to
these phases:

| Phase | Baseline entry points |
| --- | --- |
| Input capture | `prepareRepositoryIndex`: config, Git state, tracked diff, discovery, qualified input capture, input fingerprint, semantic model and lifecycle |
| TS/JS analysis | `analyzePlaneARuntimeAsync` → `analyzeRepositoryAsync` → `extractTypeScriptParallel` (program creation, checker queries, call resolution) |
| Assembly | fact batch assembly (`assembleFactBatches`), `GraphIndex` and `buildClaims` |
| Recapture | `completeRepositoryIndex` before publication: second config, discovery, input fingerprint, workspace projection, semantic model, Git state and tracked diff |
| Publication | SQLite store writes, metadata, freshness seal and store closure |
| Process | Bun startup and module loading, process exit |

Thresholds still apply to the complete path, from command entry to a validated snapshot.
Phase timings guide architecture choices only.

## Pilot observations

These observations come from single, unrepeated runs on one host. They orient the protocol.
They are not a reference series and support no ratio, budget or threshold. Raw outputs stay
outside the checkout. Their SHA-256 digests are listed in `protocol.json`.

**Semctx at the baseline commit (904 TS files, default config, 1 worker).** The index
succeeded in 4.9 s wall time, with 1.92 GB maximum resident set size. A CPU profile attributes
about 36% of sampled time to `realpathNativeSync`. It is reached mainly through
`canonicalFilesystemPath`, called once per resolved call target by `relOf` and
`resolveCallTarget` without memoization. Checker queries (`getSymbolAtLocation`,
`getResolvedSignature`) are the next cost. Recapture and publication together
(`completeRepositoryIndex`) take about 15% of sampled time.

This repeated filesystem canonicalization is a language-independent cost. A comparison must
not attribute its removal to Rust. Any ablation must keep the same confinement guarantees.

**VS Code `5b23ab3` (10,614 TS files under `src`, default config, 1 worker).** The baseline
failed after 144 s with `PlaneAAssemblyError: FACT_ID_CONFLICT` on `edge:imports:342a8bf7`,
metadata key `specifier`. The sampled peak RSS of the process tree was 18.4 GB.

`edgeId` derives edge identities from a 32-bit FNV-1a hash of `from->to`. Import occurrences
with the same pair are grouped before assembly, so the conflict comes from distinct pairs. A
regex scan of the same snapshot finds 123,283 distinct relative import pairs. Within that set,
it reproduces an independent 32-bit collision:

- `edge:imports:4fdac1ed` for
  `src/vs/workbench/contrib/browserView/common/browserSearch.ts -> src/vs/nls.ts`;
- the same identity for
  `src/vs/sessions/contrib/layout/test/browser/desktopLayoutController.test.ts -> src/vs/sessions/contrib/layout/browser/desktopLayoutController.ts`.

At this edge count, the birthday bound predicts about two colliding pairs. The partner of
`342a8bf7` lies outside the relative-import scan and remains unidentified.

## Consequences for the protocol

- The baseline cannot serve as a parity or cost oracle on large workloads until this identity
  defect is arbitrated. Under #365 section 2.3, correcting historical behavior needs a separate
  product decision and requalifies the baseline. Edge identities are public identities in T02's
  scope (IDs and domain hashes). Until then, large cells are `BLOCKED_MEASUREMENT`; they are not
  removed from the matrix.
- Baseline memory grows to tens of GB on large repositories. Every size class must declare its
  host memory before runs. A run that exhausts memory is recorded as a result, not discarded.
- Aggregate memory is measured as the maximum over time of the summed RSS of the live process
  tree. The pilot sampler polls `ps` every 200 ms and may miss short peaks. The reference series
  needs a declared collector and sampling period per OS (#365 section 3.3).

## Next checkpoints

1. Obtain the owner's confirmation of the size translation above and the arbitration route for
   the identity defect.
2. Select and pin the workload snapshots per size class, disjoint from T00's qualification and
   reserved repositories, with their configurations and dependency closures.
3. Measure instrumentation cost, then record repeated baseline series per phase and size class.
   Derive the size-dependent budget coefficients from them.
4. After `READY_TS_NATIVE`: select at most three hypotheses from the measured costs, then run the
   prototype and the economic gate under the frozen protocol.
