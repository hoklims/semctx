# Observation files

These are experiment recordings, not loadable Semctx artifacts or test snapshots. The replay
protocol states commands and expected source targets. `serial-measurements.json` records exit,
wall and max-resident accounting for three sequential processes per corpus/semantic transport;
matching `.time` and LSP `.stdout` files retain native stderr and JSON-RPC responses.
These LSP recordings predate the probe's synchronization/UTF-8/exit-propagation corrections.
In particular, historical full-text edits were accepted by a server advertising incremental
changes; the recordings do not qualify the corrected edit protocol or its latency. They remain
unchanged historical observations, as detailed in the performance note.

`tree.jsonl` retains full native CSTs, parse errors and repeated parser intervals. `syn.json` retains
helper TSV, parser intervals, process wall intervals and exit outcomes. The `.time` single-process
parser samples are labelled separately in the performance note. `fixture-1.scip.json` is diagnostic
printer output, not an ingestion contract. `extra.stderr` records the feature-enabled export;
`wasm-unicode.json` records the JavaScript binding's UTF-16 offset observation. Other `.stderr`
files record manifest, unresolved-name, absent-binary, timeout and execution-sentinel trials.

Repository and experiment-temp absolute prefixes are replaced by `$ROOT` and `$RUN`. A whitespace-only
line in `manifest.stderr` and final empty lines of native Cargo logs are trimmed for repository
diff hygiene. All other content is retained,
including engine warnings/errors. These normalizations prevent claiming byte-for-byte wire
artifacts or source/result attestations. `pico-1.scip.gz` and `linux-fixture.scip.gz` are the explicit exceptions: compressed
original binary bytes retain their original project root and are identified by hash in the replay.
`edge-*` files record later ambiguity, macro/generated, indirect-call and target-world trials;
`linux-*.txt` record platform smokes and their missing-sysroot limitation. No result implies
executed Semctx Rust support.

The initial default-configured edge LSP pilot accidentally inherited the host's stable toolchain
without rust-src. Its recording was replaced by an explicit offline `RUSTUP_TOOLCHAIN=1.98.1`
rerun with rust-src; the command record names the overrides and retains the same definition target.
Native `.log` oracles are explicitly tracked despite the repository's general log ignore rule.

## Current native Windows reanalysis

[reanalysis-windows-2026-10-17](reanalysis-windows-2026-10-17/README.md) retains a separate
A3 source identity and 24 actual cold/edited pairs. Its enumerated primaries are byte-exact,
including native CRLF and TSV trailing tabs; scoped data-only attributes prevent Git
normalization. Its catalogue binds original fields, inputs, tool/profile pins and build
transfer. The historical prefix substitutions/trimming described above do not apply to
that directory. No materialized Cargo workspace, target, executable or cache is published.
The 204 captured input files are stored losslessly in one deterministic archive; their
Rust tests and README files remain experimental data rather than additional active
repository oracles/documents. Hash-check and unpack into a scratch copy before portable validation.
