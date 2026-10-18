# C2 correction pass2 portable producer and DEV checkpoint

This publication preserves the exact frozen source tree (188 files), all51 frozen
provenance/log records, original freeze/manifests, the two small input carriers,
registration, both independent source reviews and retained producer/B reports.
The member manifest records each archived file's byte count and SHA256; the alias
map relates original absolute paths to portable archive members. Reports retain
their original historical state and absolute references. They are not rewritten
to imply later qualification.

The source includes the original checker/parser registry .crate archives and
upstream definitions/internal.ts.d.bin. Those are source inputs. Compiled native
executables, target trees and .rlib files are excluded. The selected original
executable is bound by FREEZE.json to SHA256
acfd231f629de6036056f137b44edb2513ef3283ce1e531b9747279ca6b50a37.
The freeze SHA256 is
e51c7d0137f8ab890b33116d1e5f7c2bc6e53b045cb20a3813b16e1ca53567df.
Rebuilding does not promise byte-identical executable output.

The integration is C2-P2-NATIVE-PARSER-BINDING-RESOLUTION with exact root Cargo
dependencies and Cargo.lock. The extracted vendor tree already contains the
native Rust patches. Do not apply the retained documentary patches again.
The root lock governs reconstruction; nested upstream locks and original
Cargo.toml.orig files are preserved historical source material. Rust1.95.0 and
the locked dependency artifacts require a caller-provided toolchain/cache or
network. This archive is not an offline toolchain distribution.

Decode c2-pass2.tar.gz.b64, compare its decoded SHA256 with record.json, inspect
the regular relative member names and extract into a new caller-owned directory.
Tar members are sorted, uid/gid0, mode0644 and mtime0; gzip has mtime0. No symlinks
or hardlinks are included. The publisher decoded the delivered base64 and read
every member back to verify its exact bytes without extracting or executing it.

Documentary reconstruction commands (not executed by this publication):

    T00_PORTABLE_ROOT="<absolute extraction directory>"
    T00_SOURCE="$T00_PORTABLE_ROOT/session/composition2/correction-pass2/frozen/source"
    T00_BUILD_ROOT="<new caller-owned Cargo target directory>"
    cd "$T00_SOURCE"
    env -u GIT_CONFIG_GLOBAL CARGO_TARGET_DIR="$T00_BUILD_ROOT" cargo +1.95.0 build --locked --release
    env -u GIT_CONFIG_GLOBAL CARGO_TARGET_DIR="$T00_BUILD_ROOT" cargo +1.95.0 test --locked
    env -u GIT_CONFIG_GLOBAL CARGO_TARGET_DIR="$T00_BUILD_ROOT" cargo +1.95.0 clippy --locked --all-targets -- -D warnings
    env -u GIT_CONFIG_GLOBAL cargo +1.95.0 fmt --all -- --check

The strict clippy/fmt checks cover owned wrapper/tests; upstream vendor warnings
are retained. Source bindings and original logs establish33 passing native DEV
tests on macOS ARM64 with Rust1.95.0. They do not establish full-SDK semantic
parity, R0, READY_TS_NATIVE, reserved-case success or native Windows/Linux
qualification. No native analysis was executed by this publication.

The SDK bytes are not duplicated. Reuse the canonical repository file
tools/rust-ts-r0/sdk/sdk-input.json, exactly3218481bytes and SHA256
d1e98c4875cc3d1fe302edea4964aa12a58b391a25e6368c800413d45386b654.
The archived frozen/inputs/development-request.json and
frozen/inputs/sdk-required-closure.v3.json remain the original exact carriers.
The native argv is executable, request, SDK, closure in that order:

    T00_REQUEST="$T00_PORTABLE_ROOT/session/composition2/correction-pass2/frozen/inputs/development-request.json"
    T00_SDK="<repository>/tools/rust-ts-r0/sdk/sdk-input.json"
    T00_CLOSURE="$T00_PORTABLE_ROOT/session/composition2/correction-pass2/frozen/inputs/sdk-required-closure.v3.json"

Use a freshly identified rebuilt binary for a new experiment, or supply the
original selected binary matching its frozen hash for historical replay.
A qualified invocation must use the existing canonical #383 supervisor and
independent verifier, with fresh artifact/descriptor bindings and preserved
bounded outcomes. The final independent full-SDK replay records are separate
and are intentionally absent here. No success is inferred from transport exit
or these DEV logs.

The compiled63path SDK priority matches the independent TypeScript5.9.3 order
and is documented in provenance/sdk-order-selection.json. All required SDK
files and bytes remain unchanged. It is input ordering metadata, not semantic
expected targets, and requires no JavaScript or Go runtime in the producer.

The inline native/TypeScript nullability micro-oracle is preserved byte-for-byte
inside session/composition2/oracle/pass2-tuple-source-review.json at
strict_null_checks.typescript_micro_oracle. There is no invented separate raw
file. Baseline TypeScript5.9.3 without strictNullChecks accepts explicit
undefined and types the binding as number; the native strict law differs.
The native strict tests do not prove baseline parity, and no expected/profile
was altered to hide that difference.

Captured relative module resolution is bounded. It chooses the actual captured
source path before native SourceId/parse and retains refusals; it does not prove
complete Bundler/package configuration or ambient imported .d.ts support.
Historical pending reports remain pending in their original bytes. The optional
standalone final producer report was not yet available when packaged; record.json
states this explicitly. Final SDK run reports belong to their separate archive.
No reserved corpus, repository file, Git index or GitHub object was touched.
