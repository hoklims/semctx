# Selected optimized C1 checkpoint

[FREEZE.json](FREEZE.json) freezes C1 after correction pass 1, before any native
qualification or reserved query. The selected macOS ARM64 executable is SHA256
`6fa6484b1176e1a96714c215ccd4be366808e2de95fae96ee17f0277bca73774`.
Its archived local path is historical artifact custody, not a portable expected
path. [source-manifest.json](source-manifest.json) binds the indexed prototype,
pins, SDK and development fixtures; it precedes this checkpoint's Git commit.
The source commit published immediately before this checkpoint is named there.
No bit-for-bit build reproducibility across hosts or directories is claimed.

The crate now exposes separate native semantic, source-parsing and module
configuration observations. The latter distinguishes retained inputs with and
without an explicitly supplied source from ordinary configuration inspection.
A missing native capability remains `unsupported`; matching reason strings do
not discharge that gap. The elementary `javascript.reasons` field still does not
represent the complete historical JavaScript consumer operation.

The optimized executable passed three process integration tests: four shared
TS/JS development vectors and the two existing independent pipeline cases. These
are development evidence, not the 354 qualification units or reserved cases.
The shared vectors reuse the source-authored, frozen DEV07 parsing and DEV08
BOM/CRLF/astral-coordinate expectations. Their oracles reject representative
missing/extra reasons and missing function projections. The pipeline also
exercises actual nonzero, timeout, output-limit and Unix empty-PATH outcomes.
[process-input-inventory.json](process-input-inventory.json) records ten actual
Outcomes, platform libraries, supplied inputs and successful reported read joins.
It does not claim a complete operating-system trace or coherent live acquisition.

The additional component controls and their limitations are preserved in
[component-observations-report.json](component-observations-report.json).
Two comments occur inside DEV fixture source strings: the TypeScript reference
path directive and the JSX runtime pragma. They exercise those external SDK
language rules; no explanatory Rust comment was added.

The previous remote run rejected the workflow before starting jobs because
`runner.temp` was used at job environment scope. The variable is now at step
scope; local actionlint rejects the previous placement and accepts the corrected
workflow. [checkpoint4-publication.json](checkpoint4-publication.json) and the
[independent context review](ci-context-correction-review.json) preserve that
failure. The existing native CI job also runs these optimized integration tests
on Ubuntu, native Windows and macOS, retaining each executable and its evidence.
A configured step is not a successful remote result.

From the repository root, with Rust 1.95.0:

```sh
export GOPORT_LIB_PARSE_SNAPSHOT=0 GOPORT_LIB_SNAPSHOT=0 RUST_TEST_THREADS=1
cargo build --manifest-path tools/gates/Cargo.toml --locked --release
export SEMCTX_PROCESS_HELPER="$PWD/tools/gates/target/release/semctx-gates"
export SEMCTX_NATIVE_EVIDENCE="/absolute/disposable/evidence-directory"
cargo test --manifest-path tools/rust-ts-r0/Cargo.toml --locked --release \
  --test native_development_flow --test native_common_portability
```

On Windows, select `semctx-gates.exe`. The process controller remains the one from
#383. Build tools and the reference SDK JavaScript oracle are distinct from the
candidate's analysis runtime. Rebuilding produces a new observed artifact that
needs its own identity; never overwrite the selected executable during a replay.

[evidence-manifest.json](evidence-manifest.json) names exact encoded raw evidence.
Decode a selected record with `python -m base64 -d record.b64` before parsing it.
The intentionally malformed request is retained as raw data, not a valid JSON
claim. [frozen-corpus-identity-check.json](frozen-corpus-identity-check.json) checks
54 top-level artifact references; the entire tracked case directory is also
unchanged from the stage-3 freeze commit. These checks establish byte custody,
not semantic coverage.

R0 remains `NOT_RUN` at this checkpoint. Full qualification, reserved results and
optimized native Windows/Linux common-vector execution remain required.

The original 39-file source manifest remains historical and immutable.
[post-freeze-validation-delta.json](post-freeze-validation-delta.json) records the
only two subsequent changes inside it: the crate README and verification test.
The candidate source, SDK, dependencies and selected executable are unchanged.
The debug oracle previously shared a deadline across independent poison cases
and included costly verifier preparation in positive consumer windows. Each case
now prepares its expected bindings before its own controlled acceptance window.
The supervised process timeout remains 20 seconds, separately from the ready
consumer's 20-second window; no 20-second dispatch-to-admission guarantee or full
T02 lifecycle is established. Explicit expired-result refusal remains tested.
The final verification source passed two debug pipeline tests and the three
optimized integration tests on macOS ARM64. The bounded independent review and
its final execution annex are retained alongside the original snapshots.
[validation-history/manifest.json](validation-history/manifest.json) preserves
failed and cancelled checks as well as successful runs, without qualification
credit. Historical filenames containing `green` do not override their failures.

[checkpoint5-verification.json](checkpoint5-verification.json) records all four
canonical `verify:pr` shards passing on macOS ARM64 with Bun 1.4.3 and
`GIT_CONFIG_GLOBAL` unset. Remote native portability remains unproved here.
