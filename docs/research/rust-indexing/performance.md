# Measured costs and limits

## Current Windows engine reanalysis (2026-10-17)

The completed [A3 native series](results/reanalysis-windows-2026-10-17/README.md) measures
an actual function addition: 24 cold/edited pairs, 48 states, four engines × two inputs ×
three repetitions, all 72 commands exit zero. Each structured native baseline lacks
`semctx_reindex_probe`; every native postimage contains it. This fills the bounded engine
reanalysis evidence gap for #346; it does not implement Semctx reindexing or establish parity.

The [current time and RSS tables](results/reanalysis-windows-2026-10-17/README.md#three-observed-samples)
use Node 22.23.2, Python 3.14.7, Rust 1.98.1 GNU and the pinned Windows RA binary.
Every displayed value links to [original fields and SHA-256](results/reanalysis-windows-2026-10-17/MEASUREMENTS.json).
T performs old-tree incremental reparse; Y performs new full parses; S repeats full batches
with separately timed decoding; L measures didChange→new documentSymbol on a persistent server.
T/Y use the same five/one source files; S/L also load Cargo/stdlib. Direct-process RSS,
whole-pair versus per-state timing, and warm OS cache limits are explicit in those tables.

Windows SCIP paths are **NONCONFORMING_WINDOWS_SCIP_PATHS**: only explicitly configured
diagnostic association succeeds. Original backslashes, duplicate/missing-definition warnings
and decoder unknown-field limitations are retained. This is not portable SCIP admission.
The historical macOS/Bun observations below retain their original source/runtime identities;
their numbers cannot be merged with or ranked against the Windows series.

The current Runner's input preflight, timeout cleanup and output capture changed after A3.
It rejects retained workspace directory links before copying and requires L's RUST_SRC_PATH
to be explicit and absolute, with every regular source file in that tree pinned. By default, each command retains
at most 64 MiB across stdout and stderr, refuses overflow and bounds pipe draining by the command
deadline. Cleanup covers cooperative, non-detached descendants; on Windows it requires the owned
parent to remain alive. This research supervisor is not an isolation boundary.
The Windows tables retain the original
A3 harness hashes and execution identity; read-only compatibility validation of those captures
is not a remeasurement or evidence of current timing, RSS, input preflight, timeout cleanup or output capture behavior.

## Historical macOS observations (2026-10-15)

Date: 2026-10-15. Apple M4 Max, 16 cores, 64 GiB, macOS 27.0.1 arm64; Bun 1.4.3, Python 3.15.0,
Rust/Cargo 1.98.1 + `rust-src`, RA 2026-10-12, grammar 0.24.2 / runtime 0.27.1, syn 3.0.9.
The [replay](replay.md) pins commands/inputs. [Raw samples](results/) retain outputs, timestamps,
parser timings and macOS process accounting; `$ROOT`/`$RUN` replace absolute repo/temp prefixes.
A whitespace-only manifest-stderr line and final native-Cargo empty lines are trimmed as
described in the results README.

No disk cache was flushed. “First” means first process in that recorded series; repeated processes
reuse OS/Cargo caches. They are not incremental Semctx reindexes. Earlier pilot runs overlapped;
the `serial-*` semantic measurements below were rerun sequentially without another benchmark.
Three samples show observations and variance, not p95/SLO qualification or a speed-selection gate.

## Same selected source inputs, different work

Fixture: five normal source files, two crates, 2,465 bytes. Real subset: one source, 26,273 bytes,
one crate. T/Y parse exactly those source bytes; S/L also load manifests, target configuration,
stdlib sources and the semantic workspace. T/Y lack the resulting resolution, so their lower
parser cost cannot be interpreted as faster feature-equivalent indexing.

| Measured operation | Fixture samples | Real subset samples | Scope and accounting |
| --- | --- | --- | --- |
| T native `parse` sum, ms | 28.637 / 17.488 / 52.377 | 20.755 / 3.099 / 5.522 | Per-file full parses in one Bun process, no old-tree incremental reuse; excludes WASM initialization, I/O and AST serialization. Raw individual file samples retained in `tree.jsonl`; allocation/JIT/GC variance is material. |
| Y native `parse_file` sum, ms | 0.657 / 0.679 / 0.631 | 2.187 / 2.140 / 2.119 | Separate helper processes per file, parser interval only; no resolution/I/O/traversal/output. |
| Y full process bundle, ms | 20.600 / 20.363 / 18.951 | 6.836 / 6.891 / 6.613 | Sum of process wall times for the same files, Python orchestration included; not a persistent server. |
| S full batch process, s | 1.90 / 1.68 / 1.68 | 1.70 / 1.69 / 1.68 | Four cache-priming threads, full Cargo/semantic export. First original pilot was 2.08 s fixture / 3.32 s real with colder target/cache. |
| L initialize→quiescent, ms | 1902.231 / 1878.894 / 1861.964 | 1861.701 / 1873.859 / 1896.934 | Full server start per run, readiness from experimental server-status notification, not a Semctx seal. |
| L whole probe process, s | 2.03 / 2.01 / 1.99 | 2.18 / 2.19 / 2.22 | Initialization, queries, one in-memory edit/query and shutdown. |
| L outgoing hierarchy, ms | 8.970 / 8.614 / 8.749 | 193.472 / 190.291 / 191.342 | `main` (five targets) versus `Arguments::from_env` (four); different APIs/targets, not equivalent query workload. |
| L definition query, ms | 0.208 / 0.189 / 0.219 | 0.191 / 0.194 / 0.219 | Cross-crate alias in fixture; real API's configured source position. |
| L post-edit documentSymbol, ms | 0.313 / 0.313 / 0.303 | 3.203 / 3.290 / 3.186 | Historical full-text didChange version 2 accepted despite the incremental capability; not negotiated incremental-edit evidence. Response latency only; no disk write, persisted reindex, whole-workspace generation or completeness claim. |

Native parser timing definitions differ: T's language runtime is WASM/JIT; Y's is a compiled native
parser. No claim of causal engine superiority follows from a sample this small. Large-workspace
bounded fan-out, real post-image capture and significant edit/add/delete costs remain B06/B07.

The current LSP probe corrects synchronization, explicit UTF-8 source decoding and failure exit
propagation. The whole-process and post-edit LSP samples above remain observations of the earlier
probe; the corrected probe has not been remeasured on that original macOS benchmark host. The separate
Windows A3 series above exercises the corrected protocol with a real function addition.

## RSS, artifact sizes and query cost

`/usr/bin/time -l` reports maximum resident bytes for the timed process accounting boundary, not
the sum of simultaneous subprocess RSS. In particular the Python parent is not a reliable
aggregate measure of all LSP/Cargo descendants. Treat the figures as observed process-accounting
high-water values, not a total-memory guarantee.

| Engine | Observed memory / startup | Material output size |
| --- | --- | --- |
| T | One real-corpus process sample: 81,428,480 max resident bytes; 0.20 s including Bun/WASM setup, parse and exit. No three-sample RSS series. | Grammar WASM 1,118,099 B plus runtime (npm tarball unpacked declaration 4,687,401 B, not all runtime). Real AST S-expression ~79.8 kB; AST bytes are not a persisted index. |
| Y | One real-corpus sample: 5,799,936 max resident bytes; timer rounded whole process wall to 0.00 s. Release compilation took 8.18 s with cached crates. | Helper 2,215,024 B. TSV is a diagnostic declaration summary, not a semantic artifact. |
| S | Fixture 541,573,120 / 544,112,640 / 541,900,800 B; real 545,095,680 / 543,916,032 / 545,243,136 B. | Fixture SCIP 16,162 B; real SCIP 99,070 B. Exported symbol relationships zero. No standalone query latency measured: decoding/ingestion/graph querying would be Semctx work. |
| L | Fixture 566,476,800 / 556,711,936 / 554,172,416 B; real 572,030,976 / 574,160,896 / 567,476,224 B under the above accounting limit. | No batch artifact. JSON transcripts are diagnostic recordings, not a bound persistent index. Whole-workspace request counts and generation capture would add cost. |

SCIP fixture bytes were equal in three original runs but diagnostics still report duplicate IDs
and a missing definition; determinism does not make the output admissible. Raw stderr retains
this failure. LSP absent-symbol `[]` likewise remains unqualified negative evidence.

## Operating and platform costs

All engines can parse/analyze without a remote analysis service once artifacts and dependencies
are available. T/Y need no indexed-project build execution. S prepares Cargo build outputs and
proc macros. L can disable those particular paths but still needs a reviewed Cargo executable,
configuration, environment and toolchain or an isolated execution boundary. Offline dependency
acquisition failures must be visible; no implicit download/fallback is recommended.

Comparative timings above are macOS arm64 only. Later Linux arm64 container smoke passed seven
helper tests, two fixture tests and the Bun/WASM pico-args parse. Native RA SCIP ran but missing
rust-src reduced its fixture occurrences to 117; the result remains partial. Exact image/asset pins
and commands are in the replay. Full Linux LSP/release packaging and macOS x86 packaging remain untested. Native Windows
engine reanalysis is now recorded separately above; Windows product/release packaging remains untested. Docker exposes Linux, not a native Windows executor. Upstream RA
and tree-sitter distribution/CI matrices show possible packaging inputs, not results for Semctx.
The applicable repository CI targets are `ubuntu-latest`, `windows-latest`, `macos-15`; B05 requires
separate replay/package evidence there. No result in this document is represented as a CI result.

The proposed 250 ms query / asynchronous 60 s deadline / 1 GiB per-child planning budgets in the
main note remain unapproved and unqualified. They derive from interaction/resource expectations,
not from fitting a threshold to the measurements. A large pinned corpus and native target evidence
are prerequisites to accepting them.

The BOM correction changed the helper's source-coordinate conversion after parser measurements;
the measured parser call and ASCII corpus inputs are unchanged, and the rebuilt release binary
still measures 2,215,024 bytes. Edge-case timings were collected under concurrency and deliberately
excluded from the comparative table.
