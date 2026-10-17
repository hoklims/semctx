# Windows native engine reanalysis, 2026-10-17

Actual measured source **`1f08463191369097fe15dda1721324a4c7ab4215`** (A3),
tree `1cd1d272b2f5f270fe4c3e26a1ade6d1c5b0e1de`. This is engine-level research for #346,
not a Semctx reindex implementation, feature-equivalent ranking, platform-support gate or SLO.
The original [result](result.json) is SHA-256
`a5ee4c82ac815cd285d90dbdebe408f4af90107e97a9b7b23c9b43bed5702560`;
the original [config](config.json) is
`88a7466adef45586ab656d02195cb3b4f08e1b481816f6b8da12eec97aeaa67b`.
[CATALOG.json](CATALOG.json) hashes every physical file except itself and maps the 607
original logical files to their storage. The 204 original `*/inputs/**` files are stored
losslessly in [captured-inputs.zip](captured-inputs.zip), SHA-256
`75b494bd832d4076b5f1201657039724d943f2877b41ddf35714b001bbd00656`.
[CAPTURED-INPUTS.json](CAPTURED-INPUTS.json) binds the exact member inventory, lengths and
original A3 hashes. Fixed member order, timestamp and ZIP_STORED serialization are deterministic.
Captured Rust tests and README files are data inside that archive, not active repository
test families or additional normative documents. Packing changes storage, not the measurement.
[MEASUREMENTS.json](MEASUREMENTS.json) is a derived index: each value points to its original
file, JSON field and SHA-256. Original stream bytes, including CRLF and trailing TSV tabs,
are preserved; scoped attributes prevent Git newline conversion.

The single completed A3 run took **153.183 seconds within 600 seconds**, with 24 pairs,
48 before/after states and 72 native commands, all exit zero. Each engine/corpus has three
serial pairs. [Separate validation](execution/validate.stdout) returned `VALID 24/48`.
The [postcondition audit](execution/postcondition-audit.json) checked 204 workspace inputs;
the [seal](execution/FINAL-SEAL.json) records 3,645 unchanged declared pins and the clean A3 head.
Earlier A/A2 runs stopped on measurement-projection and nonconforming-Windows-path defects;
they are not successful samples or automatic retries and are not folded into these results.

Runtime profile: native Windows x64, **Node.js 22.23.2** for T and the SCIP decoder,
**Python 3.14.7**, **Rust/Cargo 1.98.1 GNU**, RA release **2026-10-12**, actual
`0.3.3081-standalone (2ad81e72b7 2026-10-11)`, tree-sitter runtime **0.27.1**,
Rust grammar **0.24.2**, syn **3.0.9**. The diagnostic decoder uses protobufjs **7.6.3**
and official SCIP schema **v0.10.0**. [Config](config.json) records exact paths, child-only
offline profile and hashes, including explicit `RUST_SRC_PATH`; it installs nothing globally.
CPU/load and OS caches were not controlled or flushed. Earlier diagnostic runs warmed caches.
“Cold” means no prior engine index in the fresh per-pair workspace, not a cold machine.

## Identical input edit and different engine scopes

Every pair appends exactly `\npub fn semctx_reindex_probe() -> usize { 17 }\n`:
fixture `app/src/main.rs`, pico-args `src/lib.rs`. Every native baseline lacks that exact
structured function symbol and every native postimage contains it. These are positive
function-discovery witnesses, not whole-workspace or negative completeness proofs.
Input, before/after and append hashes are in each pair. The fixture's same five selected
normal `.rs` files and pico's one `.rs` file feed T/Y; S/L additionally load the Cargo
workspace, target configuration and stdlib. Cargo manifest and lockfile bytes are retained
under logical `inputs/` paths inside the archive; manifests use `.capture` names and cannot
become replay/product crates. Portable validation extracts them only into an explicit scratch copy.

- T: one fresh parser process; native full parse, `oldTree.edit`, incremental parse in that
  same process, retaining original CST S-expressions and structured function nodes.
- Y: separate full-parse helper processes for each selected file before and after the edit;
  integer native nanoseconds are summed before conversion to milliseconds.
- S: two full RA batch exports, with separately timed decoder processes. This is full batch
  reanalysis, not an incremental SCIP update.
- L: one persistent server, negotiated UTF-16 didChange, then new documentSymbol result;
  the source file stays unchanged on disk. The probe also performs readiness and navigation queries.

## Three observed samples

