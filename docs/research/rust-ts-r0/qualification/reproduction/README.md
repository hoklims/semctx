# Historical qualification observer reproduction

This supplement preserves original v1/v2 observer and recipe sources, registries,
preflights, build records and immutable public input sources. Original records are
not rewritten. Alias/hash maps identify each source. It contains no selected native
binary, compiled rlib, build target, private reserved input, or running verification
log. Reports of unsuccessful campaigns remain unsuccessful.

C1 pass1 and pass2 are distinct immutable checkpoints. Their original selected
binary SHA256 values and complete original source-manifest identities are in
historical-identities.json and session/selected-c1-passN/FREEZE.json. All 39 pass1
sources were recovered byte-exactly from identified Git objects; all 44 pass2
sources were copied byte-exactly from their frozen snapshot. The original pass1
README/test and the separately recorded authorized postfreeze DEV deltas remain
distinct. Supporting gates sources from published commit568c271 complete the local
Cargo path dependency separately; this does not extend the original freeze manifest.

Extract into an empty directory after checking record.json's decoded archive hash.
All archive members are regular relative files with deterministic metadata and gzip
mtime0. The following are documentary commands with relocation placeholders. They
were not executed by this publication task. Supply the pinned toolchain/dependency
network or cache. Rebuilt executable hashes are not promised to equal the historical
selected binaries: a rebuilt run is a new replay with separately recorded identities.

Choose one generation consistently:

    T00_PORTABLE_ROOT="<absolute extraction directory>"
    T00_GENERATION="pass1"
    T00_SOURCE="$T00_PORTABLE_ROOT/frozen-sources/c1-$T00_GENERATION"
    T00_BUILD_ROOT="<new caller-owned build directory>"
    T00_LOCAL_TREE="<new caller-owned complete source tree>"
    T00_OBSERVER="<v1 qualification_replay.rs for pass1; v2 for pass2>"
    T00_CASES="$T00_PORTABLE_ROOT/repository/docs/research/rust-ts-r0/cases"

Copy the chosen frozen source tree to T00_LOCAL_TREE. Complete tools/gates with
supporting-gates-source/tools/gates; compare overlapping files byte-for-byte first.
Use a new Cargo target directory per generation; never mix pass1/pass2 rlibs.

    cd "$T00_LOCAL_TREE"
    env -u GIT_CONFIG_GLOBAL GOPORT_LIB_PARSE_SNAPSHOT=0 GOPORT_LIB_SNAPSHOT=0 CARGO_TARGET_DIR="$T00_BUILD_ROOT" cargo +1.95.0 build --locked --release --manifest-path tools/rust-ts-r0/Cargo.toml
    env -u GIT_CONFIG_GLOBAL CARGO_TARGET_DIR="$T00_BUILD_ROOT" cargo +1.95.0 build --locked --release --manifest-path tools/gates/Cargo.toml --bin semctx-gates

The v1 exact historical rustc argv is preserved in
session/qualification-adapter/optimized-comparator-build-proof.final.json.
V2's original bridge records the exact release rlib paths and hashes; its preparation
report records rustc1.95.0 --edition2024 --test -O. The following generalization uses
the matching fresh build's rlibs, with explicit paths chosen from release/deps:

    T00_R0_RLIB="<matching libsemctx_r0_probe-*.rlib>"
    T00_GATES_RLIB="<matching libsemctx_gates-*.rlib>"
    T00_SERDE_JSON_RLIB="<matching libserde_json-*.rlib>"
    T00_COMPARATOR="<new comparator executable path>"
    rustc +1.95.0 --edition=2024 --test -O "$T00_OBSERVER" -L "dependency=$T00_BUILD_ROOT/release/deps" --extern "semctx_r0_probe=$T00_R0_RLIB" --extern "semctx_gates=$T00_GATES_RLIB" --extern "serde_json=$T00_SERDE_JSON_RLIB" -o "$T00_COMPARATOR"
    "$T00_COMPARATOR" comparator_ --nocapture

Replay requires a separate derived bridge JSON, not changes to historical records.
Copy the chosen campaign's replay-c1-passN/freeze-manifest.json to a new caller-owned
file. Relocate artifact_path, helper_path, sdk_path, recipes_path and cases_path.
For historical-binary replay, supply actual original binaries matching their frozen
hashes. For a rebuilt replay, set artifact_sha256/helper_sha256 to the independently
computed hashes of the new binaries and record this as a new, nonhistorical replay.
Keep SDK, recipe and immutable input bytes unchanged. Relocate source/library
metadata separately and record actual new hashes; do not reuse historical hashes
as if those files had been rebuilt identically. Preserve all original preflights.
Run a fresh byte-identity preflight before any replay. The v1 historical bridge's
root_execution_signal_received=false is preserved: campaign authorization was
provided separately through the recorded preflight/environment, not retroactively
edited into that record.

With the derived bridge and a nonexistent output directory:

    T00_DERIVED_BRIDGE="<new relocated bridge JSON>"
    T00_REPLAY_EVIDENCE="<new nonexistent evidence directory>"
    env -u GIT_CONFIG_GLOBAL GOPORT_LIB_PARSE_SNAPSHOT=0 GOPORT_LIB_SNAPSHOT=0 SEMCTX_QUALIFICATION_RUN_SIGNAL=stage5-optimized-frozen-stage6-authorized SEMCTX_QUALIFICATION_FREEZE_MANIFEST="$T00_DERIVED_BRIDGE" SEMCTX_QUALIFICATION_EVIDENCE="$T00_REPLAY_EVIDENCE" "$T00_COMPARATOR" qualification_replay_requires_explicit_optimized_freeze --exact --nocapture

The signal is required by the observer; merely setting it is not new execution
authorization. Both campaigns historically exited101 for actual nonpasses/gaps;
never translate that into a successful qualification. Keep new raw process outcomes,
the exact invocation/environment, source/library/artifact identities and before/after
identity checks. Do not reuse an existing output directory or overwrite old records.

The recipes are frozen. Their generators are preserved for inspection; rerunning
them is not needed to replay and must not silently replace those recipes or expected
values. Native Windows/Linux evidence, reserved-case qualification and R0 remain
separate requirements. Current canonical verification streams are excluded; the
current shard4 generated analyzer identity failure is unresolved at this checkpoint.
This supplement grants no PASS, R0 or READY_TS_NATIVE and performs no native query.
