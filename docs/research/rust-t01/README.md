# T01 research record

This directory records the architecture and frontier-protocol work of
[#365](https://github.com/hoklims/semctx/issues/365), milestone T01, sections 3 and 4. That
issue owns acceptance. This record declares neither `ECONOMIC_PROTOTYPE_PASS` nor
`STOP_OPTIMIZATION`, and it does not open the substantial ports.

## Status

T01 depends on T00. T00 has not reached `READY_TS_NATIVE`; its record reports stage 1 and
`r0Decision: NOT_RUN`. Hypotheses H1–H3, the prototype and the economic gate therefore remain
unstarted. This record only covers work #365 places in T01 before any comparison: baseline
characterization, workload preparation and the measurement protocol (D6). No Rust code,
dependency, workflow change or product change is introduced.

Checkpoint 2 adds the requalified baseline. Checkpoint 3 pins the workload matrix. Both are
described below.

[protocol.json](protocol.json) is the machine record of these checkpoints.

## Owner input on workload sizes

The T01 owner set the expected usage on 2026-10-17: every repository size, with native
adaptation. The owner confirmed the following translation the same day.

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

Both pilot runs use the default version 1 configuration. Version 1 discovery walks the whole
repository and does not apply `include` (see `docs/reference/configuration.md`), so file counts
below are what discovery indexed, not a `src` subset.

**Semctx at the baseline commit (904 `.ts`/`.tsx` files; 701 module and test nodes; 1
worker).** The index
succeeded in 4.9 s wall time, with 1.92 GB maximum resident set size. A CPU profile attributes
about 36% of sampled time to `realpathNativeSync`. It is reached mainly through
`canonicalFilesystemPath`, called once per resolved call target by `relOf` and
`resolveCallTarget` without memoization. Checker queries (`getSymbolAtLocation`,
`getResolvedSignature`) are the next cost. Recapture and publication together
(`completeRepositoryIndex`) take about 15% of sampled time.

This repeated filesystem canonicalization is a language-independent cost. A comparison must
not attribute its removal to Rust. Any ablation must keep the same confinement guarantees.

**VS Code `5b23ab3` (14,818 non-declaration TS files; 14,794 module and test nodes in the
later requalified run; 1 worker).** The baseline
failed after 144 s with `PlaneAAssemblyError: FACT_ID_CONFLICT` on `edge:imports:342a8bf7`,
metadata key `specifier`. The sampled peak RSS of the process tree was 18.4 GB.

`edgeId` derives edge identities from a 32-bit FNV-1a hash of `from->to`. Import occurrences
with the same pair are grouped before assembly, so the conflict comes from distinct pairs. A
regex scan of the snapshot's `src` tree finds 123,283 distinct relative import pairs. Within
that set,
it reproduces an independent 32-bit collision:

- `edge:imports:4fdac1ed` for
  `src/vs/workbench/contrib/browserView/common/browserSearch.ts -> src/vs/nls.ts`;
- the same identity for
  `src/vs/sessions/contrib/layout/test/browser/desktopLayoutController.test.ts -> src/vs/sessions/contrib/layout/browser/desktopLayoutController.ts`.

At this edge count, the birthday bound predicts about two colliding pairs. The partner of
`342a8bf7` lies outside the relative-import scan and remains unidentified.

## Requalified baseline

On 2026-10-17 the owner, who holds authority over #365, arbitrated the identity defect under
#365 section 2.3. The decision applies to T01 measurements only:

- The T01 reference is `3e94997` plus one patch to `packages/core/src/ids.ts`. `edgeId` and
  `claimId` use the first 128 bits of SHA-256 instead of 32-bit FNV-1a. Both populations grow
  with the repository. Other identities are unchanged. The exact patch and its digest are in
  `protocol.json` (`requalifiedBaseline`).
- The patch is applied to a disposable checkout outside this branch. It is not a product change
  and does not modify `main`. The identity format of the Rust candidate remains a T02 decision
  under D4.
- The historical baseline stays pinned. It remains the reference for any behavior other than
  these two identities.

Single-run checks of the requalified baseline:

| Check | Result |
| --- | --- |
| VS Code `5b23ab3`, previously failing | Indexed: 101,587 nodes, 463,422 edges, 697,442 evidence rows, 19,663 claims; 186.9 s; 24.8 GB maximum RSS |
| Semctx, store compared with the historical baseline | Nodes, evidence and edges without their id identical; claims identical once subject and evidence lists are compared as sets; edge and claim ids unique in both |
| Semctx, cost | 4.82 s and 1.88 GB, against 4.88 s and 1.92 GB historically; single runs, within noise |

Only identity values and the order they induce changed. Edges are iterated in id order, so 73 of
the 1,077 claims list the same subjects and evidence in a different order. At 463,422 edges, the
birthday bound predicts about 25 colliding pairs under 32-bit identities, so the historical
baseline cannot index this workload.

## Consequences for the protocol

- Large cells use the requalified baseline. A Rust candidate's facts are compared with it,
  ignoring only edge and claim identity values and the order they induce. All other fields must
  match exactly.
- Baseline memory grows to tens of GB on large repositories. Every size class must declare its
  host memory before runs. A run that exhausts memory is recorded as a result, not discarded.
- Aggregate memory is measured as the maximum over time of the summed RSS of the live process
  tree. The pilot sampler polls `ps` every 200 ms and may miss short peaks. The reference series
  needs a declared collector and sampling period per OS (#365 section 3.3).

## Workload matrix

Checkpoint 3 pins seven public snapshots, recorded before any repeated baseline series and
before any candidate exists. All are disjoint from T00's qualification and reserved
repositories. Commits, archive URLs and archive digests are in `protocol.json` (`workloads`).

Size classes count the TS/JS files selected by the matrix configuration. The thresholds were
fixed before classification:

| Class | Selected TS/JS files |
| --- | --- |
| small | fewer than 300 |
| medium | 300 to 2,999 |
| large | 3,000 to 19,999 |
| very large | 20,000 or more |

| Workload | License | Structure | TS | JS | Python | Markdown/MDX | SQL | Class |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `sindresorhus/ky` | MIT | single package | 98 | 0 | 0 | 3 | 0 | small (startup) |
| `honojs/hono` | MIT | single package, pnpm workspace file | 450 | 2 | 0 | 18 | 0 | medium |
| `trpc/trpc` | MIT | pnpm monorepo | 1,024 | 26 | 0 | 284 | 13 | medium, monorepo |
| `PrefectHQ/prefect` | Apache-2.0 | Python package with TS UI | 1,672 | 7 | 1,916 | 1,054 | 6 | medium, multilanguage |
| `backstage/backstage` | Apache-2.0 | Yarn monorepo | 7,447 | 427 | 0 | 2,143 | 0 | large, monorepo |
| `microsoft/vscode` | MIT | single repository | 14,807 | 129 | 74 | 369 | 1 | large |
| `aws/aws-sdk-js-v3` | Apache-2.0 | Yarn monorepo, generated clients | 36,895 | 608 | 0 | 1,248 | 0 | very large, monorepo |

The counts come from the requalified baseline's own discovery with the matrix configuration.
That configuration is identical for every workload. It uses version 2 `globs-v1` selection,
enables TypeScript, JavaScript, Python, Markdown and SQL, and excludes `node_modules`, `dist`,
`build`, `coverage`, `.git` and `.semctx`. Its digest is in `protocol.json`. Generated sources,
such as the AWS SDK clients, are kept: they are the repository's real source.

Discovery alone takes 15.4 s on VS Code and 44.5 s on the AWS SDK (single runs). The baseline
runs discovery twice per index, once at capture and once at recapture. This is a candidate
cost mechanism for hypothesis selection.

The very large cell may exceed this host's 48 GiB on the baseline: VS Code peaked at about
1.7 MB of RSS per selected TS/JS file, which extrapolates to about 62 GB for the AWS SDK. That outcome must be measured and recorded, not
assumed. If the baseline cannot complete a cell, no ratio exists for it. Its budget is then
derived from the size-dependent coefficients fitted on the cells the baseline completes, and the
cell stays in the matrix.

## Next checkpoints

1. Capture each workload's dependency closure from its lockfile without running install
   scripts. `sindresorhus/ky` has no lockfile, so its closure must be generated once and pinned.
2. Measure instrumentation cost, then record repeated baseline series per phase and size class.
   Derive the size-dependent budget coefficients from them.
3. After `READY_TS_NATIVE`: select at most three hypotheses from the measured costs, then run the
   prototype and the economic gate under the frozen protocol.