Each cell lists samples 1 / 2 / 3. Arrows mean baseline → edited state in that sample;
all times are milliseconds, displayed to three decimals only. Original unrounded values and
per-value field/digest references remain in [MEASUREMENTS.json](MEASUREMENTS.json).
For T/Y the scoped native column is parser-call time only. For L it is initialize→quiescent
(`ready`) → didChange-to-new-documentSymbol (`changeToDocumentSymbol`), two different
boundaries, not two parser intervals. L also retains the narrower request-only
`documentSymbolAfterEdit` and baseline `documentSymbolBeforeEdit` fields.
T process wall time covers both states, initialization and serialization; Y wall time sums
the five/one direct helper process intervals per state. S batch wall excludes its decoder,
which is shown separately. L whole-probe wall includes startup, other queries and shutdown.

| Engine and input | Scoped native interval, ms | Direct process wall, ms | Separate decoder wall, ms |
| --- | --- | --- | --- |
| [T fixture](T-fixture-1/pair.json) | [3.877→0.335 / 3.909→0.298 / 3.755→0.297](MEASUREMENTS.json) | [300.756 / 126.444 / 110.020 (whole pair)](MEASUREMENTS.json) | — |
| [T pico](T-pico-1/pair.json) | [8.509→0.369 / 8.398→0.371 / 8.451→0.351](MEASUREMENTS.json) | [121.295 / 111.166 / 109.197 (whole pair)](MEASUREMENTS.json) | — |
| [Y fixture](Y-fixture-1/pair.json) | [1.127→1.139 / 1.178→1.163 / 1.155→1.167](MEASUREMENTS.json) | [97.096→266.769 / 135.875→274.088 / 89.345→79.922](MEASUREMENTS.json) | — |
| [Y pico](Y-pico-1/pair.json) | [2.401→2.471 / 2.475→2.486 / 2.387→2.332](MEASUREMENTS.json) | [20.171→31.966 / 21.753→42.189 / 20.854→38.598](MEASUREMENTS.json) | — |
| [S fixture](S-fixture-1/pair.json) | [not a parser-only interval](MEASUREMENTS.json) | [2620.493→2631.384 / 2623.423→2111.011 / 2314.066→2215.557](MEASUREMENTS.json) | [459.170→466.047 / 427.753→431.164 / 429.893→430.382](MEASUREMENTS.json) |
| [S pico](S-pico-1/pair.json) | [not a parser-only interval](MEASUREMENTS.json) | [2291.596→2276.896 / 2140.408→2289.137 / 2243.809→2224.744](MEASUREMENTS.json) | [440.363→433.232 / 456.675→436.562 / 429.627→427.015](MEASUREMENTS.json) |
| [L fixture](L-fixture-1/pair.json) | [3635.475→3.081 / 2766.859→1.802 / 4446.549→1.970](MEASUREMENTS.json) | [3987.469 / 3214.555 / 4754.758 (whole probe)](MEASUREMENTS.json) | — |
| [L pico](L-pico-1/pair.json) | [2926.003→4.730 / 3461.349→5.017 / 4290.487→4.539](MEASUREMENTS.json) | [3447.592 / 4055.512 / 4860.279 (whole probe)](MEASUREMENTS.json) | — |

## Three direct-process memory observations

MiB = 1,048,576 bytes; displayed values below are rounded, original integer bytes are retained.
Windows PSAPI `PeakWorkingSetSize` is for that individual process, never an aggregate of
simultaneous Cargo/RA descendants. T and L peaks span the whole before/after pair and cannot
be separated into state peaks. Y reports the largest individual helper peak in each state,
not a sum; all per-file peaks remain in the command records. S reports each RA batch peak;
decoder peaks are separate command fields. L server peak is recorded by the probe from the
actual RA child; its Python wrapper peak is explicitly separate.

| Engine and input | Direct-process peak, MiB, samples 1 / 2 / 3 |
| --- | --- |
| [T fixture](T-fixture-1/pair.json) | [72.277 / 71.770 / 72.340 (Node, whole pair)](MEASUREMENTS.json) |
| [T pico](T-pico-1/pair.json) | [80.328 / 80.961 / 80.750 (Node, whole pair)](MEASUREMENTS.json) |
| [Y fixture](Y-fixture-1/pair.json) | [6.070→6.062 / 6.078→6.066 / 6.070→6.066 (largest individual helper per state)](MEASUREMENTS.json) |
| [Y pico](Y-pico-1/pair.json) | [7.449→7.434 / 7.480→7.469 / 7.449→7.434 (largest individual helper per state)](MEASUREMENTS.json) |
| [S fixture](S-fixture-1/pair.json) | [542.707→537.430 / 533.816→541.645 / 537.531→543.281 (RA per batch process)](MEASUREMENTS.json) |
| [S pico](S-pico-1/pair.json) | [538.219→535.863 / 540.488→541.738 / 540.562→539.070 (RA per batch process)](MEASUREMENTS.json) |
| [L fixture](L-fixture-1/pair.json) | [564.465 / 569.270 / 573.289 (RA server whole pair); wrapper 29.309 / 29.273 / 29.406](MEASUREMENTS.json) |
| [L pico](L-pico-1/pair.json) | [577.832 / 572.098 / 572.438 (RA server whole pair); wrapper 29.969 / 30.027 / 29.953](MEASUREMENTS.json) |

