# C2 correction pass1 portable source and DEV checkpoint

This archive preserves all119 frozen source files, original reports, registration,
freeze/source manifests, the two small frozen input carriers, and all eight DEV
logs. Every original file is copied byte for byte; the alias map binds its original
absolute path to a relative member, byte count and SHA256. Both binary source-data
files are intentionally retained: the exact original registry .crate and upstream
definitions/internal.ts.d.bin. They are source inputs, not a selected executable.
No target tree, native executable or compiled rlib is included.

The selected original executable SHA256 is
8e41b3a7adb9e33998a6fb5cba3582b041e9a8205b11c937e5651004a5893bf0.
Its immutable FREEZE.json SHA256 is
5dd67f86d363d02d42948ec9066efd7f1aa6faabe77fb9fb972aae952e5d9b30.
The source manifest SHA256 is
045b88ee7026857a1d68b8bc47b9bcde739572e9bdd60248ed36eeb8e7abfd6b.
Rebuilding this source does not promise byte-identical executable output.
Record new toolchain, platform, command and resulting hashes independently.

The integration is C2-P1-DEFINITION-LOCAL-MAPPINGS over ezno-checker0.0.18.
The vendor directory is already patched. The original registry archive, Rust patch,
exact-dependency patch and local-patch provenance are retained separately; do not
apply those patches again to the already patched tree. The historical registry
descriptor's not-yet-applied text is preserved; freeze-metadata-note.json explains
its timing. The root Cargo.lock governs this build. The nested upstream Cargo.lock
is preserved historical source material.

Decode the base64 file into a new directory, compare its decoded SHA256 with
record.json, inspect the member list, then extract. Members are regular relative
files with deterministic tar metadata and gzip mtime0. A rebuild needs Rust1.95.0
and the locked dependencies through a caller-provided cache or network; this is
not an offline toolchain distribution.

Documentary local reconstruction commands, not executed by this publication:

    T00_PORTABLE_ROOT="<absolute extraction directory>"
    T00_SOURCE="$T00_PORTABLE_ROOT/session/composition2/correction-pass1/frozen/source"
    T00_BUILD_ROOT="<new caller-owned Cargo target directory>"
    cd "$T00_SOURCE"
    env -u GIT_CONFIG_GLOBAL CARGO_TARGET_DIR="$T00_BUILD_ROOT" cargo +1.95.0 build --locked --release
    env -u GIT_CONFIG_GLOBAL CARGO_TARGET_DIR="$T00_BUILD_ROOT" cargo +1.95.0 test --locked
    env -u GIT_CONFIG_GLOBAL CARGO_TARGET_DIR="$T00_BUILD_ROOT" cargo +1.95.0 clippy --locked --all-targets -- -D warnings
    env -u GIT_CONFIG_GLOBAL cargo +1.95.0 fmt --all -- --check

These commands describe the owned wrapper checks. Inherited vendor warnings remain
visible. The preserved logs distinguish an initial compile failure from the actual
native RED panic, the targeted GREEN, and the final8test DEV run. None establishes
full-SDK semantic parity, R0, READY_TS_NATIVE or native Windows/Linux qualification.
All historical observations in this checkpoint were made on macOS ARM64.

The SDK bytes are deliberately not duplicated. Reuse the canonical repository
tools/rust-ts-r0/sdk/sdk-input.json, exactly3218481bytes with SHA256
d1e98c4875cc3d1fe302edea4964aa12a58b391a25e6368c800413d45386b654.
The other original carriers are archived under frozen/inputs:
development-request.json and sdk-required-closure.v3.json. Their original hashes
are retained in FREEZE.json and historical-identities.json. Do not regenerate,
reorder, simplify or substitute these inputs for a claimed historical replay.

    T00_SDK="<repository>/tools/rust-ts-r0/sdk/sdk-input.json"
    shasum -a 256 "$T00_SDK"
    T00_REQUEST="$T00_PORTABLE_ROOT/session/composition2/correction-pass1/frozen/inputs/development-request.json"
    T00_CLOSURE="$T00_PORTABLE_ROOT/session/composition2/correction-pass1/frozen/inputs/sdk-required-closure.v3.json"

The frozen native argv is executable, request, SDK, closure, in that order.
For a rebuilt run, choose T00_BUILD_ROOT/release/semctx-r0-ezno-probe as the new
executable and record its actual hash. For replay of the historical selected
binary, supply the original executable matching its frozen identity instead.
A qualified invocation must pass that argv through the existing canonical #383
supervisor and independent verifier with fresh descriptor/artifact bindings,
before/after identity checks, bounded outcomes and a new evidence directory.
There is no new controller in this archive. Use the separately finalized independent
full-SDK verifier record for its exact supervision/replay command; do not bypass it
with an unsupervised invocation or infer full-SDK success from these DEV logs.

Original reports preserve their pre-replay pending state. A new independent
full-SDK replay was running outside this checkpoint during publication preparation;
none of its files was inspected or included, and no result is inferred here.
No reserved corpus was accessed. No native analysis was run by this publication.
No source, freeze, expected value, repository file or Git index was changed.
