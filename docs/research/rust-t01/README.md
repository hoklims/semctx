# T01 research record

This directory records the architecture and frontier-protocol work of
[#365](https://github.com/hoklims/semctx/issues/365), milestone T01, sections 3 and 4. That
issue owns acceptance. This record declares neither `ECONOMIC_PROTOTYPE_PASS` nor
`STOP_OPTIMIZATION`, and it does not open the substantial ports.

## Status

T01 depends on T00. T00 has not reached `READY_TS_NATIVE`: its final record at `c84e9382` on
`rust/365-t00` decides `STOP_BUDGET`. On 2026-10-18 the owner stated that a new R0 budget will be
granted; no new budget is recorded yet. Hypotheses H1–H3, the prototype and the economic gate
therefore remain unstarted. This record only covers work #365 places in T01 before any
comparison: baseline characterization, workload preparation and the measurement protocol (D6).
No Rust code, dependency, workflow change or product change is introduced.

Checkpoint 2 adds the requalified baseline. Checkpoint 3 pins the workload matrix. Checkpoint 4
captures each workload's dependency closure. Checkpoint 5 fixes the measurement setup and records
one shake-down run per workload. Checkpoint 6 records the owner's choice of a single Windows
measurement host and declares its memory collector. Checkpoint 7 redoes the reference build and
the hono cell on that host; its collector-cost measurement is inconclusive. Checkpoint 8 records
the owner's return to the macOS host. Checkpoint 9 moves the measurement space to a durable path
and records the plan of the first reference series before any of its runs (`measurementSpace`
and `referenceSeries` in `protocol.json`). It also records the owner's decision on Prefect and the
large cells; see [Owner decision](#owner-decision-on-prefect-and-the-large-cells). No owner
decision is open.

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

## Dependency closures

The baseline TS/JS analyzer resolves external imports through `node_modules`. Measuring a
snapshot without its dependencies would leave SDK declarations and re-exports unresolved. It
would not represent real use. Checkpoint 4 installs each workload's closure with these rules:

- **Scope**: the closure is what the repository's own development install fetches. VS Code
  installs the 56 directories listed in `build/npm/dirs.ts`; that list is read as text, not
  executed. Prefect installs its two TS interfaces, `ui-v2` and `ui`. Every other workload
  installs from its root lockfile.
- **No repository code runs**: every install script is disabled (`--ignore-scripts`, Yarn
  `--mode=skip-build`, no pnpmfile). Package managers come from the npm registry at the
  version each repository declares. The committed Yarn releases are byte-identical to the
  registry bundles but are not executed.
- **Frozen**: `npm ci`, `pnpm install --frozen-lockfile` and `yarn install --immutable` refuse
  any lockfile drift.
- **`sindresorhus/ky`** commits no lockfile. Its lockfile was generated with npm 11.19.1,
  resolving only versions published before the pinned commit's date
  (`--before=2026-10-09T06:29:22Z`). A second generation produced the same file. Its digest is
  recorded.
- **Python** dependencies are not installed. The baseline Python analyzer resolves imports
  statically and reads no installed package.

| Workload | Package manager | Lockfiles | Distinct packages | Installed size |
| --- | --- | ---: | ---: | ---: |
| `sindresorhus/ky` | npm 11.19.1 | 1 (generated) | 571 | 0.12 GB |
| `honojs/hono` | pnpm 12.6.0 | 1 | 720 | 0.87 GB |
| `trpc/trpc` | pnpm 12.4.1 | 1 | 3,422 | 2.52 GB |
| `PrefectHQ/prefect` | npm 11.19.1 | 2 | 1,369 | 1.01 GB |
| `backstage/backstage` | Yarn 4.18.0 | 1 | 3,651 | 1.99 GB |
| `microsoft/vscode` | npm 11.19.1 | 56 | 2,738 | 5.25 GB |
| `aws/aws-sdk-js-v3` | Yarn 4.17.1 | 1 | 1,256 | 0.51 GB |

Distinct packages count name and version pairs. `protocol.json` records lockfile digests,
commands and a digest of each closure manifest, which lists every installed package by
location, name and version.

Two checks confirm that installation leaves each snapshot's sources intact:

- A SHA-256 manifest of every file outside `node_modules`, taken before and after. Nothing
  changed, except that Yarn added `.yarn/install-state.gz` to backstage and the AWS SDK.
- A rerun of the requalified baseline's discovery with the matrix configuration. Selected files
  and bytes are identical for all seven workloads. Yarn's install state is a new candidate, and
  discovery excludes it.

## Measurement setup

**Reference build.** Users install a minified bundle, not the TypeScript sources the pilots ran.
Rebuilding `3e94997` with Bun 1.4.0, the release workflow's pinned version, reproduces the
published `semctx@0.4.5` package byte for byte. `3e94997` differs from the release commit only in
documentation. The requalified reference is built the same way from `3e94997` plus the
requalification patch. Only `index.js` differs from the release. The reference runs that bundle
with Bun 1.4.3 and one worker, which is the CLI default and what `auto` selects on macOS.

**Snapshots as Git repositories.** Outside a Git repository the baseline refuses to index
(`GIT_ERROR`, cannot capture control freshness). Each snapshot is therefore a one-commit
repository built from its archive. Upstream files that match `.gitignore` are added explicitly,
and a submodule is recorded as its upstream pointer without being initialized. The local tree id
equals the upstream commit's tree id for all seven workloads, and `git status` is clean.
Discovery selection is unchanged.

**Memory collector (macOS).** The metric is `phys_footprint`, read through `proc_pid_rusage`
every 50 ms for each process of the command's tree. It excludes shared clean pages, so summing
processes does not count shared libraries twice. Aggregate memory is the maximum over samples of
the summed footprint. The kernel's per-process lifetime peak, summed over processes, bounds it
from above. On a 768 MiB allocation, the collector matches `ps` for resident size and
`/usr/bin/footprint` for footprint and peak. Each run also records the system's compressor and
swap counter deltas. The Windows collector is declared under
[Measurement host](#measurement-host). Linux has no declared collector and no measurement, so it
remains unqualified.

**Instrumentation cost.** On hono, 10 cold pairs with sampling off and at 50 ms, in shuffled
order, give a wall-time ratio of 1.0023 (95% bootstrap interval 1.0012–1.0042) and a peak
footprint ratio of 1.0043 (0.9948–1.0128). The sampled aggregate stays within 0.2–1.5% of the
kernel upper bound. Reference series keep sampling on. Phase attribution uses separate
CPU-profiled runs; their cost is not yet measured. Ratios are medians over pairs, with a seeded
percentile bootstrap over pairs.

## Shake-down runs

One cold run per workload sizes the series. These are not reference measurements. The host is an
Apple M5 Pro with 18 cores and 48 GiB.

| Workload | Result | Wall time | Aggregate peak footprint |
| --- | --- | ---: | ---: |
| `sindresorhus/ky` | indexed | 2.2 s | 0.71 GB |
| `honojs/hono` | indexed | 15.5 s | 1.63 GB |
| `trpc/trpc` | indexed | 95.7 s | 4.30 GB |
| `PrefectHQ/prefect` | refused: submodules unsupported by the freshness seal | 0.17 s | 0.06 GB |
| `backstage/backstage` | indexed | 10,746 s | 42.31 GB |
| `microsoft/vscode` | indexed | 1,146 s | 43.29 GB |
| `aws/aws-sdk-js-v3` | not run | | |

With its dependencies, VS Code takes about six times as long as the pilot without them (187 s).
The pilot measured RSS, so its 24.8 GB is not compared with these footprints. Both large workloads
plateau near 42–43 GB on a 48 GiB host. Memory
compression may dominate their times, but these runs predate the per-run compressor counters, so
that cause is not established. At these durations, 10 pairs on backstage would take days.

## Measurement host

**Current decision.** Later on 2026-10-18, after the Windows measurements below, the owner moved
every size class back to the macOS host of checkpoints 1 to 5 (Apple M5 Pro, 18 cores, 48 GiB).
The macOS setup, collector and collector cost already exist, and the Windows host was loaded by
other applications. Consequences:

- the macOS reference build, closures, snapshots, collector and collector cost of checkpoints 4
  and 5 apply; pilot and shake-down runs remain orientation;
- the large and very large cells run under memory pressure on 48 GiB, and every run records
  compressor and swap counter deltas; their series size is fixed before any series;
- the Windows records of checkpoints 6 and 7 remain records. No Windows series is planned.

**Superseded decision.** Earlier the same day, the owner had chosen one Windows host for every
size class. No 128 GiB host is available, and on the 48 GiB macOS host the large cells plateau
near host memory. A single host keeps the size-dependent coefficients fitted on one machine and
one memory metric. The rest of this section and the next record what that decision produced.

The host runs Windows 11 Pro 10.0.26300 on an Intel Core i7-13700K with 24 logical processors and
63.7 GiB of physical memory visible to Windows. Microsoft Defender real-time protection is enabled
and recorded as a run condition. Its exclusions are not readable without administrator rights,
and T01 configures none.

The macOS pilot, shake-down and instrumentation-cost runs remain orientation. They are not
reference series and are not compared with Windows numbers. Before any Windows series, the
setup of checkpoints 4 and 5 is redone on this host:

- the reference build check (done; see [Windows setup](#windows-setup-reference-and-hono));
- the dependency closures and their manifests, since platform-specific optional packages differ
  (done for hono);
- the snapshot repositories and their tree-id check, since line endings and symbolic links
  differ (done for hono);
- the collector cost on hono (run, inconclusive);
- one shake-down run per workload.

**Memory collector (Windows).** The command runs in a fresh Job Object, assigned while its root
process is still suspended. Descendants inherit the job and cannot break away, so the tree is
complete by construction. Every 50 ms, a high-resolution waitable timer triggers a sample. The
system timer resolution is not changed. The metric is `PrivateWorkingSetSize`, the private pages
resident in RAM. It excludes shared pages, so summing processes does not count shared libraries
twice. Aggregate memory is the maximum over samples of the summed private working set. The
kernel's `PeakJobMemoryUsed`, the exact peak of the job's summed private commit, bounds it from
above. Each run also records summed private commit, summed working set, job page faults and CPU
time, the minimum available physical memory, and system page-read and page-output deltas.

`phys_footprint` also counts compressed private pages; the private working set does not. Without
memory pressure both measure the same touched private memory. Under pressure the Windows metric
drops while private commit and the page counters rise. Windows and macOS numbers are not
compared.

Validation on this host, against tasklist and .NET `Process` readings taken during the hold:

| Case | Collector | Independent reading |
| --- | ---: | ---: |
| 768 MiB touched, one process: working set | 781.4 MiB | 781.0 MiB |
| same: private commit | 777.5 MiB | 777.0 MiB |
| 512 MiB parent and 256 MiB child: working set | 794.6 MiB | 794.6 MiB |
| same: private commit | 785.1 MiB | 784.9 MiB |
| 512 MiB held 5 ms above 256 MiB: sampled private working set and kernel bound | 602.9 MiB | 777.7 MiB |

The single allocation reads 774.1 MiB of private working set. The short peak shows the sampling
limit and the bound that covers it. Sample intervals have a median of 50.23 ms and a maximum of
50.78 ms. A period of 0 turns sampling off and keeps the wall time and the job's kernel peaks, as
the macOS off mode keeps its lifetime peak. With one live process, the collector uses 1.3 ms of
CPU per sample, 2.5% of one of the 24 logical processors; this figure predates the sampling-off
revision, which leaves the sampling path unchanged. The collector, fixture and validator stay
outside the checkout; their digests are in `protocol.json` (`memoryCollector.windows`).

## Windows setup: reference and hono

Checkpoint 7 redoes the reference build and the hono cell on the Windows host.

**Reference build.** Bun 1.4.0 (`@oven/bun-windows-x64`) builds `3e94997` from a `git archive`
without line-ending conversion. The historical `apps/cli/dist` is byte-identical to the published
`semctx@0.4.5`. The requalified bundle has the same digests as on macOS. The reference runs it
with Bun 1.4.3 for Windows.

**Configuration.** The macOS configuration file bytes cannot be rebuilt from the recorded object.
The Windows file serializes the same object with two-space indentation; its digest is recorded
separately.

**hono.** Archive and lockfile digests match the record:

- pnpm 12.6.0 installs the closure in 45 s with every script disabled: 719 distinct name-version
  pairs, 25,961 files, 0.85 GB;
- 25 Windows-specific packages replace their macOS counterparts (esbuild, rollup, workerd, oxc and
  others);
- sources outside `node_modules` are unchanged by the install;
- the snapshot repository's tree id equals upstream `662fabe5`, once two executable bits and two
  ignored `.gitkeep` files are restored, and `git status` is clean;
- the baseline's discovery selects exactly the macOS files and bytes;
- a first index produces the macOS counts (2,689 nodes, 5,934 edges, 11,164 evidence rows, 455
  claims) in 44.5 s, with 1.93 GB of aggregate private working set; 24.7 of its 49.9 CPU seconds
  are kernel time.

**Collector cost: inconclusive.** Ten cold pairs, sampling off versus 50 ms, shuffled with seed
365, give a wall-time ratio of 0.950 (95% bootstrap interval 0.811–1.027). The job's peak commit
ratio is 0.995 (0.963–1.025). The sampled aggregate is 89–91% of the kernel upper bound. Facts are
identical in all 20 runs. Wall times range from 38.4 s to 56.8 s, and the last three pairs are
slower. That host variation is far larger than the effect measured, so the interval cannot exclude
a cost of several percent.

The host was not quiet: available physical memory at run start ranged from 25.0 to 27.7 GiB of
63.7 GiB, because other applications held the rest. With that load, the 42–43 GB large cells would
again run under memory pressure. No quiet-host procedure is declared yet.

## Reference series

Checkpoint 9 records the first reference series on the macOS host. Its plan was committed before
any of its runs. Raw outputs stay outside the checkout, under the durable measurement space
`/Users/hokli/t01-bench`. That space is a copy of the checkpoint 4–5 space and was checked against
the record before the series: bundle and collector digests, snapshot tree ids, a clean
`git status` and the closure manifests all match.

**Design.** Ten cold runs per workload use the requalified bundle under Bun 1.4.3 with one worker,
and the collector samples every 50 ms. The order is interleaved: each of ten rounds runs the three
workloads once, in an order shuffled by `random.Random(365)`. Before every run, `.semctx` is emptied
except `config.json`, and host memory is read from `vm_stat` and `vm.swapusage`. The host ran on AC
power under `caffeinate -dimsu`, with Chrome, Discord and Teams closed. Trend Micro, the Chrome
Remote Desktop host and Claude Code sessions kept running.

| Workload | Exit codes | Wall time, median (min–max, IQR) | Aggregate peak footprint, median (min–max, IQR) |
| --- | --- | ---: | ---: |
| `sindresorhus/ky` | 10 × 0 | 2.04 s (1.88–2.08, 0.05) | 0.709 GB (0.699–0.717, 0.006) |
| `honojs/hono` | 10 × 0 | 15.28 s (14.57–15.44, 0.30) | 1.559 GB (1.546–1.579, 0.015) |
| `trpc/trpc` | 10 × 0 | 92.99 s (90.55–93.84, 0.76) | 5.046 GB (4.915–5.114, 0.020) |
| `PrefectHQ/prefect`, derived snapshot | 10 × 0 | 138.95 s (138.36–142.43, 0.13) | 8.031 GB (7.949–8.217, 0.050) |

IQR is Q3 − Q1 from `statistics.quantiles(n=4, method="inclusive")`. Nodes, edges, evidence and
claims are identical across each workload's runs:

| Workload | Nodes | Edges | Evidence | Claims |
| --- | ---: | ---: | ---: | ---: |
| `sindresorhus/ky` | 437 | 971 | 2,388 | 82 |
| `honojs/hono` | 2,689 | 5,934 | 11,164 | 455 |
| `trpc/trpc` | 5,925 | 12,101 | 18,102 | 2,047 |
| `PrefectHQ/prefect`, derived snapshot | 46,138 | 58,166 | 66,437 | 815 |

No run recorded a compression, a swap-in or a swap-out. Decompressions per run stayed between 0
and 384 pages. Swap use stayed at 0 MiB. Free memory fell from 22.43 GB before the first run to
13.06 GB after the last, while inactive pages rose from 13.15 GB to 20.52 GB. The sampled aggregate
stays within 1.7% of the kernel upper bound.

The Prefect cell ran after the three interleaved workloads, as ten consecutive runs on the
derived snapshot. Its runs also recorded no compression and no swap; decompressions stayed between
1 and 34 pages, and free memory before each run stayed between 19.35 and 20.60 GB. The seal's `planeAIndexSnapshotHash` differs on
every run, so it is not used as a fact identity; its cause is not investigated.

## Owner decision on Prefect and the large cells

On 2026-10-18 the owner decided, in these words:

> Prefect en variante dérivée sans gitlink (admise si sélection identique, refus inscrit) ;
> grandes cellules sous pression : vscode 5 runs, backstage 3 runs, aws-sdk-js-v3 1 run avec
> résultat inscrit même en échec mémoire.

This resolves both earlier open decisions. No owner decision is open.

**Derived Prefect snapshot.** The baseline's refusal of the original snapshot stays recorded in
the shake-down results. The derived snapshot is a separate copy of the original snapshot
directory. It removes `.gitmodules` and the `compat-tests` gitlink and is recommitted as one root
commit by the same identity at the same date. Its tree id is `09bb641d`, and `git status` is
clean. Its discovery selection equals the workload matrix record file for file and byte for byte.
Only the unselected `.gitmodules` candidate disappears, so the variant is admitted.

**Remaining cells.** They run in this order, with one commit and one push after each cell:

| Cell | Runs | Expected duration |
| --- | ---: | --- |
| Prefect, derived snapshot | 10 | done: 23 min; see [Reference series](#reference-series) |
| `microsoft/vscode` | 5 | about 1 h 40 |
| `backstage/backstage` | 3 | about 9 h |
| `aws/aws-sdk-js-v3` | 1 | not estimated; a memory failure is recorded and not rerun |

## Next checkpoints

1. On the macOS host: record the remaining cells above. Then derive the size-dependent budget
   coefficients from the series and measure the CPU-profile cost for phase attribution.
2. After `READY_TS_NATIVE`: select at most three hypotheses from the measured costs, then run the
   prototype and the economic gate under the frozen protocol.