## Admission and transport limits

**`NONCONFORMING_WINDOWS_SCIP_PATHS`**: this native RA exporter emits backslash document
paths despite the [SCIP protocol's required slash separator](https://github.com/scip-code/scip/blob/v0.10.0/scip.proto).
The archived config explicitly selects `S.pathMode = windows-diagnostic` for local matching
only. Strict POSIX remains the default. Matching refuses absolute/drive/UNC/traversal paths,
empty components and collisions. Original protobuf and decoded JSON paths are untouched.
This is an upstream transport conformance defect; successful diagnostic association does
not establish portable SCIP conformance or production admission. Known duplicate-symbol and
missing-definition warnings remain in native stderr, even when the process exits zero.
The protobufjs diagnostic decoder can ignore unknown wire fields; it is not a complete
protocol decoder or proof of native SCIP CLI JSON equivalence.

The preparatory Y binary [build receipt](build/READY.json) retains its actual source450 identity,
GNU profile and 4,115,497-byte binary hash. [A3 preparation](execution/preparation.json)
transfers that binary through sixteen identical Y/fixture input hashes; this is not a rebuild
at A3. Config pins retain the A3 unit-test version that existed during measurement.
The subsequently added publication/integration test is not a measured runtime input.
The current Runner received an outer-timeout process-tree cleanup correction after A3.
The three original measured harness hashes, sources, profile and tool hashes remain historical
A3 identities in [PROVENANCE.json](PROVENANCE.json); the changed Runner is not a measured A3
runtime input. Compatible read-only validation of these captures establishes stored fact
bindings only. It establishes no new engine execution, current timing/RSS or current timeout
cleanup proof, and the A3 subject is never relabelled as a later execution.

These captures exclude materialized workspaces, Cargo targets, caches, tools and binaries.
They retain only enumerated original primaries, archived captured inputs and identified receipts.
Absolute host paths are original identity/argv metadata; portable validation reads relative
capture paths and never opens those original paths or executes engines. Declared local pins
are not a whole-OS/DLL sandbox, hostile-input or descendant-resource guarantee.
No p95, performance threshold, SLO, causal speed ranking or Rust product-support claim follows.
Historical macOS/Bun and Linux-smoke observations remain separate.

## Replay

First verify physical bytes and copy the captures to a fresh absolute directory outside
the repository. The unpack utility is a publication helper, not a measured A3 input. It
checks the archive hash before ZIP parsing, exact original member inventory and hashes,
byte budgets, relative paths and member types; duplicates, symlinks, traversal, stale/missing
members and existing destinations are refused before creating input files. Never unpack
into the tracked publication directory.

```sh
export CAPTURE_COPY=/absolute/new-capture-copy
python3 - <<'PY' || exit $?
import hashlib, json, os, shutil
from pathlib import Path
root = Path("docs/research/rust-indexing/results/reanalysis-windows-2026-10-17")
for entry in json.loads((root / "CATALOG.json").read_bytes())["files"]:
    path = root / entry["path"]
    assert not path.is_symlink() and path.resolve().is_relative_to(root.resolve())
    assert hashlib.sha256(path.read_bytes()).hexdigest() == entry["sha256"], entry["path"]
destination = Path(os.environ["CAPTURE_COPY"])
assert destination.is_absolute() and not destination.resolve().is_relative_to(Path.cwd().resolve())
shutil.copytree(root, destination)
PY
python3 -B scripts/rust-indexing-unpack.py --root "$CAPTURE_COPY" || exit $?
python3 -B scripts/rust-indexing-reanalysis.py --validate "$CAPTURE_COPY" || exit $?
```

The [unmodified original invocation](execution/argv.json) retains the exact A3 paths and
`--engines T Y S L --samples 3 --budget-seconds 600`. To measure again, acquire the declared
tools/dependencies, materialize a new trusted child profile, adapt the archived config's
absolute paths and recompute their pins before execution. Use a new output directory:

```sh
python3 -B scripts/rust-indexing-reanalysis.py --config /absolute/new-profile.json --output /absolute/new-empty-run --engines T Y S L --samples 3 --budget-seconds 600
```

Adapting paths/config creates a new measurement identity; it cannot reproduce the A3 byte
receipt by renaming it. The runner refuses a pre-existing output directory, missing/stale
symbols, changed input/tool pins, invalid timings, failed commands and incomplete coverage.
Originals are byte-exact observations, not executable Semctx artifacts.
